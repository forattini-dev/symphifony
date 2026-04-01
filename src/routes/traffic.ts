import type { RuntimeState } from "../types.ts";
import type { RouteRegistrar } from "./http.ts";
import { STATE_ROOT } from "../concerns/constants.ts";
import { logger } from "../concerns/logger.ts";
import { listServiceStatuses, getServiceRuntimeStatus } from "../domains/services.ts";
import {
  getTrafficBuffer,
  getServiceGraph,
  getTrafficProxyPort,
  getTrafficProxyStats,
  getMeshMetrics,
  getMeshGraphSnapshot,
  isTrafficProxyRunning,
  startTrafficProxy,
  stopTrafficProxy,
  setServicesAccessor,
} from "../persistence/plugins/traffic-proxy-server.ts";
import {
  isReverseProxyRunning,
  getReverseProxyPort,
  getReverseProxyStats,
  getReverseProxyGraphSnapshot,
  startReverseProxy,
  stopReverseProxy,
  restartReverseProxy,
  invalidateReverseProxyCert,
  getReverseProxyCaCertPath,
} from "../persistence/plugins/reverse-proxy-server.ts";
import type { ProxyRoute } from "../types.ts";
import {
  setMeshSnapshotProvider,
  sendToMeshRoom,
  notifyMeshSnapshot,
  meshRoomHasSubscribers,
} from "./websocket.ts";

const MESH_VAR_KEYS = ["HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
const MESH_TRAFFIC_LIMIT = 500;
const MESH_WS_SNAPSHOT_DEBOUNCE_MS = 500;
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

let meshSnapshotTimer: ReturnType<typeof setTimeout> | null = null;

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

export function registerTrafficRoutes(
  collector: RouteRegistrar,
  state: RuntimeState,
): void {
  setMeshSnapshotProvider(() => {
    const graph = getServiceGraph();
    const trafficBuffer = getTrafficBuffer();
    const services = listServiceStatuses(state.config.services ?? [], STATE_ROOT);
    return {
      graph: graph ? graph.getGraph(services) : null,
      nativeGraph: getMeshGraphSnapshot(),
      traffic: trafficBuffer?.getRecent(MESH_TRAFFIC_LIMIT) ?? [],
      status: {
        enabled: state.config.meshEnabled ?? false,
        running: isTrafficProxyRunning(),
        port: getTrafficProxyPort(),
      },
    };
  });

  // ── GET /api/mesh ──────────────────────────────────────────────
  // Returns the full service graph (nodes + edges)
  collector.get("/api/mesh", (c) => {
    const graph = getServiceGraph();
    if (!graph) return c.json({ ok: false, error: "Mesh proxy not running" }, 503);
    const entries = state.config.services ?? [];
    const services = listServiceStatuses(entries, STATE_ROOT);
    return c.json({ ok: true, graph: graph.getGraph(services) });
  });

  // ── GET /api/mesh/traffic ──────────────────────────────────────
  // Returns recent traffic entries from the ring buffer
  collector.get("/api/mesh/traffic", (c) => {
    const buf = getTrafficBuffer();
    if (!buf) return c.json({ ok: false, error: "Mesh proxy not running" }, 503);
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json({ ok: true, entries: buf.getRecent(limit) });
  });

  // ── GET /api/mesh/stats ────────────────────────────────────────
  // Returns proxy stats (connections, bytes, errors)
  collector.get("/api/mesh/stats", (c) => {
    const stats = getTrafficProxyStats();
    if (!stats) return c.json({ ok: false, error: "Mesh proxy not running" }, 503);
    return c.json({ ok: true, stats });
  });

  // ── POST /api/mesh/clear ───────────────────────────────────────
  // Resets the ring buffer and graph accumulator
  collector.post("/api/mesh/clear", (c) => {
    getTrafficBuffer()?.clear();
    getServiceGraph()?.reset();
    return c.json({ ok: true });
  });

  // ── GET /api/mesh/graph/native ────────────────────────────────
  // Returns the native raffel graph snapshot: per-edge latency, rates, flow counts
  collector.get("/api/mesh/graph/native", (c) => {
    const snapshot = getMeshGraphSnapshot();
    if (!snapshot) return c.json({ ok: false, error: "Mesh proxy not running" }, 503);
    return c.json({ ok: true, snapshot });
  });

  // ── GET /api/mesh/metrics ──────────────────────────────────────
  // Returns native raffel proxy metrics in Prometheus text format
  collector.get("/api/mesh/metrics", (c) => {
    const format = (c.req.query("format") as "prometheus" | "json" | undefined) ?? "prometheus";
    const metrics = getMeshMetrics(format === "json" ? "json" : "prometheus");
    if (!metrics) return c.json({ ok: false, error: "Mesh proxy not running or metrics not available" }, 503);
    const contentType = format === "json" ? "application/json" : "text/plain; version=0.0.4; charset=utf-8";
    return new Response(metrics, { headers: { "content-type": contentType } });
  });

  // ── GET /api/mesh/status ───────────────────────────────────────
  // Returns mesh proxy status
  collector.get("/api/mesh/status", (c) => {
    return c.json({
      ok: true,
      enabled: state.config.meshEnabled ?? false,
      running: isTrafficProxyRunning(),
      port: getTrafficProxyPort(),
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

    if (enabled && !isTrafficProxyRunning()) {
      try {
        setServicesAccessor(() => listServiceStatuses(state.config.services ?? [], STATE_ROOT));
        const port = await startTrafficProxy({
          port: state.config.meshProxyPort ?? 0,
          bufferSize: state.config.meshBufferSize ?? 1000,
          onEntry: (entry) => {
            sendToMeshRoom({ type: "mesh:entry", entry });
            scheduleMeshSnapshot();
          },
        });
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

    if (!enabled && isTrafficProxyRunning()) {
      clearMeshSnapshotTimer();
      await stopTrafficProxy();
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

    return c.json({ ok: true, running: isTrafficProxyRunning(), port: getTrafficProxyPort() });
  });

  // ── GET /api/proxy/reverse/status ─────────────────────────────
  // Returns HTTPS reverse proxy status
  collector.get("/api/proxy/reverse/status", (c) => {
    return c.json({
      ok: true,
      enabled: state.config.reverseProxyEnabled ?? false,
      running: isReverseProxyRunning(),
      port: getReverseProxyPort() ?? state.config.reverseProxyPort ?? 4433,
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
      services: (state.config.services ?? []).map((s) => ({ id: s.id, port: s.port })),
      localDomain: normalizeLocalDomain(state.config.localDomain),
    };

    if (enabled && !isReverseProxyRunning()) {
      try {
        const proxyPort = await startReverseProxy(proxyOpts);
        return c.json({ ok: true, running: true, port: proxyPort });
      } catch (err) {
        logger.error({ err }, "[ReverseProxy] Failed to start");
        return c.json({ ok: false, error: String(err) }, 500);
      }
    }

    if (!enabled && isReverseProxyRunning()) {
      await stopReverseProxy();
    }

    return c.json({ ok: true, running: isReverseProxyRunning(), port: getReverseProxyPort() });
  });

  // ── PUT /api/proxy/reverse/routes ─────────────────────────────
  // Save custom routing rules and restart the proxy if it's running.
  collector.put("/api/proxy/reverse/routes", async (c) => {
    const body = await c.req.json() as { routes: ProxyRoute[] };
    const routes = Array.isArray(body.routes) ? body.routes : [];

    const { persistSetting } = await import("../persistence/settings.js");
    await persistSetting("runtime.proxyRoutes", routes, { scope: "runtime", source: "user" });
    state.config.proxyRoutes = routes;

    if (isReverseProxyRunning()) {
      try {
        const dashPort = Number(state.config.dashboardPort ?? 4000);
        await restartReverseProxy({
          port: state.config.reverseProxyPort ?? 4433,
          dashPort,
          routes,
          services: (state.config.services ?? []).map((s) => ({ id: s.id, port: s.port })),
          localDomain: normalizeLocalDomain(state.config.localDomain),
        });
      } catch (err) {
        logger.error({ err }, "[ReverseProxy] Failed to restart after routes update");
        return c.json({ ok: false, error: String(err) }, 500);
      }
    }

    return c.json({ ok: true, running: isReverseProxyRunning(), routes });
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

    if (isReverseProxyRunning()) {
      try {
        const dashPort = Number(state.config.dashboardPort ?? 4000);
        await restartReverseProxy({
          port: state.config.reverseProxyPort ?? 4433,
          dashPort,
          routes: state.config.proxyRoutes ?? [],
          services: (state.config.services ?? []).map((s) => ({ id: s.id, port: s.port })),
          localDomain: domain || undefined,
        });
      } catch (err) {
        logger.error({ err }, "[ReverseProxy] Failed to restart after domain update");
        return c.json({ ok: false, error: String(err) }, 500);
      }
    }

    return c.json({ ok: true, localDomain: domain, running: isReverseProxyRunning() });
  });

  // ── GET /api/proxy/reverse/stats ──────────────────────────────
  // Returns reverse proxy connection/byte/error counters
  collector.get("/api/proxy/reverse/stats", (c) => {
    const stats = getReverseProxyStats();
    if (!stats) return c.json({ ok: false, error: "Reverse proxy not running" }, 503);
    return c.json({ ok: true, stats });
  });

  // ── GET /api/proxy/reverse/graph ──────────────────────────────
  // Returns the native raffel graph snapshot for the reverse proxy (per-route metrics)
  collector.get("/api/proxy/reverse/graph", (c) => {
    const snapshot = getReverseProxyGraphSnapshot();
    if (!snapshot) return c.json({ ok: false, error: "Reverse proxy not running" }, 503);
    return c.json({ ok: true, snapshot });
  });
}
