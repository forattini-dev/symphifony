#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { cwd, env, exit, argv } from "node:process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "..");
const workspaceRoot = env.FIFONY_WORKSPACE_ROOT ?? cwd();

const distCli = resolve(packageRoot, "dist", "cli.js");
const srcCli = resolve(packageRoot, "src", "cli.ts");
const forceSource = argv.includes("--dev") || env.NODE_ENV === "development";
const useCompiled = !forceSource && existsSync(distCli);

if (useCompiled) {
  // Production: run compiled JS directly
  process.env.FIFONY_WORKSPACE_ROOT = workspaceRoot;
  import(distCli).catch((error) => {
    console.error(`Failed to start fifony: ${String(error)}`);
    exit(1);
  });
} else {
  // Development: use tsx to run TypeScript source
  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { execPath } = await import("node:process");
  const require = createRequire(import.meta.url);

  let tsxCli;
  try {
    tsxCli = require.resolve("tsx/cli");
  } catch {
    console.error("No compiled dist/ found and tsx is not installed. Run 'pnpm build' first.");
    exit(1);
  }

  const child = spawn(execPath, [tsxCli, srcCli, ...argv.slice(2)], {
    cwd: workspaceRoot,
    stdio: "inherit",
    env: { ...env, FIFONY_WORKSPACE_ROOT: workspaceRoot },
  });

  child.on("exit", (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return; }
    exit(code ?? 1);
  });

  child.on("error", (error) => {
    console.error(`Failed to start fifony CLI: ${String(error)}`);
    exit(1);
  });
}
