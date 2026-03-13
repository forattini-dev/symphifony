import type {
  IssueEntry,
  JsonRecord,
  RuntimeEvent,
  RuntimeState,
  WorkflowDefinition,
} from "./types.ts";
import {
  FRONTEND_INDEX,
  FRONTEND_APP_JS,
  FRONTEND_STYLES_CSS,
  S3DB_RUNTIME_RESOURCE,
  S3DB_ISSUE_RESOURCE,
  S3DB_EVENT_RESOURCE,
  S3DB_AGENT_SESSION_RESOURCE,
  S3DB_AGENT_PIPELINE_RESOURCE,
  TERMINAL_STATES,
  ALLOWED_STATES,
} from "./constants.ts";
import { now, toStringValue, normalizeState, readTextOrNull, clamp } from "./helpers.ts";
import { logger } from "./logger.ts";
import {
  loadS3dbModule,
  getStateDb,
  getIssueStateResource,
  getEventStateResource,
  setActiveApiPlugin,
  persistState,
} from "./store.ts";
import {
  addEvent,
  createIssueFromPayload,
  computeCapabilityCounts,
  handleStatePatch,
  transition,
} from "./issues.ts";
import {
  getEffectiveAgentProviders,
  detectAvailableProviders,
} from "./providers.ts";
import {
  loadAgentPipelineSnapshotForIssue,
  loadAgentSessionSnapshotsForIssue,
} from "./agent.ts";
import { analyzeParallelizability } from "./scheduler.ts";

export async function startApiServer(
  state: RuntimeState,
  port: number,
  workflowDefinition: WorkflowDefinition | null,
): Promise<void> {
  const stateDb = getStateDb();
  if (!stateDb) {
    throw new Error("Cannot start API plugin before the database is initialized.");
  }

  const { ApiPlugin } = await loadS3dbModule();
  const indexHtml = readTextOrNull(FRONTEND_INDEX) ?? "";
  const appJs = readTextOrNull(FRONTEND_APP_JS) ?? "";
  const stylesCss = readTextOrNull(FRONTEND_STYLES_CSS) ?? "";

  const fallback = `<!doctype html><html><body><pre>Unable to load Symphifo dashboard assets.</pre></body></html>`;
  const findIssue = (issueId: string) =>
    state.issues.find((c) => c.id === issueId || c.identifier === issueId);

  const issueResource = getIssueStateResource();
  const eventResource = getEventStateResource();

  const listIssues = async (filters: { state?: string; capabilityCategory?: string } = {}): Promise<IssueEntry[]> => {
    const { state: issueState, capabilityCategory } = filters;

    if (issueResource?.list) {
      const partition = issueState && capabilityCategory
        ? "byStateAndCapability"
        : issueState ? "byState"
        : capabilityCategory ? "byCapabilityCategory"
        : null;
      const partitionValues = issueState && capabilityCategory
        ? { state: issueState, capabilityCategory }
        : issueState ? { state: issueState }
        : capabilityCategory ? { capabilityCategory }
        : {};
      const records = await issueResource.list({ partition, partitionValues, limit: 500 });
      return records.map((record) => record as IssueEntry);
    }

    return state.issues.filter((issue) => {
      if (issueState && issue.state !== issueState) return false;
      if (capabilityCategory && issue.capabilityCategory !== capabilityCategory) return false;
      return true;
    });
  };

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

  const dashboardHtml = indexHtml || fallback;

  const apiPlugin = new ApiPlugin({
    port,
    host: "0.0.0.0",
    versionPrefix: false,
    rootRoute: (c: any) => c.html(dashboardHtml),
    docs: { enabled: true, title: "Symphifo API", version: "1.0.0", description: "Local orchestration API for Symphifo" },
    cors: { enabled: true, origin: "*" },
    logging: { enabled: true, excludePaths: ["/health", "/api/health"] },
    compression: { enabled: true, threshold: 1024 },
    health: { enabled: true },
    resources: {
      [S3DB_RUNTIME_RESOURCE]: { auth: false, methods: ["GET", "HEAD", "OPTIONS"] },
      [S3DB_ISSUE_RESOURCE]: { auth: false, methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] },
      [S3DB_EVENT_RESOURCE]: { auth: false, methods: ["GET", "HEAD", "OPTIONS"] },
      [S3DB_AGENT_SESSION_RESOURCE]: { auth: false, methods: ["GET", "HEAD", "OPTIONS"] },
      [S3DB_AGENT_PIPELINE_RESOURCE]: { auth: false, methods: ["GET", "HEAD", "OPTIONS"] },
    },
    routes: {
      "GET /api/state": async () => ({
        ...state,
        capabilities: computeCapabilityCounts(state.issues),
      }),
      "GET /api/health": async () => ({
        status: "ok",
        updatedAt: state.updatedAt,
        config: state.config,
        trackerKind: state.trackerKind,
      }),
      "GET /api/providers": async () => {
        const providers = detectAvailableProviders();
        return { providers };
      },
      "GET /api/parallelism": async () => {
        return analyzeParallelizability(state.issues);
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
        await persistState(state);
        return { ok: true, workerConcurrency: state.config.workerConcurrency };
      },
      "GET /api/events": async (c: any) => {
        const since = c.req.query("since");
        const issueId = c.req.query("issueId");
        const kind = c.req.query("kind");
        const events = await listEvents({
          since: typeof since === "string" ? since : undefined,
          issueId: typeof issueId === "string" && issueId ? issueId : undefined,
          kind: typeof kind === "string" && kind ? kind : undefined,
        });
        return { events: events.slice(0, 200) };
      },
      "GET /api/issue/:id/pipeline": async (c: any) => {
        const issue = findIssue(c.req.param("id"));
        if (!issue) return c.json({ ok: false, error: "Issue not found" }, 404);

        const providers = getEffectiveAgentProviders(state, issue, workflowDefinition);
        const pipeline = await loadAgentPipelineSnapshotForIssue(issue, providers);
        return { ok: true, issueId: issue.id, pipeline };
      },
      "GET /api/issue/:id/sessions": async (c: any) => {
        const issue = findIssue(c.req.param("id"));
        if (!issue) return c.json({ ok: false, error: "Issue not found" }, 404);

        const providers = getEffectiveAgentProviders(state, issue, workflowDefinition);
        const pipeline = await loadAgentPipelineSnapshotForIssue(issue, providers);
        const sessions = await loadAgentSessionSnapshotsForIssue(issue, providers, pipeline, workflowDefinition);
        return { ok: true, issueId: issue.id, pipeline, sessions };
      },
      "POST /api/issue/:id/state": async (c: any) => {
        const issue = findIssue(c.req.param("id"));
        if (!issue) return c.json({ ok: false, error: "Issue not found" }, 404);

        const payload = await c.req.json() as JsonRecord;
        try {
          handleStatePatch(state, issue, payload);
          await persistState(state);
          return { ok: true, issue };
        } catch (error) {
          return c.json({ ok: false, error: String(error) }, 400);
        }
      },
      "POST /api/issue/:id/retry": async (c: any) => {
        const issue = findIssue(c.req.param("id"));
        if (!issue) return c.json({ ok: false, error: "Issue not found" }, 404);

        if (TERMINAL_STATES.has(issue.state)) {
          issue.state = "Todo";
          issue.attempts = Math.max(0, issue.attempts - 1);
          issue.lastError = undefined;
          issue.nextRetryAt = undefined;
          transition(issue, "Todo", "Manual retry requested.");
        } else {
          issue.nextRetryAt = undefined;
          issue.lastError = undefined;
        }

        addEvent(state, issue.id, "manual", `Manual retry requested for ${issue.id}.`);
        await persistState(state);
        return { ok: true, issue };
      },
      "POST /api/issue/:id/cancel": async (c: any) => {
        const issue = findIssue(c.req.param("id"));
        if (!issue) return c.json({ ok: false, error: "Issue not found" }, 404);

        transition(issue, "Cancelled", "Manual cancel requested.");
        addEvent(state, issue.id, "manual", `Manual cancel requested for ${issue.id}.`);
        await persistState(state);
        return { ok: true, issue };
      },
      "GET /state": async (c: any) => c.redirect("/api/state"),
      "GET /index.html": async (c: any) => c.html(dashboardHtml),
      "GET /assets/app.js": async (c: any) => c.body(appJs || "console.log('Dashboard script not found.');", 200, {
        "content-type": "application/javascript; charset=utf-8",
      }),
      "GET /assets/styles.css": async (c: any) => c.body(stylesCss || "", 200, {
        "content-type": "text/css; charset=utf-8",
      }),
    },
  });

  const plugin = await stateDb.usePlugin(apiPlugin, "api") as { stop?: () => Promise<void> };
  setActiveApiPlugin(plugin);
  logger.info(`Local dashboard available at http://localhost:${port}`);
  logger.info(`State API: http://localhost:${port}/api/state`);
  logger.info(`OpenAPI docs available at http://localhost:${port}/docs`);
}
