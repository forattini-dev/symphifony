import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env, argv, cwd as getCwd } from "node:process";
import { homedir } from "node:os";
import type { IssueState } from "./types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const PACKAGE_ROOT = resolve(__dirname, "../..");
export const CLI_ARGS = argv.slice(2);

export function readArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

export function resolveInputPath(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

export function resolvePersistenceRoot(value: string): string {
  const resolved = value.startsWith("file://")
    ? fileURLToPath(value)
    : resolveInputPath(value);

  return basename(resolved) === ".symphifo"
    ? resolved
    : join(resolved, ".symphifo");
}

const CLI_WORKSPACE_ROOT = readArgValue(CLI_ARGS, "--workspace");
const CLI_PERSISTENCE = readArgValue(CLI_ARGS, "--persistence");

export const TARGET_ROOT = resolveInputPath(
  env.SYMPHIFO_WORKSPACE_ROOT ?? CLI_WORKSPACE_ROOT ?? getCwd(),
);

export const TRACKER_KIND = env.SYMPHIFO_TRACKER_KIND ?? "filesystem";

export const STATE_ROOT = resolvePersistenceRoot(
  env.SYMPHIFO_PERSISTENCE
    ?? CLI_PERSISTENCE
    ?? env.SYMPHIFO_BOOTSTRAP_ROOT
    ?? TARGET_ROOT,
);

export const SOURCE_ROOT = `${STATE_ROOT}/source`;
export const WORKSPACE_ROOT = `${STATE_ROOT}/workspaces`;
export const SOURCE_MARKER = `${SOURCE_ROOT}/.symphifo-local-source-ready`;

export const WORKFLOW_TEMPLATE = existsSync(join(TARGET_ROOT, "WORKFLOW.md"))
  ? join(TARGET_ROOT, "WORKFLOW.md")
  : existsSync(join(PACKAGE_ROOT, "WORKFLOW.md"))
    ? join(PACKAGE_ROOT, "WORKFLOW.md")
    : "";

export const WORKFLOW_RENDERED = `${STATE_ROOT}/WORKFLOW.local.md`;

export const S3DB_DATABASE_PATH = `${STATE_ROOT}/s3db`;
export const S3DB_BUCKET = env.SYMPHIFO_STORAGE_BUCKET ?? "symphifo";
export const S3DB_KEY_PREFIX = env.SYMPHIFO_STORAGE_KEY_PREFIX ?? "state";

export const S3DB_RUNTIME_RESOURCE = "runtime_state";
export const S3DB_ISSUE_RESOURCE = "issues";
export const S3DB_EVENT_RESOURCE = "events";
export const S3DB_AGENT_SESSION_RESOURCE = "agent_sessions";
export const S3DB_AGENT_PIPELINE_RESOURCE = "agent_pipelines";
export const S3DB_RUNTIME_RECORD_ID = "current";
export const S3DB_RUNTIME_SCHEMA_VERSION = 1;

export const DEFAULT_ISSUES_TEMPLATE = `${PACKAGE_ROOT}/src/fixtures/local-issues.json`;
export const LOCAL_ISSUES_FILE = resolveInputPath(
  env.SYMPHIFO_ISSUES_FILE ?? join(STATE_ROOT, "issues.json"),
);

export const FRONTEND_DIR = `${PACKAGE_ROOT}/src/dashboard`;
export const FRONTEND_INDEX = `${FRONTEND_DIR}/index.html`;
export const FRONTEND_APP_JS = `${FRONTEND_DIR}/app.js`;
export const FRONTEND_STYLES_CSS = `${FRONTEND_DIR}/styles.css`;

export const DEBUG_BOOT = env.SYMPHIFO_DEBUG_BOOT === "1";

export const ALLOWED_STATES: IssueState[] = [
  "Todo",
  "In Progress",
  "In Review",
  "Blocked",
  "Done",
  "Cancelled",
];

export const TERMINAL_STATES = new Set<IssueState>(["Done", "Cancelled"]);
export const EXECUTING_STATES = new Set<IssueState>(["In Progress", "In Review"]);
export const PERSIST_EVENTS_MAX = 500;
