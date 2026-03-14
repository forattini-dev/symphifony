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

  logger.info("Creating local source snapshot for Symphifo (local-only runtime)...");

  const skipDirs = new Set([
    ".git", ".symphifo", "node_modules", ".venv", "data",
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

export function loadWorkflowDefinition(): WorkflowDefinition {
  const template = WORKFLOW_TEMPLATE
    ? readFileSync(WORKFLOW_TEMPLATE, "utf8")
    : [
        "---",
        "tracker:",
        "  kind: filesystem",
        "workspace:",
        `  root: "${WORKSPACE_ROOT}"`,
        "agent:",
        "  max_concurrent_agents: 2",
        "  max_attempts: 3",
        "codex:",
        '  command: ""',
        "---",
        "",
        "You are working on {{ issue.identifier }}.",
        "",
        "Title: {{ issue.title }}",
        "Description:",
        "{{ issue.description }}",
      ].join("\n");

  const { config, body } = parseFrontMatter(template);
  const normalizedConfig: JsonRecord = {
    ...config,
    tracker: {
      ...getNestedRecord(config, "tracker"),
      kind: "filesystem",
      project_slug: "",
    },
  };

  const rendered = [
    "---",
    stringifyYaml(normalizedConfig).trim(),
    "---",
    "",
    body,
    "",
  ].join("\n");

  const agentConfig = getNestedRecord(normalizedConfig, "agent");
  const agentProvider = normalizeAgentProvider(getNestedString(agentConfig, "provider", "codex"));
  const agentProfile = getNestedString(agentConfig, "profile");
  const resolvedProfile = resolveAgentProfile(agentProfile);
  const agentProviders = resolveWorkflowAgentProviders(normalizedConfig, agentProvider, agentProfile, "");

  writeFileSync(WORKFLOW_RENDERED, rendered, "utf8");

  return {
    workflowPath: WORKFLOW_TEMPLATE || WORKFLOW_RENDERED,
    rendered,
    config: normalizedConfig,
    promptTemplate: body,
    agentProvider,
    agentProfile,
    agentProfilePath: resolvedProfile.profilePath,
    agentProfileInstructions: resolvedProfile.instructions,
    agentProviders,
    afterCreateHook: getNestedString(getNestedRecord(normalizedConfig, "hooks"), "after_create"),
    beforeRunHook: getNestedString(getNestedRecord(normalizedConfig, "hooks"), "before_run"),
    afterRunHook: getNestedString(getNestedRecord(normalizedConfig, "hooks"), "after_run"),
    beforeRemoveHook: getNestedString(getNestedRecord(normalizedConfig, "hooks"), "before_remove"),
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

export function watchWorkflowFile(
  onReload: (definition: WorkflowDefinition) => void,
): void {
  const filePath = WORKFLOW_TEMPLATE;
  if (!filePath || !existsSync(filePath)) return;

  // Unwatch previous if any
  if (workflowWatcher) workflowWatcher();

  watchFile(filePath, { interval: 2000 }, () => {
    try {
      const definition = loadWorkflowDefinition();
      logger.info(`WORKFLOW.md reloaded: ${filePath}`);
      onReload(definition);
    } catch (error) {
      logger.warn(`Failed to reload WORKFLOW.md: ${String(error)}. Keeping last known good config.`);
    }
  });

  workflowWatcher = () => {
    unwatchFile(filePath);
    workflowWatcher = null;
  };

  logger.info(`Watching WORKFLOW.md for changes: ${filePath}`);
}

export function unwatchWorkflowFile(): void {
  if (workflowWatcher) workflowWatcher();
}
