#!/usr/bin/env node
/**
 * PTY Daemon — detached subprocess that holds the PTY master for an agent CLI.
 *
 * Spawned by command-executor.ts with detached: true + stdio: 'ignore'.
 * Survives parent (fifony) crashes. Writes all output to live-output.log.
 * Exposes a Unix socket (agent.sock) for the parent to monitor and cancel.
 *
 * Socket protocol: newline-delimited JSON (NDJSON)
 *   Server → Client:
 *     { "t": "d", "v": "<chunk>" }          output chunk
 *     { "t": "x", "c": 0, "s": true }       process exited (code, success)
 *   Client → Server:
 *     { "t": "cancel" }                      kill the agent process
 *     { "t": "tail" }                        request current output tail
 *
 * Invocation:
 *   node pty-daemon.js '<JSON options>'
 *
 * Options (JSON):
 *   command        Full shell command to run (already has env file sourced)
 *   workspacePath  Workspace directory
 *   issueId        Issue ID (for PID file metadata)
 *   startedAt      ISO timestamp of when execution started
 *   commandSlice   First 200 chars of the original command (for PID file)
 */

import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import type { Socket } from "node:net";

interface DaemonOptions {
  command: string;
  workspacePath: string;
  /** Git worktree path — used as CWD for the CLI. Falls back to workspacePath if absent. */
  codePath?: string;
  issueId: string;
  startedAt: string;
  commandSlice: string;
}

interface DaemonExitRecord {
  success: boolean;
  code: number | null;
  outputPath: string;
  completedAt: string;
}

function appendTail(current: string, text: string, maxChars: number): string {
  const combined = current + text;
  return combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) {
    process.stderr.write("[pty-daemon] Missing options argument\n");
    process.exit(1);
  }

  let opts: DaemonOptions;
  try {
    opts = JSON.parse(raw) as DaemonOptions;
  } catch {
    process.stderr.write("[pty-daemon] Failed to parse options JSON\n");
    process.exit(1);
  }

  const { command, workspacePath, codePath, issueId, startedAt, commandSlice } = opts;
  const effectiveCwd = codePath ?? workspacePath;

  const liveLogFile = join(workspacePath, "live-output.log");
  const socketPath = join(workspacePath, "agent.sock");
  const agentPidFile = join(workspacePath, "agent.pid");
  const daemonPidFile = join(workspacePath, "daemon.pid");
  const daemonExitFile = join(workspacePath, "daemon.exit.json");

  // Write daemon PID immediately so the parent can check we started
  writeFileSync(daemonPidFile, String(process.pid), "utf8");
  writeFileSync(liveLogFile, "", "utf8");

  // Cleanup on exit — remove socket and daemon PID
  const cleanupFiles = () => {
    try { rmSync(socketPath, { force: true }); } catch {}
    try { rmSync(daemonPidFile, { force: true }); } catch {}
  };
  process.on("exit", cleanupFiles);
  process.on("SIGTERM", () => { cleanupFiles(); process.exit(0); });
  process.on("SIGINT", () => { cleanupFiles(); process.exit(0); });

  // Start Unix socket server before spawning PTY, so clients can connect immediately
  const clients = new Set<Socket>();
  let outputTail = "";
  const OUTPUT_RING_CHARS = 300_000; // ~300KB ring buffer for reattach

  const MAX_LOG_BYTES = 10 * 1024 * 1024;    // rotate when file reaches 10MB
  const TARGET_LOG_BYTES = 5 * 1024 * 1024;  // keep last 5MB after rotation
  let bytesWritten = 0;

  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { t: string };
          if (msg.t === "cancel") {
            try { ptyProcess.kill(); } catch {}
          } else if (msg.t === "tail") {
            const reply = JSON.stringify({ t: "tail", v: outputTail }) + "\n";
            try { socket.write(reply); } catch {}
          } else if (msg.t === "write" && typeof (msg as { t: string; v?: string }).v === "string") {
            // Forward text directly to the agent CLI's PTY stdin
            // Enables slash commands: /usage, /stats, /insights, /frontend-design, etc.
            try { ptyProcess.write((msg as { t: string; v: string }).v); } catch {}
          }
        } catch {}
      }
    });
  });

  // Remove stale socket from previous run
  try { rmSync(socketPath, { force: true }); } catch {}
  server.listen(socketPath);

  // Spawn the agent CLI via PTY
  const nodePty = await import("node-pty");
  const ptyProcess = nodePty.spawn("sh", ["-c", command], {
    name: "xterm-256color",
    cols: 220,
    rows: 50,
    cwd: effectiveCwd,
    env: process.env as Record<string, string>,
  });

  // Write agent PID file so fifony can track it
  const agentPid = ptyProcess.pid;
  if (agentPid) {
    writeFileSync(agentPidFile, JSON.stringify({
      pid: agentPid,
      issueId,
      startedAt,
      command: commandSlice,
    }), "utf8");
  }

  const broadcast = (msg: string) => {
    for (const client of clients) {
      try { client.write(msg); } catch { clients.delete(client); }
    }
  };

  ptyProcess.onData((data) => {
    outputTail = appendTail(outputTail, data, OUTPUT_RING_CHARS);
    const encoded = Buffer.from(data);
    try { appendFileSync(liveLogFile, encoded); } catch {}
    bytesWritten += encoded.length;
    // Rotate: when file hits 10MB, keep only the last 5MB
    if (bytesWritten >= MAX_LOG_BYTES) {
      try {
        const content = readFileSync(liveLogFile);
        if (content.length > TARGET_LOG_BYTES) {
          writeFileSync(liveLogFile, content.slice(content.length - TARGET_LOG_BYTES));
        }
      } catch {}
      bytesWritten = 0;
    }
    broadcast(JSON.stringify({ t: "d", v: data }) + "\n");
  });

  ptyProcess.onExit(({ exitCode }) => {
    const success = exitCode === 0;

    // Write daemon exit record so fifony can recover the result after a crash
    const exitRecord: DaemonExitRecord = {
      success,
      code: exitCode ?? null,
      outputPath: liveLogFile,
      completedAt: new Date().toISOString(),
    };
    try { writeFileSync(daemonExitFile, JSON.stringify(exitRecord, null, 2), "utf8"); } catch {}

    // Notify connected clients
    broadcast(JSON.stringify({ t: "x", c: exitCode ?? null, s: success }) + "\n");

    // Clean up agent PID file
    try { rmSync(agentPidFile, { force: true }); } catch {}

    // Give clients 2 seconds to receive the exit message, then shut down
    setTimeout(() => {
      server.close();
      for (const client of clients) { try { client.destroy(); } catch {} }
      process.exit(0);
    }, 2000);
  });
}

main().catch((err) => {
  process.stderr.write(`[pty-daemon] Fatal: ${String(err)}\n`);
  process.exit(1);
});
