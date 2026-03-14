import type {
  JsonRecord,
  RuntimeEvent,
  RuntimeState,
  WorkflowDefinition,
} from "./types.ts";
import {
  FRONTEND_INDEX,
  FRONTEND_APP_JS,
  FRONTEND_STYLES_CSS,
} from "./constants.ts";
import { NATIVE_RESOURCE_CONFIGS } from "./resources/index.ts";
import { now, readTextOrNull, clamp } from "./helpers.ts";
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
} from "./issues.ts";
import { detectAvailableProviders } from "./providers.ts";
import { analyzeParallelizability } from "./scheduler.ts";
import { setApiRuntimeContext } from "./api-runtime-context.ts";

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
      item.name.startsWith("symphifo_") &&
      !nativeResourceNames.has(item.name)
    ) {
      resourceConfigs[item.name] = { enabled: false };
    }
  }

  const dashboardHtml = indexHtml || fallback;
  setApiRuntimeContext(state, workflowDefinition);

  const apiPlugin = new ApiPlugin({
    port,
    host: "0.0.0.0",
    versionPrefix: false,
    docs: { enabled: true, title: "Symphifo API", version: "1.0.0", description: "Local orchestration API for Symphifo" },
    middlewares: [
      async (c: any, next: () => Promise<void>) => {
        if (c.req.path === "/") {
          const redirectTo = new URL("/index.html", c.req.url).toString();
          return c.redirect(redirectTo);
        }
        return next();
      },
    ],
    cors: { enabled: true, origin: "*" },
    logging: { enabled: true, excludePaths: ["/health", "/status"] },
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
  logger.info(`State API: http://localhost:${port}/state`);
  logger.info(`OpenAPI docs available at http://localhost:${port}/docs`);
}
