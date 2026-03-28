import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { env, execPath } from "node:process";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { IssueEntry, RuntimeConfig } from "../types.ts";
import { appendFileTail } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { normalizeAgentProvider } from "./providers.ts";
import { TARGET_ROOT } from "../concerns/constants.ts";
import { translatePaths, buildDockerRunCommand } from "./docker-runner.ts";

type NodePtyModule = typeof import("node-pty");

// ── Daemon script resolution ──────────────────────────────────────────────────

interface DaemonScript {
  command: string;
  args: string[];
}

function resolveDaemonScript(): DaemonScript | null {
  const pkgRoot = process.env.FIFONY_PKG_ROOT;
  if (!pkgRoot) return null;

  // Prefer compiled daemon (production)
  const compiled = join(pkgRoot, "dist", "agent", "pty-daemon.js");
  if (existsSync(compiled)) {
    return { command: execPath, args: [compiled] };
  }

  // Fall back to tsx source (dev mode)
  const source = join(pkgRoot, "src", "agents", "pty-daemon.ts");
  if (existsSync(source)) {
    try {
      const require = createRequire(fileURLToPath(import.meta.url));
      const tsxCli = require.resolve("tsx/cli") as string;
      return { command: execPath, args: [tsxCli, source] };
    } catch {
      return null;
    }
  }

  return null;
}

// Resolved once at module load — stable for the lifetime of the process
const DAEMON_SCRIPT = resolveDaemonScript();

// ── HOOK_RUNTIME_CONFIG ───────────────────────────────────────────────────────

const HOOK_RUNTIME_CONFIG: RuntimeConfig = {
  pollIntervalMs: 0,
  workerConcurrency: 1,
  maxConcurrentByState: {},
  commandTimeoutMs: 1_800_000,
  maxAttemptsDefault: 1,
  maxTurns: 1,
  retryDelayMs: 0,
  staleInProgressTimeoutMs: 0,
  logLinesTail: 12_000,
  maxPreviousOutputChars: 12_000,
  agentProvider: "codex",
  agentCommand: "",
  defaultEffort: { default: "medium" },
  runMode: "filesystem",
  autoReviewApproval: true,
  dockerExecution: false,
  dockerImage: "fifony-agent:latest",
  afterCreateHook: "",
  beforeRunHook: "",
  afterRunHook: "",
  beforeRemoveHook: "",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for a Unix socket file to appear, up to timeoutMs. */
async function waitForSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return true;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  return false;
}

// ── Main execution function ───────────────────────────────────────────────────

export async function runCommandWithTimeout(
  command: string,
  workspacePath: string,
  issue: IssueEntry,
  config: RuntimeConfig,
  promptFile: string,
  extraEnv: Record<string, string> = {},
  outputFile?: string,
): Promise<{ success: boolean; code: number | null; output: string }> {
  const started = Date.now();
  const resultFile = extraEnv.FIFONY_RESULT_FILE;

  // Write all FIFONY_* vars to an env file and source it in the command.
  // This avoids E2BIG: child inherits process.env naturally (no ...env spread),
  // and our custom vars are loaded from a file instead of argv/env.
  const allVars: Record<string, string> = {
    FIFONY_ISSUE_ID: issue.id,
    FIFONY_ISSUE_IDENTIFIER: issue.identifier,
    FIFONY_ISSUE_TITLE: issue.title,
    FIFONY_WORKSPACE_PATH: issue.worktreePath ?? workspacePath,
    FIFONY_PROMPT_FILE: promptFile,
  };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value.length > 4000) {
      const valFile = join(workspacePath, `${key.toLowerCase()}.txt`);
      writeFileSync(valFile, value, "utf8");
      allVars[`${key}_FILE`] = valFile;
    } else {
      allVars[key] = value;
    }
  }

  // Docker mode: translate host paths to container paths in all env vars
  if (config.dockerExecution) {
    for (const key of Object.keys(allVars)) {
      allVars[key] = translatePaths(allVars[key], workspacePath);
    }
  }

  const envFilePath = join(workspacePath, ".env.sh");
  const envFileLines = Object.entries(allVars)
    .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, "'\\''")}'`)
    .join("\n");
  writeFileSync(envFilePath, envFileLines, "utf8");

  let effectiveCommand: string;
  if (config.dockerExecution && config.dockerImage) {
    const translatedCmd = translatePaths(command, workspacePath);
    effectiveCommand = buildDockerRunCommand(
      translatedCmd,
      workspacePath,
      issue.worktreePath,
      TARGET_ROOT,
      config.dockerImage,
    );
  } else {
    effectiveCommand = `. "${envFilePath}" && ${command}`;
  }

  const liveLogFile = join(workspacePath, "live-output.log");

  // Write header to persistent stdout file if requested
  if (outputFile) {
    try {
      const header = `# fifony stdout capture\n# turn: ${extraEnv.FIFONY_TURN_INDEX ?? "?"}\n# provider: ${extraEnv.FIFONY_AGENT_PROVIDER ?? "?"}\n# role: ${extraEnv.FIFONY_AGENT_ROLE ?? "?"}\n# timestamp: ${new Date().toISOString()}\n---\n`;
      writeFileSync(outputFile, header, "utf8");
    } catch {}
  }

  // ── Fase 2: PTY Daemon path (non-Docker, daemon script available) ──────────
  if (!config.dockerExecution && DAEMON_SCRIPT) {
    const socketPath = join(workspacePath, "agent.sock");

    // If a live daemon is already running (e.g. fifony restarted mid-execution),
    // reattach to it directly — do not spawn a new daemon or wipe the live log.
    if (existsSync(socketPath)) {
      const { isDaemonAlive } = await import("./pid-manager.ts");
      if (isDaemonAlive(workspacePath)) {
        logger.info({ issueId: issue.id }, "[Agent] Live PTY daemon detected — reattaching to existing session");
        return attachToDaemon(socketPath, workspacePath, issue, config, started, outputFile, resultFile);
      }
      // Daemon is dead — remove the stale socket before spawning fresh
      try { rmSync(socketPath, { force: true }); } catch {}
    }

    if (resultFile && extraEnv.FIFONY_PRESERVE_RESULT_FILE !== "1") {
      rmSync(resultFile, { force: true });
    }
    writeFileSync(liveLogFile, "", "utf8");

    const daemonArgs = JSON.stringify({
      command: effectiveCommand,
      workspacePath,
      codePath: issue.worktreePath ?? workspacePath,
      issueId: issue.id,
      startedAt: new Date(started).toISOString(),
      commandSlice: command.slice(0, 200),
    });

    const effectiveCwd = issue.worktreePath ?? workspacePath;
    const daemonProcess = spawn(DAEMON_SCRIPT.command, [...DAEMON_SCRIPT.args, daemonArgs], {
      detached: true,
      stdio: "ignore",
      cwd: effectiveCwd,
    });
    daemonProcess.unref();

    logger.debug({ issueId: issue.id, daemonPid: daemonProcess.pid, command: command.slice(0, 120), cwd: effectiveCwd }, "[Agent] PTY daemon spawned");

    // Wait for the socket to be ready (daemon creates it before PTY spawn)
    const socketReady = await waitForSocket(socketPath, 10_000);
    if (!socketReady) {
      logger.warn({ issueId: issue.id }, "[Agent] PTY daemon socket not ready — falling back to inline PTY");
      // Fall through to Fase 1 below
    } else {
      return attachToDaemon(socketPath, workspacePath, issue, config, started, outputFile, resultFile);
    }
  }

  // ── Fase 1: Inline PTY path (non-Docker, node-pty available, no daemon) ───
  if (!config.dockerExecution) {
    let nodePty: NodePtyModule | null = null;
    try {
      const mod = await import("node-pty");
      if (typeof mod.spawn === "function") nodePty = mod;
    } catch {}

    if (nodePty) {
      if (resultFile && extraEnv.FIFONY_PRESERVE_RESULT_FILE !== "1") {
        rmSync(resultFile, { force: true });
      }
      writeFileSync(liveLogFile, "", "utf8");

      return new Promise((resolve) => {
        const ptyEffectiveCwd = issue.worktreePath ?? workspacePath;
        const ptyProcess = (nodePty as NodePtyModule).spawn("sh", ["-c", effectiveCommand], {
          name: "xterm-256color",
          cols: 220,
          rows: 50,
          cwd: ptyEffectiveCwd,
          env: process.env as Record<string, string>,
        });

        const pid = ptyProcess.pid;
        const pidFile = join(workspacePath, "agent.pid");
        if (pid) {
          logger.debug({ issueId: issue.id, pid, command: command.slice(0, 120), cwd: ptyEffectiveCwd }, "[Agent] Process spawned (PTY)");
          writeFileSync(pidFile, JSON.stringify({
            pid,
            issueId: issue.id,
            startedAt: new Date(started).toISOString(),
            command: command.slice(0, 200),
          }), "utf8");
        }

        let output = "";
        let timedOut = false;
        let outputBytes = 0;
        let outputHeader = "";

        const onChunk = (chunk: Buffer | string) => {
          const text = String(chunk);
          if (outputHeader.length < 2000) outputHeader = (outputHeader + text).slice(0, 2000);
          output = appendFileTail(output, text, config.logLinesTail);
          outputBytes += text.length;
          try { appendFileSync(liveLogFile, text); } catch {}
          if (outputFile) { try { appendFileSync(outputFile, text); } catch {} }
          issue.commandOutputTail = output;
        };

        ptyProcess.onData(onChunk);

        const AGENT_STALE_OUTPUT_MS = 1_800_000;
        const killPty = () => { try { ptyProcess.kill(); } catch {} };

        const timer = setTimeout(() => {
          timedOut = true;
          killPty();
        }, config.commandTimeoutMs);

        let lastWatchdogBytes = 0;
        let lastOutputGrowthAt = Date.now();
        let watchdogKilled = false;
        const watchdog = setInterval(() => {
          if (pid) {
            try { process.kill(pid, 0); } catch {
              clearInterval(watchdog);
              clearTimeout(timer);
              watchdogKilled = true;
              try { rmSync(pidFile, { force: true }); } catch {}
              resolve({ success: false, code: null, output: appendFileTail(output, `\nAgent process died unexpectedly (PID ${pid}).`, config.logLinesTail) });
              return;
            }
          }
          if (outputBytes > lastWatchdogBytes) {
            lastWatchdogBytes = outputBytes;
            lastOutputGrowthAt = Date.now();
          } else if (Date.now() - lastOutputGrowthAt > AGENT_STALE_OUTPUT_MS) {
            clearInterval(watchdog);
            clearTimeout(timer);
            timedOut = true;
            watchdogKilled = true;
            killPty();
            try { rmSync(pidFile, { force: true }); } catch {}
            resolve({ success: false, code: null, output: appendFileTail(output, `\nAgent process stuck — no output for ${Math.round(AGENT_STALE_OUTPUT_MS / 60_000)} minutes.`, config.logLinesTail) });
          }
        }, 30_000);

        const cleanup = () => {
          clearInterval(watchdog);
          try { rmSync(pidFile, { force: true }); } catch {}
        };

        ptyProcess.onExit(({ exitCode }) => {
          clearTimeout(timer);
          cleanup();
          if (watchdogKilled) return;
          const buildOutput = (suffix: string) => {
            const tail = appendFileTail(output, suffix, config.logLinesTail);
            return outputHeader.length > 0 && !tail.startsWith(outputHeader.slice(0, 80))
              ? `${outputHeader}\n${tail}`
              : tail;
          };
          if (timedOut) {
            resolve({ success: false, code: null, output: buildOutput(`\nExecution timeout after ${config.commandTimeoutMs}ms.`) });
            return;
          }
          const duration = Math.max(0, Date.now() - started);
          if (exitCode === 0) {
            resolve({ success: true, code: exitCode, output: buildOutput(`\nExecution succeeded in ${duration}ms.`) });
            return;
          }
          resolve({ success: false, code: exitCode ?? null, output: buildOutput(`\nCommand exit code ${exitCode ?? "unknown"} after ${duration}ms.`) });
        });
      });
    }
  }

  // ── Original spawn path (Docker or PTY unavailable) ───────────────────────
  if (resultFile && extraEnv.FIFONY_PRESERVE_RESULT_FILE !== "1") {
    rmSync(resultFile, { force: true });
  }
  writeFileSync(liveLogFile, "", "utf8");

  return new Promise((resolve) => {
    const child = spawn(effectiveCommand, {
      shell: true,
      cwd: workspacePath,
      detached: !config.dockerExecution, // Docker containers don't need detached mode
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Detach from parent so child survives SIGINT/restart (not needed in Docker mode)
    if (!config.dockerExecution) child.unref();

    if (child.stdin) {
      child.stdin.end();
    }

    // Write PID file for recovery
    const pidFile = join(workspacePath, "agent.pid");
    const pid = child.pid;
    if (pid) {
      logger.debug({ issueId: issue.id, pid, command: command.slice(0, 120), cwd: workspacePath }, "[Agent] Process spawned");
      writeFileSync(pidFile, JSON.stringify({
        pid,
        issueId: issue.id,
        startedAt: new Date(started).toISOString(),
        command: command.slice(0, 200),
      }), "utf8");
    }

    let output = "";
    let timedOut = false;
    let outputBytes = 0;
    let outputHeader = ""; // First 2KB — always contains provider header (model name, etc.)

    const onChunk = (chunk: Buffer | string) => {
      const text = String(chunk);
      if (outputHeader.length < 2000) outputHeader = (outputHeader + text).slice(0, 2000);
      output = appendFileTail(output, text, config.logLinesTail);
      outputBytes += text.length;
      try { appendFileSync(liveLogFile, text); } catch {}
      if (outputFile) { try { appendFileSync(outputFile, text); } catch {} }
      issue.commandOutputTail = output;
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    const AGENT_STALE_OUTPUT_MS = 1_800_000; // 30 minutes without output growth → stuck

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group (detached child + its children)
      if (pid) { try { process.kill(-pid, "SIGTERM"); } catch {} }
      else { child.kill("SIGTERM"); }
    }, config.commandTimeoutMs);

    // Progress watchdog: check PID alive + output growing every 30s
    let lastWatchdogBytes = 0;
    let lastOutputGrowthAt = Date.now();
    let watchdogKilled = false;
    const watchdog = setInterval(() => {
      // Check if PID is still alive
      if (pid) {
        try { process.kill(pid, 0); } catch {
          // PID died without triggering close — force resolve
          clearInterval(watchdog);
          clearTimeout(timer);
          watchdogKilled = true;
          try { rmSync(pidFile, { force: true }); } catch {}
          resolve({ success: false, code: null, output: appendFileTail(output, `\nAgent process died unexpectedly (PID ${pid}).`, config.logLinesTail) });
          return;
        }
      }
      // Check if output is still growing
      if (outputBytes > lastWatchdogBytes) {
        lastWatchdogBytes = outputBytes;
        lastOutputGrowthAt = Date.now();
      } else if (Date.now() - lastOutputGrowthAt > AGENT_STALE_OUTPUT_MS) {
        clearInterval(watchdog);
        clearTimeout(timer);
        timedOut = true;
        watchdogKilled = true;
        if (pid) { try { process.kill(-pid, "SIGTERM"); } catch {} }
        else { child.kill("SIGTERM"); }
        try { rmSync(pidFile, { force: true }); } catch {}
        resolve({ success: false, code: null, output: appendFileTail(output, `\nAgent process stuck — no output for ${Math.round(AGENT_STALE_OUTPUT_MS / 60_000)} minutes.`, config.logLinesTail) });
      }
    }, 30_000);

    const cleanup = () => {
      clearInterval(watchdog);
      try { rmSync(pidFile, { force: true }); } catch {}
    };

    child.on("error", () => {
      clearTimeout(timer);
      cleanup();
      if (watchdogKilled) return;
      resolve({ success: false, code: null, output: `Command execution failed for issue ${issue.id}.` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      if (watchdogKilled) return;
      // Prepend the captured header if it was truncated out of the tail — ensures model name is always extractable
      const buildOutput = (suffix: string) => {
        const tail = appendFileTail(output, suffix, config.logLinesTail);
        return outputHeader.length > 0 && !tail.startsWith(outputHeader.slice(0, 80))
          ? `${outputHeader}\n${tail}`
          : tail;
      };
      if (timedOut) {
        resolve({ success: false, code: null, output: buildOutput(`\nExecution timeout after ${config.commandTimeoutMs}ms.`) });
        return;
      }
      const duration = Math.max(0, Date.now() - started);
      if (code === 0) {
        resolve({ success: true, code, output: buildOutput(`\nExecution succeeded in ${duration}ms.`) });
        return;
      }
      resolve({ success: false, code, output: buildOutput(`\nCommand exit code ${code ?? "unknown"} after ${duration}ms.`) });
    });
  });
}

// ── Daemon socket attachment ──────────────────────────────────────────────────

/**
 * Connect to a running PTY daemon via its Unix socket and monitor it until exit.
 * Used both by runCommandWithTimeout (Fase 2 path) and by recoverOrphans reattach.
 */
export function attachToDaemon(
  socketPath: string,
  workspacePath: string,
  issue: IssueEntry,
  config: RuntimeConfig,
  started: number,
  outputFile?: string,
  resultFile?: string,
): Promise<{ success: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    const daemonExitFile = join(workspacePath, "daemon.exit.json");

    let output = "";
    let outputHeader = "";
    let outputBytes = 0;
    let timedOut = false;
    let resolved = false;
    let sockBuf = "";

    const onChunk = (text: string) => {
      if (outputHeader.length < 2000) outputHeader = (outputHeader + text).slice(0, 2000);
      output = appendFileTail(output, text, config.logLinesTail);
      outputBytes += text.length;
      // live-output.log is written by the daemon directly — skip here to avoid double writes
      if (outputFile) { try { appendFileSync(outputFile, text); } catch {} }
      issue.commandOutputTail = output;
    };

    const buildOutput = (suffix: string) => {
      const tail = appendFileTail(output, suffix, config.logLinesTail);
      return outputHeader.length > 0 && !tail.startsWith(outputHeader.slice(0, 80))
        ? `${outputHeader}\n${tail}`
        : tail;
    };

    const finish = (success: boolean, code: number | null, suffix: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      sock.destroy();
      if (resultFile) { try { rmSync(daemonExitFile, { force: true }); } catch {} }
      resolve({ success, code, output: buildOutput(suffix) });
    };

    const sock = createConnection(socketPath);

    sock.on("connect", () => {
      // Request the current output tail in case we connected after some output
      sock.write(JSON.stringify({ t: "tail" }) + "\n");
    });

    sock.on("data", (chunk) => {
      sockBuf += chunk.toString();
      const lines = sockBuf.split("\n");
      sockBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { t: string; v?: string; c?: number | null; s?: boolean };
          if (msg.t === "d" && typeof msg.v === "string") {
            onChunk(msg.v);
          } else if (msg.t === "tail" && typeof msg.v === "string") {
            // Prefill output with the current tail (avoid requesting full log)
            output = msg.v.slice(-config.logLinesTail * 4);
            if (outputHeader.length === 0) outputHeader = output.slice(0, 2000);
            outputBytes = output.length;
            issue.commandOutputTail = output;
          } else if (msg.t === "x") {
            const exitCode = msg.c ?? null;
            const success = exitCode === 0;
            const duration = Math.max(0, Date.now() - started);
            const suffix = success
              ? `\nExecution succeeded in ${duration}ms.`
              : `\nCommand exit code ${exitCode ?? "unknown"} after ${duration}ms.`;
            finish(success, exitCode, suffix);
          }
        } catch {}
      }
    });

    sock.on("error", (err) => {
      // Socket error — try to recover from daemon.exit.json
      logger.warn({ issueId: issue.id, err: String(err) }, "[Agent] Daemon socket error");
      tryRecoverFromExitFile();
    });

    sock.on("close", () => {
      if (!resolved) tryRecoverFromExitFile();
    });

    const tryRecoverFromExitFile = () => {
      if (resolved) return;
      try {
        const raw = readFileSync(daemonExitFile, "utf8");
        const rec = JSON.parse(raw) as { success: boolean; code: number | null };
        const duration = Math.max(0, Date.now() - started);
        finish(rec.success, rec.code, `\nRecovered from daemon exit record after ${duration}ms.`);
      } catch {
        finish(false, null, "\nDaemon socket closed unexpectedly and no exit record found.");
      }
    };

    const AGENT_STALE_OUTPUT_MS = 1_800_000;
    let lastWatchdogBytes = 0;
    let lastOutputGrowthAt = Date.now();

    const timer = setTimeout(() => {
      timedOut = true;
      sock.write(JSON.stringify({ t: "cancel" }) + "\n");
      finish(false, null, `\nExecution timeout after ${config.commandTimeoutMs}ms.`);
    }, config.commandTimeoutMs);

    const watchdog = setInterval(() => {
      if (outputBytes > lastWatchdogBytes) {
        lastWatchdogBytes = outputBytes;
        lastOutputGrowthAt = Date.now();
      } else if (Date.now() - lastOutputGrowthAt > AGENT_STALE_OUTPUT_MS) {
        sock.write(JSON.stringify({ t: "cancel" }) + "\n");
        finish(false, null, `\nAgent process stuck — no output for ${Math.round(AGENT_STALE_OUTPUT_MS / 60_000)} minutes.`);
      }
      void timedOut; // suppress unused warning
    }, 30_000);
  });
}

// ── Write to daemon ───────────────────────────────────────────────────────────

/**
 * Send text to a running PTY daemon's agent CLI via its Unix socket.
 *
 * Enables injecting slash commands into the active agent session:
 *   - CLI built-ins:  "/usage\r", "/stats session\r", "/status\r"
 *   - Installed skills:  "/insights\r", "/simplify\r", "/frontend-design\r"
 *   - Any installed agent subagent: "/my-agent\r"
 *
 * Text is forwarded verbatim to the PTY stdin — append "\r" to submit, or
 * pass raw characters/escape sequences for special input.
 * Silently no-ops when the daemon socket is absent.
 */
export async function writeToDaemon(workspacePath: string, text: string): Promise<void> {
  const socketPath = join(workspacePath, "agent.sock");
  if (!existsSync(socketPath)) return;
  return new Promise((resolve) => {
    const sock = createConnection(socketPath);
    const cleanup = () => { try { sock.destroy(); } catch {} resolve(); };
    sock.on("connect", () => {
      try { sock.write(JSON.stringify({ t: "write", v: text }) + "\n"); } catch {}
      setImmediate(cleanup);
    });
    sock.on("error", cleanup);
    sock.on("timeout", cleanup);
    sock.setTimeout(3_000);
  });
}

// ── Hook runner ───────────────────────────────────────────────────────────────

export async function runHook(
  command: string,
  workspacePath: string,
  issue: IssueEntry,
  hookName: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  if (!command.trim()) return;

  const result = await runCommandWithTimeout(command, workspacePath, issue, {
    ...HOOK_RUNTIME_CONFIG,
    agentProvider: normalizeAgentProvider(env.FIFONY_AGENT_PROVIDER ?? "codex"),
    agentCommand: command,
  }, "", { FIFONY_HOOK_NAME: hookName, ...extraEnv });

  if (!result.success) {
    throw new Error(`${hookName} hook failed: ${result.output}`);
  }
}
