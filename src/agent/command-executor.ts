import {
  appendFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { spawn } from "node:child_process";
import type { IssueEntry, RuntimeConfig } from "./types.ts";
import { appendFileTail } from "./helpers.ts";
import { logger } from "./logger.ts";
import { normalizeAgentProvider } from "./providers.ts";

export async function runCommandWithTimeout(
  command: string,
  workspacePath: string,
  issue: IssueEntry,
  config: RuntimeConfig,
  promptText: string,
  promptFile: string,
  extraEnv: Record<string, string> = {},
): Promise<{ success: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const resultFile = extraEnv.FIFONY_RESULT_FILE;
    if (resultFile && extraEnv.FIFONY_PRESERVE_RESULT_FILE !== "1") {
      rmSync(resultFile, { force: true });
    }

    // Write all FIFONY_* vars to an env file and source it in the command.
    // This avoids E2BIG: child inherits process.env naturally (no ...env spread),
    // and our custom vars are loaded from a file instead of argv/env.
    const allVars: Record<string, string> = {
      FIFONY_ISSUE_ID: issue.id,
      FIFONY_ISSUE_IDENTIFIER: issue.identifier,
      FIFONY_ISSUE_TITLE: issue.title,
      FIFONY_ISSUE_PRIORITY: String(issue.priority),
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

    const envFilePath = join(workspacePath, ".env.sh");
    const envFileLines = Object.entries(allVars)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("\n");
    writeFileSync(envFilePath, envFileLines, "utf8");

    const wrappedCommand = `. "${envFilePath}" && ${command}`;
    const child = spawn(wrappedCommand, {
      shell: true,
      cwd: issue.worktreePath ?? workspacePath,
      detached: true,  // Survive parent death
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Detach from parent so child survives SIGINT/restart
    child.unref();

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
    const liveLogFile = join(workspacePath, "live-output.log");
    writeFileSync(liveLogFile, "", "utf8");

    const onChunk = (chunk: Buffer | string) => {
      const text = String(chunk);
      if (outputHeader.length < 2000) outputHeader = (outputHeader + text).slice(0, 2000);
      output = appendFileTail(output, text, config.logLinesTail);
      outputBytes += text.length;
      try { appendFileSync(liveLogFile, text); } catch {}
      issue.commandOutputTail = output;
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    const AGENT_STALE_OUTPUT_MS = 300_000; // 5 minutes without output growth → stuck

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

export async function runHook(
  command: string,
  workspacePath: string,
  issue: IssueEntry,
  hookName: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  if (!command.trim()) return;

  const result = await runCommandWithTimeout(command, workspacePath, issue, {
    pollIntervalMs: 0,
    workerConcurrency: 1,
    maxConcurrentByState: {},
    commandTimeoutMs: 300_000,
    maxAttemptsDefault: 1,
    retryDelayMs: 0,
    staleInProgressTimeoutMs: 0,
    logLinesTail: 12_000,
    agentProvider: normalizeAgentProvider(env.FIFONY_AGENT_PROVIDER ?? "codex"),
    agentCommand: command,
    maxTurns: 1,
    runMode: "filesystem",
  }, "", "", { FIFONY_HOOK_NAME: hookName, ...extraEnv });

  if (!result.success) {
    throw new Error(`${hookName} hook failed: ${result.output}`);
  }
}
