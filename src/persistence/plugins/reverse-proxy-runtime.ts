import type {
  ExplicitProxy,
  ProxyGraphSnapshot,
  ProxyTelemetryCollector,
  ProxyMiddleware,
  ProxyTelemetryEvent,
  ReverseProxy,
  ReverseProxyRouteConfig,
} from "raffel";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createSign, generateKeyPairSync } from "node:crypto";
import { STATE_ROOT } from "../../concerns/constants.ts";
import { logger } from "../../concerns/logger.ts";
import {
  TrafficRingBuffer,
  buildTrafficEntry,
  resolveTargetService,
} from "../../domains/traffic-proxy.ts";
import { createRaffelProxyTelemetry } from "../../domains/raffel-telemetry.ts";
import type {
  JsonRecord,
  ProxyRoute,
  ServiceEntry,
  ServiceStatus,
  TrafficEntry,
} from "../../types.ts";

let reverseProxy: ReverseProxy | null = null;
let meshProxy: ExplicitProxy | null = null;
let meshBuffer: TrafficRingBuffer | null = null;
let meshTelemetryUnsubscribe: (() => void) | null = null;
let meshTelemetryEvents: ProxyTelemetryEvent[] = [];
let meshTelemetryCollector: ProxyTelemetryCollector | null = null;
let meshExpireTimer: NodeJS.Timeout | null = null;

const MAX_MESH_TELEMETRY_EVENTS = 2_000;
const MESH_EXPIRE_INTERVAL_MS = 30 * 1000;

const NETWORK_RUNTIME_ID = "reverse-proxy";
const RUNTIME_CONFIG_PATH = join(STATE_ROOT, `service-${NETWORK_RUNTIME_ID}.runtime.json`);
const RUNTIME_PID_PATH = join(STATE_ROOT, `service-${NETWORK_RUNTIME_ID}.pid`);

type RuntimePidInfo = {
  pid: number;
  command: string;
  startedAt: string;
  controlPort?: number;
  proxyPort?: number;
  meshPort?: number;
  dashPort?: number;
  localDomain?: string;
};

export interface ReverseProxyStartOptions {
  dashPort: number;
  services?: ServiceEntry[];
  routes?: ProxyRoute[];
  localDomain?: string;
  reverseProxyEnabled?: boolean;
  port?: number;
  meshEnabled?: boolean;
  meshPort?: number;
  meshBufferSize?: number;
  meshLiveWindowSeconds?: number;
}

function writeRuntimePidInfo(info: RuntimePidInfo): void {
  writeFileSync(RUNTIME_PID_PATH, JSON.stringify(info));
}

function removeRuntimePidInfo(): void {
  try { rmSync(RUNTIME_PID_PATH, { force: true }); } catch {}
}

function removeRuntimeConfig(): void {
  try { rmSync(RUNTIME_CONFIG_PATH, { force: true }); } catch {}
}

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let tmp = n;
  while (tmp > 0) { bytes.unshift(tmp & 0xff); tmp >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(value.length), value]);
}

function encodeOID(oidStr: string): Buffer {
  const parts = oidStr.split(".").map(Number);
  const body: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const chunk: number[] = [];
    chunk.push(v & 0x7f);
    v >>= 7;
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v >>= 7; }
    body.push(...chunk);
  }
  return tlv(0x06, Buffer.from(body));
}

function algId(oidStr: string): Buffer {
  return tlv(0x30, Buffer.concat([encodeOID(oidStr), tlv(0x05, Buffer.alloc(0))]));
}

function encodeRDN(attrOid: string, value: string): Buffer {
  return tlv(0x31, tlv(0x30, Buffer.concat([encodeOID(attrOid), tlv(0x0c, Buffer.from(value, "utf8"))])));
}

function encodeName(components: Array<[string, string]>): Buffer {
  return tlv(0x30, Buffer.concat(components.map(([oid, v]) => encodeRDN(oid, v))));
}

function encodeUTCTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${String(d.getUTCFullYear()).slice(-2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, "ascii"));
}

function encodeExtension(extOid: string, critical: boolean, extValueDer: Buffer): Buffer {
  const parts = [encodeOID(extOid)];
  if (critical) parts.push(tlv(0x01, Buffer.from([0xff])));
  parts.push(tlv(0x04, extValueDer));
  return tlv(0x30, Buffer.concat(parts));
}

function encodeSAN(hosts: string[]): Buffer {
  const names = hosts.map((h) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(h)
      ? tlv(0x87, Buffer.from(h.split(".").map(Number)))
      : tlv(0x82, Buffer.from(h, "ascii")),
  );
  return encodeExtension("2.5.29.17", false, tlv(0x30, Buffer.concat(names)));
}

function encodeBasicConstraints(): Buffer {
  return encodeExtension("2.5.29.19", true, tlv(0x30, Buffer.alloc(0)));
}

function posInt(bytes: Buffer): Buffer {
  return bytes.length > 0 && (bytes[0] & 0x80) ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes;
}

function toPEM(der: Buffer, label: string): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

const SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const OID_CN = "2.5.4.3";

async function generateMultiSanCert(hosts: string[]): Promise<{ key: string; cert: string; ca: string }> {
  const { getDefaultCA } = await import("raffel");
  const ca = getDefaultCA();

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const { X509Certificate } = await import("node:crypto");
  let caIssuerName: Buffer;
  try {
    const x509 = new X509Certificate(ca.cert);
    const cnMatch = x509.subject.match(/CN=([^\n,/]+)/);
    const cn = cnMatch?.[1]?.trim() ?? "Spark Local CA";
    caIssuerName = encodeName([[OID_CN, cn]]);
  } catch {
    caIssuerName = encodeName([[OID_CN, "Spark Local CA"]]);
  }

  const now = new Date();
  const notAfter = new Date(now.getTime() + 825 * 24 * 60 * 60 * 1000);
  const sigAlg = algId(SHA256_WITH_RSA);

  const serialBytes = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
  serialBytes[0] = serialBytes[0] & 0x7f;

  const version = tlv(0xa0, tlv(0x02, Buffer.from([0x02])));
  const serial = tlv(0x02, posInt(serialBytes));
  const validity = tlv(0x30, Buffer.concat([encodeUTCTime(now), encodeUTCTime(notAfter)]));
  const subjectName = encodeName([[OID_CN, hosts[0]]]);
  const exts = tlv(0xa3, tlv(0x30, Buffer.concat([encodeBasicConstraints(), encodeSAN(hosts)])));

  const tbs = tlv(0x30, Buffer.concat([
    version, serial, sigAlg, caIssuerName, validity, subjectName, spkiDer, exts,
  ]));

  const signer = createSign("SHA256");
  signer.update(tbs);
  const sig = signer.sign(ca.key);

  const certDer = tlv(0x30, Buffer.concat([
    tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0x00]), sig])),
  ]));

  return { key: privateKeyPem, cert: toPEM(certDer, "CERTIFICATE"), ca: ca.cert };
}

const TLS_DIR = join(STATE_ROOT, "tls");
const KEY_PATH = join(TLS_DIR, "key.pem");
const CERT_PATH = join(TLS_DIR, "cert.pem");
const CA_PATH = join(TLS_DIR, "ca.pem");
const DOMAIN_PATH = join(TLS_DIR, "domain.txt");
const LOCAL_DOMAIN_PORT_SUFFIX = /:\d+$/;

export function getReverseProxyCaCertPath(): string {
  return CA_PATH;
}

export async function ensureReverseProxyTlsCert(localDomain?: string): Promise<{ key: string; cert: string }> {
  mkdirSync(TLS_DIR, { recursive: true });

  const storedDomain = existsSync(DOMAIN_PATH) ? readFileSync(DOMAIN_PATH, "utf8").trim() : "";
  const needsRegen =
    !existsSync(KEY_PATH) ||
    !existsSync(CERT_PATH) ||
    storedDomain !== (localDomain ?? "");

  if (!needsRegen) {
    return { key: readFileSync(KEY_PATH, "utf8"), cert: readFileSync(CERT_PATH, "utf8") };
  }

  const hosts = ["localhost", "127.0.0.1"];
  if (localDomain) {
    hosts.push(localDomain);
    hosts.push(`*.${localDomain}`);
  }

  logger.info({ hosts }, "[NetworkRuntime] Generating TLS cert");
  const { key, cert, ca } = await generateMultiSanCert(hosts);

  writeFileSync(KEY_PATH, key);
  writeFileSync(CERT_PATH, cert);
  writeFileSync(CA_PATH, ca);
  writeFileSync(DOMAIN_PATH, localDomain ?? "");

  return { key, cert };
}

export function invalidateReverseProxyCert(): void {
  try { if (existsSync(DOMAIN_PATH)) unlinkSync(DOMAIN_PATH); } catch {}
}

export function buildRaffelRoutes(
  routes: ProxyRoute[],
  services: ServiceEntry[],
  dashPort: number,
): ReverseProxyRouteConfig[] {
  const normalizeOneHost = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const hostOnly = withoutScheme.split("/")[0]?.split("?")[0] ?? "";
    const normalized = hostOnly.replace(LOCAL_DOMAIN_PORT_SUFFIX, "").toLowerCase();
    return normalized || undefined;
  };
  const normalizeHost = (value?: string | string[]): string | string[] | undefined => {
    if (!value) return undefined;
    if (Array.isArray(value)) {
      const normalized = value.map(normalizeOneHost).filter((h): h is string => !!h);
      return normalized.length === 1 ? normalized[0] : normalized.length > 1 ? normalized : undefined;
    }
    return normalizeOneHost(value);
  };
  const normalizePathPrefix = (value?: string) => {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  };
  const portById = new Map(services.map((s) => [s.id, s.port]));
  const normalizedRoutes = routes.map((route) => ({
    ...route,
    host: normalizeHost(route.host),
    pathPrefix: normalizePathPrefix(route.pathPrefix),
    target: route.target?.trim() || undefined,
  }));
  const specificity = (r: ProxyRoute) => ((Array.isArray(r.host) ? r.host.length > 0 : !!r.host) ? 2 : 0) + (r.pathPrefix ? 1 : 0);
  const sorted = [...normalizedRoutes].sort((a, b) => specificity(b) - specificity(a));
  const raffelRoutes: ReverseProxyRouteConfig[] = [];

  for (const route of sorted) {
    const port = route.serviceId ? portById.get(route.serviceId) : undefined;
    const target = port ? `http://127.0.0.1:${port}` : route.target?.trim() ?? null;
    if (!target) {
      logger.warn({ routeId: route.id }, "[NetworkRuntime] Skipping route — no resolvable target");
      continue;
    }
    const match: ReverseProxyRouteConfig["match"] = {};
    if (route.host) match.host = route.host;
    if (route.pathPrefix) match.pathPrefix = route.pathPrefix;

    const raffelRoute: ReverseProxyRouteConfig = { match, target };
    if (route.pathPrefix && route.stripPrefix !== false) {
      raffelRoute.stripPrefix = route.pathPrefix;
    }
    raffelRoutes.push(raffelRoute);
  }

  raffelRoutes.push({ match: { pathPrefix: "/" }, target: `http://127.0.0.1:${dashPort}` });
  return raffelRoutes;
}

function toRuntimeServiceStatuses(services: ServiceEntry[]): ServiceStatus[] {
  return services.map((service) => ({
    id: service.id,
    name: service.name,
    command: service.command,
    cwd: service.cwd,
    env: service.env,
    autoStart: service.autoStart,
    autoRestart: service.autoRestart,
    maxCrashes: service.maxCrashes,
    port: service.port,
    state: "running",
    running: true,
    pid: null,
    startedAt: null,
    uptime: 0,
    logSize: 0,
    crashCount: 0,
    errorCount: 0,
  }));
}

export async function startReverseProxy(options: ReverseProxyStartOptions): Promise<number | null> {
  if (!options.reverseProxyEnabled) return null;
  if (reverseProxy?.isRunning) {
    logger.warn("[NetworkRuntime] Reverse proxy already running, skipping start");
    return reverseProxy.boundPort!;
  }

  const { key, cert } = await ensureReverseProxyTlsCert(options.localDomain);
  const { createReverseProxy } = await import("raffel");
  const routes = buildRaffelRoutes(options.routes ?? [], options.services ?? [], options.dashPort);

  reverseProxy = await createReverseProxy({
    server: { host: "0.0.0.0", port: options.port ?? 4433, tls: { key, cert } },
    routes,
  });

  const boundPort = await reverseProxy.start();
  logger.info({ port: boundPort, routeCount: routes.length, localDomain: options.localDomain }, "[NetworkRuntime] HTTPS reverse proxy started");
  return boundPort;
}

export async function stopReverseProxy(): Promise<void> {
  if (!reverseProxy?.isRunning) return;
  await reverseProxy.stop();
  logger.info("[NetworkRuntime] HTTPS reverse proxy stopped");
  reverseProxy = null;
}

const meshRequestStartTimes = new Map<string, number>();

function buildMeshMiddleware(services: ServiceEntry[]): ProxyMiddleware {
  return async (ctx, next) => {
    if (ctx.kind === "http-request") {
      meshRequestStartTimes.set(ctx.clientAddress, Date.now());
      await next();
      return;
    }

    if (ctx.kind === "http-response") {
      await next();

      const startTime = meshRequestStartTimes.get(ctx.clientAddress) ?? Date.now();
      meshRequestStartTimes.delete(ctx.clientAddress);

      const url = ctx.request?.url ?? "";
      const method = ctx.request?.method ?? "GET";
      const sourceId = ctx.authUsername ?? null;
      const targetId = resolveTargetService(url, toRuntimeServiceStatuses(services));

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

      meshBuffer?.push(entry);
    }
  };
}

function queueMeshTelemetryEvent(event: ProxyTelemetryEvent): void {
  meshTelemetryEvents.push(event);
  if (meshTelemetryEvents.length > MAX_MESH_TELEMETRY_EVENTS) {
    meshTelemetryEvents = meshTelemetryEvents.slice(-MAX_MESH_TELEMETRY_EVENTS);
  }
}

function getMeshLiveWindowMs(options?: ReverseProxyStartOptions): number {
  const seconds = Number(options?.meshLiveWindowSeconds ?? 900);
  if (!Number.isFinite(seconds)) return 900_000;
  return Math.min(Math.max(seconds, 30), 86_400) * 1000;
}

function resolveMeshDestinationNode(
  services: ServiceEntry[],
  host?: string,
  port?: number,
): string | null {
  if (!host && !port) return null;
  const match = services.find((service) => service.port != null && service.port === port);
  if (match?.id) return match.id;
  if (host && port != null) return `${host}:${port}`;
  return host ?? null;
}

export async function startMeshProxy(options: ReverseProxyStartOptions): Promise<number | null> {
  if (!options.meshEnabled) return null;
  if (meshProxy?.isRunning) {
    logger.warn("[NetworkRuntime] Mesh proxy already running, skipping start");
    return meshProxy.boundPort!;
  }

  meshBuffer = new TrafficRingBuffer(options.meshBufferSize ?? 1000);
  meshTelemetryEvents = [];

  const { createExplicitProxy } = await import("raffel");
  meshTelemetryCollector = await createRaffelProxyTelemetry({
    rateWindowMs: 60_000,
  });
  meshProxy = createExplicitProxy({
    port: options.meshPort ?? 0,
    host: "127.0.0.1",
    forward: {
      timeout: 30_000,
      maxBodySize: 10 * 1024 * 1024,
    },
    telemetry: {
      collector: meshTelemetryCollector,
      resolveNode: (ctx) => {
        if (ctx.role === "destination") {
          return resolveMeshDestinationNode(options.services ?? [], ctx.host, ctx.port);
        }
        // authUsername is set when services authenticate to the proxy
        // (HTTP_PROXY=http://serviceId:@host:port)
        if (ctx.authUsername) return ctx.authUsername;
        return null;
      },
      metricsEndpoint: false,
      graphEndpoint: false,
    },
    middleware: [buildMeshMiddleware(options.services ?? [])],
  });

  await meshProxy.start();
  meshTelemetryUnsubscribe?.();
  meshTelemetryUnsubscribe = meshProxy.subscribe((event) => {
    queueMeshTelemetryEvent(event);
  });
  if (meshExpireTimer) clearInterval(meshExpireTimer);
  meshExpireTimer = setInterval(() => {
    if (!meshTelemetryCollector) return;
    const cutoff = new Date(Date.now() - getMeshLiveWindowMs(options)).toISOString();
    meshTelemetryCollector.expireEdgesBefore(cutoff);
  }, MESH_EXPIRE_INTERVAL_MS);
  logger.info({ port: meshProxy.boundPort }, "[NetworkRuntime] Mesh proxy started");
  return meshProxy.boundPort!;
}

export async function stopMeshProxy(): Promise<void> {
  if (!meshProxy?.isRunning) return;
  await meshProxy.stop();
  logger.info("[NetworkRuntime] Mesh proxy stopped");
  if (meshExpireTimer) clearInterval(meshExpireTimer);
  meshExpireTimer = null;
  meshTelemetryUnsubscribe?.();
  meshTelemetryUnsubscribe = null;
  meshProxy = null;
  meshBuffer = null;
  meshTelemetryEvents = [];
  meshTelemetryCollector = null;
}

export function isReverseProxyRunning(): boolean {
  return reverseProxy?.isRunning ?? false;
}

export function isMeshProxyRunning(): boolean {
  return meshProxy?.isRunning ?? false;
}

export function getReverseProxyPort(): number | null {
  return reverseProxy?.boundPort ?? null;
}

export function getMeshProxyPort(): number | null {
  return meshProxy?.boundPort ?? null;
}

export function getReverseProxyCaCert(): string | null {
  return reverseProxy?.caCert ?? null;
}

export function getReverseProxyStats(): JsonRecord | null {
  return reverseProxy?.stats as unknown as JsonRecord | null ?? null;
}

export function getReverseProxyGraphSnapshot(): JsonRecord | null {
  if (!reverseProxy?.isRunning) return null;
  return reverseProxy.graphSnapshot() as unknown as JsonRecord | null;
}

export function getMeshStats(): JsonRecord | null {
  return meshProxy?.stats as unknown as JsonRecord | null ?? null;
}

export function getMeshNativeGraphSnapshot(): JsonRecord | null {
  if (!meshProxy?.isRunning) return null;
  return meshProxy.graphSnapshot() as unknown as JsonRecord | null;
}

export function getMeshMetrics(format: "prometheus" | "json" = "prometheus"): string | null {
  return meshProxy?.metricsRegistry?.export(format) ?? null;
}

export function getMeshTrafficEntries(limit = 200): TrafficEntry[] {
  return meshBuffer?.getRecent(limit) ?? [];
}

export async function clearMeshData(): Promise<void> {
  meshBuffer?.clear();
  if (!meshTelemetryCollector || !meshProxy?.isRunning) {
    meshTelemetryEvents = [];
    return;
  }
  meshTelemetryCollector.reset();
  meshTelemetryEvents = [];
}

export function getMeshServiceGraph(services: ServiceEntry[]): JsonRecord | null {
  if (!meshProxy?.isRunning) return null;
  const snapshot = meshProxy.graphSnapshot() as ProxyGraphSnapshot;
  const serviceStatuses = toRuntimeServiceStatuses(services);
  const serviceNames = new Map(serviceStatuses.map((service) => [service.id, service.name]));
  const servicePorts = new Map(serviceStatuses.map((service) => [service.id, service.port]));
  const serviceStates = new Map(serviceStatuses.map((service) => [service.id, service.state]));
  const nodeIds = new Set(serviceStatuses.map((service) => service.id));
  const snapshotNodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const edges = snapshot.edges
    .filter((edge) => nodeIds.has(edge.target))  // at least target must be a known service
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      requestCount: edge.requestsTotal > 0 ? edge.requestsTotal : edge.flowsTotal,
      errorCount: edge.errorsTotal,
      dominantProtocol: edge.protocol,
      protocolCounts: [{ protocol: edge.protocol, count: edge.flowsTotal }],
      avgLatencyMs: edge.latency.averageSeconds != null ? Math.round(edge.latency.averageSeconds * 1000) : 0,
      p50LatencyMs: edge.latency.percentiles.p50 != null ? Math.round(edge.latency.percentiles.p50 * 1000) : 0,
      p90LatencyMs: edge.latency.percentiles.p90 != null ? Math.round(edge.latency.percentiles.p90 * 1000) : 0,
      p95LatencyMs: edge.latency.percentiles.p95 != null ? Math.round(edge.latency.percentiles.p95 * 1000) : 0,
      p99LatencyMs: edge.latency.percentiles.p99 != null ? Math.round(edge.latency.percentiles.p99 * 1000) : 0,
      lastSeenAt: edge.lastSeenAt,
      topPaths: edge.topPaths,
      bytesIn: edge.bytesFromSource,
      bytesOut: edge.bytesToSource,
      activeFlows: edge.activeFlows,
      flowsTotal: edge.flowsTotal,
      statusClassCounts: edge.statusClassCounts,
      methodCounts: edge.methodCounts,
    }));

  // Collect external source node IDs (not in known services)
  const externalIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source && !nodeIds.has(edge.source)) externalIds.add(edge.source);
  }

  const externalNodes = [...externalIds].map((id) => ({
    id,
    name: id.length > 22 ? id.slice(0, 20) + "\u2026" : id,
    state: "external",
    port: null,
    requestsIn: 0, requestsOut: 0, errorsIn: 0, errorsOut: 0,
    bytesIn: 0, bytesOut: 0, activeFlows: 0,
    protocols: {}, lastSeenAt: null, external: true,
  }));

  return {
    nodes: [
      ...serviceStatuses.map((service) => ({
        id: service.id,
        name: serviceNames.get(service.id) ?? service.id,
        state: serviceStates.get(service.id) ?? "running",
        port: servicePorts.get(service.id),
        requestsIn: snapshotNodes.get(service.id)?.requestsIn ?? 0,
        requestsOut: snapshotNodes.get(service.id)?.requestsOut ?? 0,
        errorsIn: snapshotNodes.get(service.id)?.errorsIn ?? 0,
        errorsOut: snapshotNodes.get(service.id)?.errorsOut ?? 0,
        bytesIn: snapshotNodes.get(service.id)?.bytesIn ?? 0,
        bytesOut: snapshotNodes.get(service.id)?.bytesOut ?? 0,
        activeFlows: snapshotNodes.get(service.id)?.activeFlows ?? 0,
        protocols: snapshotNodes.get(service.id)?.protocols ?? {},
        lastSeenAt: snapshotNodes.get(service.id)?.lastSeenAt ?? null,
      })),
      ...externalNodes,
    ],
    edges,
    capturedSince: snapshot.windowStart,
    totalRequests: edges.reduce((sum, edge) => sum + (typeof edge.requestCount === "number" ? edge.requestCount : 0), 0),
    windowStart: snapshot.windowStart,
    windowEnd: snapshot.windowEnd,
    seq: snapshot.seq,
  } as JsonRecord;
}

export function getMeshTelemetryEvents(afterSeq = 0, limit = 200): JsonRecord[] {
  return meshTelemetryEvents
    .filter((event) => event.seq > afterSeq)
    .slice(0, Math.max(1, limit))
    .map((event) => event as unknown as JsonRecord);
}

export async function runReverseProxyRuntimeProcess(configPath: string): Promise<void> {
  // Synchronous fallback: pino worker threads may not flush before process exit.
  // Write startup errors directly to stderr so the log file is never empty on crash.
  const syncErr = (msg: string) => {
    try { process.stderr.write(`[NetworkRuntime] ${msg}\n`); } catch {}
  };

  let config: ReverseProxyStartOptions;
  try {
    const raw = readFileSync(configPath, "utf8");
    config = JSON.parse(raw) as ReverseProxyStartOptions;
  } catch (err) {
    syncErr(`Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    process.exit(1);
    return;
  }

  const startedAt = new Date().toISOString();
  let proxyPort: number | null;
  let meshPort: number | null;
  try {
    proxyPort = await startReverseProxy(config);
    meshPort = await startMeshProxy(config);
  } catch (err) {
    syncErr(`Failed to start proxy: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
    process.exit(1);
    return;
  }

  const controlServer = createServer(async (req, res) => {
    const sendJson = (statusCode: number, payload: unknown) => {
      res.statusCode = statusCode;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };

    if (!req.url) return void sendJson(404, { ok: false });
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/status") {
      return void sendJson(200, {
        ok: true,
        running: isReverseProxyRunning() || isMeshProxyRunning(),
        startedAt,
        pid: process.pid,
        controlPort: (controlServer.address() as { port?: number } | null)?.port ?? null,
        localDomain: config.localDomain ?? null,
        reverseProxy: {
          enabled: config.reverseProxyEnabled === true,
          running: isReverseProxyRunning(),
          proxyPort: getReverseProxyPort(),
        },
        mesh: {
          enabled: config.meshEnabled === true,
          running: isMeshProxyRunning(),
          port: getMeshProxyPort(),
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/stats") return void sendJson(200, { ok: true, stats: getReverseProxyStats() });
    if (req.method === "GET" && url.pathname === "/graph") return void sendJson(200, { ok: true, snapshot: getReverseProxyGraphSnapshot() });
    if (req.method === "GET" && url.pathname === "/mesh/status") {
      return void sendJson(200, { ok: true, running: isMeshProxyRunning(), port: getMeshProxyPort() });
    }
    if (req.method === "GET" && url.pathname === "/mesh/traffic") {
      const limit = Number(url.searchParams.get("limit") ?? "200");
      return void sendJson(200, { ok: true, entries: getMeshTrafficEntries(limit) });
    }
    if (req.method === "GET" && url.pathname === "/mesh/events") {
      const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "200");
      return void sendJson(200, {
        ok: true,
        events: getMeshTelemetryEvents(Number.isFinite(afterSeq) ? afterSeq : 0, Number.isFinite(limit) ? limit : 200),
        currentSeq: meshProxy?.graphSnapshot().seq ?? 0,
      });
    }
    if (req.method === "GET" && url.pathname === "/mesh/stats") {
      return void sendJson(200, { ok: true, stats: getMeshStats() });
    }
    if (req.method === "GET" && url.pathname === "/mesh/graph") {
      return void sendJson(200, {
        ok: true,
        graph: getMeshServiceGraph(config.services ?? []),
        nativeGraph: getMeshNativeGraphSnapshot(),
      });
    }
    if (req.method === "GET" && url.pathname === "/mesh/metrics") {
      const format = url.searchParams.get("format") === "json" ? "json" : "prometheus";
      const metrics = getMeshMetrics(format);
      return void sendJson(200, { ok: true, metrics, format });
    }
    if (req.method === "POST" && url.pathname === "/mesh/clear") {
      await clearMeshData();
      return void sendJson(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      sendJson(200, { ok: true });
      setTimeout(() => {
        Promise.allSettled([stopReverseProxy(), stopMeshProxy()]).finally(() => {
          try { controlServer.close(); } catch {}
          removeRuntimePidInfo();
          removeRuntimeConfig();
          process.exit(0);
        });
      }, 20);
      return;
    }
    sendJson(404, { ok: false });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    controlServer.once("error", rejectPromise);
    controlServer.listen(0, "127.0.0.1", () => resolvePromise());
  });

  writeRuntimePidInfo({
    pid: process.pid,
    command: process.argv.join(" "),
    startedAt,
    controlPort: (controlServer.address() as { port?: number } | null)?.port,
    proxyPort: proxyPort ?? undefined,
    meshPort: meshPort ?? undefined,
    dashPort: config.dashPort,
    localDomain: config.localDomain,
  });

  const shutdown = async () => {
    await Promise.allSettled([stopReverseProxy(), stopMeshProxy()]);
    try { controlServer.close(); } catch {}
    removeRuntimePidInfo();
    removeRuntimeConfig();
    process.exit(0);
  };

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  await new Promise<void>(() => {});
}
