import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { env } from "node:process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ── Types ────────────────────────────────────────────────────────────────────

export type IssueRecord = {
  id: string;
  identifier?: string;
  title: string;
  description?: string;
  priority?: number;
  state?: string;
  labels?: string[];
  paths?: string[];
  url?: string;
  assigned_to_worker?: boolean;
  [key: string]: unknown;
};

export type RuntimeSnapshot = {
  updatedAt?: string;
  config?: Record<string, unknown>;
  issues?: IssueRecord[];
  metrics?: Record<string, unknown>;
  notes?: string[];
  [key: string]: unknown;
};

export type S3dbResource = {
  insert: (record: Record<string, unknown>) => Promise<Record<string, unknown>>;
  get: (id: string) => Promise<Record<string, unknown> | null>;
  update: (id: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  list: (options?: {
    partition?: string | null;
    partitionValues?: Record<string, string | number>;
    limit?: number;
    offset?: number;
  }) => Promise<Record<string, unknown>[]>;
  query?: (options?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
};

export type S3dbDatabase = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  createResource: (config: Record<string, unknown>) => Promise<S3dbResource>;
  resources: Record<string, S3dbResource>;
};

type S3dbModule = {
  default: new (config: Record<string, unknown>) => S3dbDatabase;
  SqliteClient: new (config: Record<string, unknown>) => unknown;
};

// ── Constants ────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = env.FIFONY_WORKSPACE_ROOT ?? process.cwd();
const PERSISTENCE_ROOT = env.FIFONY_PERSISTENCE ?? WORKSPACE_ROOT;
const STATE_ROOT = resolvePersistenceRoot(PERSISTENCE_ROOT);
const DATABASE_PATH = join(STATE_ROOT, "fifony.sqlite");
const DEBUG_BOOT = env.FIFONY_DEBUG_BOOT === "1";

function resolvePersistenceRoot(value: string): string {
  const resolved = value.startsWith("file://")
    ? fileURLToPath(value)
    : value.startsWith("~/")
      ? resolve(homedir(), value.slice(2))
      : resolve(value);

  return basename(resolved) === ".fifony" ? resolved : join(resolved, ".fifony");
}

export const RUNTIME_RESOURCE = "runtime_state";
export const ISSUE_RESOURCE = "issues";
export const EVENT_RESOURCE = "events";
export const SESSION_RESOURCE = "agent_sessions";
export const PIPELINE_RESOURCE = "agent_pipelines";
export const RUNTIME_RECORD_ID = "current";
export { WORKSPACE_ROOT, PERSISTENCE_ROOT, STATE_ROOT };

// ── State ────────────────────────────────────────────────────────────────────

let database: S3dbDatabase | null = null;
let runtimeResource: S3dbResource | null = null;
let issueResource: S3dbResource | null = null;
let eventResource: S3dbResource | null = null;
let sessionResource: S3dbResource | null = null;
let pipelineResource: S3dbResource | null = null;

export function getResources() {
  return { runtimeResource, issueResource, eventResource, sessionResource, pipelineResource };
}

export function getDatabase(): S3dbDatabase | null {
  return database;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function debugBoot(message: string): void {
  if (!DEBUG_BOOT) return;
  process.stderr.write(`[FIFONY_DEBUG_BOOT] ${message}\n`);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeRead(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// ── Module loading ───────────────────────────────────────────────────────────

async function loadS3dbModule(): Promise<S3dbModule> {
  try {
    const imported = await import("s3db.js");
    return {
      default: imported.default,
      SqliteClient: imported.SqliteClient,
    };
  } catch (error) {
    throw new Error(`Unable to load s3db.js: ${String(error)}`);
  }
}

// ── Database initialization ──────────────────────────────────────────────────

export async function initDatabase(): Promise<S3dbDatabase> {
  if (database) return database;

  debugBoot("mcp:getDatabase:start");
  const s3db = await loadS3dbModule();
  debugBoot("mcp:getDatabase:module-loaded");
  const client = new s3db.SqliteClient({ basePath: DATABASE_PATH });
  database = new s3db.default({ client, verbose: false });
  await database.connect();
  debugBoot("mcp:getDatabase:connected");

  runtimeResource = database.resources[RUNTIME_RESOURCE] ?? await database.createResource({
    name: RUNTIME_RESOURCE,
    behavior: "body-overflow",
    attributes: {
      updatedAt: "datetime|required",
      state: "json|required",
    },
  });

  issueResource = database.resources[ISSUE_RESOURCE] ?? await database.createResource({
    name: ISSUE_RESOURCE,
    behavior: "body-overflow",
    attributes: {
      id: "string|required",
      identifier: "string|required",
      title: "string|required",
      description: "string|optional",
      priority: "number|required",
      state: "string|required",
      branchName: "string|optional",
      labels: "json|required",
      paths: "json|optional",
      inferredPaths: "json|optional",
      capabilityCategory: "string|optional",
      capabilityOverlays: "json|optional",
      capabilityRationale: "json|optional",
      blockedBy: "json|required",
      assignedToWorker: "boolean|required",
      createdAt: "datetime|required",
      updatedAt: "datetime|required",
      history: "json|required",
      attempts: "number|required",
      maxAttempts: "number|required",
      url: "string|optional",
      assigneeId: "string|optional",
      startedAt: "datetime|optional",
      completedAt: "datetime|optional",
      nextRetryAt: "datetime|optional",
      workspacePath: "string|optional",
      workspacePreparedAt: "datetime|optional",
      lastError: "string|optional",
      durationMs: "number|optional",
      commandExitCode: "number|optional",
      commandOutputTail: "string|optional",
    },
    partitions: {
      byState: { fields: { state: "string" } },
      byCapabilityCategory: { fields: { capabilityCategory: "string" } },
      byStateAndCapability: {
        fields: { state: "string", capabilityCategory: "string" },
      },
    },
    asyncPartitions: true,
  });

  eventResource = database.resources[EVENT_RESOURCE] ?? await database.createResource({
    name: EVENT_RESOURCE,
    behavior: "body-overflow",
    attributes: {
      id: "string|required",
      issueId: "string|optional",
      kind: "string|required",
      message: "string|required",
      at: "datetime|required",
    },
    partitions: {
      byIssueId: { fields: { issueId: "string" } },
      byKind: { fields: { kind: "string" } },
      byIssueIdAndKind: { fields: { issueId: "string", kind: "string" } },
    },
    asyncPartitions: true,
  });

  sessionResource = database.resources[SESSION_RESOURCE] ?? await database.createResource({
    name: SESSION_RESOURCE,
    behavior: "body-overflow",
    attributes: {
      id: "string|required",
      issueId: "string|required",
      issueIdentifier: "string|required",
      attempt: "number|required",
      provider: "string|required",
      role: "string|required",
      cycle: "number|required",
      session: "json|required",
      updatedAt: "datetime|required",
    },
    partitions: {
      byIssueId: { fields: { issueId: "string" } },
      byIssueAttempt: { fields: { issueId: "string", attempt: "number" } },
      byProviderRole: { fields: { provider: "string", role: "string" } },
    },
    asyncPartitions: true,
  });

  pipelineResource = database.resources[PIPELINE_RESOURCE] ?? await database.createResource({
    name: PIPELINE_RESOURCE,
    behavior: "body-overflow",
    attributes: {
      id: "string|required",
      issueId: "string|required",
      issueIdentifier: "string|required",
      attempt: "number|required",
      pipeline: "json|required",
      updatedAt: "datetime|required",
    },
    partitions: {
      byIssueId: { fields: { issueId: "string" } },
      byIssueAttempt: { fields: { issueId: "string", attempt: "number" } },
    },
    asyncPartitions: true,
  });

  debugBoot("mcp:getDatabase:resources-ready");
  return database;
}

// ── Query helpers ────────────────────────────────────────────────────────────

export async function listRecords(resource: S3dbResource | null, limit: number = 100): Promise<Record<string, unknown>[]> {
  if (!resource) return [];
  if (typeof resource.query === "function") return await resource.query({});
  return await resource.list({ limit });
}

export async function listIssues(filters: { state?: string; capabilityCategory?: string } = {}): Promise<IssueRecord[]> {
  await initDatabase();
  const { state, capabilityCategory } = filters;

  if (!issueResource) return [];

  const partition = state && capabilityCategory
    ? "byStateAndCapability"
    : state ? "byState"
    : capabilityCategory ? "byCapabilityCategory"
    : null;
  const partitionValues = state && capabilityCategory
    ? { state, capabilityCategory }
    : state ? { state }
    : capabilityCategory ? { capabilityCategory }
    : {};

  const records = await issueResource.list({ partition, partitionValues, limit: 500 });
  return records.map((record) => record as IssueRecord);
}

export async function listEvents(filters: { issueId?: string; kind?: string; limit?: number } = {}): Promise<Record<string, unknown>[]> {
  await initDatabase();
  const { issueId, kind, limit = 100 } = filters;

  if (!eventResource) return [];

  const partition = issueId && kind
    ? "byIssueIdAndKind"
    : issueId ? "byIssueId"
    : kind ? "byKind"
    : null;
  const partitionValues = issueId && kind
    ? { issueId, kind }
    : issueId ? { issueId }
    : kind ? { kind }
    : {};

  return await eventResource.list({ partition, partitionValues, limit });
}

export async function getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  await initDatabase();
  const record = await runtimeResource?.get(RUNTIME_RECORD_ID);
  const state = record?.state;
  if (state && typeof state === "object") return state as RuntimeSnapshot;
  return {};
}

export async function getIssues(): Promise<IssueRecord[]> {
  return await listIssues();
}

export async function getIssue(issueId: string): Promise<IssueRecord | null> {
  await initDatabase();
  const issue = await issueResource?.get(issueId);
  return (issue as IssueRecord | null) ?? null;
}

export async function appendEvent(level: string, message: string, payload: Record<string, unknown> = {}, issueId?: string): Promise<void> {
  await initDatabase();
  const { randomUUID } = await import("node:crypto");
  await eventResource?.insert({
    id: randomUUID(),
    issueId,
    kind: level,
    message,
    at: nowIso(),
  });
}
