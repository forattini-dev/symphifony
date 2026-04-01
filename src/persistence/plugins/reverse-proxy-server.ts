import type { ReverseProxy, ReverseProxyRouteConfig } from "raffel";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { createSign, generateKeyPairSync } from "node:crypto";
import { STATE_ROOT } from "../../concerns/constants.ts";
import { logger } from "../../concerns/logger.ts";
import type { ProxyRoute } from "../../types.ts";

// ── Singleton state ──────────────────────────────────────────────

let reverseProxy: ReverseProxy | null = null;

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
