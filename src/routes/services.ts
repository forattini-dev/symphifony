import type { RuntimeState } from "../types.ts";
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
import {
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

// ── Route registration ────────────────────────────────────────────────────────

export function registerServiceRoutes(
  app: RouteRegistrar,
  state: RuntimeState,
): void {
  const listRuntimeServices = (): ServiceStatus[] => {
    const reverseProxy = getReverseProxyRuntimeSnapshotStatus({
      enabled: state.config.reverseProxyEnabled ?? false,
      localDomain: state.config.localDomain,
      configuredPort: state.config.reverseProxyPort ?? 4433,
    }) as ServiceStatus;

    if (
      state.config.reverseProxyEnabled ||
      reverseProxy.running ||
      reverseProxy.logSize > 0
    ) {
      return [reverseProxy];
    }

    return [];
  };

  const findManagedService = (id: string) => (state.config.services ?? []).find((e) => e.id === id);
  const isReverseProxyRuntimeService = (id: string) => id === "reverse-proxy";
  const getReverseProxyRuntimeOptions = () => ({
    port: state.config.reverseProxyPort ?? 4433,
    dashPort: Number(state.config.dashboardPort ?? 4000),
    routes: state.config.proxyRoutes ?? [],
    services: (state.config.services ?? []).map((s) => ({ id: s.id, port: s.port })),
    localDomain: state.config.localDomain,
  });

  setServicesSnapshotProvider(() => ({
    services: listServiceStatuses(state.config.services ?? [], STATE_ROOT),
    runtimeServices: listRuntimeServices(),
  }));

  // GET /api/services — list all entries with status
  app.get("/api/services", (c) => {
    const entries = state.config.services ?? [];
    const services = listServiceStatuses(entries, STATE_ROOT);
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
  app.get("/api/services/:id/status", (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (entry) {
      return c.json({ ok: true, ...getServiceRuntimeStatus(entry, STATE_ROOT) });
    }
    if (isReverseProxyRuntimeService(id)) {
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
    return c.json({ ok: false, error: "Service not found." }, 404);
  });

  // POST /api/services/:id/start
  app.post("/api/services/:id/start", async (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry && !isReverseProxyRuntimeService(id)) return c.json({ ok: false, error: "Service not found." }, 404);
    try {
      if (entry) {
        await startManagedService(id);
        const status = getServiceRuntimeStatus(entry, STATE_ROOT);
        return c.json({ ok: true, pid: status.pid, state: status.state });
      }

      const port = await startReverseProxyRuntime(getReverseProxyRuntimeOptions());
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
    } catch (err) {
      logger.error({ err }, `[Service] Failed to start ${id}`);
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // POST /api/services/:id/restart — stop + start via state machine
  app.post("/api/services/:id/restart", async (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry && !isReverseProxyRuntimeService(id)) return c.json({ ok: false, error: "Service not found." }, 404);
    try {
      if (entry) {
        try { await stopManagedService(id); } catch {}
        await startManagedService(id);
        const status = getServiceRuntimeStatus(entry, STATE_ROOT);
        return c.json({ ok: true, pid: status.pid, state: status.state });
      }

      const port = await restartReverseProxyRuntime(getReverseProxyRuntimeOptions());
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
    } catch (err) {
      logger.error({ err }, `[Service] Failed to restart ${id}`);
      return c.json({ ok: false, error: String(err) }, 500);
    }
  });

  // POST /api/services/:id/stop
  app.post("/api/services/:id/stop", async (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry && !isReverseProxyRuntimeService(id)) return c.json({ ok: false, error: "Service not found." }, 404);
    try {
      if (entry) {
        await stopManagedService(id);
      } else {
        await stopReverseProxyRuntime();
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
    if (!entry && !isReverseProxyRuntimeService(id)) return c.json({ ok: false, error: "Service not found." }, 404);
    const logFile = entry ? getManagedServiceLogPath(id, STATE_ROOT) : getReverseProxyRuntimeLogPath();
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
    const logTail = readServiceLogTail(id, STATE_ROOT, 16_384);
    const truncated = logSize > 16_384;
    return c.json({ ok: true, logTail, logSize, truncated });
  });

  // GET /api/services/:id/stream — SSE live log
  app.get("/api/services/:id/stream", (c) => {
    const id = c.req.param("id");
    const entry = findManagedService(id);
    if (!entry && !isReverseProxyRuntimeService(id)) return c.json({ ok: false, error: "Service not found." }, 404);

    const logFile = entry ? getManagedServiceLogPath(id, STATE_ROOT) : getReverseProxyRuntimeLogPath();

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
          getReverseProxyRuntimeState().then((status) => {
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
      notifyServicesSnapshot();
    }
    return response;
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
}
