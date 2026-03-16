import { mkdirSync } from "node:fs";
import type {
  RuntimeState,
  RuntimeStateRecord,
  IssueRecord,
  EventRecord,
  RuntimeSettingRecord,
  S3dbModule,
  S3dbDatabase,
  S3dbResource,
} from "./types.ts";
import {
  S3DB_DATABASE_PATH,
  S3DB_BUCKET,
  S3DB_ISSUE_RESOURCE,
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
import {
  setIssueStateMachinePlugin,
  ISSUE_STATE_MACHINE_DEFINITION,
  ISSUE_STATE_MACHINE_ID,
} from "./issue-state-machine.ts";

let loadedS3dbModule: S3dbModule | null = null;
let stateDb: S3dbDatabase | null = null;
let runtimeStateResource: S3dbResource | null = null;
let issueStateResource: S3dbResource | null = null;
let eventStateResource: S3dbResource | null = null;
let settingStateResource: S3dbResource | null = null;
let agentSessionResource: S3dbResource | null = null;
let agentPipelineResource: S3dbResource | null = null;
let activeApiPlugin: { stop?: () => Promise<void> } | null = null;
let activeStateMachinePlugin: { stop?: () => Promise<void> } | null = null;
let activeEcPlugin: S3dbModule["EventualConsistencyPlugin"] extends new (...a: never[]) => infer R ? R | null : null = null;

export function getStateDb(): S3dbDatabase | null { return stateDb; }
export function getRuntimeStateResource(): S3dbResource | null { return runtimeStateResource; }
export function getIssueStateResource(): S3dbResource | null { return issueStateResource; }
export function getEventStateResource(): S3dbResource | null { return eventStateResource; }
export function getSettingStateResource(): S3dbResource | null { return settingStateResource; }
export function getAgentSessionResource(): S3dbResource | null { return agentSessionResource; }
export function getAgentPipelineResource(): S3dbResource | null { return agentPipelineResource; }
export function getActiveApiPlugin(): { stop?: () => Promise<void> } | null { return activeApiPlugin; }
export function setActiveApiPlugin(plugin: { stop?: () => Promise<void> } | null): void { activeApiPlugin = plugin; }
let activeWebSocketPlugin: { stop?: () => Promise<void> } | null = null;
export function getActiveWebSocketPlugin(): { stop?: () => Promise<void> } | null { return activeWebSocketPlugin; }
export function setActiveWebSocketPlugin(plugin: { stop?: () => Promise<void> } | null): void { activeWebSocketPlugin = plugin; }
export function getActiveStateMachinePlugin(): { stop?: () => Promise<void> } | null { return activeStateMachinePlugin; }
export function getActiveEcPlugin() { return activeEcPlugin; }
export function setActiveStateMachinePlugin(plugin: { stop?: () => Promise<void> } | null): void { activeStateMachinePlugin = plugin; }

export async function loadS3dbModule(): Promise<S3dbModule> {
  if (loadedS3dbModule) return loadedS3dbModule;

  try {
    const imported = await import("s3db.js/lite") as unknown as Record<string, unknown>;
    const pluginModule = await import("s3db.js/plugins/index");

    let ApiPluginCtor: S3dbModule["ApiPlugin"] | undefined;
    let WebSocketPluginCtor: S3dbModule["WebSocketPlugin"] | undefined;
    let StateMachinePluginCtor: S3dbModule["StateMachinePlugin"] | undefined;

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

    if (typeof (pluginModule as Record<string, unknown>).StateMachinePlugin === "function") {
      StateMachinePluginCtor = (pluginModule as { StateMachinePlugin: S3dbModule["StateMachinePlugin"] }).StateMachinePlugin;
    }

    let EventualConsistencyPluginCtor: S3dbModule["EventualConsistencyPlugin"] | undefined;
    if (typeof (pluginModule as Record<string, unknown>).EventualConsistencyPlugin === "function") {
      EventualConsistencyPluginCtor = (pluginModule as { EventualConsistencyPlugin: S3dbModule["EventualConsistencyPlugin"] }).EventualConsistencyPlugin;
    }

    loadedS3dbModule = {
      S3db: imported.S3db as S3dbModule["S3db"],
      FileSystemClient: imported.FileSystemClient as S3dbModule["FileSystemClient"],
      ApiPlugin: ApiPluginCtor,
      WebSocketPlugin: WebSocketPluginCtor,
      StateMachinePlugin: StateMachinePluginCtor,
      EventualConsistencyPlugin: EventualConsistencyPluginCtor,
    };
    return loadedS3dbModule;
  } catch (error) {
    fail(`Failed to load s3db.js: ${String(error)}`);
  }
}

export async function initStateStore(): Promise<void> {
  debugBoot("initStateStore:start");
  const { S3db, FileSystemClient, StateMachinePlugin } = await loadS3dbModule();
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

  if (StateMachinePlugin) {
    const stateMachinePlugin = await stateDb.usePlugin(
      new StateMachinePlugin({
        stateMachines: {
          [ISSUE_STATE_MACHINE_ID]: ISSUE_STATE_MACHINE_DEFINITION,
        },
      }) as unknown,
      "state-machine",
    ) as Record<string, unknown>;

    activeStateMachinePlugin = stateMachinePlugin as { stop?: () => Promise<void> };
    const bindPluginMethod = <T extends (...args: never[]) => unknown>(method: unknown): T | undefined => {
      return typeof method === "function" ? method.bind(stateMachinePlugin) as T : undefined;
    };
    setIssueStateMachinePlugin({
      send: bindPluginMethod<S3dbModule["StateMachinePlugin"] extends { send?: infer T } ? T & ((...args: never[]) => unknown) : never>(stateMachinePlugin.send),
      getMachineDefinition: bindPluginMethod<S3dbModule["StateMachinePlugin"] extends { getMachineDefinition?: infer T } ? T & ((...args: never[]) => unknown) : never>(stateMachinePlugin.getMachineDefinition),
      getState: bindPluginMethod<S3dbModule["StateMachinePlugin"] extends { getState?: infer T } ? T & ((...args: never[]) => unknown) : never>(stateMachinePlugin.getState),
      initializeEntity: bindPluginMethod<S3dbModule["StateMachinePlugin"] extends { initializeEntity?: infer T } ? T & ((...args: never[]) => unknown) : never>(stateMachinePlugin.initializeEntity),
      getValidEvents: bindPluginMethod<S3dbModule["StateMachinePlugin"] extends { getValidEvents?: infer T } ? T & ((...args: never[]) => unknown) : never>(stateMachinePlugin.getValidEvents),
    });
  } else {
    logger.warn("StateMachinePlugin not available. Issue transitions will use local logic only.");
  }

  // EventualConsistency plugin for token usage analytics
  const { EventualConsistencyPlugin } = await loadS3dbModule();
  if (EventualConsistencyPlugin) {
    try {
      const ecPlugin = new EventualConsistencyPlugin({
        resources: {
          [S3DB_ISSUE_RESOURCE]: [
            // Per-model totals (dynamic keys: { "claude-sonnet-4-6": 12345, "o4-mini": 6789 })
            { field: "usage.tokens", fieldPath: "usage.tokens", initialValue: 0, cohort: { granularity: "day" } },
            // Overall volume
            { field: "tokenUsage.totalTokens", fieldPath: "tokenUsage.totalTokens", initialValue: 0, cohort: { granularity: "day" } },
            { field: "tokenUsage.inputTokens", fieldPath: "tokenUsage.inputTokens", initialValue: 0, cohort: { granularity: "day" } },
            { field: "tokenUsage.outputTokens", fieldPath: "tokenUsage.outputTokens", initialValue: 0, cohort: { granularity: "day" } },
            // Per-phase volume
            { field: "tokensByPhase.planner.totalTokens", fieldPath: "tokensByPhase.planner.totalTokens", initialValue: 0, cohort: { granularity: "day" } },
            { field: "tokensByPhase.executor.totalTokens", fieldPath: "tokensByPhase.executor.totalTokens", initialValue: 0, cohort: { granularity: "day" } },
            { field: "tokensByPhase.reviewer.totalTokens", fieldPath: "tokensByPhase.reviewer.totalTokens", initialValue: 0, cohort: { granularity: "day" } },
          ],
        },
        enableAnalytics: true,
        analytics: { enabled: true },
        cohort: { granularity: "day", timezone: "UTC" },
        analyticsConfig: { rollupStrategy: "incremental", retentionDays: 90 },
        autoConsolidate: true,
        consolidationInterval: 30_000,
      });
      await stateDb.usePlugin(ecPlugin as unknown, "eventual-consistency");
      activeEcPlugin = ecPlugin as typeof activeEcPlugin;
      logger.info("EventualConsistency plugin installed for token usage analytics.");
    } catch (error) {
      logger.warn(`EventualConsistency plugin failed to install: ${String(error)}`);
    }
  }

  const [
    runtimeStateResourceName,
    issueResourceName,
    eventResourceName,
    settingResourceName,
    agentSessionResourceName,
    agentPipelineResourceName,
  ] = NATIVE_RESOURCE_NAMES;
  runtimeStateResource = await stateDb.getResource(runtimeStateResourceName);
  issueStateResource = await stateDb.getResource(issueResourceName);
  eventStateResource = await stateDb.getResource(eventResourceName);
  settingStateResource = await stateDb.getResource(settingResourceName);
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
      const state = record.state as RuntimeState;
      if (Array.isArray(state.issues) && state.issues.length > 0) {
        return state;
      }
      // State blob has no issues — try recovering from individual issue records
      logger.warn("Runtime state blob has no issues, attempting recovery from issue resource...");
    }
  } catch (error) {
    if (!isStateNotFoundError(error)) {
      logger.warn(`Could not load persisted state from s3db (will attempt issue recovery): ${String(error)}`);
    }
  }

  // Fallback: recover issues from individual s3db issue records
  return recoverStateFromIssueResource();
}

async function recoverStateFromIssueResource(): Promise<RuntimeState | null> {
  if (!issueStateResource) return null;

  try {
    const records = await (issueStateResource as any).list({ limit: 500 });
    if (!Array.isArray(records) || records.length === 0) return null;

    const issues = records
      .filter((r: any) => r?.id && r?.identifier && r?.state)
      .map((r: any) => r as RuntimeState["issues"][number]);

    if (issues.length === 0) return null;

    logger.info(`Recovered ${issues.length} issue(s) from s3db issue resource.`);

    return {
      startedAt: now(),
      updatedAt: now(),
      trackerKind: "filesystem",
      sourceRepoUrl: "",
      sourceRef: "workspace",
      workflowPath: "",
      config: {} as any,
      issues,
      events: [],
      metrics: computeMetrics(issues),
      notes: ["State recovered from individual issue records after corruption."],
    };
  } catch (error) {
    logger.warn(`Failed to recover issues from s3db: ${String(error)}`);
    return null;
  }
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
      // s3db requires valid datetime or undefined — clean empty strings
      const clean = {
        ...issue,
        nextRetryAt: issue.nextRetryAt || undefined,
        startedAt: issue.startedAt || undefined,
        completedAt: issue.completedAt || undefined,
        workspacePreparedAt: issue.workspacePreparedAt || undefined,
        commandExitCode: typeof issue.commandExitCode === "number" ? issue.commandExitCode : undefined,
      };
      try {
        await issueStateResource.replace(issue.id, clean satisfies IssueRecord);
      } catch (error) {
        logger.warn(`Failed to persist issue ${issue.id}: ${String(error)}`);
      }
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

export async function loadPersistedSettings(): Promise<RuntimeSettingRecord[]> {
  if (!settingStateResource?.list) return [];

  try {
    const records = await settingStateResource.list({ limit: 500 });
    return Array.isArray(records)
      ? records.filter((record): record is RuntimeSettingRecord =>
        Boolean(
          record &&
          typeof record.id === "string" &&
          typeof record.scope === "string",
        ),
      )
      : [];
  } catch (error) {
    logger.warn(`Failed to load persisted settings from s3db: ${String(error)}`);
    return [];
  }
}

export async function replacePersistedSetting(setting: RuntimeSettingRecord): Promise<void> {
  if (!settingStateResource) return;
  await settingStateResource.replace(setting.id, setting);
}

export async function closeStateStore(): Promise<void> {
  clearApiRuntimeContext();
  if (activeEcPlugin?.stop) {
    try {
      await activeEcPlugin.stop();
    } catch (error) {
      logger.warn(`Failed to stop EventualConsistency plugin: ${String(error)}`);
    } finally {
      activeEcPlugin = null;
    }
  }
  if (activeStateMachinePlugin?.stop) {
    try {
      await activeStateMachinePlugin.stop();
    } catch (error) {
      logger.warn(`Failed to stop StateMachine plugin: ${String(error)}`);
    } finally {
      activeStateMachinePlugin = null;
      setIssueStateMachinePlugin(null);
    }
  }
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
    settingStateResource = null;
    agentSessionResource = null;
    agentPipelineResource = null;
  }
}
