#!/usr/bin/env node
/**
 * fifony-wrap — man-in-the-middle wrapper for CLI agents
 *
 * Protocol:
 *   FIFONY_WRAP_COMMAND      (required) real CLI command to run, e.g. "claude -p $FIFONY_TURN_PROMPT_FILE"
 *   FIFONY_WRAP_BEFORE_HOOK  (optional) shell script run before the CLI; can modify $FIFONY_TURN_PROMPT_FILE in place
 *   FIFONY_WRAP_AFTER_HOOK   (optional) shell script run after the CLI; receives FIFONY_WRAP_OUTPUT_FILE pointing
 *                             to a temp file with the captured output — modify it in place to change what fifony sees
 *
 * Configure via the API, MCP, or s3db — set agentCommand on the workflow config to:
 *   FIFONY_WRAP_COMMAND="claude -p $FIFONY_TURN_PROMPT_FILE" FIFONY_WRAP_BEFORE_HOOK=./hooks/before.sh fifony-wrap
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { env, exit } from "node:process";
import { spawn } from "node:child_process";

function runShell(command: string, extraEnv: Record<string, string> = {}): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: "inherit",
      env: { ...env, ...extraEnv },
    });
    child.on("close", (code) => resolve({ code: code ?? 1 }));
    child.on("error", () => resolve({ code: 1 }));
  });
}

function runAndCapture(command: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += String(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { output += String(chunk); });
    child.on("close", (code) => resolve({ code, output }));
    child.on("error", () => resolve({ code: null, output: `Command execution error: ${command}` }));
  });
}

async function main() {
  const wrapCommand = env.FIFONY_WRAP_COMMAND?.trim();
  if (!wrapCommand) {
    process.stderr.write("fifony-wrap: FIFONY_WRAP_COMMAND is required\n");
    exit(1);
  }

  const workspacePath = env.FIFONY_WORKSPACE_PATH ?? process.cwd();
  const beforeHook = env.FIFONY_WRAP_BEFORE_HOOK?.trim();
  const afterHook = env.FIFONY_WRAP_AFTER_HOOK?.trim();
  const outputFile = join(workspacePath, ".wrap-output.txt");

  if (beforeHook) {
    const { code } = await runShell(beforeHook);
    if (code !== 0) {
      process.stderr.write(`fifony-wrap: before hook exited ${code}\n`);
      exit(code);
    }
  }

  const { code, output } = await runAndCapture(wrapCommand);

  writeFileSync(outputFile, output, "utf8");

  if (afterHook) {
    const { code: hookCode } = await runShell(afterHook, { FIFONY_WRAP_OUTPUT_FILE: outputFile });
    if (hookCode !== 0) {
      process.stderr.write(`fifony-wrap: after hook exited ${hookCode} — using original output\n`);
      writeFileSync(outputFile, output, "utf8");
    }
  }

  let finalOutput = output;
  try {
    finalOutput = readFileSync(outputFile, "utf8");
  } catch {}
  try { rmSync(outputFile, { force: true }); } catch {}

  process.stdout.write(finalOutput);
  exit(code ?? 1);
}

main().catch((err) => {
  process.stderr.write(`fifony-wrap: fatal: ${String(err)}\n`);
  exit(1);
});
