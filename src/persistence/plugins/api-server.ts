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
  QUIET_MODE,
} from "../../concerns/constants.ts";
import { APP_SHELL_ROUTES } from "../../concerns/app-shell-routes.ts";
import { NATIVE_RESOURCE_CONFIGS } from "../resources/index.ts";
import { logger } from "../../concerns/logger.ts";
import {
  loadS3dbModule,
  getStateDb,
  setActiveApiPlugin,
} from "../store.ts";
import type { RouteHandler, RouteRegistrar } from "../../routes/http.ts";
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
import { registerServiceRoutes } from "../../routes/services.js";
import { registerTrafficRoutes } from "../../routes/traffic.js";
import { registerVariableRoutes } from "../../routes/variables.js";
import { registerDevProfileRoutes } from "../../routes/dev-profile.js";
import { registerChatRoutes } from "../../routes/chat.js";

// ── Route collector ──────────────────────────────────────────────────────────
// Accumulates routes before ApiPlugin construction (ApiPlugin only accepts routes
// via constructor config, not via .get()/.post() methods after creation).

class RouteCollector implements RouteRegistrar {
  readonly routes: Record<string, RouteHandler> = {};

  get(path: string, handler: RouteHandler) { this.routes[`GET ${path}`] = handler; }
  post(path: string, handler: RouteHandler) { this.routes[`POST ${path}`] = handler; }
  put(path: string, handler: RouteHandler) { this.routes[`PUT ${path}`] = handler; }
  patch(path: string, handler: RouteHandler) { this.routes[`PATCH ${path}`] = handler; }
  delete(path: string, handler: RouteHandler) { this.routes[`DELETE ${path}`] = handler; }
}

// ── API server ───────────────────────────────────────────────────────────────

export async function startApiServer(
  state: RuntimeState,
  port: number,
  _options?: { tls?: boolean; devPort?: number },
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
        ...(("api" in resourceConfig ? resourceConfig.api : undefined) ?? {}),
        versionPrefix: "api",
      },
    ]),
  );
  const nativeResourceNames = new Set(Object.keys(resourceConfigs));

  const existingResources = await (stateDb as { listResources?: () => Promise<Array<{ name: string }>> }).listResources?.();
  for (const item of existingResources || []) {
    if (
      typeof item?.name === "string" &&
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

  const devPort = _options?.devPort;

  const serveAppShell = (path?: string) => {
    // In dev mode, redirect browser to the Vite HMR server
    if (devPort) {
      return new Response(null, {
        status: 302,
        headers: { location: `http://localhost:${devPort}${path ?? "/"}` },
      });
    }
    if (!existsSync(FRONTEND_INDEX)) {
      return new Response("Not found", { status: 404 });
    }
    const html = readFileSync(FRONTEND_INDEX, "utf8")
      .replace('href="/assets/manifest.webmanifest"', 'href="/manifest.webmanifest"')
      .replaceAll('href="/assets/icon.svg"', 'href="/icon.svg"')
      .replaceAll('href="/assets/favicon.png"', 'href="/favicon.png"')
      .replaceAll('href="/assets/icon-16.png"', 'href="/icon-16.png"')
      .replaceAll('href="/assets/icon-32.png"', 'href="/icon-32.png"')
      .replaceAll('href="/assets/apple-touch-icon.png"', 'href="/apple-touch-icon.png"')
      .replaceAll('content="/assets/og-image.png"', 'content="/og-image.png"');
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  };

  const rootStaticAssets = Object.fromEntries(
    [
      "favicon.png",
      "apple-touch-icon.png",
      "og-image.png",
      "dinofffaur.png",
      "dinofffaur.webp",
      "icon-16.png",
      "icon-32.png",
      "icon-48.png",
      "icon-72.png",
      "icon-96.png",
      "icon-128.png",
      "icon-144.png",
      "icon-152.png",
      "icon-192.png",
      "icon-384.png",
      "icon-512.png",
      "icon-maskable-192.png",
      "icon-maskable-512.png",
    ].map((file) => [
      `GET /${file}`,
      () => serveTextFile(`${FRONTEND_DIR}/${file}`, "image/png", "public, max-age=604800, immutable"),
    ]),
  );

  const appShellRoutes = Object.fromEntries(
    APP_SHELL_ROUTES.map((path) => [`GET ${path}`, () => serveAppShell(path)]),
  );

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
  registerServiceRoutes(collector, state);
  registerTrafficRoutes(collector, state);
  registerVariableRoutes(collector, state);
  registerDevProfileRoutes(collector);
  registerChatRoutes(collector, state);

  const apiPlugin = new ApiPlugin({
    port,
    host: "0.0.0.0",
    tls: false,
    versionPrefix: false,
    metrics: { enabled: false, logLevel: false },
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
      headers: { location: devPort ? `http://localhost:${devPort}/` : "/kanban" },
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
    logging: {
      enabled: !QUIET_MODE,
      logLevel: devPort ? "debug" : "info",
      excludePaths: ["/health", "/status", "/**/*.js", "/**/*.css", "/**/*.svg"],
    },
    websocket: { logLevel: devPort ? "debug" : "warn" },
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
      ...rootStaticAssets,
      ...appShellRoutes,
      "GET /api/health": (c) =>
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
