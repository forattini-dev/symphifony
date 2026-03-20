import { spawn } from "node:child_process";
import { cwd, env, execPath, exit, kill, pid } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createCLI, type CommandParseResult } from "cli-args-parser";
import {
  getReferenceRepositoriesRoot,
  importReferenceArtifacts,
  listReferenceRepositories,
  syncReferenceRepositories,
  type ReferenceImportSummary,
  type ReferenceImportKind,
  type ReferenceSyncResult,
} from "./domains/project.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
  name?: string;
  version?: string;
  description?: string;
};
// Prefer compiled dist/ if available, fallback to tsx + source
const distRuntime = resolve(packageRoot, "dist", "agent", "run-local.js");
const distMcp = resolve(packageRoot, "dist", "mcp", "server.js");
const srcRuntime = resolve(packageRoot, "src", "boot.ts");
const srcMcp = resolve(packageRoot, "src", "mcp", "server.ts");

import { existsSync } from "node:fs";
const forceSource = process.argv.includes("--dev") || env.NODE_ENV === "development";
const useCompiled = !forceSource && existsSync(distRuntime);

let tsxCli: string | null = null;
if (!useCompiled) {
  try { tsxCli = require.resolve("tsx/cli"); } catch {
    console.error("No compiled dist/ found and tsx is not installed. Run 'pnpm build' first.");
    exit(1);
  }
}

const runtimeScript = useCompiled ? distRuntime : srcRuntime;
const mcpScript = useCompiled ? distMcp : srcMcp;

const commonOptions = {
  workspace: {
    type: "string",
    description: "Target workspace root. Defaults to the current directory.",
  },
  persistence: {
    type: "string",
    description: "Persistence root. Defaults to the current directory.",
  },
  port: {
    type: "number",
    aliases: ["-p"],
    description: "Start the local API/dashboard on the provided port.",
    default: 4000,
  },
  concurrency: {
    type: "number",
    description: "Maximum number of concurrent workers.",
  },
  attempts: {
    type: "number",
    description: "Maximum attempts per issue.",
  },
  poll: {
    type: "number",
    description: "Scheduler interval in milliseconds.",
  },
  once: {
    type: "boolean",
    description: "Process one scheduler cycle and exit.",
    default: false,
  },
} as const;

function getStringOption(result: CommandParseResult, key: string): string | undefined {
  const value = result.options[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getNumberOption(result: CommandParseResult, key: string): number | undefined {
  const value = result.options[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getBooleanOption(result: CommandParseResult, key: string): boolean {
  return result.options[key] === true;
}

function parseReferenceKind(value: unknown): ReferenceImportKind {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "all";
  if (normalized === "all") return "all";
  if (normalized === "agents" || normalized === "agent") return "agents";
  if (normalized === "skills" || normalized === "skill") return "skills";
  throw new Error(`Invalid kind: ${normalized}. Expected all, agents, or skills.`);
}

function getWorkspaceRoot(result: CommandParseResult): string {
  const workspace = getStringOption(result, "workspace");
  return resolve(workspace ?? env.FIFONY_WORKSPACE_ROOT ?? cwd());
}

async function runOnboardingList(): Promise<void> {
  const root = getReferenceRepositoriesRoot();
  const repositories = listReferenceRepositories();

  console.log("Reference repositories:");
  console.log(`Storage: ${root}`);
  console.log("");

  for (const repository of repositories) {
    const status = repository.synced
      ? repository.branch
        ? `synced (${repository.branch})`
        : "synced"
      : repository.present
        ? `present — ${repository.error ?? "not synced"}`
        : "not found";

    console.log(`- ${repository.id}`);
    console.log(`  name: ${repository.name}`);
    console.log(`  url:  ${repository.url}`);
    console.log(`  path: ${repository.path}`);
    console.log(`  status: ${status}`);
    if (repository.remote) {
      console.log(`  remote: ${repository.remote}`);
    }
    console.log("");
  }
}

async function runOnboardingSync(result: CommandParseResult): Promise<void> {
  const repositoryFilter = getStringOption(result, "repository");
  let syncTarget: ReferenceSyncResult[];
  try {
    syncTarget = repositoryFilter
      ? syncReferenceRepositories(repositoryFilter)
      : syncReferenceRepositories();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
    return;
  }

  const succeeded: ReferenceSyncResult[] = [];
  const failed: ReferenceSyncResult[] = [];

  for (const item of syncTarget) {
    if (item.action === "failed") {
      failed.push(item);
    } else {
      succeeded.push(item);
    }

    if (item.action === "failed") {
      console.log(`✗ ${item.id}: ${item.message}`);
    } else if (item.action === "cloned") {
      console.log(`+ ${item.id}: ${item.message}`);
    } else {
      console.log(`↻ ${item.id}: ${item.message}`);
    }
  }

  if (failed.length > 0) {
    console.log("");
    console.log(`${succeeded.length} repository(ies) synced, ${failed.length} failed.`);
    console.log("Run onboarding sync with a direct repository to retry failed items.");
    exit(1);
  }

  console.log("");
  console.log(`Done: ${succeeded.length} repository(ies) synced.`);
}

async function runOnboardingImport(result: CommandParseResult): Promise<void> {
  const repository = typeof result.positional?.repository === "string" ? result.positional.repository : "";
  let kind: ReferenceImportKind;
  try {
    kind = parseReferenceKind(result.options.kind);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
    return;
  }
  const overwrite = getBooleanOption(result, "overwrite");
  const dryRun = getBooleanOption(result, "dryRun");
  const importToGlobal = getBooleanOption(result, "global");
  const workspaceRoot = getWorkspaceRoot(result);

  if (!repository) {
    console.error("Repository argument is required.");
    exit(1);
  }

  let summary: ReferenceImportSummary;
  try {
    summary = importReferenceArtifacts(repository, workspaceRoot, {
      kind,
      overwrite,
      dryRun,
      importToGlobal,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    exit(1);
    return;
  }

  const targetLabel = importToGlobal ? "global ~/.codex" : `${workspaceRoot}/.codex`;

  if (dryRun) {
    console.log(`Dry run active. No files were written.`);
  }
  console.log(`Reference repository: ${summary.repositoryId}`);
  console.log(`Source: ${summary.localPath}`);
  console.log(`Target: ${targetLabel}`);
  console.log(`Kind: ${summary.requestedKind}`);
  console.log(`Imported agents: ${summary.importedAgents.length}`);
  console.log(`Imported skills: ${summary.importedSkills.length}`);
  console.log(`Skipped agents: ${summary.skippedAgents.length}`);
  console.log(`Skipped skills: ${summary.skippedSkills.length}`);

  if (summary.errors.length > 0) {
    console.log("");
    console.log("Errors:");
    for (const item of summary.errors) {
      console.log(`- ${item.kind}/${item.targetName}: ${item.error}`);
    }
    exit(1);
  }

  if (summary.importedAgents.length + summary.importedSkills.length === 0) {
    console.log("Nothing to import. Run onboarding sync first if the repository was not downloaded.");
    return;
  }
}

function buildRuntimeArgs(result: CommandParseResult): string[] {
  const runtimeArgs: string[] = [];
  const workspace = getStringOption(result, "workspace");
  const persistence = getStringOption(result, "persistence");
  const port = getNumberOption(result, "port");
  const concurrency = getNumberOption(result, "concurrency");
  const attempts = getNumberOption(result, "attempts");
  const poll = getNumberOption(result, "poll");

  if (workspace) {
    runtimeArgs.push("--workspace", workspace);
  }
  if (persistence) {
    runtimeArgs.push("--persistence", persistence);
  }
  if (typeof port === "number") {
    runtimeArgs.push("--port", String(port));
  }
  if (typeof concurrency === "number") {
    runtimeArgs.push("--concurrency", String(concurrency));
  }
  if (typeof attempts === "number") {
    runtimeArgs.push("--attempts", String(attempts));
  }
  if (typeof poll === "number") {
    runtimeArgs.push("--poll", String(poll));
  }
  if (getBooleanOption(result, "once")) {
    runtimeArgs.push("--once");
  }
  if (forceSource) {
    runtimeArgs.push("--dev");
  }

  return runtimeArgs;
}

async function runRuntime(mode: "cli" | "mcp", result: CommandParseResult): Promise<void> {
  const workspace = getStringOption(result, "workspace");
  const workspaceRoot = resolve(workspace ?? env.FIFONY_WORKSPACE_ROOT ?? cwd());
  const runtimeArgs = buildRuntimeArgs(result);

  const outcome = await new Promise<{ code?: number | null; signal?: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
    const args = useCompiled ? [runtimeScript, ...runtimeArgs] : [tsxCli!, runtimeScript, ...runtimeArgs];
    const child = spawn(execPath, args, {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: {
        ...env,
        FIFONY_INTERFACE: mode,
        FIFONY_WORKSPACE_ROOT: workspaceRoot,
      },
    });

    child.on("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });
  });

  if (outcome.signal) {
    kill(pid, outcome.signal);
    return;
  }

  if (typeof outcome.code === "number" && outcome.code !== 0) {
    exit(outcome.code);
  }
}

async function runMcpServer(result: CommandParseResult): Promise<void> {
  const workspace = getStringOption(result, "workspace");
  const persistence = getStringOption(result, "persistence");
  const workspaceRoot = resolve(workspace ?? env.FIFONY_WORKSPACE_ROOT ?? cwd());
  const persistenceRoot = resolve(persistence ?? env.FIFONY_PERSISTENCE ?? workspaceRoot);

  const outcome = await new Promise<{ code?: number | null; signal?: NodeJS.Signals | null }>((resolvePromise, rejectPromise) => {
    const mcpArgs = useCompiled ? [mcpScript] : [tsxCli!, mcpScript];
    const child = spawn(execPath, mcpArgs, {
      cwd: workspaceRoot,
      stdio: "inherit",
      env: {
        ...env,
        FIFONY_WORKSPACE_ROOT: workspaceRoot,
        FIFONY_PERSISTENCE: persistenceRoot,
      },
    });

    child.on("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });

    child.on("error", (error) => {
      rejectPromise(error);
    });
  });

  if (outcome.signal) {
    kill(pid, outcome.signal);
    return;
  }

  if (typeof outcome.code === "number" && outcome.code !== 0) {
    exit(outcome.code);
  }
}

const cli = createCLI({
  name: packageJson.name ?? "fifony",
  version: packageJson.version ?? "0.0.0",
  description: packageJson.description ?? "Filesystem-backed local multi-agent orchestrator.",
  commands: {
    run: {
      description: "Run the local Fifony runtime with dashboard/API (default port 4000).",
      options: commonOptions,
      handler: (result) => runRuntime("cli", result),
    },
    mcp: {
      description: "Run a Fifony MCP server over stdio with resources, tools, and prompts backed by the local durable store.",
      options: commonOptions,
      handler: (result) => runMcpServer(result),
    },
    onboarding: {
      description: "Manage reference repositories and import agents/skills from them.",
      aliases: ["onboard"],
      commands: {
        list: {
          description: "List reference repositories and local sync status.",
          handler: () => runOnboardingList(),
        },
        sync: {
          description: "Clone/update reference repositories into ~/.fifony/repositories.",
          options: {
            repository: {
              short: "r",
              type: "string",
              description: "Sync only this repository by id or URL.",
            },
          },
          handler: (result) => runOnboardingSync(result),
        },
        import: {
          description: "Import agents/skills from a synced reference repository.",
          aliases: ["integrate"],
          positional: [
            {
              name: "repository",
              type: "string",
              required: true,
              description: "Repository id or URL",
            },
          ],
          options: {
            kind: {
              short: "k",
              type: "string",
              default: "all",
              description: "What to import: agents, skills, or all (default: all).",
            },
            overwrite: {
              type: "boolean",
              description: "Overwrite existing local files.",
            },
            dryRun: {
              type: "boolean",
              description: "Show what would be imported without writing files.",
            },
            global: {
              type: "boolean",
              description: "Import into ~/.codex instead of workspace .codex.",
            },
          },
          handler: (result) => runOnboardingImport(result),
        },
      },
    },
  },
});

function normalizeArgs(rawArgs: string[]): string[] {
  if (rawArgs.length === 0) {
    return ["run"];
  }

  const first = rawArgs[0];
  if (["--help", "-h", "help", "--version", "-v", "version"].includes(first)) {
    return rawArgs;
  }

  if (first.startsWith("-")) {
    return ["run", ...rawArgs];
  }

  return rawArgs;
}

const args = normalizeArgs(process.argv.slice(2));

// Handle help explicitly since cli-args-parser doesn't auto-detect it
const firstArg = args[0];
if (firstArg === "help" || firstArg === "--help" || firstArg === "-h") {
  console.log(cli.help());
} else {
  cli.run(args).catch((error) => {
    console.error(`Failed to start fifony CLI: ${String(error)}`);
    exit(1);
  });
}
