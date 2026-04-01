import type { ReverseProxy, ReverseProxyRouteConfig } from "raffel";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createSign, generateKeyPairSync } from "node:crypto";
import { STATE_ROOT } from "../../concerns/constants.ts";
import { logger } from "../../concerns/logger.ts";
import type { ProxyRoute } from "../../types.ts";
import { isProcessAlive } from "../../agents/pid-manager.ts";

// ── Singleton state ──────────────────────────────────────────────

let reverseProxy: ReverseProxy | null = null;

const REVERSE_PROXY_RUNTIME_ID = "reverse-proxy";
const RUNTIME_CONFIG_PATH = join(STATE_ROOT, `service-${REVERSE_PROXY_RUNTIME_ID}.runtime.json`);
const RUNTIME_PID_PATH = join(STATE_ROOT, `service-${REVERSE_PROXY_RUNTIME_ID}.pid`);
const RUNTIME_LOG_PATH = join(STATE_ROOT, `service-${REVERSE_PROXY_RUNTIME_ID}.log`);

type ReverseProxyRuntimeConfig = {
  port: number;
  dashPort: number;
  routes?: ProxyRoute[];
  services?: Array<{ id: string; port?: number }>;
  localDomain?: string;
};

type ReverseProxyRuntimePidInfo = {
  pid: number;
  command: string;
  startedAt: string;
  controlPort?: number;
  proxyPort?: number;
  dashPort?: number;
  localDomain?: string;
};

function readRuntimePidInfo(): ReverseProxyRuntimePidInfo | null {
  if (!existsSync(RUNTIME_PID_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(RUNTIME_PID_PATH, "utf8")) as ReverseProxyRuntimePidInfo;
    if (!data?.pid || typeof data.pid !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

function writeRuntimePidInfo(info: ReverseProxyRuntimePidInfo): void {
  writeFileSync(RUNTIME_PID_PATH, JSON.stringify(info));
}

function removeRuntimePidInfo(): void {
  try { rmSync(RUNTIME_PID_PATH, { force: true }); } catch {}
}

function removeRuntimeConfig(): void {
  try { rmSync(RUNTIME_CONFIG_PATH, { force: true }); } catch {}
}

export function getReverseProxyRuntimeLogPath(): string {
  return RUNTIME_LOG_PATH;
}

export function getReverseProxyRuntimePidPath(): string {
  return RUNTIME_PID_PATH;
}

function getPackageRoot(): string {
  const filePath = fileURLToPath(import.meta.url);
  return resolve(dirname(filePath), "../../..");
}

function getReverseProxyRuntimeCommand(): { file: string; command: string } {
  const packageRoot = process.env.FIFONY_PKG_ROOT ?? getPackageRoot();
  const file = resolve(packageRoot, "bin", "fifony.js");
  return {
    file,
    command: `${process.execPath} ${file} reverse-proxy-runtime --runtimeConfig ${RUNTIME_CONFIG_PATH}`,
  };
}

async function queryRuntimeControl<T>(pathname: string, init?: RequestInit): Promise<T | null> {
  const info = readRuntimePidInfo();
  if (!info?.controlPort || !isProcessAlive(info.pid)) return null;

  try {
    const response = await fetch(`http://127.0.0.1:${info.controlPort}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

export async function startReverseProxyRuntime(options: ReverseProxyRuntimeConfig): Promise<number> {
  const existing = readRuntimePidInfo();
  if (existing?.pid && isProcessAlive(existing.pid)) {
    const status = await queryRuntimeControl<{ proxyPort?: number; running?: boolean }>("/status");
    if (status?.running) {
      return status.proxyPort ?? existing.proxyPort ?? options.port;
    }
  }

  mkdirSync(STATE_ROOT, { recursive: true });
  writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(options));
  try { writeFileSync(RUNTIME_LOG_PATH, ""); } catch {}

  const { file, command } = getReverseProxyRuntimeCommand();
  const logFd = openSync(RUNTIME_LOG_PATH, "a");
  const child = spawn(process.execPath, [file, "reverse-proxy-runtime", "--runtimeConfig", RUNTIME_CONFIG_PATH], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  try { closeSync(logFd); } catch {}
  child.unref();

  if (child.pid == null) {
    throw new Error("Failed to spawn reverse proxy runtime process.");
  }

  writeRuntimePidInfo({
    pid: child.pid,
    command,
    startedAt: new Date().toISOString(),
    dashPort: options.dashPort,
    proxyPort: options.port,
    localDomain: options.localDomain,
  });

  const started = Date.now();
  while (Date.now() - started < 5_000) {
    const info = readRuntimePidInfo();
    if (info?.controlPort && info.proxyPort) {
      return info.proxyPort;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  return options.port;
}

export async function stopReverseProxyRuntime(): Promise<void> {
  const info = readRuntimePidInfo();
  if (!info) return;

  if (info.controlPort) {
    await queryRuntimeControl("/stop", { method: "POST" });
  }

  if (isProcessAlive(info.pid)) {
    try { process.kill(-info.pid, "SIGTERM"); } catch {}
    try { process.kill(info.pid, "SIGTERM"); } catch {}
  }

  const started = Date.now();
  while (Date.now() - started < 3_000) {
    if (!isProcessAlive(info.pid)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  if (isProcessAlive(info.pid)) {
    try { process.kill(-info.pid, "SIGKILL"); } catch {}
    try { process.kill(info.pid, "SIGKILL"); } catch {}
  }

  removeRuntimePidInfo();
  removeRuntimeConfig();
}

export async function restartReverseProxyRuntime(options: ReverseProxyRuntimeConfig): Promise<number> {
  await stopReverseProxyRuntime();
  return startReverseProxyRuntime(options);
}

export function isReverseProxyRuntimeRunning(): boolean {
  const info = readRuntimePidInfo();
  return info?.pid != null && isProcessAlive(info.pid);
}

export function getReverseProxyRuntimeSnapshotStatus(options?: {
  enabled?: boolean;
  localDomain?: string;
  configuredPort?: number;
}) {
  const info = readRuntimePidInfo();
  const alive = info?.pid != null && isProcessAlive(info.pid);
  let logSize = 0;
  if (existsSync(RUNTIME_LOG_PATH)) {
    try { logSize = statSync(RUNTIME_LOG_PATH).size; } catch {}
  }

  return {
    id: REVERSE_PROXY_RUNTIME_ID,
    name: "HTTPS Reverse Proxy",
    command: info?.command ?? getReverseProxyRuntimeCommand().command,
    port: info?.proxyPort ?? options?.configuredPort,
    state: alive ? "running" : "stopped",
    running: alive,
    pid: alive ? info?.pid ?? null : null,
    startedAt: info?.startedAt ?? null,
    uptime: alive && info?.startedAt ? Math.max(0, Date.now() - Date.parse(info.startedAt)) : 0,
    logSize,
    crashCount: 0,
    errorCount: 0,
    isRuntimeService: true,
    runtimeServiceKind: REVERSE_PROXY_RUNTIME_ID,
    managedByFifonyRuntime: true,
    enabled: options?.enabled ?? false,
    localDomain: options?.localDomain ?? null,
  };
}

export async function getReverseProxyRuntimeStats() {
  const payload = await queryRuntimeControl<{ stats?: unknown }>("/stats");
  return payload?.stats ?? null;
}

export async function getReverseProxyRuntimeGraphSnapshot() {
  const payload = await queryRuntimeControl<{ snapshot?: unknown }>("/graph");
  return payload?.snapshot ?? null;
}

export async function getReverseProxyRuntimeState() {
  const info = readRuntimePidInfo();
  const alive = info?.pid != null && isProcessAlive(info.pid);
  if (!info) {
    return { running: false, pid: null, proxyPort: null, controlPort: null, startedAt: null };
  }

  const status = await queryRuntimeControl<{
    running?: boolean;
    proxyPort?: number;
    controlPort?: number;
    startedAt?: string;
    localDomain?: string;
  }>("/status");

  return {
    running: status?.running ?? alive,
    pid: alive ? info.pid : null,
    proxyPort: status?.proxyPort ?? info.proxyPort ?? null,
    controlPort: status?.controlPort ?? info.controlPort ?? null,
    startedAt: status?.startedAt ?? info.startedAt ?? null,
    localDomain: status?.localDomain ?? info.localDomain ?? null,
  };
}

export async function runReverseProxyRuntimeProcess(configPath: string): Promise<void> {
  const raw = readFileSync(configPath, "utf8");
  const config = JSON.parse(raw) as ReverseProxyRuntimeConfig;
  const startedAt = new Date().toISOString();
  const proxyPort = await startReverseProxy(config);

  const controlServer = createServer(async (req, res) => {
    const sendJson = (statusCode: number, payload: unknown) => {
      res.statusCode = statusCode;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };

    if (!req.url) {
      sendJson(404, { ok: false });
      return;
    }

    if (req.method === "GET" && req.url === "/status") {
      sendJson(200, {
        ok: true,
        running: isReverseProxyRunning(),
        proxyPort: getReverseProxyPort(),
        startedAt,
        localDomain: config.localDomain ?? null,
        pid: process.pid,
        controlPort: (controlServer.address() as { port?: number } | null)?.port ?? null,
      });
      return;
    }

    if (req.method === "GET" && req.url === "/stats") {
      sendJson(200, { ok: true, stats: getReverseProxyStats() });
      return;
    }

    if (req.method === "GET" && req.url === "/graph") {
      sendJson(200, { ok: true, snapshot: getReverseProxyGraphSnapshot() });
      return;
    }

    if (req.method === "POST" && req.url === "/stop") {
      sendJson(200, { ok: true });
      setTimeout(() => {
        stopReverseProxy().catch(() => {}).finally(() => {
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

  const controlPort = (controlServer.address() as { port?: number } | null)?.port;
  const { command } = getReverseProxyRuntimeCommand();
  writeRuntimePidInfo({
    pid: process.pid,
    command,
    startedAt,
    controlPort,
    proxyPort,
    dashPort: config.dashPort,
    localDomain: config.localDomain,
  });

  const shutdown = async () => {
    try { await stopReverseProxy(); } catch {}
    try { controlServer.close(); } catch {}
    removeRuntimePidInfo();
    removeRuntimeConfig();
    process.exit(0);
  };

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });

  await new Promise<void>(() => {});
}

// ── Multi-SAN cert generation ─────────────────────────────────────

// Minimal DER/TLV encoding — mirrors raffel's internal certs.js
// so we can produce a leaf cert with multiple SANs (localhost + domain + wildcard).

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

/**
 * Generates a leaf certificate signed by raffel's default CA, covering all
 * given hosts as SANs. Supports DNS names, IPs, and wildcards.
 */
async function generateMultiSanCert(hosts: string[]): Promise<{ key: string; cert: string; ca: string }> {
  const { getDefaultCA } = await import("raffel");
  const ca = getDefaultCA();

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  // Extract CN from the CA cert to set as issuer name
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
  // 825 days is the Chrome/Safari max for self-signed certs
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

// ── TLS helpers ──────────────────────────────────────────────────

const TLS_DIR = join(STATE_ROOT, "tls");
const KEY_PATH = join(TLS_DIR, "key.pem");
const CERT_PATH = join(TLS_DIR, "cert.pem");
const CA_PATH = join(TLS_DIR, "ca.pem");
const DOMAIN_PATH = join(TLS_DIR, "domain.txt");

/**
 * Returns the path to the CA cert for importing into browsers/OS keychain.
 */
export function getReverseProxyCaCertPath(): string {
  return CA_PATH;
}

/**
 * Ensures a TLS cert exists covering localhost + the given localDomain (+ wildcard).
 * Regenerates if localDomain changed since the last generation.
 */
export async function ensureReverseProxyTlsCert(
  localDomain?: string,
): Promise<{ key: string; cert: string }> {
  mkdirSync(TLS_DIR, { recursive: true });

  // Check if we need to regenerate
  const storedDomain = existsSync(DOMAIN_PATH) ? readFileSync(DOMAIN_PATH, "utf8").trim() : "";
  const needsRegen =
    !existsSync(KEY_PATH) ||
    !existsSync(CERT_PATH) ||
    storedDomain !== (localDomain ?? "");

  if (!needsRegen) {
    return { key: readFileSync(KEY_PATH, "utf8"), cert: readFileSync(CERT_PATH, "utf8") };
  }

  // Build SAN list: always include localhost + 127.0.0.1
  const hosts = ["localhost", "127.0.0.1"];
  if (localDomain) {
    hosts.push(localDomain);
    hosts.push(`*.${localDomain}`);
  }

  logger.info({ hosts }, "[ReverseProxy] Generating TLS cert");
  const { key, cert, ca } = await generateMultiSanCert(hosts);

  writeFileSync(KEY_PATH, key);
  writeFileSync(CERT_PATH, cert);
  writeFileSync(CA_PATH, ca);
  writeFileSync(DOMAIN_PATH, localDomain ?? "");

  return { key, cert };
}

/**
 * Invalidates the cached cert so it will be regenerated on next start.
 * Call this when localDomain changes while the proxy is stopped.
 */
export function invalidateReverseProxyCert(): void {
  try { if (existsSync(DOMAIN_PATH)) unlinkSync(DOMAIN_PATH); } catch {}
}

// ── Route builder ─────────────────────────────────────────────────

/**
 * Converts user-defined ProxyRoute[] into raffel ReverseProxyRouteConfig[].
 * Routes are sorted by specificity (host+path > host-only > path-only) before
 * appending the catch-all to the dashboard.
 */
export function buildRaffelRoutes(
  routes: ProxyRoute[],
  services: Array<{ id: string; port?: number }>,
  dashPort: number,
): ReverseProxyRouteConfig[] {
  const portById = new Map(services.map((s) => [s.id, s.port]));

  // Sort: most specific (host+pathPrefix) first, then host-only, then path-only
  const specificity = (r: ProxyRoute) =>
    (r.host ? 2 : 0) + (r.pathPrefix ? 1 : 0);
  const sorted = [...routes].sort((a, b) => specificity(b) - specificity(a));

  const raffelRoutes: ReverseProxyRouteConfig[] = [];

  for (const route of sorted) {
    const port = route.serviceId ? portById.get(route.serviceId) : undefined;
    const target = port
      ? `http://127.0.0.1:${port}`
      : route.target?.trim() ?? null;

    if (!target) {
      logger.warn({ routeId: route.id }, "[ReverseProxy] Skipping route — no resolvable target");
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

  // Catch-all → dashboard (always last)
  raffelRoutes.push({ match: { pathPrefix: "/" }, target: `http://127.0.0.1:${dashPort}` });

  return raffelRoutes;
}

// ── Lifecycle ────────────────────────────────────────────────────

export interface ReverseProxyStartOptions {
  port: number;
  dashPort: number;
  routes?: ProxyRoute[];
  services?: Array<{ id: string; port?: number }>;
  localDomain?: string;
}

export async function startReverseProxy(options: ReverseProxyStartOptions): Promise<number> {
  if (reverseProxy?.isRunning) {
    logger.warn("[ReverseProxy] Already running, skipping start");
    return reverseProxy.boundPort!;
  }

  const { key, cert } = await ensureReverseProxyTlsCert(options.localDomain);
  const { createReverseProxy } = await import("raffel");

  const routes = buildRaffelRoutes(
    options.routes ?? [],
    options.services ?? [],
    options.dashPort,
  );

  reverseProxy = await createReverseProxy({
    server: {
      host: "0.0.0.0",
      port: options.port,
      tls: { key, cert },
    },
    routes,
  });

  const boundPort = await reverseProxy.start();
  logger.info({ port: boundPort, routeCount: routes.length, localDomain: options.localDomain }, "[ReverseProxy] HTTPS reverse proxy started");
  return boundPort;
}

export async function stopReverseProxy(): Promise<void> {
  if (!reverseProxy?.isRunning) return;
  await reverseProxy.stop();
  logger.info("[ReverseProxy] HTTPS reverse proxy stopped");
  reverseProxy = null;
}

export async function restartReverseProxy(options: ReverseProxyStartOptions): Promise<number> {
  await stopReverseProxy();
  return startReverseProxy(options);
}

// ── Accessors ────────────────────────────────────────────────────

export function isReverseProxyRunning(): boolean {
  return reverseProxy?.isRunning ?? false;
}

export function getReverseProxyPort(): number | null {
  return reverseProxy?.boundPort ?? null;
}

export function getReverseProxyCaCert(): string | null {
  return reverseProxy?.caCert ?? null;
}

export function getReverseProxyStats() {
  return reverseProxy?.stats ?? null;
}

/** Returns the native raffel reverse proxy graph snapshot with per-route latency and rates. */
export function getReverseProxyGraphSnapshot() {
  if (!reverseProxy?.isRunning) return null;
  return reverseProxy.graphSnapshot();
}
