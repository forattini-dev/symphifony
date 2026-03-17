import type {
  JsonRecord,
  RuntimeEvent,
  RuntimeState,
  IssueEntry,
  RuntimeSettingScope,
  RuntimeSettingSource,
  WorkflowDefinition,
} from "./types.ts";
import { execSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  FRONTEND_DIR,
  FRONTEND_ICON_SVG,
  FRONTEND_INDEX,
  FRONTEND_MANIFEST_JSON,
  FRONTEND_MASKABLE_ICON_SVG,
  FRONTEND_OFFLINE_HTML,
  FRONTEND_SERVICE_WORKER_JS,
  SOURCE_ROOT,
} from "./constants.ts";
import { NATIVE_RESOURCE_CONFIGS } from "./resources/index.ts";
import { now, isoWeek, clamp, toStringValue } from "./helpers.ts";
import { isAgentStillRunning, mergeWorkspace } from "./agent.ts";
import { logger } from "./logger.ts";
import {
  loadS3dbModule,
  getStateDb,
  getEventStateResource,
  setActiveApiPlugin,
  persistState,
} from "./store.ts";
import { markIssueDirty } from "./dirty-tracker.ts";
import {
  addEvent,
  computeCapabilityCounts,
  computeMetrics,
  createIssueFromPayload,
  handleStatePatch,
  transitionIssueState,
} from "./issues.ts";
import { detectAvailableProviders, discoverModels } from "./providers.ts";
import { collectProvidersUsage } from "./providers-usage.ts";
import { analyzeParallelizability, wakeScheduler } from "./scheduler.ts";
import { setApiRuntimeContext } from "./api-runtime-context.ts";
import { TERMINAL_STATES } from "./constants.ts";
import { getAnalytics as getTokenAnalytics, getHourlySnapshot } from "./token-ledger.ts";
import { enhanceIssueField } from "./issue-enhancer.ts";
import { generatePlan, refinePlan, generatePlanInBackground, refinePlanInBackground, loadPlanningSession, savePlanningInput, clearPlanningSession } from "./issue-planner.ts";
import type { PlanningSessionUsage } from "./issue-planner.ts";
import {
  applyPersistedSettings,
  buildDefaultWorkflowConfig,
  getWorkflowConfig,
  inferSettingScope,
  loadRuntimeSettings,
  persistSetting,
  persistWorkerConcurrencySetting,
  persistWorkflowConfig,
  RUNTIME_CONFIG_SETTING_IDS,
} from "./settings.ts";
import { scanProjectFiles, analyzeProjectWithCli } from "./project-scanner.ts";
import { scanForTodos, categorizeScannedIssues } from "./issue-scanner.ts";
import { fetchGitHubIssues } from "./github-sync.ts";
import {
  loadAgentCatalog,
  loadSkillCatalog,
  filterByDomains,
  installAgents,
  installSkills,
} from "./catalog.ts";
import { TARGET_ROOT } from "./constants.ts";
import { join } from "node:path";

// ── WebSocket broadcast (same port via listeners) ────────────────────────────
// s3db.js 21.2.7 WebSocket contract: handlers receive (socketId, send, req)
// instead of raw socket objects. We track socketId → send function.

type WsSendFn = (data: string) => void;
const wsClients = new Map<string, WsSendFn>(); // socketId → send
let broadcastSeq = 0;
let lastBroadcastIssueSnapshot: Map<string, string> = new Map(); // id → JSON
const VALID_SETTING_SCOPES = new Set<RuntimeSettingScope>(["runtime", "providers", "ui", "system"]);
const VALID_SETTING_SOURCES = new Set<RuntimeSettingSource>(["user", "detected", "workflow", "system"]);

function sendToAllClients(data: string): void {
  for (const [socketId, send] of [...wsClients]) {
    try { send(data); } catch (error) {
      logger.debug(`WebSocket send failed for ${socketId}, removing (remaining: ${wsClients.size - 1}): ${String(error)}`);
      wsClients.delete(socketId);
    }
  }
}

export function broadcastToWebSocketClients(message: Record<string, unknown>): void {
  if (wsClients.size === 0) return;

  broadcastSeq++;
  logger.debug({ seq: broadcastSeq, type: message.type, clientCount: wsClients.size }, "[WebSocket] Broadcasting state update");
  const issues = message.issues as Array<Record<string, unknown>> | undefined;

  if (issues && lastBroadcastIssueSnapshot.size > 0) {
    // Compute delta: only changed/new/removed issues
    const currentIds = new Set<string>();
    const changedIssues: Array<Record<string, unknown>> = [];

    for (const issue of issues) {
      const id = issue.id as string;
      currentIds.add(id);
      const serialized = JSON.stringify(issue);
      if (lastBroadcastIssueSnapshot.get(id) !== serialized) {
        changedIssues.push(issue);
      }
    }

    const removedIds: string[] = [];
    for (const prevId of lastBroadcastIssueSnapshot.keys()) {
      if (!currentIds.has(prevId)) {
        removedIds.push(prevId);
      }
    }

    // Update snapshot
    lastBroadcastIssueSnapshot = new Map(
      issues.map((issue) => [issue.id as string, JSON.stringify(issue)]),
    );

    // If fewer than half changed, send a delta instead of full state
    if (changedIssues.length < issues.length / 2 || changedIssues.length <= 3) {
      const delta: Record<string, unknown> = {
        type: "state:delta",
        seq: broadcastSeq,
        metrics: message.metrics,
        capabilities: message.capabilities,
        updatedAt: message.updatedAt,
        issuesDelta: changedIssues,
        issuesRemoved: removedIds,
        events: message.events,
      };
      sendToAllClients(JSON.stringify(delta));
      return;
    }
  }

  // Full state broadcast (first time or too many changes)
  if (issues) {
    lastBroadcastIssueSnapshot = new Map(
      issues.map((issue) => [issue.id as string, JSON.stringify(issue)]),
    );
  }

  sendToAllClients(JSON.stringify({
    ...message,
    seq: broadcastSeq,
  }));
}

// ── API server ───────────────────────────────────────────────────────────────

export async function startApiServer(
  state: RuntimeState,
  port: number,
  workflowDefinition: WorkflowDefinition | null,
): Promise<void> {
  logger.info({ port }, "[API] Starting API server");
  const stateDb = getStateDb();
  if (!stateDb) {
    throw new Error("Cannot start API plugin before the database is initialized.");
  }

    const { ApiPlugin } = await loadS3dbModule();
  const eventResource = getEventStateResource();

  const listEvents = async (filters: { issueId?: string; kind?: string; since?: string } = {}): Promise<RuntimeEvent[]> => {
    const { issueId, kind, since } = filters;

    let events: RuntimeEvent[];
    if (eventResource?.list) {
      const partition = issueId && kind ? "byIssueIdAndKind"
        : issueId ? "byIssueId"
        : kind ? "byKind"
        : null;
      const partitionValues = issueId && kind ? { issueId, kind }
        : issueId ? { issueId }
        : kind ? { kind }
        : {};
      events = (await eventResource.list({ partition, partitionValues, limit: 200 }))
        .map((record) => record as RuntimeEvent);
    } else {
      events = state.events.filter((event) => {
        if (issueId && event.issueId !== issueId) return false;
        if (kind && event.kind !== kind) return false;
        return true;
      });
    }

    return typeof since === "string" && since
      ? events.filter((entry) => entry.at > since)
      : events;
  };

  const findIssue = (issueId: string): IssueEntry | undefined =>
    state.issues.find((issue) => issue.id === issueId || issue.identifier === issueId);

  const parseIssue = (c: any): string | null => {
    const value = c.req?.param ? c.req.param("id") : undefined;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };

  /** Apply plan token usage to issue tracking fields */
  const applyPlanUsage = (issue: IssueEntry, usage: PlanningSessionUsage) => {
    if (usage.totalTokens <= 0) return;
    const prev = issue.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    issue.tokenUsage = {
      inputTokens: prev.inputTokens + usage.inputTokens,
      outputTokens: prev.outputTokens + usage.outputTokens,
      totalTokens: prev.totalTokens + usage.totalTokens,
      model: usage.model,
    };
    if (!issue.tokensByPhase) issue.tokensByPhase = {} as any;
    const prevPlanner = issue.tokensByPhase.planner ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    issue.tokensByPhase.planner = {
      inputTokens: prevPlanner.inputTokens + usage.inputTokens,
      outputTokens: prevPlanner.outputTokens + usage.outputTokens,
      totalTokens: prevPlanner.totalTokens + usage.totalTokens,
      model: usage.model,
    };
    if (!issue.tokensByModel) issue.tokensByModel = {};
    const model = usage.model || "unknown";
    const prevModel = issue.tokensByModel[model] ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    issue.tokensByModel[model] = {
      inputTokens: prevModel.inputTokens + usage.inputTokens,
      outputTokens: prevModel.outputTokens + usage.outputTokens,
      totalTokens: prevModel.totalTokens + usage.totalTokens,
      model,
    };
    if (!issue.usage) issue.usage = { tokens: {} };
    issue.usage.tokens[model] = (issue.usage.tokens[model] || 0) + usage.totalTokens;
  };

  /** Apply plan suggestions to issue (paths, labels, effort) */
  const applyPlanSuggestions = (issue: IssueEntry, plan: import("./types.ts").IssuePlan) => {
    if (plan.suggestedPaths?.length && !(issue.paths?.length)) issue.paths = plan.suggestedPaths;
    if (plan.suggestedLabels?.length && !issue.labels?.length) issue.labels = plan.suggestedLabels;
    if (plan.suggestedEffort && !issue.effort) issue.effort = plan.suggestedEffort;
  };

  const mutateIssueState = async (c: any, updater: (issue: IssueEntry) => Promise<void> | void) => {
    const issueId = parseIssue(c);
    if (!issueId) {
      return c.json({ ok: false, error: "Issue id is required." }, 400);
    }

    const issue = findIssue(issueId);
    if (!issue) {
      return c.json({ ok: false, error: "Issue not found" }, 404);
    }

    await updater(issue);
    await persistState(state);
    wakeScheduler();
    return c.json({ ok: true, issue });
  };

  const resourceConfigs: Record<string, Record<string, unknown>> = Object.fromEntries(
    NATIVE_RESOURCE_CONFIGS.map((resourceConfig) => [
      resourceConfig.name,
      {
        ...(resourceConfig.api ?? {}),
        versionPrefix: "api",
      },
    ]),
  );
  const nativeResourceNames = new Set(Object.keys(resourceConfigs));

  const existingResources = await (stateDb as { listResources?: () => Promise<Array<{ name: string }>> }).listResources?.();
  for (const item of existingResources || []) {
    if (
      typeof item?.name === "string" &&
      item.name.startsWith("fifony_") &&
      !nativeResourceNames.has(item.name)
    ) {
      resourceConfigs[item.name] = { enabled: false };
    }
  }

  setApiRuntimeContext(state, workflowDefinition);

  const serveTextFile = (filePath: string, contentType: string, cacheControl = "no-cache") => {
    if (!existsSync(filePath)) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(readFileSync(filePath), {
      headers: {
        "content-type": contentType,
        "cache-control": cacheControl,
      },
    });
  };

  const serveAppShell = () => {
    if (!existsSync(FRONTEND_INDEX)) {
      return new Response("Not found", { status: 404 });
    }
    const html = readFileSync(FRONTEND_INDEX, "utf8")
      .replace('href="/assets/manifest.webmanifest"', 'href="/manifest.webmanifest"')
      .replaceAll('href="/assets/icon.svg"', 'href="/icon.svg"');
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  };

  const apiPlugin = new ApiPlugin({
    port,
    host: "0.0.0.0",
    versionPrefix: false,
    // HTTP + WebSocket on the same port via listeners
    listeners: [{
      bind: { host: "0.0.0.0", port },
      protocols: {
        http: true,
        websocket: {
          enabled: true,
          path: "/ws",
          maxPayloadBytes: 512_000,
          onConnection: (socketId: string, send: WsSendFn) => {
            wsClients.set(socketId, send);
            logger.debug(`WebSocket client connected: ${socketId} (total: ${wsClients.size})`);
            try {
              send(JSON.stringify({
                type: "connected",
                seq: broadcastSeq,
                timestamp: now(),
                metrics: computeMetrics(state.issues),
                capabilities: computeCapabilityCounts(state.issues),
                issues: state.issues,
                events: state.events.slice(0, 50),
              }));
            } catch (error) {
              logger.debug(`WebSocket initial send failed for ${socketId}: ${String(error)}`);
            }
          },
          onMessage: (socketId: string, message: string | Buffer, send: WsSendFn) => {
            try {
              const msg = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
              if (msg.type === "ping") {
                send(JSON.stringify({ type: "pong", timestamp: now() }));
              }
            } catch {}
          },
          onClose: (socketId: string) => {
            wsClients.delete(socketId);
            logger.debug(`WebSocket client disconnected: ${socketId} (total: ${wsClients.size})`);
          },
        },
      },
    }],
    rootRoute: () => new Response(null, {
      status: 302,
      headers: { location: "/kanban" },
    }),
    static: [{
      driver: "filesystem",
      path: "/assets",
      root: FRONTEND_DIR,
      pwa: false,
      config: { etag: true },
    }],
    docs: { enabled: true, title: "Fifony API", version: "1.0.0", description: "Local orchestration API for Fifony" },
    cors: { enabled: true, origin: "*" },
    security: { enabled: false },
    logging: { enabled: true, excludePaths: ["/health", "/status", "/**/*.js", "/**/*.css", "/**/*.svg"] },
    compression: { enabled: true, threshold: 1024 },
    health: { enabled: true },
    resources: {
      ...resourceConfigs,
    },
    routes: {
      "GET /manifest.webmanifest": () =>
        serveTextFile(FRONTEND_MANIFEST_JSON, "application/manifest+json; charset=utf-8"),
      "GET /service-worker.js": () =>
        serveTextFile(FRONTEND_SERVICE_WORKER_JS, "application/javascript; charset=utf-8", "no-cache"),
      "GET /offline.html": () =>
        serveTextFile(FRONTEND_OFFLINE_HTML, "text/html; charset=utf-8"),
      "GET /icon.svg": () =>
        serveTextFile(FRONTEND_ICON_SVG, "image/svg+xml", "public, max-age=604800, immutable"),
      "GET /icon-maskable.svg": () =>
        serveTextFile(FRONTEND_MASKABLE_ICON_SVG, "image/svg+xml", "public, max-age=604800, immutable"),
      "GET /kanban": () => serveAppShell(),
      "GET /issues": () => serveAppShell(),
      "GET /discover": () => serveAppShell(),
      "GET /agents": () => serveAppShell(),
      "GET /settings": () => serveAppShell(),
      "GET /settings/general": () => serveAppShell(),
      "GET /settings/notifications": () => serveAppShell(),
      "GET /settings/workflow": () => serveAppShell(),
      "GET /settings/providers": () => serveAppShell(),
      "GET /api/health": (c: any) =>
        c.json({ status: (state as any).booting ? "booting" : "ready" }),
      "GET /api/state": async (c: any) => {
        const showAll = c.req.query("all") === "1";
        let issues = state.issues;

        if (!showAll) {
          // Default: active issues + terminal from this week and last week
          const thisWeek = isoWeek();
          const lastWeekDate = new Date();
          lastWeekDate.setUTCDate(lastWeekDate.getUTCDate() - 7);
          const lastWeek = isoWeek(lastWeekDate);
          const recentWeeks = new Set([thisWeek, lastWeek]);

          issues = state.issues.filter((i) => {
            if (!i.terminalWeek) return true; // active issue
            return recentWeeks.has(i.terminalWeek);
          });
        }

        return c.json({
          ...state,
          issues,
          capabilities: computeCapabilityCounts(issues),
          metrics: computeMetrics(issues),
          _filter: showAll ? "all" : "recent",
          _totalIssues: state.issues.length,
        });
      },
      "GET /api/status": async (c: any) =>
        c.json({
          status: "ok",
          updatedAt: state.updatedAt,
          config: state.config,
          trackerKind: state.trackerKind,
        }),
      "GET /api/providers": async (c: any) => {
        const providers = detectAvailableProviders();
        return c.json({ providers });
      },
      "GET /api/parallelism": async (c: any) => {
        return c.json(analyzeParallelizability(state.issues));
      },
      "GET /api/providers/usage": async (c: any) => {
        try {
          const usage = collectProvidersUsage();
          return c.json(usage);
        } catch (error) {
          logger.error({ err: error }, "Failed to collect providers usage");
          return c.json({ providers: [] }, 500);
        }
      },
      "GET /api/settings": async (c: any) => {
        const settings = await loadRuntimeSettings();
        return c.json({ settings });
      },
      "GET /api/settings/:id": async (c: any) => {
        const settingId = c.req?.param ? c.req.param("id") : "";
        const settings = await loadRuntimeSettings();
        const setting = settings.find((entry) => entry.id === settingId);
        if (!setting) {
          return c.json({ ok: false, error: "Setting not found" }, 404);
        }
        return c.json({ ok: true, setting });
      },
      "POST /api/settings/:id": async (c: any) => {
        const settingId = c.req?.param ? c.req.param("id") : "";
        if (!settingId) {
          return c.json({ ok: false, error: "Setting id is required" }, 400);
        }

        const payload = await c.req.json() as JsonRecord;
        const scopeValue = typeof payload.scope === "string" ? payload.scope : inferSettingScope(settingId);
        const sourceValue = typeof payload.source === "string" ? payload.source : "user";

        if (!VALID_SETTING_SCOPES.has(scopeValue as RuntimeSettingScope)) {
          return c.json({ ok: false, error: "Invalid setting scope" }, 400);
        }

        if (!VALID_SETTING_SOURCES.has(sourceValue as RuntimeSettingSource)) {
          return c.json({ ok: false, error: "Invalid setting source" }, 400);
        }

        const setting = await persistSetting(settingId, payload.value, {
          scope: scopeValue as RuntimeSettingScope,
          source: sourceValue as RuntimeSettingSource,
        });
        if (RUNTIME_CONFIG_SETTING_IDS.has(settingId)) {
          state.config = applyPersistedSettings(state.config, [setting]);
          state.updatedAt = now();
          addEvent(state, undefined, "manual", `Runtime setting ${settingId} updated.`);
          await persistState(state);
        }
        return c.json({ ok: true, setting });
      },
      "POST /api/config/concurrency": async (c: any) => {
        const payload = await c.req.json() as JsonRecord;
        const value = typeof payload.concurrency === "number" ? payload.concurrency : undefined;
        if (!value || value < 1 || value > 16) {
          return c.json({ ok: false, error: "concurrency must be between 1 and 16" }, 400);
        }
        state.config.workerConcurrency = clamp(Math.round(value), 1, 16);
        state.updatedAt = now();
        addEvent(state, undefined, "manual", `Worker concurrency updated to ${state.config.workerConcurrency}.`);
        await persistWorkerConcurrencySetting(state.config.workerConcurrency);
        await persistState(state);
        return c.json({ ok: true, workerConcurrency: state.config.workerConcurrency });
      },
      "GET /api/config/workflow": async (c: any) => {
        const settings = await loadRuntimeSettings();
        const saved = getWorkflowConfig(settings);
        const providers = detectAvailableProviders();
        const models = await discoverModels(providers);
        const defaultConfig = buildDefaultWorkflowConfig(providers, models);
        return c.json({ ok: true, workflow: saved || defaultConfig, isDefault: !saved, providers, models });
      },
      "GET /api/config/models": async (c: any) => {
        const providers = detectAvailableProviders();
        const models = await discoverModels(providers);
        return c.json({ ok: true, models });
      },
      "GET /api/analytics/tokens": async (c: any) => {
        // O(1) read from in-memory ledger — no disk I/O, no scans
        return c.json({ ok: true, ...getTokenAnalytics() });
      },
      "POST /api/config/workflow": async (c: any) => {
        try {
          const payload = await c.req.json() as JsonRecord;
          const workflow = payload.workflow as any;
          if (!workflow?.plan?.provider || !workflow?.execute?.provider || !workflow?.review?.provider) {
            return c.json({ ok: false, error: "Invalid workflow config. Each stage needs provider, model, and effort." }, 400);
          }
          await persistWorkflowConfig(workflow);
          addEvent(state, undefined, "manual", `Workflow config updated: plan=${workflow.plan.provider}/${workflow.plan.model}, execute=${workflow.execute.provider}/${workflow.execute.model}, review=${workflow.review.provider}/${workflow.review.model}.`);
          return c.json({ ok: true, workflow });
        } catch (error) {
          return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
        }
      },
      "GET /api/planning/session": async (c: any) => {
        const session = await loadPlanningSession();
        return c.json({ ok: true, session });
      },
      "POST /api/planning/save": async (c: any) => {
        try {
          const payload = await c.req.json() as JsonRecord;
          const title = toStringValue(payload.title);
          const description = toStringValue(payload.description);
          const session = await savePlanningInput(title, description);
          return c.json({ ok: true, session });
        } catch (error) {
          return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
        }
      },
      "POST /api/planning/generate": async (c: any) => {
        try {
          const payload = await c.req.json() as JsonRecord;
          const title = toStringValue(payload.title);
          const description = toStringValue(payload.description);
          if (!title) return c.json({ ok: false, error: "Title is required." }, 400);
          logger.info({ title: title.slice(0, 80) }, "[API] POST /api/planning/generate");
          const result = await generatePlan(title, description, state.config, workflowDefinition);
          return c.json({ ok: true, plan: result.plan, usage: result.usage });
        } catch (error) {
          logger.error({ err: error }, `Plan generation failed: ${String(error)}`);
          return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
        }
      },
      "POST /api/planning/clear": async (c: any) => {
        await clearPlanningSession();
        return c.json({ ok: true });
      },
      "POST /api/issues/plan": async (c: any) => {
        // Legacy alias
        try {
          const payload = await c.req.json() as JsonRecord;
          const title = toStringValue(payload.title);
          const description = toStringValue(payload.description);
          if (!title) return c.json({ ok: false, error: "Title is required." }, 400);
          const result = await generatePlan(title, description, state.config, workflowDefinition);
          return c.json({ ok: true, plan: result.plan, usage: result.usage });
        } catch (error) {
          logger.error({ err: error }, `Plan generation failed: ${String(error)}`);
          return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
        }
      },
      "POST /api/issues/create": async (c: any) => {
        try {
          const payload = await c.req.json() as JsonRecord;
          logger.info({ title: toStringValue(payload.title, "").slice(0, 80) }, "[API] POST /api/issues/create");
          const issue = createIssueFromPayload(payload, state.issues, workflowDefinition);
          state.issues.push(issue);
          markIssueDirty(issue.id);
          addEvent(state, issue.id, "info", `Issue ${issue.identifier} created via API.`);
          if (issue.plan) {
            addEvent(state, issue.id, "info", `Plan: ${issue.plan.steps.length} steps, complexity: ${issue.plan.estimatedComplexity}.`);
          }
          await persistState(state);
          wakeScheduler();
          return c.json({ ok: true, issue }, 201);
        } catch (error) {
          return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
      },
      "POST /api/issues/enhance": async (c: any) => {
        try {
          const payload = await c.req.json() as JsonRecord;
          const field = payload.field === "description" ? "description" : payload.field === "title" ? "title" : null;
          if (!field) {
            return c.json({ ok: false, error: 'Invalid field. Expected "title" or "description".' }, 400);
          }

          const title = toStringValue(payload.title);
          const description = toStringValue(payload.description);
          const provider = toStringValue(payload.provider, state.config.agentProvider);

          const result = await enhanceIssueField(
            { field, title, description, provider },
            state.config,
            workflowDefinition,
          );

          return c.json({ ok: true, field: result.field, value: result.value, provider: result.provider });
        } catch (error) {
          logger.error({ err: error }, `Issue enhance failed: ${String(error)}`);
          return c.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            500,
          );
        }
      },
      "POST /api/issues/:id/state": async (c: any) => {
        const issueId = parseIssue(c);
        if (!issueId) {
          return c.json({ ok: false, error: "Issue id is required." }, 400);
        }

        const issue = findIssue(issueId);
        if (!issue) {
          return c.json({ ok: false, error: "Issue not found" }, 404);
        }

        try {
          const payload = await c.req.json() as JsonRecord;
          logger.info({ issueId, identifier: issue.identifier, targetState: payload.state }, "[API] POST /api/issues/:id/state");
          await handleStatePatch(state, issue, payload);
          await persistState(state);
          wakeScheduler();
          return c.json({ ok: true, issue });
        } catch (error) {
          return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
      },
      "POST /api/issues/:id/retry": async (c: any) => {
        logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/retry");
        return mutateIssueState(c, async (issue) => {
          if (TERMINAL_STATES.has(issue.state)) {
            await transitionIssueState(issue, "Todo", "Manual retry requested.");
          } else {
            issue.lastError = undefined;
            issue.nextRetryAt = undefined;
            issue.updatedAt = now();
          }

          addEvent(state, issue.id, "manual", `Manual retry requested for ${issue.id}.`);
        });
      },
      "POST /api/issues/:id/cancel": async (c: any) => {
        logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/cancel");
        return mutateIssueState(c, async (issue) => {
          await transitionIssueState(issue, "Cancelled", "Manual cancel requested.");
          addEvent(state, issue.id, "manual", `Manual cancel requested for ${issue.id}.`);
        });
      },
      "POST /api/issues/:id/plan": async (c: any) => {
        return mutateIssueState(c, async (issue) => {
          if (issue.state !== "Planning") {
            throw new Error(`Cannot plan issue in state ${issue.state}. Must be in Planning.`);
          }
          if (issue.planningStatus === "planning" || issue.planningStatus === "refining") {
            throw new Error("A plan is already being generated for this issue.");
          }
          const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
          const fast = body.fast === true;

          // Fire-and-forget — plan runs in background, updates via WS
          generatePlanInBackground(issue, state.config, workflowDefinition, {
            addEvent: (issueId, kind, message) => addEvent(state, issueId, kind as any, message),
            persistState: () => persistState(state),
            applyUsage: (iss, usage) => applyPlanUsage(iss, usage),
            applySuggestions: (iss, plan) => applyPlanSuggestions(iss, plan),
          }, { fast });

          addEvent(state, issue.id, "progress", `${fast ? "Fast plan" : "Plan"} generation started for ${issue.identifier}.`);
        });
      },
      "POST /api/issues/:id/approve": async (c: any) => {
        logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/approve");
        return mutateIssueState(c, async (issue) => {
          if (issue.state !== "Planning") {
            throw new Error(`Cannot approve issue in state ${issue.state}. Must be in Planning.`);
          }
          await transitionIssueState(issue, "Todo", `Plan approved for ${issue.identifier}. Ready for execution.`);
          addEvent(state, issue.id, "state", `Plan approved — ${issue.identifier} moved to Todo.`);
        });
      },
      "POST /api/issues/:id/merge": async (c: any) => {
        logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/merge");
        try {
          const issueId = parseIssue(c);
          if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
          const issue = findIssue(issueId);
          if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);
          const wp = issue.workspacePath;
          if (!wp || !existsSync(wp)) {
            return c.json({ ok: false, error: "No workspace found for this issue." }, 400);
          }
          const result = mergeWorkspace(wp);
          const conflictMsg = result.conflicts.length > 0
            ? ` ${result.conflicts.length} conflict(s): ${result.conflicts.join(", ")}.`
            : "";
          addEvent(state, issue.id, "merge", `Workspace merged: ${result.copied.length} file(s) copied, ${result.deleted.length} deleted.${conflictMsg}`);
          if (result.conflicts.length > 0) {
            addEvent(state, issue.id, "error", `Merge conflicts: ${result.conflicts.join(", ")}`);
          }
          await persistState(state);
          return c.json({ ok: true, ...result });
        } catch (error) {
          const issueId = parseIssue(c);
          logger.error(`Failed to merge workspace for ${issueId || "<unknown>"}: ${String(error)}`);
          return c.json({ ok: false, error: String(error) }, 500);
        }
      },
      "POST /api/issues/:id/plan/refine": async (c: any) => {
        return mutateIssueState(c, async (issue) => {
          if (issue.state !== "Planning") {
            throw new Error(`Cannot refine plan for issue in state ${issue.state}. Must be in Planning.`);
          }
          if (!issue.plan) {
            throw new Error("Issue has no plan to refine. Generate a plan first.");
          }
          if (issue.planningStatus === "planning" || issue.planningStatus === "refining") {
            throw new Error("A plan operation is already in progress for this issue.");
          }
          const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
          const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
          if (!feedback) {
            throw new Error("Feedback message is required.");
          }

          // Fire-and-forget — refinement runs in background, updates via WS
          refinePlanInBackground(issue, feedback, state.config, workflowDefinition, {
            addEvent: (issueId, kind, message) => addEvent(state, issueId, kind as any, message),
            persistState: () => persistState(state),
            applyUsage: (iss, usage) => applyPlanUsage(iss, usage),
            applySuggestions: (iss, plan) => {
              if (plan.suggestedPaths?.length) iss.paths = plan.suggestedPaths;
              if (plan.suggestedLabels?.length) iss.labels = plan.suggestedLabels;
              if (plan.suggestedEffort) iss.effort = plan.suggestedEffort;
            },
          });

          addEvent(state, issue.id, "progress", `Plan refinement started for ${issue.identifier}.`);
        });
      },
      "POST /api/refresh": async (c: any) => {
        addEvent(state, undefined, "manual", "Manual refresh requested via API.");
        await persistState(state);
        return c.json({ queued: true, requestedAt: now() }, 202);
      },
      "GET /api/live/:id": async (c: any) => {
        try {
          const issueId = parseIssue(c);
          if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
          const issue = findIssue(issueId);
          if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);

          const parseStartedAt = (value: unknown): number | null => {
            const valueText = typeof value === "string" ? value.trim() : "";
            if (!valueText) return null;
            const ts = Date.parse(valueText);
            return Number.isFinite(ts) ? ts : null;
          };

          const startedAtText = toStringValue(issue.startedAt, "");
          const updatedAtText = toStringValue(issue.updatedAt, "");
          const startedAtTs = parseStartedAt(startedAtText) ?? parseStartedAt(updatedAtText);
          const elapsed = startedAtTs ? Date.now() - startedAtTs : 0;

          const wp = issue.workspacePath;
          const liveLog = wp ? `${wp}/fifony-live-output.log` : null;
          let logTail = "";
          let logSize = 0;
          if (liveLog && existsSync(liveLog)) {
            try {
              const stat = statSync(liveLog);
              logSize = stat.size;
              // Read last 8KB
              const fd = openSync(liveLog, "r");
              const readSize = Math.min(logSize, 8192);
              const buf = Buffer.alloc(readSize);
              readSync(fd, buf, 0, readSize, Math.max(0, logSize - readSize));
              closeSync(fd);
              logTail = buf.toString("utf8");
            } catch {}
          }
          const agentStatus = isAgentStillRunning(issue);
          return c.json({
            ok: true,
            issueId: issue.id,
            state: issue.state,
            running: issue.state === "Running" || issue.state === "In Review",
            agentAlive: agentStatus.alive,
            agentPid: agentStatus.pid?.pid ?? null,
            startedAt: startedAtText || updatedAtText || now(),
            elapsed: Number.isFinite(elapsed) ? elapsed : 0,
            logSize,
            logTail,
            outputTail: issue.commandOutputTail || "",
          });
        } catch (error) {
          const issueId = parseIssue(c);
          logger.error(`Failed to load live issue state for ${issueId || "<unknown>"}: ${String(error)}`);
          return c.json({ ok: false, error: "Failed to load live issue state." }, 500);
        }
      },
      "GET /api/diff/:id": async (c: any) => {
        try {
          const issueId = parseIssue(c);
          if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
          const issue = findIssue(issueId);
          if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);
          const wp = issue.workspacePath;
          if (!wp || !existsSync(wp)) {
            return c.json({ ok: true, files: [], diff: "", message: "No workspace found." });
          }
          if (!existsSync(SOURCE_ROOT)) {
            return c.json({ ok: true, files: [], diff: "", message: "Source root not found." });
          }
          let raw = "";
          try {
            raw = execSync(
              `git diff --no-index --no-color -- "${SOURCE_ROOT}" "${wp}"`,
              { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
            );
          } catch (err: any) {
            // git diff --no-index exits 1 when diffs exist — normal
            raw = err.stdout || "";
          }

          if (!raw.trim()) {
            return c.json({ ok: true, files: [], diff: "", message: "No changes" });
          }

          // Clean paths: replace absolute paths with relative a/ b/ style
          const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const sourcePrefix = SOURCE_ROOT.endsWith("/") ? SOURCE_ROOT : `${SOURCE_ROOT}/`;
          const wpPrefix = wp.endsWith("/") ? wp : `${wp}/`;
          const cleaned = raw
            .replace(new RegExp(esc(wpPrefix), "g"), "b/")
            .replace(new RegExp(esc(sourcePrefix), "g"), "a/");

          // Split into per-file chunks and filter internals
          const internalRe = /^(fifony[-_]|\.fifony-|WORKFLOW\.local)/;
          const chunks = cleaned.split(/(?=^diff --git )/m);
          const filtered = chunks.filter((chunk) => {
            const m = chunk.match(/^diff --git a\/(.+?) b\//);
            if (!m) return false;
            const basename = m[1].split("/").pop() || "";
            return !internalRe.test(basename);
          });

          const diff = filtered.join("").trim();

          // Per-file summary (like GitHub PR file list)
          const files = filtered.map((chunk) => {
            const pathMatch = chunk.match(/^diff --git a\/(.+?) b\//);
            const path = pathMatch?.[1] || "unknown";
            const additions = (chunk.match(/^\+[^+]/gm) || []).length;
            const deletions = (chunk.match(/^-[^-]/gm) || []).length;
            const isNew = chunk.includes("new file mode");
            const isDeleted = chunk.includes("deleted file mode");
            const status = isNew ? "added" : isDeleted ? "removed" : "modified";
            return { path, status, additions, deletions };
          });

          const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
          const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

          return c.json({ ok: true, files, diff, totalAdditions, totalDeletions });
        } catch (error) {
          const issueId = parseIssue(c);
          logger.error(`Failed to load issue diff for ${issueId || "<unknown>"}: ${String(error)}`);
          return c.json({ ok: false, error: "Failed to load issue diff." }, 500);
        }
      },
      // Token analytics served from in-memory ledger (primary endpoint is above)
      "GET /api/analytics/tokens/weekly": async (c: any) => {
        // Weekly is part of the daily data in the ledger — filter client-side
        return c.json({ ok: true, ...getTokenAnalytics() });
      },
      "GET /api/analytics/hourly": async (c: any) => {
        const hours = Math.min(parseInt(c.req.query("hours") || "24", 10) || 24, 48);
        return c.json({ ok: true, ...getHourlySnapshot(hours) });
      },
      "GET /api/events/feed": async (c: any) => {
        const since = c.req.query("since");
        const issueId = c.req.query("issueId");
        const kind = c.req.query("kind");
        const events = await listEvents({
          since: typeof since === "string" ? since : undefined,
          issueId: typeof issueId === "string" && issueId ? issueId : undefined,
          kind: typeof kind === "string" && kind ? kind : undefined,
        });
        return c.json({ events: events.slice(0, 200) });
      },
      // ── Onboarding: gitignore check ────────────────────────────────────
      "GET /api/gitignore/status": async (c: any) => {
        try {
          const gitignorePath = join(TARGET_ROOT, ".gitignore");
          if (!existsSync(gitignorePath)) {
            return c.json({ exists: false, hasFifony: false });
          }
          const content = readFileSync(gitignorePath, "utf-8");
          const lines = content.split("\n").map((l: string) => l.trim());
          const hasFifony = lines.some((l: string) => l === ".fifony" || l === ".fifony/" || l === "/.fifony" || l === "/.fifony/");
          return c.json({ exists: true, hasFifony });
        } catch (error) {
          logger.error({ err: error }, "Failed to check .gitignore");
          return c.json({ exists: false, hasFifony: false, error: "Failed to check .gitignore" }, 500);
        }
      },
      "POST /api/gitignore/add": async (c: any) => {
        try {
          const gitignorePath = join(TARGET_ROOT, ".gitignore");
          if (!existsSync(gitignorePath)) {
            writeFileSync(gitignorePath, "# Fifony state directory\n.fifony/\n", "utf-8");
            return c.json({ ok: true, created: true });
          }
          const content = readFileSync(gitignorePath, "utf-8");
          const lines = content.split("\n").map((l: string) => l.trim());
          const hasFifony = lines.some((l: string) => l === ".fifony" || l === ".fifony/" || l === "/.fifony" || l === "/.fifony/");
          if (hasFifony) {
            return c.json({ ok: true, alreadyPresent: true });
          }
          const suffix = content.endsWith("\n") ? "" : "\n";
          appendFileSync(gitignorePath, `${suffix}\n# Fifony state directory\n.fifony/\n`, "utf-8");
          return c.json({ ok: true, added: true });
        } catch (error) {
          logger.error({ err: error }, "Failed to update .gitignore");
          return c.json({ ok: false, error: "Failed to update .gitignore" }, 500);
        }
      },
      // ── Onboarding: project scanning & catalog ─────────────────────────
      "GET /api/scan/project": async (c: any) => {
        try {
          const result = scanProjectFiles(TARGET_ROOT);
          return c.json(result);
        } catch (error) {
          logger.error({ err: error }, "Failed to scan project files");
          return c.json({ ok: false, error: "Failed to scan project." }, 500);
        }
      },
      "POST /api/scan/analyze": async (c: any) => {
        try {
          const payload = await c.req.json() as { provider?: string };
          const provider = typeof payload.provider === "string" ? payload.provider : state.config.agentProvider;
          const result = await analyzeProjectWithCli(provider, TARGET_ROOT);
          return c.json(result);
        } catch (error) {
          logger.error({ err: error }, "Failed to analyze project with CLI");
          return c.json({ ok: false, error: "Failed to analyze project." }, 500);
        }
      },
      "GET /api/scan/issues": async (c: any) => {
        try {
          const todos = scanForTodos(TARGET_ROOT);
          const categorized = categorizeScannedIssues(todos, workflowDefinition);
          return c.json({ ok: true, issues: categorized, total: categorized.length });
        } catch (error) {
          logger.error({ err: error }, "Failed to scan for TODOs");
          return c.json({ ok: false, error: "Failed to scan for issues." }, 500);
        }
      },
      "POST /api/boot/skip-scan": async (c: any) => {
        broadcastToWebSocketClients({ type: "boot:scan:skipped" });
        return c.json({ ok: true, message: "Scan skipped." });
      },
      "GET /api/scan/github-issues": async (c: any) => {
        try {
          const issues = await fetchGitHubIssues(TARGET_ROOT);
          const categorized = categorizeScannedIssues(issues, workflowDefinition);
          return c.json({ ok: true, issues: categorized, total: categorized.length });
        } catch (error) {
          logger.error({ err: error }, "Failed to fetch GitHub issues");
          return c.json({ ok: false, error: "Failed to fetch GitHub issues." }, 500);
        }
      },
      "GET /api/catalog/agents": async (c: any) => {
        const domainsParam = c.req.query("domains");
        const domains = typeof domainsParam === "string"
          ? domainsParam.split(",").map((d: string) => d.trim()).filter(Boolean)
          : [];
        const catalog = loadAgentCatalog();
        return c.json({ agents: domains.length ? filterByDomains(catalog, domains) : catalog });
      },
      "GET /api/catalog/skills": async (c: any) => {
        const catalog = loadSkillCatalog();
        return c.json({ skills: catalog });
      },
      "POST /api/install/agents": async (c: any) => {
        try {
          const payload = await c.req.json() as { agents?: string[] };
          const agentNames = Array.isArray(payload.agents) ? payload.agents.filter((a): a is string => typeof a === "string") : [];
          if (agentNames.length === 0) {
            return c.json({ ok: false, error: "No agent names provided." }, 400);
          }
          const catalog = loadAgentCatalog();
          const result = installAgents(TARGET_ROOT, agentNames, catalog);
          return c.json({ ok: true, ...result });
        } catch (error) {
          logger.error({ err: error }, "Failed to install agents");
          return c.json({ ok: false, error: "Failed to install agents." }, 500);
        }
      },
      "POST /api/install/skills": async (c: any) => {
        try {
          const payload = await c.req.json() as { skills?: string[] };
          const skillNames = Array.isArray(payload.skills) ? payload.skills.filter((s): s is string => typeof s === "string") : [];
          if (skillNames.length === 0) {
            return c.json({ ok: false, error: "No skill names provided." }, 400);
          }
          const catalog = loadSkillCatalog();
          const result = installSkills(TARGET_ROOT, skillNames, catalog);
          return c.json({ ok: true, ...result });
        } catch (error) {
          logger.error({ err: error }, "Failed to install skills");
          return c.json({ ok: false, error: "Failed to install skills." }, 500);
        }
      },
    },
  });

  const plugin = await stateDb.usePlugin(apiPlugin, "api") as { stop?: () => Promise<void> };
  setActiveApiPlugin(plugin);
  logger.info(`Local dashboard available at http://localhost:${port}`);
  logger.info(`WebSocket available at ws://localhost:${port}/ws`);
  logger.info(`State API: http://localhost:${port}/api/state`);
  logger.info(`OpenAPI docs available at http://localhost:${port}/docs`);
}
