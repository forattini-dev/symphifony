import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env, argv, cwd as getCwd } from "node:process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { IssueState } from "../types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Walk up from the compiled chunk to find the package root (where package.json lives).
// In dev: __dirname = src/concerns → ../../ = package root
// In prod: __dirname = dist/ (chunk) or dist/agent (entry) → walk up until package.json
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, "../..");
}

export const PACKAGE_ROOT = findPackageRoot(__dirname);
export const CLI_ARGS = argv.slice(2);

function readArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function resolveInputPath(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

export function resolvePersistenceRoot(value: string): string {
  const resolved = value.startsWith("file://")
    ? fileURLToPath(value)
    : resolveInputPath(value);

  return basename(resolved) === ".fifony"
    ? resolved
    : join(resolved, ".fifony");
}

const CLI_WORKSPACE_ROOT = readArgValue(CLI_ARGS, "--workspace");
const CLI_PERSISTENCE = readArgValue(CLI_ARGS, "--persistence");

export const TARGET_ROOT = resolveInputPath(
  env.FIFONY_WORKSPACE_ROOT ?? CLI_WORKSPACE_ROOT ?? getCwd(),
);

export const STATE_ROOT = resolvePersistenceRoot(
  env.FIFONY_PERSISTENCE
    ?? CLI_PERSISTENCE
    ?? env.FIFONY_BOOTSTRAP_ROOT
    ?? TARGET_ROOT,
);

export const SOURCE_ROOT = `${STATE_ROOT}/source`;
export const WORKSPACE_ROOT = `${STATE_ROOT}/workspaces`;
export const SOURCE_MARKER = `${SOURCE_ROOT}/.fifony-local-source-ready`;

export const ATTACHMENTS_ROOT = `${STATE_ROOT}/attachments`;
export const WIKI_ROOT = `${STATE_ROOT}/wiki`;
export const BLUEPRINT_ARTIFACTS_DIRNAME = ".fifony-blueprint";

export const S3DB_DATABASE_PATH = `${STATE_ROOT}/fifony.sqlite`;

export const S3DB_RUNTIME_RESOURCE = "runtime_state";
export const S3DB_ISSUE_RESOURCE = "issues";
export const S3DB_MILESTONE_RESOURCE = "milestones";
export const S3DB_ISSUE_PLAN_RESOURCE = "issue_plans";
export const S3DB_EVENT_RESOURCE = "events";
export const S3DB_SETTINGS_RESOURCE = "settings";
export const S3DB_AGENT_SESSION_RESOURCE = "agent_sessions";
export const S3DB_AGENT_PIPELINE_RESOURCE = "agent_pipelines";
export const S3DB_SERVICES_RESOURCE = "workspace_services";
export const S3DB_VARIABLES_RESOURCE = "workspace_variables";
export const S3DB_CONTEXT_FRAGMENT_RESOURCE = "context_fragments";
export const S3DB_RUNTIME_RECORD_ID = "current";
export const S3DB_RUNTIME_SCHEMA_VERSION = 1;
export const EMBEDDING_VECTOR_DIMENSIONS = 384;
export const GLOBAL_FIFONY_ROOT = resolvePersistenceRoot(
  env.FIFONY_GLOBAL_ROOT
    ?? join(homedir(), ".fifony"),
);
export const LEGACY_WORKSPACE_EMBEDDING_CACHE_DIR = resolveInputPath(
  join(STATE_ROOT, "models", "embeddings"),
);
export const EMBEDDING_LOCAL_CACHE_DIR = resolveInputPath(
  env.FIFONY_EMBEDDINGS_CACHE_DIR
    ?? join(GLOBAL_FIFONY_ROOT, "models", "embeddings"),
);

export const FRONTEND_DIR = `${PACKAGE_ROOT}/app/dist`;
export const FRONTEND_INDEX = `${FRONTEND_DIR}/index.html`;
export const FRONTEND_MANIFEST_JSON = `${FRONTEND_DIR}/manifest.webmanifest`;
export const FRONTEND_SERVICE_WORKER_JS = `${FRONTEND_DIR}/service-worker.js`;
export const FRONTEND_ICON_SVG = `${FRONTEND_DIR}/icon.svg`;
export const FRONTEND_MASKABLE_ICON_SVG = `${FRONTEND_DIR}/icon-maskable.svg`;
export const FRONTEND_OFFLINE_HTML = `${FRONTEND_DIR}/offline.html`;

export const DEBUG_BOOT = env.FIFONY_DEBUG_BOOT === "1";

export const ALLOWED_STATES: IssueState[] = [
  "Planning",
  "PendingApproval",
  "Queued",
  "Running",
  "Reviewing",
  "PendingDecision",
  "Blocked",
  "Approved",
  "Merged",
  "Cancelled",
  "Archived",
];

/** Truly final — workspace can be cleaned, no more work expected. */
export const TERMINAL_STATES = new Set<IssueState>(["Merged", "Cancelled", "Archived"]);
/** Approved or final — no more automated work, but merge may still be pending. */
export const COMPLETED_STATES = new Set<IssueState>(["Approved", "Merged", "Cancelled", "Archived"]);
export const EXECUTING_STATES = new Set<IssueState>(["Running", "Reviewing"]);
export const PERSIST_EVENTS_MAX = 500;

/** Default max automated review→requeue cycles before escalating to human */
export const DEFAULT_MAX_REVIEW_AUTO_RETRIES = 1;

/** Default max turns per execution phase (fallback when no per-mode default applies) */
export const DEFAULT_MAX_TURNS = 20;

/** Per-harness-mode defaults for max agent turns per execution phase */
export const DEFAULT_MAX_TURNS_BY_MODE: Record<string, number> = {
  solo: 10,
  standard: 20,
  contractual: 30,
};

/** Default number of planner↔reviewer negotiation rounds before failing the contract gate */
export const DEFAULT_MAX_CONTRACT_NEGOTIATION_ROUNDS = 2;

/** Maximum context reset (new session with handoff) cycles per execute attempt */
export const DEFAULT_MAX_CONTEXT_RESETS = 2;

/** Context window usage % that triggers an automatic context reset */
export const DEFAULT_CONTEXT_RESET_THRESHOLD_PCT = 85;

/** Default minimum samples before adaptive policy makes routing decisions */
export const DEFAULT_ADAPTIVE_POLICY_MIN_SAMPLES = 3;
export const DEFAULT_BLUEPRINT_ID = "fifony.unattended.v1";
export const DEFAULT_BLUEPRINT_VERSION = 1;
export const DEFAULT_BLUEPRINT_MAX_LOCAL_RETRIES = 2;
export const DEFAULT_BLUEPRINT_MAX_REMOTE_ROUNDS = 1;
export const DEFAULT_BLUEPRINT_MAX_FANOUT = 3;
export const DEFAULT_BLUEPRINT_MAX_WALL_CLOCK_MINUTES = 120;

// ── CLI skip flags ──────────────────────────────────────────────────────────
const FAST_BOOT = CLI_ARGS.includes("--fast-boot");
export const SKIP_SOURCE = FAST_BOOT || CLI_ARGS.includes("--skip-source");
export const SKIP_SCAN = FAST_BOOT || CLI_ARGS.includes("--skip-scan");
export const SKIP_RECOVERY = FAST_BOOT || CLI_ARGS.includes("--skip-recovery");
export const QUIET_MODE = CLI_ARGS.includes("--quiet") || CLI_ARGS.includes("--silent");
