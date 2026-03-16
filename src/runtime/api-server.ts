import type {
  JsonRecord,
  RuntimeEvent,
  RuntimeState,
  IssueEntry,
  WorkflowDefinition,
} from "./types.ts";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  FRONTEND_DIR,
  FRONTEND_INDEX,
  SOURCE_ROOT,
} from "./constants.ts";
import { NATIVE_RESOURCE_CONFIGS } from "./resources/index.ts";
import { now, readTextOrNull, clamp, toStringValue } from "./helpers.ts";
import { logger } from "./logger.ts";
import {
  loadS3dbModule,
  getStateDb,
  getEventStateResource,
  setActiveApiPlugin,
  persistState,
} from "./store.ts";
import {
  addEvent,
  computeCapabilityCounts,
  computeMetrics,
  createIssueFromPayload,
  handleStatePatch,
  transitionIssueState,
} from "./issues.ts";
import { detectAvailableProviders } from "./providers.ts";
import { collectProvidersUsage } from "./providers-usage.ts";
import { analyzeParallelizability } from "./scheduler.ts";
import { setApiRuntimeContext } from "./api-runtime-context.ts";
import { TERMINAL_STATES } from "./constants.ts";
import { enhanceIssueField } from "./issue-enhancer.ts";

// ── WebSocket broadcast (same port via listeners) ────────────────────────────
// s3db.js 21.2.7 WebSocket contract: handlers receive (socketId, send, req)
// instead of raw socket objects. We track socketId → send function.

type WsSendFn = (data: string) => void;
const wsClients = new Map<string, WsSendFn>(); // socketId → send
let broadcastSeq = 0;
let lastBroadcastIssueSnapshot: Map<string, string> = new Map(); // id → JSON

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
    return c.json({ ok: true, issue });
  };

  const resourceConfigs: Record<string, Record<string, unknown>> = Object.fromEntries(
    NATIVE_RESOURCE_CONFIGS.map((resourceConfig) => [
      resourceConfig.name,
      resourceConfig.api ?? {},
    ]),
  );
  const nativeResourceNames = new Set(Object.keys(resourceConfigs));

  const existingResources = await (stateDb as { listResources?: () => Promise<Array<{ name: string }>> }).listResources?.();
  for (const item of existingResources || []) {
    if (
      typeof item?.name === "string" &&
      item.name.startsWith("symphifony_") &&
      !nativeResourceNames.has(item.name)
    ) {
      resourceConfigs[item.name] = { enabled: false };
    }
  }

  setApiRuntimeContext(state, workflowDefinition);

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
    rootRoute: (c: any) => {
      const html = readTextOrNull(FRONTEND_INDEX);
      if (!html) return c.text("Dashboard not found", 404);
      return c.html(html);
    },
    static: [{
      driver: "filesystem",
      path: "/",
      root: FRONTEND_DIR,
      pwa: true,
      config: { etag: true },
    }],
    docs: { enabled: true, title: "Symphifony API", version: "1.0.0", description: "Local orchestration API for Symphifony" },
    cors: { enabled: true, origin: "*" },
    security: { enabled: false },
    logging: { enabled: true, excludePaths: ["/health", "/status", "/**/*.js", "/**/*.css", "/**/*.svg"] },
    compression: { enabled: true, threshold: 1024 },
    health: { enabled: true },
    resources: {
      ...resourceConfigs,
    },
    routes: {
      "GET /state": async (c: any) =>
        c.json({
          ...state,
          capabilities: computeCapabilityCounts(state.issues),
        }),
      "GET /status": async (c: any) =>
        c.json({
          status: "ok",
          updatedAt: state.updatedAt,
          config: state.config,
          trackerKind: state.trackerKind,
        }),
      "GET /providers": async (c: any) => {
        const providers = detectAvailableProviders();
        return c.json({ providers });
      },
      "GET /parallelism": async (c: any) => {
        return c.json(analyzeParallelizability(state.issues));
      },
      "GET /providers/usage": async (c: any) => {
        try {
          const usage = collectProvidersUsage();
          return c.json(usage);
        } catch (error) {
          logger.error({ err: error }, "Failed to collect providers usage");
          return c.json({ providers: [] }, 500);
        }
      },
      "POST /config/concurrency": async (c: any) => {
        const payload = await c.req.json() as JsonRecord;
        const value = typeof payload.concurrency === "number" ? payload.concurrency : undefined;
        if (!value || value < 1 || value > 16) {
          return c.json({ ok: false, error: "concurrency must be between 1 and 16" }, 400);
        }
        state.config.workerConcurrency = clamp(Math.round(value), 1, 16);
        state.updatedAt = now();
        addEvent(state, undefined, "manual", `Worker concurrency updated to ${state.config.workerConcurrency}.`);
        await persistState(state);
        return c.json({ ok: true, workerConcurrency: state.config.workerConcurrency });
      },
      "POST /issues/create": async (c: any) => {
        try {
          const payload = await c.req.json() as JsonRecord;
          const issue = createIssueFromPayload(payload, state.issues, workflowDefinition);
          state.issues.push(issue);
          addEvent(state, issue.id, "info", `Issue ${issue.identifier} created via API.`);
          await persistState(state);
          return c.json({ ok: true, issue }, 201);
        } catch (error) {
          return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
      },
      "POST /issues/enhance": async (c: any) => {
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
      "POST /issues/:id/state": async (c: any) => {
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
          await handleStatePatch(state, issue, payload);
          await persistState(state);
          return c.json({ ok: true, issue });
        } catch (error) {
          return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
        }
      },
      "POST /issues/:id/retry": async (c: any) => {
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
      "POST /issues/:id/cancel": async (c: any) => {
        return mutateIssueState(c, async (issue) => {
          await transitionIssueState(issue, "Cancelled", "Manual cancel requested.");
          addEvent(state, issue.id, "manual", `Manual cancel requested for ${issue.id}.`);
        });
      },
      "POST /refresh": async (c: any) => {
        addEvent(state, undefined, "manual", "Manual refresh requested via API.");
        await persistState(state);
        return c.json({ queued: true, requestedAt: now() }, 202);
      },
      "GET /issues/:id/live": async (c: any) => {
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
        const liveLog = wp ? `${wp}/symphifony-live-output.log` : null;
        let logTail = "";
        let logSize = 0;
        if (liveLog && existsSync(liveLog)) {
          try {
            const stat = require("node:fs").statSync(liveLog);
            logSize = stat.size;
            // Read last 8KB
            const fd = require("node:fs").openSync(liveLog, "r");
            const readSize = Math.min(logSize, 8192);
            const buf = Buffer.alloc(readSize);
            require("node:fs").readSync(fd, buf, 0, readSize, Math.max(0, logSize - readSize));
            require("node:fs").closeSync(fd);
            logTail = buf.toString("utf8");
          } catch {}
        }
        return c.json({
          ok: true,
          issueId: issue.id,
          state: issue.state,
          running: issue.state === "In Progress" || issue.state === "In Review",
          startedAt: startedAtText || updatedAtText || now(),
          elapsed: Number.isFinite(elapsed) ? elapsed : 0,
          logSize,
          logTail,
          outputTail: issue.commandOutputTail || "",
        });
      },
      "GET /issues/:id/diff": async (c: any) => {
        const issueId = parseIssue(c);
        if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
        const issue = findIssue(issueId);
        if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);
        const wp = issue.workspacePath;
        if (!wp || !existsSync(wp)) {
          return c.json({ ok: true, diff: "", message: "No workspace found." });
        }
        if (!existsSync(SOURCE_ROOT)) {
          return c.json({ ok: true, diff: "", message: "Source root not found." });
        }
        try {
          const excludes = [
            "symphifony-*", ".symphifony-*", "symphifony_*",
            "WORKFLOW.local.md",
          ].map((p) => `":(exclude)${p}"`).join(" ");
          // git diff --no-index exits 1 when there are differences, which is expected
          const cmd = `git diff --no-index --stat -- "${SOURCE_ROOT}" "${wp}" ${excludes} 2>/dev/null; echo "---"; git diff --no-index --no-color -- "${SOURCE_ROOT}" "${wp}" ${excludes} 2>/dev/null`;
          const diff = execSync(cmd, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 10_000 }).trim();
          return c.json({ ok: true, diff: diff || "(no changes)" });
        } catch (error: any) {
          // git diff --no-index exits 1 when diffs exist — that's the normal case
          if (error.stdout) {
            return c.json({ ok: true, diff: error.stdout.trim() || "(no changes)" });
          }
          return c.json({ ok: true, diff: "", message: `Diff failed: ${String(error.message || error)}` });
        }
      },
      "GET /events/feed": async (c: any) => {
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
    },
  });

  const plugin = await stateDb.usePlugin(apiPlugin, "api") as { stop?: () => Promise<void> };
  setActiveApiPlugin(plugin);
  logger.info(`Local dashboard available at http://localhost:${port}`);
  logger.info(`WebSocket available at ws://localhost:${port}/ws`);
  logger.info(`State API: http://localhost:${port}/state`);
  logger.info(`OpenAPI docs available at http://localhost:${port}/docs`);
}
