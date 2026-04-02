import type { JsonRecord, RuntimeState } from "../types.ts";
import type { RouteRegistrar } from "./http.ts";
import { STATE_ROOT } from "../concerns/constants.ts";
import { logger } from "../concerns/logger.ts";
import { listServiceStatuses, getServiceRuntimeStatus } from "../domains/services.ts";
import {
  applyNetworkRuntimeConfig,
  clearMeshRuntimeTraffic,
  getMeshRuntimeEvents,
  getMeshRuntimeGraph,
  getMeshRuntimeMetrics,
  getMeshRuntimeSnapshotStatus,
  getMeshRuntimeState,
  getMeshRuntimeStats,
  getMeshRuntimeTraffic,
  getReverseProxyRuntimeGraphSnapshot,
  getReverseProxyRuntimeSnapshotStatus,
  getReverseProxyRuntimeState,
  getReverseProxyRuntimeStats,
  invalidateReverseProxyCert,
  getReverseProxyCaCertPath,
  restartReverseProxyRuntime,
  startReverseProxyRuntime,
  stopReverseProxyRuntime,
} from "../persistence/plugins/reverse-proxy-server.ts";
import type { ProxyRoute } from "../types.ts";
import {
  setMeshSnapshotProvider,
  notifyMeshSnapshot,
  notifyServicesSnapshot,
  meshRoomHasSubscribers,
  sendToMeshRoom,
  setReverseProxySnapshotProvider,
  notifyReverseProxySnapshot,
  reverseProxyRoomHasSubscribers,
} from "./websocket.ts";

const MESH_VAR_KEYS = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
const MESH_TRAFFIC_LIMIT = 500;
const MESH_WS_SNAPSHOT_DEBOUNCE_MS = 500;
const MESH_SNAPSHOT_RESYNC_INTERVAL_MS = 10_000;
const MESH_EVENT_PUSH_INTERVAL_MS = 400;
const LOCAL_DOMAIN_PORT_SUFFIX = /:\d+$/;

function normalizeLocalDomain(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const noPath = withoutScheme.split("/")[0];
  const hostOnly = noPath.split("?")[0];
  return hostOnly.replace(LOCAL_DOMAIN_PORT_SUFFIX, "").toLowerCase();
}

function normalizePathPrefix(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeProxyRoutes(routes: ProxyRoute[]): ProxyRoute[] {
  return routes.map((route) => ({
    ...route,
    host: Array.isArray(route.host)
      ? route.host.map((h) => normalizeLocalDomain(h)).filter(Boolean)
      : normalizeLocalDomain(route.host),
    pathPrefix: normalizePathPrefix(route.pathPrefix),
    serviceId: typeof route.serviceId === "string" && route.serviceId.trim()
      ? route.serviceId.trim()
      : undefined,
    target: typeof route.target === "string" && route.target.trim()
      ? route.target.trim()
      : undefined,
  }));
}

let meshSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
let meshPushTimer: ReturnType<typeof setInterval> | null = null;
let meshEventPushTimer: ReturnType<typeof setInterval> | null = null;
let lastMeshEventSeq = 0;
let cachedMeshGraph: JsonRecord | null = null;
let cachedMeshNativeGraph: JsonRecord | null = null;
let cachedMeshTraffic: JsonRecord[] = [];
let cachedMeshStatus: JsonRecord | null = null;

function scheduleMeshSnapshot() {
  if (!meshRoomHasSubscribers()) return;
  if (meshSnapshotTimer) return;

  meshSnapshotTimer = setTimeout(() => {
    meshSnapshotTimer = null;
    if (!meshRoomHasSubscribers()) return;
    notifyMeshSnapshot();
  }, MESH_WS_SNAPSHOT_DEBOUNCE_MS);
}

function clearMeshSnapshotTimer() {
  if (!meshSnapshotTimer) return;
  clearTimeout(meshSnapshotTimer);
  meshSnapshotTimer = null;
}

let meshWatchdogBusy = false;

async function pushMeshSnapshot(state: RuntimeState) {
  if (!meshRoomHasSubscribers()) return;
  const [status, graphPayload, traffic] = await Promise.all([
    getMeshRuntimeState(),
    getMeshRuntimeGraph(),
    getMeshRuntimeTraffic(MESH_TRAFFIC_LIMIT),
  ]);

  // Watchdog: if mesh should be running but the sidecar is dead, restart it automatically.
  if (state.config.meshEnabled && !status.running && !meshWatchdogBusy) {
    meshWatchdogBusy = true;
    logger.warn("[Mesh] Sidecar is down but mesh is enabled — attempting auto-restart");
    applyNetworkRuntimeConfig({
      dashPort: Number(state.config.dashboardPort ?? 4000),
      services: state.config.services ?? [],
      routes: state.config.proxyRoutes ?? [],
      localDomain: normalizeLocalDomain(state.config.localDomain),
      reverseProxyEnabled: state.config.reverseProxyEnabled ?? false,
      port: state.config.reverseProxyPort ?? 4433,
      meshEnabled: true,
      meshPort: state.config.meshProxyPort ?? 0,
      meshBufferSize: state.config.meshBufferSize ?? 1000,
      meshLiveWindowSeconds: state.config.meshLiveWindowSeconds ?? 900,
    }).then(() => {
      logger.info("[Mesh] Auto-restart complete");
    }).catch((err: unknown) => {
      logger.error({ err }, "[Mesh] Auto-restart failed");
    }).finally(() => {
      meshWatchdogBusy = false;
    });
  }

  const services = listServiceStatuses(state.config.services ?? [], STATE_ROOT);
  const graphNodes = Array.isArray(graphPayload?.graph?.nodes) ? graphPayload.graph.nodes as JsonRecord[] : [];
  const nodeMap = new Map(graphNodes.map((node) => [String(node.id), node]));
  cachedMeshGraph = graphPayload?.graph
    ? {
      ...graphPayload.graph,
      nodes: services.map((service) => ({
        ...(nodeMap.get(service.id) ?? {}),
        id: service.id,
        name: service.name,
        state: service.state,
        port: service.port,
      })),
    }
    : null;
  cachedMeshNativeGraph = graphPayload?.nativeGraph ?? null;
  cachedMeshTraffic = traffic ?? [];
  cachedMeshStatus = {
    enabled: state.config.meshEnabled ?? false,
    running: status.running,
    port: status.port,
  };
  notifyMeshSnapshot();
}

async function pushMeshEvents() {
  if (!meshRoomHasSubscribers()) return;
  const payload = await getMeshRuntimeEvents(lastMeshEventSeq, 200);
  if (!payload) return;
  const events = Array.isArray(payload.events) ? payload.events : [];
  for (const event of events) {
    const seq = typeof event?.seq === "number" ? event.seq : null;
    if (seq != null && seq <= lastMeshEventSeq) continue;
    if (seq != null) lastMeshEventSeq = seq;
    sendToMeshRoom({
      type: "mesh:event",
      event,
      timestamp: new Date().toISOString(),
    });
  }
  if (typeof payload.currentSeq === "number" && payload.currentSeq > lastMeshEventSeq) {
    lastMeshEventSeq = payload.currentSeq;
  }
}

function startMeshPushTimer(state: RuntimeState) {
  if (meshPushTimer) return;
  meshPushTimer = setInterval(() => { void pushMeshSnapshot(state); }, MESH_SNAPSHOT_RESYNC_INTERVAL_MS);
  if (!meshEventPushTimer) {
    meshEventPushTimer = setInterval(() => { void pushMeshEvents(); }, MESH_EVENT_PUSH_INTERVAL_MS);
  }
}

function stopMeshPushTimer() {
  if (!meshPushTimer) return;
  clearInterval(meshPushTimer);
  meshPushTimer = null;
  if (meshEventPushTimer) {
    clearInterval(meshEventPushTimer);
    meshEventPushTimer = null;
  }
  lastMeshEventSeq = 0;
  cachedMeshGraph = null;
  cachedMeshNativeGraph = null;
  cachedMeshTraffic = [];
  cachedMeshStatus = null;
}

// ── Reverse proxy push timer ──────────────────────────────────────────────────
// Fetches stats + graph and pushes to subscribed clients every 3s when running.
// Stats/graph are async; we cache the last fetch so the sync provider can serve them.

const REVERSE_PROXY_PUSH_INTERVAL_MS = 3_000;
let reverseProxyPushTimer: ReturnType<typeof setInterval> | null = null;
let cachedReverseProxyStats: JsonRecord | null = null;
let cachedReverseProxySnapshot: JsonRecord | null = null;

async function pushReverseProxySnapshot() {
  if (!reverseProxyRoomHasSubscribers()) return;
  const [stats, snapshot] = await Promise.all([
    getReverseProxyRuntimeStats(),
    getReverseProxyRuntimeGraphSnapshot(),
  ]);
  cachedReverseProxyStats = stats as JsonRecord | null;
  cachedReverseProxySnapshot = snapshot as JsonRecord | null;
  if (!stats && !snapshot) return;
  notifyReverseProxySnapshot();
}

function startReverseProxyPushTimer() {
  if (reverseProxyPushTimer) return;
  reverseProxyPushTimer = setInterval(() => { void pushReverseProxySnapshot(); }, REVERSE_PROXY_PUSH_INTERVAL_MS);
}

function stopReverseProxyPushTimer() {
  if (!reverseProxyPushTimer) return;
  clearInterval(reverseProxyPushTimer);
  reverseProxyPushTimer = null;
  cachedReverseProxyStats = null;
  cachedReverseProxySnapshot = null;
}

export function registerTrafficRoutes(
  collector: RouteRegistrar,
  state: RuntimeState,
): void {
  const buildNetworkRuntimeOptions = () => ({
    dashPort: Number(state.config.dashboardPort ?? 4000),
    services: state.config.services ?? [],
    routes: state.config.proxyRoutes ?? [],
    localDomain: normalizeLocalDomain(state.config.localDomain),
    reverseProxyEnabled: state.config.reverseProxyEnabled ?? false,
    port: state.config.reverseProxyPort ?? 4433,
    meshEnabled: state.config.meshEnabled ?? false,
    meshPort: state.config.meshProxyPort ?? 0,
    meshBufferSize: state.config.meshBufferSize ?? 1000,
    meshLiveWindowSeconds: state.config.meshLiveWindowSeconds ?? 900,
  });

  setMeshSnapshotProvider(() => {
    return {
      graph: cachedMeshGraph,
      nativeGraph: cachedMeshNativeGraph,
      traffic: cachedMeshTraffic,
      status: cachedMeshStatus ?? {
        enabled: state.config.meshEnabled ?? false,
        running: false,
        port: null,
      },
    };
  });

  setReverseProxySnapshotProvider(() => {
    const snapshotStatus = getReverseProxyRuntimeSnapshotStatus();
    if (!snapshotStatus.running) return null;
    return {
      stats: cachedReverseProxyStats,
      snapshot: cachedReverseProxySnapshot,
      running: snapshotStatus.running,
    };
  });

  // If proxies were already running at boot, start the push timers immediately
  if (getMeshRuntimeSnapshotStatus().running) {
    startMeshPushTimer(state);
    void pushMeshSnapshot(state);
  }
  if (getReverseProxyRuntimeSnapshotStatus().running) {
    startReverseProxyPushTimer();
    void pushReverseProxySnapshot();
  }

  // ── GET /api/mesh ──────────────────────────────────────────────
  // Returns the full service graph (nodes + edges)
  collector.get("/api/mesh", async (c) => {
    const payload = await getMeshRuntimeGraph();
    if (!payload?.graph) return c.json({ ok: false, error: "Mesh proxy not running" }, 503);
    const services = listServiceStatuses(state.config.services ?? [], STATE_ROOT);
    const graphNodes = Array.isArray(payload.graph.nodes) ? payload.graph.nodes as JsonRecord[] : [];
    const nodeMap = new Map(graphNodes.map((node) => [String(node.id), node]));
    return c.json({
      ok: true,
      graph: {
        ...payload.graph,
        nodes: services.map((service) => ({
          ...(nodeMap.get(service.id) ?? { id: service.id }),
          id: service.id,
          name: service.name,
          state: service.state,
          port: service.port,
        })),
      },
    });
  });

  // ── GET /api/mesh/traffic ──────────────────────────────────────
  // Returns recent traffic entries from the ring buffer
  collector.get("/api/mesh/traffic", async (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const entries = await getMeshRuntimeTraffic(limit);
    if (!entries) return c.json({ ok: false, error: "Mesh proxy not running" }, 503);
    return c.json({ ok: true, entries });
  });

  // ── GET /api/mesh/stats ────────────────────────────────────────
  // Returns proxy stats (connections, bytes, errors)
  collector.get("/api/mesh/stats", async (c) => {
    const stats = await getMeshRuntimeStats();
    if (!stats) return c.json({ ok: false, error: "Mesh proxy not running" }, 503);
    return c.json({ ok: true, stats });
  });

  // ── POST /api/mesh/clear ───────────────────────────────────────
  // Resets the ring buffer and graph accumulator
  collector.post("/api/mesh/clear", async (c) => {
    await clearMeshRuntimeTraffic();
    cachedMeshTraffic = [];
    cachedMeshGraph = null;
    cachedMeshNativeGraph = null;
    notifyMeshSnapshot();
    return c.json({ ok: true });
  });

  // ── GET /api/mesh/graph/native ────────────────────────────────
  // Returns the native raffel graph snapshot: per-edge latency, rates, flow counts
  collector.get("/api/mesh/graph/native", async (c) => {
    const payload = await getMeshRuntimeGraph();
    if (!payload?.nativeGraph) return c.json({ ok: false, error: "Mesh proxy not running" }, 503);
    return c.json({ ok: true, snapshot: payload.nativeGraph });
  });

  // ── GET /api/mesh/metrics ──────────────────────────────────────
  // Returns native raffel proxy metrics in Prometheus text format
  collector.get("/api/mesh/metrics", async (c) => {
    const format = (c.req.query("format") as "prometheus" | "json" | undefined) ?? "prometheus";
    const metrics = await getMeshRuntimeMetrics(format === "json" ? "json" : "prometheus");
    if (!metrics) return c.json({ ok: false, error: "Mesh proxy not running or metrics not available" }, 503);
    const contentType = format === "json" ? "application/json" : "text/plain; version=0.0.4; charset=utf-8";
    return new Response(metrics, { headers: { "content-type": contentType } });
  });

  // ── GET /api/mesh/status ───────────────────────────────────────
  // Returns mesh proxy status
  collector.get("/api/mesh/status", async (c) => {
    const mesh = await getMeshRuntimeState();
    return c.json({
      ok: true,
      enabled: state.config.meshEnabled ?? false,
      running: mesh.running,
      port: mesh.port,
      liveWindowSeconds: state.config.meshLiveWindowSeconds ?? 900,
    });
  });

  // ── POST /api/mesh/toggle ──────────────────────────────────────
  // Enable or disable the mesh proxy at runtime
  collector.post("/api/mesh/toggle", async (c) => {
    const body = await c.req.json() as Record<string, unknown>;
    const enabled = body.enabled === true;

    // Persist the setting
    const { persistSetting } = await import("../persistence/settings.js");
    await persistSetting("runtime.meshEnabled", enabled, { scope: "runtime", source: "user" });
    state.config.meshEnabled = enabled;

    if (enabled) {
      try {
        await applyNetworkRuntimeConfig(buildNetworkRuntimeOptions());
        const meshState = await getMeshRuntimeState();
        const port = meshState.port;
        // Inject HTTP_PROXY as global env vars so all services pick it up automatically
        const dashPort = Number(state.config.dashboardPort ?? 4000);
        // NO_PROXY must only exclude the dashboard — NOT service ports.
        // Including service ports would cause all localhost service-to-service calls
        // to bypass the proxy entirely, making mesh observability useless.
        // The proxy itself does not use HTTP_PROXY, so there is no forwarding loop.
        const noProxyList = `localhost:${dashPort}`;
        const proxyUrl = `http://localhost:${port}`;
        const vars = state.variables ?? [];
        const ts = new Date().toISOString();
        const globalVars: Record<string, string> = {
          HTTP_PROXY: proxyUrl, http_proxy: proxyUrl,
          NO_PROXY: noProxyList, no_proxy: noProxyList,
        };
        for (const [key, value] of Object.entries(globalVars)) {
          const id = `global:${key}`;
          const idx = vars.findIndex((v) => v.id === id);
          const entry = { id, key, value, scope: "global" as const, updatedAt: ts };
          if (idx >= 0) vars[idx] = entry;
          else vars.push(entry);
        }
        state.variables = vars;
        logger.info({ port }, "[Mesh] Proxy started + global env vars injected");
        startMeshPushTimer(state);
        void pushMeshSnapshot(state);
        // Restart all running services so they pick up the proxy env vars
        const runningServices = (state.config.services ?? []).filter((s) => {
          const status = getServiceRuntimeStatus(s, STATE_ROOT);
          return status.running;
        });
        for (const svc of runningServices) {
          try {
            const { sendServiceEvent } = await import("../persistence/plugins/fsm-service.js");
            await sendServiceEvent(svc.id, "STOP");
            await new Promise((r) => setTimeout(r, 500));
            await sendServiceEvent(svc.id, "START");
            logger.info({ id: svc.id }, "[Mesh] Restarted service to apply proxy env");
          } catch (err) {
            logger.warn({ err, id: svc.id }, "[Mesh] Failed to restart service for proxy");
          }
        }
        return c.json({ ok: true, running: true, port, restarted: runningServices.map((s) => s.id) });
      } catch (err) {
        logger.error({ err }, "[Mesh] Failed to start proxy");
        return c.json({ ok: false, error: String(err) }, 500);
      }
    }

    if (!enabled) {
      clearMeshSnapshotTimer();
      stopMeshPushTimer();
      await applyNetworkRuntimeConfig(buildNetworkRuntimeOptions());
      // Remove mesh-related global env vars
      state.variables = (state.variables ?? []).filter(
        (v) => v.scope !== "global" || !MESH_VAR_KEYS.includes(v.key),
      );
      logger.info("[Mesh] Proxy stopped + global env vars removed");
      // Restart running services to remove proxy env
      const runningServices = (state.config.services ?? []).filter((s) => {
        const status = getServiceRuntimeStatus(s, STATE_ROOT);
        return status.running;
      });
      for (const svc of runningServices) {
        try {
          const { sendServiceEvent } = await import("../persistence/plugins/fsm-service.js");
          await sendServiceEvent(svc.id, "STOP");
          await new Promise((r) => setTimeout(r, 500));
          await sendServiceEvent(svc.id, "START");
          logger.info({ id: svc.id }, "[Mesh] Restarted service to remove proxy env");
        } catch (err) {
          logger.warn({ err, id: svc.id }, "[Mesh] Failed to restart service after proxy disable");
        }
      }
    }

    const mesh = await getMeshRuntimeState();
    return c.json({ ok: true, running: mesh.running, port: mesh.port });
  });

  // ── GET /api/proxy/reverse/status ─────────────────────────────
  // Returns HTTPS reverse proxy status
  collector.get("/api/proxy/reverse/status", async (c) => {
    const runtime = await getReverseProxyRuntimeState();
    const snapshot = getReverseProxyRuntimeSnapshotStatus({
      enabled: state.config.reverseProxyEnabled ?? false,
      localDomain: normalizeLocalDomain(state.config.localDomain),
      configuredPort: state.config.reverseProxyPort ?? 4433,
    });
    return c.json({
      ok: true,
      enabled: state.config.reverseProxyEnabled ?? false,
      running: runtime.running,
      pid: runtime.pid,
      port: runtime.proxyPort ?? snapshot.port ?? state.config.reverseProxyPort ?? 4433,
      certPath: `${STATE_ROOT}/tls/cert.pem`,
      caCertPath: getReverseProxyCaCertPath(),
      localDomain: normalizeLocalDomain(state.config.localDomain),
      routes: state.config.proxyRoutes ?? [],
    });
  });

  // ── POST /api/proxy/reverse/toggle ────────────────────────────
  // Enable or disable the HTTPS reverse proxy at runtime
  collector.post("/api/proxy/reverse/toggle", async (c) => {
    const body = await c.req.json() as Record<string, unknown>;
    const enabled = body.enabled === true;

    const { persistSetting } = await import("../persistence/settings.js");
    await persistSetting("runtime.reverseProxyEnabled", enabled, { scope: "runtime", source: "user" });
    state.config.reverseProxyEnabled = enabled;

    const dashPort = Number(state.config.dashboardPort ?? 4000);

    const proxyOpts = {
      port: state.config.reverseProxyPort ?? 4433,
      dashPort,
      routes: state.config.proxyRoutes ?? [],
      services: state.config.services ?? [],
      localDomain: normalizeLocalDomain(state.config.localDomain),
    };

    if (enabled && !getReverseProxyRuntimeSnapshotStatus().running) {
      try {
        const proxyPort = await startReverseProxyRuntime({
          ...buildNetworkRuntimeOptions(),
          ...proxyOpts,
          reverseProxyEnabled: true,
        });
        notifyServicesSnapshot();
        void pushReverseProxySnapshot();
        startReverseProxyPushTimer();
        return c.json({ ok: true, running: true, port: proxyPort });
      } catch (err) {
        logger.error({ err }, "[ReverseProxy] Failed to start");
        return c.json({ ok: false, error: String(err) }, 500);
      }
    }

    if (!enabled && getReverseProxyRuntimeSnapshotStatus().running) {
      stopReverseProxyPushTimer();
      await applyNetworkRuntimeConfig(buildNetworkRuntimeOptions());
      notifyServicesSnapshot();
    }

    const runtime = await getReverseProxyRuntimeState();
    return c.json({ ok: true, running: runtime.running, port: runtime.proxyPort ?? state.config.reverseProxyPort ?? 4433 });
  });

  // ── PUT /api/proxy/reverse/routes ─────────────────────────────
  // Save custom routing rules and restart the proxy if it's running.
  collector.put("/api/proxy/reverse/routes", async (c) => {
    const body = await c.req.json() as { routes: ProxyRoute[] };
    const routes = normalizeProxyRoutes(Array.isArray(body.routes) ? body.routes : []);

    const { persistSetting } = await import("../persistence/settings.js");
    await persistSetting("runtime.proxyRoutes", routes, { scope: "runtime", source: "user" });
    state.config.proxyRoutes = routes;

    if (getReverseProxyRuntimeSnapshotStatus().running) {
      try {
        const dashPort = Number(state.config.dashboardPort ?? 4000);
        await restartReverseProxyRuntime({ ...buildNetworkRuntimeOptions(), port: state.config.reverseProxyPort ?? 4433, dashPort, routes });
        notifyServicesSnapshot();
        void pushReverseProxySnapshot();
      } catch (err) {
        logger.error({ err }, "[ReverseProxy] Failed to restart after routes update");
        return c.json({ ok: false, error: String(err) }, 500);
      }
    }

    return c.json({ ok: true, running: getReverseProxyRuntimeSnapshotStatus().running, routes });
  });

  // ── PUT /api/proxy/reverse/domain ─────────────────────────────
  // Save the local domain and regenerate the TLS cert (restart proxy if running).
  collector.put("/api/proxy/reverse/domain", async (c) => {
    const body = await c.req.json() as { localDomain?: string };
    const domain = normalizeLocalDomain(typeof body.localDomain === "string" ? body.localDomain : "");

    const { persistSetting } = await import("../persistence/settings.js");
    await persistSetting("runtime.localDomain", domain || null, { scope: "runtime", source: "user" });
    state.config.localDomain = domain || undefined;

    // Invalidate cached cert so it regenerates with the new domain on next start
    invalidateReverseProxyCert();

    if (getReverseProxyRuntimeSnapshotStatus().running) {
      try {
        const dashPort = Number(state.config.dashboardPort ?? 4000);
        await restartReverseProxyRuntime({
          ...buildNetworkRuntimeOptions(),
          port: state.config.reverseProxyPort ?? 4433,
          dashPort,
          routes: state.config.proxyRoutes ?? [],
          localDomain: domain || undefined,
        });
        notifyServicesSnapshot();
        void pushReverseProxySnapshot();
      } catch (err) {
        logger.error({ err }, "[ReverseProxy] Failed to restart after domain update");
        return c.json({ ok: false, error: String(err) }, 500);
      }
    }

    return c.json({ ok: true, localDomain: domain, running: getReverseProxyRuntimeSnapshotStatus().running });
  });

  // ── GET /api/proxy/reverse/stats ──────────────────────────────
  // Returns reverse proxy connection/byte/error counters
  collector.get("/api/proxy/reverse/stats", async (c) => {
    const stats = await getReverseProxyRuntimeStats();
    if (!stats) return c.json({ ok: false, error: "Reverse proxy not running" }, 503);
    return c.json({ ok: true, stats });
  });

  // ── GET /api/proxy/reverse/graph ──────────────────────────────
  // Returns the native raffel graph snapshot for the reverse proxy (per-route metrics)
  collector.get("/api/proxy/reverse/graph", async (c) => {
    const snapshot = await getReverseProxyRuntimeGraphSnapshot();
    if (!snapshot) return c.json({ ok: false, error: "Reverse proxy not running" }, 503);
    return c.json({ ok: true, snapshot });
  });
}
