import type {
  RuntimeState,
  RuntimeStateRecord,
  IssueEntry,
  RuntimeEvent,
  RuntimeSettingRecord,
  S3dbModule,
  S3dbDatabase,
  S3dbResource,
} from "../types.ts";
import {
  S3DB_DATABASE_PATH,
  S3DB_ISSUE_RESOURCE,
  S3DB_RUNTIME_RECORD_ID,
  S3DB_RUNTIME_SCHEMA_VERSION,
} from "../concerns/constants.ts";
import { now, debugBoot, fail } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { computeCapabilityCounts } from "../domains/metrics.ts";
import { getMetrics } from "./metrics-cache.ts";
import { clearApiRuntimeContext } from "../persistence/plugins/api-runtime-context.ts";
import { broadcastToWebSocketClients } from "../persistence/plugins/api-server.ts";
import { NATIVE_RESOURCE_CONFIGS, NATIVE_RESOURCE_NAMES } from "./resources/index.ts";
import {
  setIssueStateMachinePlugin,
  setIssueResourceStateApi,
  issueStateMachineConfig,
  ISSUE_STATE_MACHINE_ID,
} from "./plugins/issue-state-machine.ts";

let loadedS3dbModule: S3dbModule | null = null;
let stateDb: S3dbDatabase | null = null;
let runtimeStateResource: S3dbResource | null = null;
let issueStateResource: S3dbResource | null = null;
let issuePlanResource: S3dbResource | null = null;
let eventStateResource: S3dbResource | null = null;
let settingStateResource: S3dbResource | null = null;
let agentSessionResource: S3dbResource | null = null;
let agentPipelineResource: S3dbResource | null = null;
let activeApiPlugin: { stop?: () => Promise<void> } | null = null;
let activeStateMachinePlugin: { stop?: () => Promise<void> } | null = null;
let activeEcPlugin: S3dbModule["EventualConsistencyPlugin"] extends new (...a: never[]) => infer R ? R | null : null = null;

import {
  markIssueDirty,
  markIssuePlanDirty,
  markEventDirty,
  hasDirtyState,
  getDirtyIssueIds,
  getDirtyIssuePlanIds,
  getDirtyEventIds,
  snapshotAndClearDirtyIssueIds,
  snapshotAndClearDirtyIssuePlanIds,
  snapshotAndClearDirtyEventIds,
  markAllIssuesDirty,
  markAllIssuePlansDirty,
  markAllEventsDirty,
} from "./dirty-tracker.ts";

export { markIssueDirty, markIssuePlanDirty, markEventDirty, hasDirtyState };

export function getStateDb(): S3dbDatabase | null { return stateDb; }
export function getIssueStateResource(): S3dbResource | null { return issueStateResource; }
export function getIssuePlanResource(): S3dbResource | null { return issuePlanResource; }
export function getEventStateResource(): S3dbResource | null { return eventStateResource; }
export function getSettingStateResource(): S3dbResource | null { return settingStateResource; }
export function getAgentSessionResource(): S3dbResource | null { return agentSessionResource; }
export function getAgentPipelineResource(): S3dbResource | null { return agentPipelineResource; }
export function setActiveApiPlugin(plugin: { stop?: () => Promise<void> } | null): void { activeApiPlugin = plugin; }
let activeWebSocketPlugin: { stop?: () => Promise<void> } | null = null;

export async function loadS3dbModule(): Promise<S3dbModule> {
  if (loadedS3dbModule) return loadedS3dbModule;

  try {
    const imported = await import("s3db.js");
    const ApiPlugin = await imported.loadApiPlugin();

    loadedS3dbModule = {
      S3db: imported.S3db as S3dbModule["S3db"],
      SqliteClient: imported.SqliteClient as S3dbModule["SqliteClient"],
      ApiPlugin: ApiPlugin as S3dbModule["ApiPlugin"],
      WebSocketPlugin: imported.WebSocketPlugin as S3dbModule["WebSocketPlugin"],
      StateMachinePlugin: imported.StateMachinePlugin as S3dbModule["StateMachinePlugin"],
      EventualConsistencyPlugin: imported.EventualConsistencyPlugin as S3dbModule["EventualConsistencyPlugin"],
      S3QueuePlugin: imported.S3QueuePlugin as S3dbModule["S3QueuePlugin"],
    };
    return loadedS3dbModule;
  } catch (error) {
    fail(`Failed to load s3db.js: ${String(error)}`);
  }
}

export async function initStateStore(): Promise<void> {
  debugBoot("initStateStore:start");
  const { S3db, SqliteClient, StateMachinePlugin } = await loadS3dbModule();
  debugBoot("initStateStore:module-loaded");

  stateDb = new S3db({
    client: new SqliteClient({ basePath: S3DB_DATABASE_PATH }),
  });

  await stateDb.connect();
  debugBoot("initStateStore:connected");

  for (const resourceConfig of NATIVE_RESOURCE_CONFIGS) {
    await stateDb.createResource(resourceConfig);
  }

  if (StateMachinePlugin) {
    const stateMachinePlugin = await stateDb.usePlugin(
      new StateMachinePlugin(issueStateMachineConfig) as unknown,
      "state-machine",
    ) as Record<string, unknown>;

    activeStateMachinePlugin = stateMachinePlugin as { stop?: () => Promise<void> };
    const bind = (method: unknown) => typeof method === "function" ? (method as Function).bind(stateMachinePlugin) : undefined;
    setIssueStateMachinePlugin({
      send: bind(stateMachinePlugin.send),
      getMachineDefinition: bind(stateMachinePlugin.getMachineDefinition),
      getState: bind(stateMachinePlugin.getState),
      initializeEntity: bind(stateMachinePlugin.initializeEntity),
      getValidEvents: bind(stateMachinePlugin.getValidEvents),
      getTransitionHistory: bind(stateMachinePlugin.getTransitionHistory),
      visualize: bind(stateMachinePlugin.visualize),
      waitForPendingEvents: bind(stateMachinePlugin.waitForPendingEvents),
    } as any);
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
            // Event count (incremented on each addEvent call for this issue)
            { field: "eventsCount", fieldPath: "eventsCount", initialValue: 0, cohort: { granularity: "day" } },
            // Code churn (set at merge time, accumulated per day)
            { field: "linesAdded", fieldPath: "linesAdded", initialValue: 0, cohort: { granularity: "day" } },
            { field: "linesRemoved", fieldPath: "linesRemoved", initialValue: 0, cohort: { granularity: "day" } },
            { field: "filesChanged", fieldPath: "filesChanged", initialValue: 0, cohort: { granularity: "day" } },
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
    issuePlanResourceName,
    eventResourceName,
    settingResourceName,
    agentSessionResourceName,
    agentPipelineResourceName,
  ] = NATIVE_RESOURCE_NAMES;
  runtimeStateResource = await stateDb.getResource(runtimeStateResourceName);
  issueStateResource = await stateDb.getResource(issueResourceName);
  issuePlanResource = await stateDb.getResource(issuePlanResourceName);
  eventStateResource = await stateDb.getResource(eventResourceName);
  settingStateResource = await stateDb.getResource(settingResourceName);
  agentSessionResource = await stateDb.getResource(agentSessionResourceName);
  agentPipelineResource = await stateDb.getResource(agentPipelineResourceName);

  // Capture resource.state API injected by StateMachinePlugin (resource-level shortcuts)
  if (issueStateResource && (issueStateResource as any).state) {
    const stateApi = (issueStateResource as any).state;
    setIssueResourceStateApi({
      send: stateApi.send?.bind(stateApi),
      get: stateApi.get?.bind(stateApi),
      canTransition: stateApi.canTransition?.bind(stateApi),
      history: stateApi.history?.bind(stateApi),
      initialize: stateApi.initialize?.bind(stateApi),
      getValidEvents: stateApi.getValidEvents?.bind(stateApi),
      delete: stateApi.delete?.bind(stateApi),
    });
    debugBoot("initStateStore:resource-state-api-bound");
  }

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
  if (!runtimeStateResource) {
    logger.debug("[Store] No runtime state resource available, skipping load");
    return null;
  }

  logger.debug("[Store] Loading persisted state from s3db");
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

    if (issuePlanResource) {
      for (const issue of issues) {
        try {
          const planRecord = await issuePlanResource.get(issue.id) as Record<string, unknown> | null | undefined;
          if (planRecord?.plan) issue.plan = planRecord.plan as IssueEntry["plan"];
          if (planRecord?.planHistory) issue.planHistory = planRecord.planHistory as IssueEntry["planHistory"];
        } catch {
          // plan may not exist yet — ok
        }
      }
    }

    return {
      startedAt: now(),
      updatedAt: now(),
      trackerKind: "filesystem",
      sourceRepoUrl: "",
      sourceRef: "workspace",
      config: {} as any,
      issues,
      events: [],
      metrics: getMetrics(issues),
      notes: ["State recovered from individual issue records after corruption."],
    };
  } catch (error) {
    logger.warn(`Failed to recover issues from s3db: ${String(error)}`);
    return null;
  }
}

export async function persistState(state: RuntimeState): Promise<void> {
  state.metrics = {
    ...getMetrics(state.issues),
    activeWorkers: state.metrics.activeWorkers,
  };

  if (!runtimeStateResource) return;

  // Only write the runtime state blob if something changed
  const dirty = hasDirtyState();
  const dirtyIssueCount = getDirtyIssueIds().size;
  const dirtyEventCount = getDirtyEventIds().size;
  if (dirty || dirtyIssueCount > 0 || dirtyEventCount > 0) {
    logger.debug({ dirty, dirtyIssues: dirtyIssueCount, dirtyEvents: dirtyEventCount }, "[Store] Persisting state");
  }

  if (dirty) {
    await runtimeStateResource.replace(S3DB_RUNTIME_RECORD_ID, {
      id: S3DB_RUNTIME_RECORD_ID,
      schemaVersion: S3DB_RUNTIME_SCHEMA_VERSION,
      trackerKind: "filesystem",
      runtimeTag: "local-only",
      updatedAt: now(),
      state,
    } satisfies RuntimeStateRecord);
  }

  // Snapshot dirty IDs before iterating to avoid losing IDs added during persist
  const dirtyIssues = issueStateResource ? snapshotAndClearDirtyIssueIds() : new Set<string>();
  if (issueStateResource && dirtyIssues.size > 0) {
    for (const issue of state.issues) {
      if (!dirtyIssues.has(issue.id)) continue;
      // s3db requires valid datetime or undefined — clean empty strings
      // Exclude plan/planHistory — those live in issue_plans resource
      const { plan: _plan, planHistory: _planHistory, ...issueCore } = issue;
      const clean = {
        ...issueCore,
        nextRetryAt: issue.nextRetryAt || undefined,
        startedAt: issue.startedAt || undefined,
        completedAt: issue.completedAt || undefined,
        workspacePreparedAt: issue.workspacePreparedAt || undefined,
        commandExitCode: typeof issue.commandExitCode === "number" ? issue.commandExitCode : undefined,
      };
      try {
        await issueStateResource.replace(issue.id, clean);
      } catch (error) {
        logger.warn(`Failed to persist issue ${issue.id}: ${String(error)}`);
      }
    }
  }

  const dirtyIssuePlans = issuePlanResource ? snapshotAndClearDirtyIssuePlanIds() : new Set<string>();
  if (issuePlanResource && dirtyIssuePlans.size > 0) {
    for (const issue of state.issues) {
      if (!dirtyIssuePlans.has(issue.id)) continue;
      try {
        await issuePlanResource.replace(issue.id, {
          id: issue.id,
          plan: issue.plan,
          planHistory: issue.planHistory,
          planVersion: issue.planVersion ?? 0,
        });
      } catch (error) {
        logger.warn(`Failed to persist issue plan ${issue.id}: ${String(error)}`);
      }
    }
  }

  const dirtyEvents = eventStateResource ? snapshotAndClearDirtyEventIds() : new Set<string>();
  if (eventStateResource && dirtyEvents.size > 0) {
    for (const event of state.events) {
      if (!dirtyEvents.has(event.id)) continue;
      await eventStateResource.replace(event.id, event satisfies RuntimeEvent);
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

/** Force persist all issues (used during boot and shutdown). */
export async function persistStateFull(state: RuntimeState): Promise<void> {
  markAllIssuesDirty(state.issues.map((i) => i.id));
  markAllIssuePlansDirty(state.issues.map((i) => i.id));
  markAllEventsDirty(state.events.map((e) => e.id));
  await persistState(state);
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

/**
 * Query EC plugin for daily event counts (sum of eventsCount deltas per day).
 * Returns last N days as { date: "2026-03-18", events: 5 }[].
 */
export async function getEcDailyEvents(days = 90): Promise<Array<{ date: string; events: number }>> {
  if (!activeEcPlugin?.getLastNDays) return [];
  try {
    const raw = await activeEcPlugin.getLastNDays(S3DB_ISSUE_RESOURCE, "eventsCount", days);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r: unknown) => {
        const rec = r as Record<string, unknown>;
        const date = (rec.date ?? rec.cohort ?? rec.key ?? "") as string;
        const events = Number(rec.total ?? rec.value ?? rec.sum ?? rec.count ?? 0);
        return { date: String(date).slice(0, 10), events };
      })
      .filter((e) => e.date && e.events > 0);
  } catch {
    return [];
  }
}

/**
 * Query EC plugin for daily code churn (linesAdded + linesRemoved + filesChanged per day).
 */
export async function getEcDailyLines(days = 90): Promise<Array<{ date: string; linesAdded: number; linesRemoved: number; filesChanged: number }>> {
  if (!activeEcPlugin?.getLastNDays) return [];
  try {
    const [addedRaw, removedRaw, filesRaw] = await Promise.all([
      activeEcPlugin.getLastNDays(S3DB_ISSUE_RESOURCE, "linesAdded", days),
      activeEcPlugin.getLastNDays(S3DB_ISSUE_RESOURCE, "linesRemoved", days),
      activeEcPlugin.getLastNDays(S3DB_ISSUE_RESOURCE, "filesChanged", days),
    ]);

    const toMap = (raw: unknown): Map<string, number> => {
      if (!Array.isArray(raw)) return new Map();
      return new Map(
        raw
          .map((r: unknown) => {
            const rec = r as Record<string, unknown>;
            const date = String(rec.date ?? rec.cohort ?? rec.key ?? "").slice(0, 10);
            const value = Number(rec.total ?? rec.value ?? rec.sum ?? rec.count ?? 0);
            return [date, value] as [string, number];
          })
          .filter(([date]) => date.length === 10),
      );
    };

    const addedMap = toMap(addedRaw);
    const removedMap = toMap(removedRaw);
    const filesMap = toMap(filesRaw);
    const allDates = new Set([...addedMap.keys(), ...removedMap.keys(), ...filesMap.keys()]);

    return Array.from(allDates)
      .map((date) => ({
        date,
        linesAdded: addedMap.get(date) ?? 0,
        linesRemoved: removedMap.get(date) ?? 0,
        filesChanged: filesMap.get(date) ?? 0,
      }))
      .filter((e) => e.linesAdded > 0 || e.linesRemoved > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

export async function closeStateStore(): Promise<void> {
  logger.info("[Store] Closing state store and plugins");
  clearApiRuntimeContext();

  try {
    const { stopQueueWorkers } = await import("./queue-workers.ts");
    await stopQueueWorkers();
  } catch (error) {
    logger.warn(`Failed to stop queue workers: ${String(error)}`);
  }

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
      setIssueResourceStateApi(null);
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
    issuePlanResource = null;
    eventStateResource = null;
    settingStateResource = null;
    agentSessionResource = null;
    agentPipelineResource = null;
  }
}
