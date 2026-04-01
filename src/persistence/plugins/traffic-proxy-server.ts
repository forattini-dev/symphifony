import {
  createExplicitProxy,
  type ExplicitProxy,
  type ProxyMiddleware,
  type ProxyStats,
} from "raffel";
import { logger } from "../../concerns/logger.ts";
import {
  TrafficRingBuffer,
  ServiceGraphAccumulator,
  resolveTargetService,
  buildTrafficEntry,
} from "../../domains/traffic-proxy.ts";
import type { TrafficEntry, ServiceStatus } from "../../types.ts";

// ── Singleton state ──────────────────────────────────────────────

let meshProxy: ExplicitProxy | null = null;
let buffer: TrafficRingBuffer | null = null;
let graph: ServiceGraphAccumulator | null = null;

type OnEntryFn = (entry: TrafficEntry) => void;

// Accessor for services list — injected externally to avoid importing persistence
let servicesAccessor: (() => ServiceStatus[]) | null = null;

export function setServicesAccessor(fn: () => ServiceStatus[]): void {
  servicesAccessor = fn;
}

// ── Middleware ────────────────────────────────────────────────────

// Track request start times keyed by clientAddress (unique per TCP connection).
// HTTP/1.1 keep-alive is sequential so a single entry per address is sufficient.
const startTimes = new Map<string, number>();

function buildMeshMiddleware(onEntry?: OnEntryFn): ProxyMiddleware {
  return async (ctx, next) => {
    if (ctx.kind === "http-request") {
      startTimes.set(ctx.clientAddress, Date.now());
      await next();
      return;
    }

    if (ctx.kind === "http-response") {
      await next();

      const startTime = startTimes.get(ctx.clientAddress) ?? Date.now();
      startTimes.delete(ctx.clientAddress);

      const url = ctx.request?.url ?? "";
      const method = ctx.request?.method ?? "GET";
      // authUsername is parsed from Proxy-Authorization even without auth validation
      const sourceId = ctx.authUsername ?? null;
      const services = servicesAccessor?.() ?? [];
      const targetId = resolveTargetService(url, services);

      const entry = buildTrafficEntry(
        method,
        url,
        0,
        ctx.response?.statusCode ?? 0,
        0,
        sourceId,
        targetId,
        startTime,
      );

      buffer?.push(entry);
      graph?.record(entry);
      onEntry?.(entry);
    }
  };
}

// ── Lifecycle ────────────────────────────────────────────────────

export interface TrafficProxyOptions {
  port?: number;
  bufferSize?: number;
  onEntry?: OnEntryFn;
}

export async function startTrafficProxy(
  options: TrafficProxyOptions = {},
): Promise<number> {
  if (meshProxy?.isRunning) {
    logger.warn("[Mesh] Traffic proxy already running, skipping start");
    return meshProxy.boundPort!;
  }

  const bufferSize = options.bufferSize ?? 1000;
  buffer = new TrafficRingBuffer(bufferSize);
  graph = new ServiceGraphAccumulator();

  meshProxy = createExplicitProxy({
    port: options.port ?? 0,
    host: "127.0.0.1",
    forward: {
      timeout: 30_000,
      maxBodySize: 10 * 1024 * 1024,
    },
    // telemetry with endpoints disabled keeps metricsRegistry populated
    // but doesn't expose /metrics or /proxy/graph directly on the proxy port;
    // they are exposed via /api/mesh/metrics and /api/mesh/graph in our API
    telemetry: {
      metricsEndpoint: false,
      graphEndpoint: false,
    },
    middleware: [buildMeshMiddleware(options.onEntry)],
  });

  await meshProxy.start();
  logger.info({ port: meshProxy.boundPort }, "[Mesh] Traffic proxy started");
  return meshProxy.boundPort!;
}

export async function stopTrafficProxy(): Promise<void> {
  if (!meshProxy?.isRunning) return;
  await meshProxy.stop();
  logger.info("[Mesh] Traffic proxy stopped");
  meshProxy = null;
  buffer = null;
  graph = null;
}

// ── Accessors ─────────────────────────────────────────────────────

export function getTrafficProxyPort(): number | null {
  return meshProxy?.boundPort ?? null;
}

export function isTrafficProxyRunning(): boolean {
  return meshProxy?.isRunning ?? false;
}

export function getTrafficBuffer(): TrafficRingBuffer | null {
  return buffer;
}

export function getServiceGraph(): ServiceGraphAccumulator | null {
  return graph;
}

export function getTrafficProxyStats(): ProxyStats | null {
  return meshProxy?.stats ?? null;
}

/** Exports native raffel proxy metrics in Prometheus or JSON format. */
export function getMeshMetrics(format: "prometheus" | "json" = "prometheus"): string | null {
  return meshProxy?.metricsRegistry?.export(format) ?? null;
}

/** Returns the native raffel proxy graph snapshot with per-edge latency, rates, and flow counts. */
export function getMeshGraphSnapshot() {
  if (!meshProxy?.isRunning) return null;
  return meshProxy.graphSnapshot();
}
