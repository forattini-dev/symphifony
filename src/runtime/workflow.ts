import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, watchFile, unwatchFile } from "node:fs";
import { extname, join } from "node:path";
import { env, argv, exit } from "node:process";
import { stringify as stringifyYaml } from "yaml";
import type { JsonRecord, WorkflowDefinition } from "./types.ts";
import {
  PACKAGE_ROOT,
  SOURCE_ROOT,
  SOURCE_MARKER,
  TARGET_ROOT,
  WORKFLOW_TEMPLATE,
  WORKFLOW_RENDERED,
  WORKSPACE_ROOT,
} from "./constants.ts";
import {
  now,
  parseFrontMatter,
  getNestedRecord,
  getNestedString,
  fail,
  parseIntArg,
} from "./helpers.ts";
import { logger } from "./logger.ts";
import {
  normalizeAgentProvider,
  resolveAgentProfile,
  resolveWorkflowAgentProviders,
} from "./providers.ts";

export function bootstrapSource(): void {
  if (existsSync(SOURCE_MARKER)) return;

  logger.info("Creating local source snapshot for Fifony (local-only runtime)...");

  const skipDirs = new Set([
    ".git", ".fifony", "node_modules", ".venv", "data",
    "dist", "build", ".turbo", ".next", ".nuxt", ".tanstack",
    "coverage", "artifacts", "captures", "tmp", "temp",
  ]);

  const shouldSkip = (relativePath: string): boolean => {
    const parts = relativePath.split("/");
    if (parts.some((segment) => skipDirs.has(segment))) return true;
    const base = relativePath.split("/").at(-1) ?? "";
    if (base.startsWith("map_scan_") && extname(base) === ".json") return true;
    if (extname(base) === ".xlsx") return true;
    return false;
  };

  const copyRecursive = (source: string, target: string, rel = "") => {
    mkdirSync(target, { recursive: true });
    const items = readdirSync(source, { withFileTypes: true });

    for (const item of items) {
      const nextRel = rel ? `${rel}/${item.name}` : item.name;
      if (shouldSkip(nextRel)) continue;

      const sourcePath = `${source}/${item.name}`;
      const targetPath = `${target}/${item.name}`;
      const itemStat = statSync(sourcePath);

      if (item.isDirectory()) {
        copyRecursive(sourcePath, targetPath, nextRel);
        continue;
      }

      if (item.isSymbolicLink() || itemStat.isSymbolicLink()) continue;

      if (itemStat.isFile() || itemStat.isFIFO()) {
        try {
          const file = readFileSync(sourcePath);
          writeFileSync(targetPath, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            logger.debug(`Skipped missing source file: ${sourcePath}`);
          } else {
            throw error;
          }
        }
      }
    }
  };

  mkdirSync(SOURCE_ROOT, { recursive: true });
  copyRecursive(TARGET_ROOT, SOURCE_ROOT);
  writeFileSync(SOURCE_MARKER, `${now()}\n`, "utf8");
}

/**
 * Returns an empty WorkflowDefinition.
 * WORKFLOW.md is no longer supported — all configuration lives in s3db settings
 * (Settings → Workflow in the dashboard).
 */
export function loadWorkflowDefinition(): WorkflowDefinition {
  const defaultPrompt = [
    "You are working on {{ issue.identifier }}.",
    "",
    "Title: {{ issue.title }}",
    "Description:",
    "{{ issue.description }}",
  ].join("\n");

  return {
    workflowPath: "",
    rendered: "",
    config: {},
    promptTemplate: defaultPrompt,
    agentProvider: "codex",
    agentProfile: "",
    agentProfilePath: "",
    agentProfileInstructions: "",
    agentProviders: [],
    afterCreateHook: "",
    beforeRunHook: "",
    afterRunHook: "",
    beforeRemoveHook: "",
  };
}

export function parsePort(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: ${argv[1]} [options]\n` +
        "Options:\n" +
        "  --port <n>             Start local dashboard (default: no UI and single batch run)\n" +
        "  --workspace <path>     Target workspace root (default: current directory)\n" +
        "  --persistence <path>   Persistence root (default: current directory)\n" +
        "  --concurrency <n>      Maximum number of parallel issue runners\n" +
        "  --attempts <n>         Maximum attempts per issue\n" +
        "  --poll <ms>            Polling interval for the scheduler\n" +
        "  --once                  Run one local batch and exit\n" +
        "  --help                  Show this message",
      );
      exit(0);
    }

    if (arg === "--port") {
      const value = args[i + 1];
      if (!value || !/^\d+$/.test(value)) {
        fail(`Invalid value for --port: ${value ?? "<empty>"}`);
      }
      return parseIntArg(value, 4040);
    }
  }

  return undefined;
}

// ── Dynamic WORKFLOW.md reload ───────────────────────────────────────────────

let workflowWatcher: (() => void) | null = null;

/**
 * No-op — WORKFLOW.md watching is deprecated.
 * Configuration is now managed via s3db settings.
 */
export function watchWorkflowFile(
  _onReload: (definition: WorkflowDefinition) => void,
): void {
  // No-op: WORKFLOW.md is no longer used
}

export function unwatchWorkflowFile(): void {
  if (workflowWatcher) workflowWatcher();
}
