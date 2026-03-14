import { mkdirSync } from "node:fs";
import type {
  RuntimeState,
  RuntimeStateRecord,
  IssueRecord,
  EventRecord,
  S3dbModule,
  S3dbDatabase,
  S3dbResource,
} from "./types.ts";
import {
  S3DB_DATABASE_PATH,
  S3DB_BUCKET,
  S3DB_KEY_PREFIX,
  S3DB_RUNTIME_RECORD_ID,
  S3DB_RUNTIME_SCHEMA_VERSION,
} from "./constants.ts";
import { now, debugBoot, fail } from "./helpers.ts";
import { logger } from "./logger.ts";
import { computeMetrics, computeCapabilityCounts } from "./issues.ts";
import { clearApiRuntimeContext } from "./api-runtime-context.ts";
import { broadcastToWebSocketClients } from "./api-server.ts";
import { NATIVE_RESOURCE_CONFIGS, NATIVE_RESOURCE_NAMES } from "./resources/index.ts";

let loadedS3dbModule: S3dbModule | null = null;
let stateDb: S3dbDatabase | null = null;
let runtimeStateResource: S3dbResource | null = null;
let issueStateResource: S3dbResource | null = null;
let eventStateResource: S3dbResource | null = null;
let agentSessionResource: S3dbResource | null = null;
let agentPipelineResource: S3dbResource | null = null;
let activeApiPlugin: { stop?: () => Promise<void> } | null = null;

export function getStateDb(): S3dbDatabase | null { return stateDb; }
export function getRuntimeStateResource(): S3dbResource | null { return runtimeStateResource; }
export function getIssueStateResource(): S3dbResource | null { return issueStateResource; }
export function getEventStateResource(): S3dbResource | null { return eventStateResource; }
export function getAgentSessionResource(): S3dbResource | null { return agentSessionResource; }
export function getAgentPipelineResource(): S3dbResource | null { return agentPipelineResource; }
export function getActiveApiPlugin(): { stop?: () => Promise<void> } | null { return activeApiPlugin; }
export function setActiveApiPlugin(plugin: { stop?: () => Promise<void> } | null): void { activeApiPlugin = plugin; }
let activeWebSocketPlugin: { stop?: () => Promise<void> } | null = null;
export function getActiveWebSocketPlugin(): { stop?: () => Promise<void> } | null { return activeWebSocketPlugin; }
export function setActiveWebSocketPlugin(plugin: { stop?: () => Promise<void> } | null): void { activeWebSocketPlugin = plugin; }

export async function loadS3dbModule(): Promise<S3dbModule> {
  if (loadedS3dbModule) return loadedS3dbModule;

  try {
    const imported = await import("s3db.js/lite") as unknown as Record<string, unknown>;
    const pluginModule = await import("s3db.js/plugins/index");

    let ApiPluginCtor: S3dbModule["ApiPlugin"] | undefined;
    let WebSocketPluginCtor: S3dbModule["WebSocketPlugin"] | undefined;

    if (typeof (pluginModule as Record<string, unknown>).ApiPlugin === "function") {
      ApiPluginCtor = (pluginModule as { ApiPlugin: S3dbModule["ApiPlugin"] }).ApiPlugin;
    } else if (typeof (pluginModule as Record<string, unknown>).loadApiPlugin === "function") {
      ApiPluginCtor = await (pluginModule as { loadApiPlugin: () => Promise<S3dbModule["ApiPlugin"]> }).loadApiPlugin();
    }

    if (!ApiPluginCtor) {
      throw new Error("ApiPlugin export not found.");
    }

    if (typeof (pluginModule as Record<string, unknown>).WebSocketPlugin === "function") {
      WebSocketPluginCtor = (pluginModule as { WebSocketPlugin: S3dbModule["WebSocketPlugin"] }).WebSocketPlugin;
    } else if (typeof (pluginModule as Record<string, unknown>).loadWebSocketPlugin === "function") {
      WebSocketPluginCtor = await (pluginModule as { loadWebSocketPlugin: () => Promise<S3dbModule["WebSocketPlugin"]> }).loadWebSocketPlugin();
    }

    loadedS3dbModule = {
      S3db: imported.S3db as S3dbModule["S3db"],
      FileSystemClient: imported.FileSystemClient as S3dbModule["FileSystemClient"],
      ApiPlugin: ApiPluginCtor,
      WebSocketPlugin: WebSocketPluginCtor,
    };
    return loadedS3dbModule;
  } catch (error) {
    fail(`Failed to load s3db.js: ${String(error)}`);
  }
}

export async function initStateStore(): Promise<void> {
  debugBoot("initStateStore:start");
  const { S3db, FileSystemClient } = await loadS3dbModule();
  debugBoot("initStateStore:module-loaded");

  mkdirSync(S3DB_DATABASE_PATH, { recursive: true });

  stateDb = new S3db({
    client: new FileSystemClient({
      basePath: S3DB_DATABASE_PATH,
      bucket: S3DB_BUCKET,
      keyPrefix: S3DB_KEY_PREFIX,
    }),
  });

  await stateDb.connect();
  debugBoot("initStateStore:connected");

  for (const resourceConfig of NATIVE_RESOURCE_CONFIGS) {
    await stateDb.createResource(resourceConfig);
  }

  const [
    runtimeStateResourceName,
    issueResourceName,
    eventResourceName,
    agentSessionResourceName,
    agentPipelineResourceName,
  ] = NATIVE_RESOURCE_NAMES;
  runtimeStateResource = await stateDb.getResource(runtimeStateResourceName);
  issueStateResource = await stateDb.getResource(issueResourceName);
  eventStateResource = await stateDb.getResource(eventResourceName);
  agentSessionResource = await stateDb.getResource(agentSessionResourceName);
  agentPipelineResource = await stateDb.getResource(agentPipelineResourceName);
  debugBoot("initStateStore:resources-ready");
}

export function isStateNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    return /not found|does not exist|no such key/i.test(error.message);
  }
  if (typeof error === "string") {
    return /not found|does not exist|no such key/i.test(error);
  }
  return false;
}

export async function loadPersistedState(): Promise<RuntimeState | null> {
  if (!runtimeStateResource) return null;

  try {
    const record = await runtimeStateResource.get(S3DB_RUNTIME_RECORD_ID);
    if (record?.state && typeof record.state === "object") {
      return record.state as RuntimeState;
    }
  } catch (error) {
    if (!isStateNotFoundError(error)) {
      logger.warn(`Could not load persisted state from s3db: ${String(error)}`);
    }
  }

  return null;
}

export async function persistState(state: RuntimeState): Promise<void> {
  state.metrics = {
    ...computeMetrics(state.issues),
    activeWorkers: state.metrics.activeWorkers,
  };

  if (!runtimeStateResource) return;

  await runtimeStateResource.replace(S3DB_RUNTIME_RECORD_ID, {
    id: S3DB_RUNTIME_RECORD_ID,
    schemaVersion: S3DB_RUNTIME_SCHEMA_VERSION,
    trackerKind: "filesystem",
    runtimeTag: "local-only",
    updatedAt: now(),
    state,
  } satisfies RuntimeStateRecord);

  if (issueStateResource) {
    for (const issue of state.issues) {
      await issueStateResource.replace(issue.id, {
        ...issue,
        commandExitCode: typeof issue.commandExitCode === "number" ? issue.commandExitCode : undefined,
      } satisfies IssueRecord);
    }
  }

  if (eventStateResource) {
    for (const event of state.events) {
      await eventStateResource.replace(event.id, event satisfies EventRecord);
    }
  }

  // Push state to connected WebSocket clients
  broadcastToWebSocketClients({
    type: "state:update",
    metrics: state.metrics,
    capabilities: computeCapabilityCounts(state.issues),
    issues: state.issues,
    events: state.events.slice(0, 50),
    updatedAt: state.updatedAt,
  });
}

export async function closeStateStore(): Promise<void> {
  clearApiRuntimeContext();
  if (activeWebSocketPlugin?.stop) {
    try {
      await activeWebSocketPlugin.stop();
    } catch (error) {
      logger.warn(`Failed to stop WebSocket plugin: ${String(error)}`);
    } finally {
      activeWebSocketPlugin = null;
    }
  }
  if (activeApiPlugin?.stop) {
    try {
      await activeApiPlugin.stop();
    } catch (error) {
      logger.warn(`Failed to stop API plugin: ${String(error)}`);
    } finally {
      activeApiPlugin = null;
    }
  }

  if (!stateDb) return;

  try {
    await stateDb.disconnect();
  } catch (error) {
    logger.warn(`Failed to close s3db runtime store: ${String(error)}`);
  } finally {
    stateDb = null;
    runtimeStateResource = null;
    issueStateResource = null;
    eventStateResource = null;
    agentSessionResource = null;
    agentPipelineResource = null;
  }
}
