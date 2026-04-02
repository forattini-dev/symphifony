import type { RuntimeState, ServiceEntry } from "../types.ts";
import type { RouteRegistrar } from "./http.ts";
import { STATE_ROOT, TARGET_ROOT } from "../concerns/constants.ts";
import { logger } from "../concerns/logger.ts";
import {
  getServiceRuntimeStatus,
  listServiceStatuses,
  startManagedService,
  stopManagedService,
  readServiceLogTail,
  getManagedServiceLogPath,
} from "../domains/services.ts";
import { assignServicePort, collectReservedPorts } from "../domains/service-port.ts";
import {
  applyNetworkRuntimeConfig,
  getMeshRuntimeLogPath,
  getMeshRuntimeSnapshotStatus,
  getMeshRuntimeState,
  getReverseProxyRuntimeLogPath,
  getReverseProxyRuntimeSnapshotStatus,
  getReverseProxyRuntimeState,
  restartReverseProxyRuntime,
  startReverseProxyRuntime,
  stopReverseProxyRuntime,
} from "../persistence/plugins/reverse-proxy-server.ts";
import {
  replaceServiceConfigs,
  upsertServiceConfig,
  deleteServiceConfig,
} from "../persistence/resources/services.resource.ts";
import {
  notifyServicesSnapshot,
  setServicesSnapshotProvider,
  broadcastToWebSocketClients,
} from "./websocket.ts";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { ServiceStatus } from "../types.ts";

// ── Detection helpers ─────────────────────────────────────────────────────────

type DetectedService = {
  label: string;
  command: string;
  cwd?: string;
  isRoot: boolean;
};

function detectServices(targetRoot: string): DetectedService[] {
  const suggestions: DetectedService[] = [];

  // 1. turbo.json → suggest pnpm turbo dev
  if (existsSync(join(targetRoot, "turbo.json"))) {
    suggestions.push({ label: "All (turbo dev)", command: "pnpm turbo dev", isRoot: true });
  }

  // 2. pnpm-workspace.yaml or package.json#workspaces → per-package suggestions
  const pnpmWorkspaceFile = join(targetRoot, "pnpm-workspace.yaml");
  const rootPkgFile = join(targetRoot, "package.json");
  const workspaceParentDirs: string[] = [];

  if (existsSync(pnpmWorkspaceFile)) {
    try {
      const content = readFileSync(pnpmWorkspaceFile, "utf8");
      for (const match of content.matchAll(/^\s+-\s+["']?([^"'\n]+)["']?/gm)) {
        const glob = match[1].trim();
        // Handle "apps/*" → resolve parent "apps/"
        const parent = glob.replace(/\/\*.*$/, "");
        if (parent && !workspaceParentDirs.includes(parent)) {
          workspaceParentDirs.push(parent);
        }
      }
    } catch {}
  } else if (existsSync(rootPkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(rootPkgFile, "utf8")) as Record<string, unknown>;
      if (Array.isArray(pkg.workspaces)) {
        for (const glob of pkg.workspaces as string[]) {
          const parent = String(glob).replace(/\/\*.*$/, "");
          if (parent && !workspaceParentDirs.includes(parent)) {
            workspaceParentDirs.push(parent);
          }
        }
      }
    } catch {}
  }

  for (const parent of workspaceParentDirs) {
    const parentAbs = join(targetRoot, parent);
    if (!existsSync(parentAbs)) continue;
    try {
      const children = readdirSync(parentAbs, { withFileTypes: true });
      for (const child of children) {
        if (!child.isDirectory()) continue;
        const childPkg = join(parentAbs, child.name, "package.json");
        if (!existsSync(childPkg)) continue;
        try {
          const pkg = JSON.parse(readFileSync(childPkg, "utf8")) as Record<string, unknown>;
          const pkgName = typeof pkg.name === "string" ? pkg.name : child.name;
          const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
          const preferred = ["dev", "start", "serve"];
          for (const script of preferred) {
            if (scripts[script]) {
              suggestions.push({
                label: `${pkgName} — ${script}`,
                command: `pnpm --filter ${pkgName} ${script}`,
                cwd: `${parent}/${child.name}`,
                isRoot: false,
              });
              break;
            }
          }
        } catch {}
      }
    } catch {}
  }

  // 3. Root Makefile — grep for dev:/start:/serve: targets
  const makefile = join(targetRoot, "Makefile");
  if (existsSync(makefile)) {
    try {
      const content = readFileSync(makefile, "utf8");
      for (const target of ["dev", "start", "serve"]) {
        if (new RegExp(`^${target}:`, "m").test(content)) {
          suggestions.push({ label: `make ${target}`, command: `make ${target}`, isRoot: true });
          break;
        }
      }
    } catch {}
  }

  // 4. Root package.json scripts (only if no workspace suggestions from it)
  if (workspaceParentDirs.length === 0 && existsSync(rootPkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(rootPkgFile, "utf8")) as Record<string, unknown>;
      const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
      for (const script of ["dev", "start", "serve"]) {
        if (scripts[script]) {
          suggestions.push({ label: `pnpm ${script}`, command: `pnpm ${script}`, isRoot: true });
          break;
        }
      }
    } catch {}
  }

  // 5. docker-compose
  if (existsSync(join(targetRoot, "docker-compose.yml")) || existsSync(join(targetRoot, "docker-compose.yaml"))) {
    suggestions.push({ label: "docker compose up", command: "docker compose up", isRoot: true });
  }

  return suggestions;
}

// ── Backend health checker ────────────────────────────────────────────────────
// Probes all running services with ports every 30s. Results are merged into the
// services:snapshot WS push — no per-client HTTP polling needed.

type HealthResult = { healthy: boolean; latencyMs: number; checkedAt: string };
const serviceHealthCache = new Map<string, HealthResult | null>();

async function probeServiceHealth(entry: ServiceEntry, fifonyDir: string): Promise<HealthResult | null> {
  const status = getServiceRuntimeStatus(entry, fifonyDir);
  if (!status.running || !entry.port) return null;
  const url = entry.healthcheck?.endpoint ?? `http://localhost:${entry.port}`;
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return { healthy: res.ok, latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
  } catch {
    return { healthy: false, latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerServiceRoutes(
  app: RouteRegistrar,
  state: RuntimeState,
): void {
  const buildNetworkRuntimeOptions = () => ({
    dashPort: Number(state.config.dashboardPort ?? 4000),
    services: state.config.services ?? [],
    routes: state.config.proxyRoutes ?? [],
    localDomain: state.config.localDomain,
    reverseProxyEnabled: state.config.reverseProxyEnabled ?? false,
    port: state.config.reverseProxyPort ?? 4433,
    meshEnabled: state.config.meshEnabled ?? false,
    meshPort: state.config.meshProxyPort ?? 0,
    meshBufferSize: state.config.meshBufferSize ?? 1000,
    meshLiveWindowSeconds: state.config.meshLiveWindowSeconds ?? 900,
  });

  const syncNetworkRuntime = async () => {
    const options = buildNetworkRuntimeOptions();
    if (!options.reverseProxyEnabled && !options.meshEnabled) return;
    await applyNetworkRuntimeConfig(options);
  };

  const listRuntimeServices = (): ServiceStatus[] => {
    const reverseProxy = getReverseProxyRuntimeSnapshotStatus({
      enabled: state.config.reverseProxyEnabled ?? false,
      localDomain: state.config.localDomain,
      configuredPort: state.config.reverseProxyPort ?? 4433,
    }) as ServiceStatus;
    const mesh = getMeshRuntimeSnapshotStatus({
      enabled: state.config.meshEnabled ?? false,
      configuredPort: state.config.meshProxyPort ?? 0,
    }) as ServiceStatus;
    const runtimeServices: ServiceStatus[] = [];

    if (
      state.config.reverseProxyEnabled ||
      reverseProxy.running ||
      reverseProxy.logSize > 0
    ) {
      runtimeServices.push(reverseProxy);
    }

    if (
      state.config.meshEnabled ||
      mesh.running ||
      mesh.logSize > 0
    ) {
      runtimeServices.push(mesh);
    }

    return runtimeServices;
  };

  const findManagedService = (id: string) => (state.config.services ?? []).find((e) => e.id === id);
  const ensureManagedServicePort = async (entry: ServiceStatus | any) => {
    if (entry.port && entry.port > 0) return entry;
    const reservedPorts = collectReservedPorts(
      state.config,
      (state.config.services ?? []).filter((service) => service.id !== entry.id),
    );
    const nextEntry = await assignServicePort(entry, reservedPorts);
    const { replacePersistedService } = await import("../persistence/store.ts");
    await replacePersistedService(nextEntry);
    const entries = state.config.services ?? [];
    const idx = entries.findIndex((service) => service.id === entry.id);
    if (idx >= 0) entries[idx] = nextEntry;
    else entries.push(nextEntry);
    state.config.services = entries;
    return nextEntry;
  };
  const isRuntimeService = (id: string) => id === "reverse-proxy" || id === "mesh";
  const getRuntimeLogPath = (id: string) => id === "mesh" ? getMeshRuntimeLogPath() : getReverseProxyRuntimeLogPath();

  const withHealth = (services: ReturnType<typeof listServiceStatuses>) =>
    services.map((s) => ({ ...s, health: serviceHealthCache.get(s.id) ?? null }));

  setServicesSnapshotProvider(() => ({
    services: withHealth(listServiceStatuses(state.config.services ?? [], STATE_ROOT)),
    runtimeServices: listRuntimeServices(),
  }));

  // GET /api/services — list all entries with status
  app.get("/api/services", (c) => {
    const entries = state.config.services ?? [];
    const services = withHealth(listServiceStatuses(entries, STATE_ROOT));
    return c.json({ ok: true, services, runtimeServices: listRuntimeServices() });
  });

  // GET /api/services/detect — scan project for runnable commands
  app.get("/api/services/detect", (c) => {
    try {
      const suggestions = detectServices(TARGET_ROOT);
      return c.json({ ok: true, suggestions });
    } catch (err) {
      logger.error({ err }, "[Service] Detection failed");
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // GET /api/services/:id/status
  app.get("/api/services/:id/status", async (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (entry) {
      return c.json({ ok: true, ...getServiceRuntimeStatus(entry, STATE_ROOT) });
    }
    if (id === "reverse-proxy") {
      const runtime = await getReverseProxyRuntimeState();
      return c.json({
        ok: true,
        ...getReverseProxyRuntimeSnapshotStatus({
          enabled: state.config.reverseProxyEnabled ?? false,
          localDomain: state.config.localDomain,
          configuredPort: state.config.reverseProxyPort ?? 4433,
        }),
        running: runtime.running,
        pid: runtime.pid,
        startedAt: runtime.startedAt,
        port: runtime.proxyPort ?? state.config.reverseProxyPort ?? 4433,
      });
    }
    if (id === "mesh") {
      const runtime = await getMeshRuntimeState();
      return c.json({
        ok: true,
        ...getMeshRuntimeSnapshotStatus({
          enabled: state.config.meshEnabled ?? false,
          configuredPort: state.config.meshProxyPort ?? 0,
        }),
        running: runtime.running,
        pid: runtime.running ? getMeshRuntimeSnapshotStatus().pid : null,
        port: runtime.port ?? state.config.meshProxyPort ?? 0,
      });
    }
    return c.json({ ok: false, error: "Service not found." }, 404);
  });

  // POST /api/services/:id/start
  app.post("/api/services/:id/start", async (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry && !isRuntimeService(id)) return c.json({ ok: false, error: "Service not found." }, 404);
    try {
      if (entry) {
        const nextEntry = await ensureManagedServicePort(entry);
        await startManagedService(id);
        const status = getServiceRuntimeStatus(nextEntry, STATE_ROOT);
        return c.json({ ok: true, pid: status.pid, state: status.state });
      }

      if (id === "reverse-proxy") {
        const port = await startReverseProxyRuntime({ ...buildNetworkRuntimeOptions(), reverseProxyEnabled: true });
        const runtime = await getReverseProxyRuntimeState();
        broadcastToWebSocketClients({
          type: "service",
          id,
          state: runtime.running ? "running" : "stopped",
          running: runtime.running,
          pid: runtime.pid,
        });
        notifyServicesSnapshot();
        return c.json({ ok: true, pid: runtime.pid, state: "running", port });
      }

      state.config.meshEnabled = true;
      await applyNetworkRuntimeConfig(buildNetworkRuntimeOptions());
      const runtime = await getMeshRuntimeState();
      broadcastToWebSocketClients({
        type: "service",
        id,
        state: runtime.running ? "running" : "stopped",
        running: runtime.running,
        pid: getMeshRuntimeSnapshotStatus().pid,
      });
      notifyServicesSnapshot();
      return c.json({ ok: true, pid: getMeshRuntimeSnapshotStatus().pid, state: "running", port: runtime.port });
    } catch (err) {
      logger.error({ err }, `[Service] Failed to start ${id}`);
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // POST /api/services/:id/restart — stop + start via state machine
  app.post("/api/services/:id/restart", async (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry && !isRuntimeService(id)) return c.json({ ok: false, error: "Service not found." }, 404);
    try {
      if (entry) {
        const nextEntry = await ensureManagedServicePort(entry);
        try { await stopManagedService(id); } catch {}
        await startManagedService(id);
        const status = getServiceRuntimeStatus(nextEntry, STATE_ROOT);
        return c.json({ ok: true, pid: status.pid, state: status.state });
      }

      if (id === "reverse-proxy") {
        const port = await restartReverseProxyRuntime({ ...buildNetworkRuntimeOptions(), reverseProxyEnabled: true });
        const runtime = await getReverseProxyRuntimeState();
        broadcastToWebSocketClients({
          type: "service",
          id,
          state: runtime.running ? "running" : "stopped",
          running: runtime.running,
          pid: runtime.pid,
        });
        notifyServicesSnapshot();
        return c.json({ ok: true, pid: runtime.pid, state: "running", port });
      }

      await applyNetworkRuntimeConfig(buildNetworkRuntimeOptions());
      const runtime = await getMeshRuntimeState();
      broadcastToWebSocketClients({
        type: "service",
        id,
        state: runtime.running ? "running" : "stopped",
        running: runtime.running,
        pid: getMeshRuntimeSnapshotStatus().pid,
      });
      notifyServicesSnapshot();
      return c.json({ ok: true, pid: getMeshRuntimeSnapshotStatus().pid, state: runtime.running ? "running" : "stopped", port: runtime.port });
    } catch (err) {
      logger.error({ err }, `[Service] Failed to restart ${id}`);
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // POST /api/services/:id/stop
  app.post("/api/services/:id/stop", async (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry && !isRuntimeService(id)) return c.json({ ok: false, error: "Service not found." }, 404);
    try {
      if (entry) {
        await stopManagedService(id);
      } else if (id === "reverse-proxy") {
        state.config.reverseProxyEnabled = false;
        await applyNetworkRuntimeConfig(buildNetworkRuntimeOptions());
      } else {
        state.config.meshEnabled = false;
        await applyNetworkRuntimeConfig(buildNetworkRuntimeOptions());
      }
      if (!entry) {
        broadcastToWebSocketClients({
          type: "service",
          id,
          state: "stopped",
          running: false,
          pid: null,
        });
      }
    } catch { /* may already be stopped */ }
    notifyServicesSnapshot();
    if (entry) {
      const status = getServiceRuntimeStatus(entry, STATE_ROOT);
      return c.json({ ok: true, state: status.state });
    }
    return c.json({ ok: true, state: "stopped" });
  });

  // GET /api/services/:id/health — quick HTTP ping if port configured
  app.get("/api/services/:id/health", async (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry) return c.json({ ok: false, error: "Service not found." }, 404);

    const status = getServiceRuntimeStatus(entry, STATE_ROOT);
    if (!status.running) {
      return c.json({ ok: false, error: "Service is not running." });
    }

    const port = entry.port;
    if (!port) {
      return c.json({ ok: false, error: "No port configured." });
    }

    const url = entry.healthcheck?.endpoint ?? `http://localhost:${port}`;
    const start = Date.now();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(3_000),
      });
      const latencyMs = Date.now() - start;
      return c.json({ ok: true, healthy: res.ok, latencyMs, status: res.status });
    } catch (err) {
      const latencyMs = Date.now() - start;
      return c.json({ ok: true, healthy: false, latencyMs, error: String(err) });
    }
  });

  // GET /api/services/:id/log — tail (last 16KB) or new bytes since ?after=N
  app.get("/api/services/:id/log", (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry && !isRuntimeService(id)) return c.json({ ok: false, error: "Service not found." }, 404);
    const logFile = entry ? getManagedServiceLogPath(id, STATE_ROOT) : getRuntimeLogPath(id);
    let logSize = 0;
    if (existsSync(logFile)) {
      try { logSize = statSync(logFile).size; } catch {}
    }
    const afterParam = c.req.query("after");
    const after = afterParam !== undefined ? parseInt(afterParam, 10) : null;
    if (after !== null && !isNaN(after) && after >= 0 && logSize > after) {
      // Incremental: return only new bytes since `after`
      const readSize = logSize - after;
      try {
        const fd = openSync(logFile, "r");
        const buf = Buffer.alloc(readSize);
        readSync(fd, buf, 0, readSize, after);
        closeSync(fd);
        return c.json({ ok: true, text: buf.toString("utf8"), logSize, truncated: false });
      } catch {
        return c.json({ ok: true, text: "", logSize, truncated: false });
      }
    }
    // Full tail: last 16KB
    const logTail = entry ? readServiceLogTail(id, STATE_ROOT, 16_384) : readServiceLogTail("reverse-proxy", STATE_ROOT, 16_384);
    const truncated = logSize > 16_384;
    return c.json({ ok: true, logTail, logSize, truncated });
  });

  // GET /api/services/:id/stream — SSE live log
  app.get("/api/services/:id/stream", (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry && !isRuntimeService(id)) return c.json({ ok: false, error: "Service not found." }, 404);

    const logFile = entry ? getManagedServiceLogPath(id, STATE_ROOT) : getRuntimeLogPath(id);

    const enc = new TextEncoder();
    const sseMsg = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`);
    const sseComment = () => enc.encode(": keepalive\n\n");

    let chunkIntervalId: ReturnType<typeof setInterval>;
    let keepaliveId: ReturnType<typeof setInterval>;
    let statusCheckId: ReturnType<typeof setInterval>;

    const stream = new ReadableStream({
      start(ctrl) {
        let lastSize = 0;

        // Send initial content (last 16KB)
        if (existsSync(logFile)) {
          try {
            const stat = statSync(logFile);
            lastSize = stat.size;
            const readSize = Math.min(lastSize, 16_384);
            const fd = openSync(logFile, "r");
            const buf = Buffer.alloc(readSize);
            readSync(fd, buf, 0, readSize, Math.max(0, lastSize - readSize));
            closeSync(fd);
            ctrl.enqueue(sseMsg({ type: "init", text: buf.toString("utf8"), size: lastSize }));
          } catch {}
        } else {
          ctrl.enqueue(sseMsg({ type: "init", text: "", size: 0 }));
        }

        // Stream new bytes every second
        chunkIntervalId = setInterval(() => {
          if (!existsSync(logFile)) return;
          try {
            const stat = statSync(logFile);
            if (stat.size < lastSize) {
              // File was truncated (service restarted) — re-init from beginning
              lastSize = 0;
              const readSize = Math.min(stat.size, 16_384);
              let text = "";
              if (readSize > 0) {
                const fd = openSync(logFile, "r");
                const buf = Buffer.alloc(readSize);
                readSync(fd, buf, 0, readSize, 0);
                closeSync(fd);
                text = buf.toString("utf8");
                lastSize = stat.size;
              }
              ctrl.enqueue(sseMsg({ type: "init", text, size: lastSize }));
            } else if (stat.size > lastSize) {
              const readSize = stat.size - lastSize;
              const fd = openSync(logFile, "r");
              const buf = Buffer.alloc(readSize);
              readSync(fd, buf, 0, readSize, lastSize);
              closeSync(fd);
              lastSize = stat.size;
              ctrl.enqueue(sseMsg({ type: "chunk", text: buf.toString("utf8"), size: lastSize }));
            }
          } catch {}
        }, 1_000);

        // Notify client if process dies
        statusCheckId = setInterval(() => {
          if (entry) {
            const currentEntry = findManagedService(id);
            if (!currentEntry) return;
            const status = getServiceRuntimeStatus(currentEntry, STATE_ROOT);
            if (!status.running) {
              try { ctrl.enqueue(sseMsg({ type: "status", running: false })); } catch {}
            }
            return;
          }
          const runtimeStatePromise = id === "mesh" ? getMeshRuntimeState() : getReverseProxyRuntimeState();
          runtimeStatePromise.then((status) => {
            if (!status.running) {
              try { ctrl.enqueue(sseMsg({ type: "status", running: false })); } catch {}
            }
          }).catch(() => {});
        }, 5_000);

        keepaliveId = setInterval(() => {
          try { ctrl.enqueue(sseComment()); } catch {}
        }, 15_000);
      },
      cancel() {
        clearInterval(chunkIntervalId);
        clearInterval(keepaliveId);
        clearInterval(statusCheckId);
      },
    });

    return c.body(stream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
  });

  // POST /api/services/kill-all — stop all managed services + mesh + reverse proxy
  app.post("/api/services/kill-all", async (c) => {
    const services = state.config.services ?? [];
    const results: { id: string; ok: boolean; error?: string }[] = [];

    // Stop all managed services in parallel
    await Promise.allSettled(
      services.map(async (entry) => {
        try {
          await stopManagedService(entry.id);
          results.push({ id: entry.id, ok: true });
        } catch (err) {
          results.push({ id: entry.id, ok: false, error: String(err) });
        }
      }),
    );

    // Stop network runtimes
    if (state.config.meshEnabled) {
      try {
        state.config.meshEnabled = false;
        await applyNetworkRuntimeConfig(buildNetworkRuntimeOptions());
      } catch { /* already stopped */ }
    }
    if (state.config.reverseProxyEnabled) {
      try {
        state.config.reverseProxyEnabled = false;
        await applyNetworkRuntimeConfig(buildNetworkRuntimeOptions());
      } catch { /* already stopped */ }
    }

    broadcastToWebSocketClients({ type: "service", id: "mesh", state: "stopped", running: false, pid: null });
    broadcastToWebSocketClients({ type: "service", id: "reverse-proxy", state: "stopped", running: false, pid: null });
    notifyServicesSnapshot();

    logger.info({ stopped: results.length }, "kill-all: stopped all services and runtimes");
    return c.json({ ok: true, stopped: results });
  });

  // POST /api/services/config — save the services array
  app.post("/api/services/config", async (c) => {
    const response = await replaceServiceConfigs(c, {
      replaceAllServices: async (entries) => {
        const { replaceAllServices } = await import("../persistence/store.ts");
        await replaceAllServices(entries);
      },
      replacePersistedService: async () => {},
      deletePersistedService: async () => {},
    });
    if (response.status < 400) {
      await syncNetworkRuntime();
      notifyServicesSnapshot();
    }
    return response;
  });

  // DELETE /api/services/:id — stop + remove a single entry
  app.delete("/api/services/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await stopManagedService(id);
    } catch { /* ignore if not running */ }
    const response = await deleteServiceConfig(c, {
      deletePersistedService: async (serviceId) => {
        const { deletePersistedService } = await import("../persistence/store.ts");
        await deletePersistedService(serviceId);
      },
      replacePersistedService: async () => {},
      replaceAllServices: async () => {},
    });
    if (response.status < 400) {
      await syncNetworkRuntime();
      notifyServicesSnapshot();
    }
    return response;
  });

  // PUT /api/services/:id — update a single entry
  app.put("/api/services/:id", async (c) => {
    const response = await upsertServiceConfig(c, {
      replacePersistedService: async (entry) => {
        const { replacePersistedService } = await import("../persistence/store.ts");
        await replacePersistedService(entry);
      },
      deletePersistedService: async () => {},
      replaceAllServices: async () => {},
    });
    if (response.status < 400) {
      await syncNetworkRuntime();
      notifyServicesSnapshot();
    }
    return response;
  });

  app.post("/api/services/:id/assign-port", async (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry) return c.json({ ok: false, error: "Service not found." }, 404);

    try {
      const nextEntry = await ensureManagedServicePort(entry);
      await syncNetworkRuntime();
      notifyServicesSnapshot();
      return c.json({ ok: true, service: nextEntry });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // POST /api/services/:id/detect-healthcheck — AI reads log and detects host/port
  app.post("/api/services/:id/detect-healthcheck", async (c) => {
    const id = c.req.param("id");
    const entry = (state.config.services ?? []).find((e) => e.id === id);
    if (!entry) return c.json({ ok: false, error: "Service not found." }, 404);

    try {
      const logTail = readServiceLogTail(id, STATE_ROOT, 16_384);
      if (!logTail.trim()) {
        return c.json({ ok: false, error: "Service log is empty — start the service first." }, 400);
      }

      const { analyzeLogForHealthcheck } = await import("../agents/planning/log-analyzer.ts");
      const healthcheck = await analyzeLogForHealthcheck(logTail, entry.name, state.config);

      if (!healthcheck) {
        return c.json({ ok: true, found: false, healthcheck: null });
      }

      // Save healthcheck config to the service entry
      entry.healthcheck = healthcheck;
      const { replacePersistedService } = await import("../persistence/store.ts");
      await replacePersistedService(entry);
      notifyServicesSnapshot();

      return c.json({ ok: true, found: true, healthcheck, saved: true });
    } catch (err) {
      logger.error({ err, id }, "[Service] detect-healthcheck failed");
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // POST /api/services/:id/fix — AI reads log and suggests an issue to create
  app.post("/api/services/:id/fix", async (c) => {
    const id = c.req.param("id");
    const entry = (state.config.services ?? []).find((e) => e.id === id);
    if (!entry) return c.json({ ok: false, error: "Service not found." }, 404);

    try {
      const logTail = readServiceLogTail(id, STATE_ROOT, 8_192);
      if (!logTail.trim()) {
        return c.json({ ok: false, error: "Service log is empty — start the service first." }, 400);
      }

      const { analyzeLogForFix } = await import("../agents/planning/log-analyzer.ts");
      const suggestion = await analyzeLogForFix(logTail, entry.name, state.config);

      if (!suggestion) {
        return c.json({ ok: false, error: "Could not parse AI response." }, 422);
      }

      if (!suggestion.hasProblem) {
        return c.json({ ok: true, hasProblem: false });
      }

      return c.json({ ok: true, ...suggestion });
    } catch (err) {
      logger.error({ err, id }, "[Service] fix analysis failed");
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // POST /api/services/:id/insights — AI reads log and provides health insights
  app.post("/api/services/:id/insights", async (c) => {
    const id = c.req.param("id");
    const entry = (state.config.services ?? []).find((e) => e.id === id);
    if (!entry) return c.json({ ok: false, error: "Service not found." }, 404);

    try {
      const logTail = readServiceLogTail(id, STATE_ROOT, 16_384);
      if (!logTail.trim()) {
        return c.json({ ok: false, error: "Service log is empty — start the service first." }, 400);
      }

      const { analyzeLogForInsights } = await import("../agents/planning/log-analyzer.ts");
      const insights = await analyzeLogForInsights(logTail, entry.name, state.config);

      if (!insights) {
        return c.json({ ok: false, error: "Could not parse AI response." }, 422);
      }

      return c.json({ ok: true, insights });
    } catch (err) {
      logger.error({ err, id }, "[Service] insights analysis failed");
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // ── Backend health check loop ──────────────────────────────────────────────
  // Probes all running services with ports every 30s. Results flow to the
  // frontend via the existing services:snapshot WS push — no client polling.
  setInterval(async () => {
    const entries = (state.config.services ?? []).filter((e) => e.port);
    if (!entries.length) return;

    let changed = false;
    await Promise.allSettled(entries.map(async (entry) => {
      const prev = serviceHealthCache.get(entry.id);
      const result = await probeServiceHealth(entry, STATE_ROOT);
      serviceHealthCache.set(entry.id, result);
      if (!changed && JSON.stringify(prev) !== JSON.stringify(result)) changed = true;
    }));

    if (changed) notifyServicesSnapshot();
  }, 30_000);
}
