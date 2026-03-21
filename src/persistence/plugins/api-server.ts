import type {
  RuntimeState,
} from "../../types.ts";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import {
  FRONTEND_DIR,
  FRONTEND_ICON_SVG,
  FRONTEND_INDEX,
  FRONTEND_MANIFEST_JSON,
  FRONTEND_MASKABLE_ICON_SVG,
  FRONTEND_OFFLINE_HTML,
  FRONTEND_SERVICE_WORKER_JS,
} from "../../concerns/constants.ts";
import { NATIVE_RESOURCE_CONFIGS } from "../resources/index.ts";
import { logger } from "../../concerns/logger.ts";
import {
  loadS3dbModule,
  getStateDb,
  setActiveApiPlugin,
} from "../store.ts";
import { setApiRuntimeContext } from "./api-runtime-context.ts";
import { makeWebSocketConfig } from "../../routes/websocket.ts";
export { broadcastToWebSocketClients } from "../../routes/websocket.ts";

import { registerStateRoutes } from "../../routes/state.js";
import { registerPlanRoutes } from "../../routes/plan.js";
import { registerSettingsRoutes } from "../../routes/settings.js";
import { registerAnalyticsRoutes } from "../../routes/analytics.js";
import { registerScanningRoutes } from "../../routes/scanning.js";
import { registerCatalogRoutes } from "../../routes/catalog.js";
import { registerReferenceRepositoryRoutes } from "../../routes/reference-repositories.js";
import { registerMiscRoutes } from "../../routes/misc.js";

// ── Route collector ──────────────────────────────────────────────────────────
// Accumulates routes before ApiPlugin construction (ApiPlugin only accepts routes
// via constructor config, not via .get()/.post() methods after creation).

class RouteCollector {
  readonly routes: Record<string, (c: any) => any> = {};

  get(path: string, handler: (c: any) => any) { this.routes[`GET ${path}`] = handler; }
  post(path: string, handler: (c: any) => any) { this.routes[`POST ${path}`] = handler; }
  put(path: string, handler: (c: any) => any) { this.routes[`PUT ${path}`] = handler; }
  patch(path: string, handler: (c: any) => any) { this.routes[`PATCH ${path}`] = handler; }
  delete(path: string, handler: (c: any) => any) { this.routes[`DELETE ${path}`] = handler; }
}

// ── API server ───────────────────────────────────────────────────────────────

export async function startApiServer(
  state: RuntimeState,
  port: number,
): Promise<void> {
  logger.info({ port }, "[API] Starting API server");
  const stateDb = getStateDb();
  if (!stateDb) {
    throw new Error("Cannot start API plugin before the database is initialized.");
  }

  const { ApiPlugin } = await loadS3dbModule();

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

  setApiRuntimeContext(state);

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

  // Collect routes from route modules before plugin instantiation
  const collector = new RouteCollector();
  registerStateRoutes(collector, state);
  registerPlanRoutes(collector, state);
  registerSettingsRoutes(collector, state);
  registerAnalyticsRoutes(collector);
  registerScanningRoutes(collector, state);
  registerCatalogRoutes(collector);
  registerReferenceRepositoryRoutes(collector);
  registerMiscRoutes(collector, state);

  const apiPlugin = new ApiPlugin({
    port,
    host: "0.0.0.0",
    versionPrefix: false,
    metrics: {
      logLevel: 'info'
    },
    // HTTP + WebSocket on the same port via listeners
    listeners: [{
      bind: { host: "0.0.0.0", port },
      protocols: {
        http: true,
        websocket: makeWebSocketConfig(state),
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
      ...collector.routes,
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
      "GET /onboarding": () => serveAppShell(),
      "GET /kanban": () => serveAppShell(),
      "GET /issues": () => serveAppShell(),
      "GET /analytics": () => serveAppShell(),
      "GET /agents": () => serveAppShell(),
      "GET /settings": () => serveAppShell(),
      "GET /settings/general": () => serveAppShell(),
      "GET /settings/notifications": () => serveAppShell(),
      "GET /settings/workflow": () => serveAppShell(),
      "GET /settings/providers": () => serveAppShell(),
      "GET /api/health": (c: any) =>
        c.json({ status: state.booting ? "booting" : "ready" }),
    },
  });

  const plugin = await stateDb.usePlugin(apiPlugin, "api") as { stop?: () => Promise<void> };
  setActiveApiPlugin(plugin);
  logger.info(`Local dashboard available at http://localhost:${port}`);
  logger.info(`WebSocket available at ws://localhost:${port}/ws`);
  logger.info(`State API: http://localhost:${port}/api/state`);
  logger.info(`OpenAPI docs available at http://localhost:${port}/docs`);
}
