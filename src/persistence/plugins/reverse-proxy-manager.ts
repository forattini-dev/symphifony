import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { STATE_ROOT } from "../../concerns/constants.ts";
import { logger } from "../../concerns/logger.ts";
import type { JsonRecord, ProxyRoute, ServiceEntry, ServiceStatus } from "../../types.ts";
import { isProcessAlive } from "../../agents/pid-manager.ts";
import {
  getReverseProxyCaCertPath,
  invalidateReverseProxyCert,
} from "./reverse-proxy-runtime.ts";

const NETWORK_RUNTIME_LOGICAL_ID = "reverse-proxy";
const RUNTIME_CONFIG_PATH = join(STATE_ROOT, `service-${NETWORK_RUNTIME_LOGICAL_ID}.runtime.json`);
const RUNTIME_PID_PATH = join(STATE_ROOT, `service-${NETWORK_RUNTIME_LOGICAL_ID}.pid`);
const RUNTIME_LOG_PATH = join(STATE_ROOT, `service-${NETWORK_RUNTIME_LOGICAL_ID}.log`);
const RUNTIME_READY_TIMEOUT_MS = 20_000;
const RUNTIME_EXISTING_READY_TIMEOUT_MS = 10_000;
const RUNTIME_POLL_INTERVAL_MS = 100;

export type ReverseProxyRuntimeConfig = {
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
};

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

type RuntimeControlResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; kind: "missing" | "dead" | "unreachable" | "http_error"; status?: number };

type RuntimeStatusResponse = {
  running?: boolean;
  startedAt?: string;
  controlPort?: number;
  localDomain?: string | null;
  reverseProxy?: {
    enabled?: boolean;
    running?: boolean;
    proxyPort?: number | null;
  };
  mesh?: {
    enabled?: boolean;
    running?: boolean;
    port?: number | null;
  };
};

function readRuntimePidInfo(): RuntimePidInfo | null {
  if (!existsSync(RUNTIME_PID_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(RUNTIME_PID_PATH, "utf8")) as RuntimePidInfo;
    if (!data?.pid || typeof data.pid !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

function writeRuntimePidInfo(info: RuntimePidInfo): void {
  writeFileSync(RUNTIME_PID_PATH, JSON.stringify(info));
}

function readRuntimeConfig(): ReverseProxyRuntimeConfig | null {
  if (!existsSync(RUNTIME_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8")) as ReverseProxyRuntimeConfig;
  } catch {
    return null;
  }
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

export function getMeshRuntimeLogPath(): string {
  return RUNTIME_LOG_PATH;
}

export function getReverseProxyRuntimePidPath(): string {
  return RUNTIME_PID_PATH;
}

function getPackageRoot(): string {
  const filePath = fileURLToPath(import.meta.url);
  return resolve(dirname(filePath), "../../..");
}

function getNetworkRuntimeCommand(): { file: string; command: string } {
  const packageRoot = process.env.FIFONY_PKG_ROOT ?? getPackageRoot();
  const file = resolve(packageRoot, "bin", "fifony.js");
  return {
    file,
    command: `${process.execPath} ${file} reverse-proxy-runtime --runtimeConfig ${RUNTIME_CONFIG_PATH}`,
  };
}

function readRuntimeLogTail(bytes = 4_096): string {
  if (!existsSync(RUNTIME_LOG_PATH)) return "";
  try {
    const size = statSync(RUNTIME_LOG_PATH).size;
    const readSize = Math.min(size, bytes);
    if (readSize <= 0) return "";
    const fd = openSync(RUNTIME_LOG_PATH, "r");
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, size - readSize));
    closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

async function queryRuntimeControl<T>(pathname: string, init?: RequestInit): Promise<RuntimeControlResult<T>> {
  const info = readRuntimePidInfo();
  if (!info?.controlPort) return { ok: false, kind: "missing" };
  if (!isProcessAlive(info.pid)) return { ok: false, kind: "dead" };

  try {
    const response = await fetch(`http://127.0.0.1:${info.controlPort}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return { ok: false, kind: "http_error", status: response.status };
    return { ok: true, data: await response.json() as T, status: response.status };
  } catch {
    return { ok: false, kind: "unreachable" };
  }
}

function configRequiresReadiness(config: ReverseProxyRuntimeConfig, info: RuntimePidInfo): boolean {
  if (!info.controlPort) return false;
  if (config.reverseProxyEnabled && !info.proxyPort) return false;
  if (config.meshEnabled && !info.meshPort) return false;
  return true;
}

async function waitForRuntimeReady(expectedPid: number, config: ReverseProxyRuntimeConfig, timeoutMs: number): Promise<RuntimePidInfo> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const info = readRuntimePidInfo();
    // Don't check info.pid === expectedPid: in dev mode (NODE_ENV=development) bin/fifony.js
    // re-spawns tsx as a grandchild, so process.pid(tsx) !== child.pid(bin/fifony.js).
    // Instead, verify the launcher process is alive and the sidecar wrote its ready state.
    if (info && configRequiresReadiness(config, info) && isProcessAlive(expectedPid)) {
      return info;
    }
    if (!isProcessAlive(expectedPid)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, RUNTIME_POLL_INTERVAL_MS));
  }
  const logTail = readRuntimeLogTail();
  const suffix = logTail.trim() ? ` Log tail: ${logTail.slice(-500)}` : "";
  throw new Error(`Network runtime did not become ready within ${timeoutMs}ms.${suffix}`);
}

function runtimeMatchesConfig(status: RuntimeStatusResponse, config: ReverseProxyRuntimeConfig): boolean {
  const reverseRunning = status.reverseProxy?.running === true;
  const meshRunning = status.mesh?.running === true;
  const reversePort = status.reverseProxy?.proxyPort ?? null;
  const meshPort = status.mesh?.port ?? null;

  if (config.reverseProxyEnabled) {
    if (!reverseRunning) return false;
    if (config.port && reversePort !== config.port) return false;
  } else if (reverseRunning) {
    return false;
  }

  if (config.meshEnabled) {
    if (!meshRunning) return false;
    if (config.meshPort && meshPort !== config.meshPort) return false;
  } else if (meshRunning) {
    return false;
  }

  return true;
}

async function spawnRuntime(config: ReverseProxyRuntimeConfig): Promise<RuntimePidInfo> {
  mkdirSync(STATE_ROOT, { recursive: true });
  writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(config));
  try { writeFileSync(RUNTIME_LOG_PATH, ""); } catch {}

  const { file, command } = getNetworkRuntimeCommand();
  const logFd = openSync(RUNTIME_LOG_PATH, "a");
  const child = spawn(process.execPath, [file, "reverse-proxy-runtime", "--runtimeConfig", RUNTIME_CONFIG_PATH], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  try { closeSync(logFd); } catch {}
  child.unref();

  if (child.pid == null) throw new Error("Failed to spawn network runtime process.");

  writeRuntimePidInfo({
    pid: child.pid,
    command,
    startedAt: new Date().toISOString(),
    dashPort: config.dashPort,
    proxyPort: config.port,
    meshPort: config.meshPort,
    localDomain: config.localDomain,
  });

  return waitForRuntimeReady(child.pid, config, RUNTIME_READY_TIMEOUT_MS);
}

// Serialize all network runtime operations to prevent concurrent calls from
// racing: a second applyNetworkRuntimeConfig that sees the newly-spawned
// launcher PID in the PID file would send SIGTERM to its entire process group
// (including the sidecar itself), causing the sidecar to shut down immediately
// after starting. Public functions acquire the lock; internal Impl functions
// are called from within withRuntimeLock to avoid deadlocks.
let _runtimeLock: Promise<void> = Promise.resolve();

async function withRuntimeLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _runtimeLock;
  let release!: () => void;
  _runtimeLock = new Promise<void>((r) => { release = r; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function stopNetworkRuntimeImpl(): Promise<void> {
  const info = readRuntimePidInfo();
  if (!info) return;
  if (info.controlPort) await queryRuntimeControl("/stop", { method: "POST" });

  if (isProcessAlive(info.pid)) {
    try { process.kill(-info.pid, "SIGTERM"); } catch (error) {
      logger.debug({ err: error, pid: info.pid }, "[NetworkRuntime] Failed to SIGTERM process group");
    }
    try { process.kill(info.pid, "SIGTERM"); } catch (error) {
      logger.debug({ err: error, pid: info.pid }, "[NetworkRuntime] Failed to SIGTERM process");
    }
  }

  const started = Date.now();
  while (Date.now() - started < 3_000) {
    if (!isProcessAlive(info.pid)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  if (isProcessAlive(info.pid)) {
    try { process.kill(-info.pid, "SIGKILL"); } catch (error) {
      logger.debug({ err: error, pid: info.pid }, "[NetworkRuntime] Failed to SIGKILL process group");
    }
    try { process.kill(info.pid, "SIGKILL"); } catch (error) {
      logger.debug({ err: error, pid: info.pid }, "[NetworkRuntime] Failed to SIGKILL process");
    }
  }

  removeRuntimePidInfo();
  removeRuntimeConfig();
}

async function applyNetworkRuntimeConfigImpl(config: ReverseProxyRuntimeConfig): Promise<void> {
  if (!config.reverseProxyEnabled && !config.meshEnabled) {
    await stopNetworkRuntimeImpl();
    return;
  }

  const existing = readRuntimePidInfo();
  if (existing?.pid && isProcessAlive(existing.pid)) {
    if (existing.controlPort) {
      const currentConfig = readRuntimeConfig();
      const status = await queryRuntimeControl<RuntimeStatusResponse>("/status");
      // Exclude `services` from the comparison — the array is used only for graph label
      // resolution, not for actual proxy behavior. Including it causes unnecessary restarts
      // every time a service is added/modified/port-assigned.
      const proxyConfig = (c: ReverseProxyRuntimeConfig | null) =>
        c ? { ...c, services: [] } : null;
      if (status.ok && runtimeMatchesConfig(status.data, config) && JSON.stringify(proxyConfig(currentConfig)) === JSON.stringify(proxyConfig(config))) {
        return;
      }
      await stopNetworkRuntimeImpl();
      await spawnRuntime(config);
      return;
    }

    await waitForRuntimeReady(existing.pid, config, RUNTIME_EXISTING_READY_TIMEOUT_MS);
    return;
  }

  await spawnRuntime(config);
}

export async function stopNetworkRuntime(): Promise<void> {
  return withRuntimeLock(() => stopNetworkRuntimeImpl());
}

export async function applyNetworkRuntimeConfig(config: ReverseProxyRuntimeConfig): Promise<void> {
  return withRuntimeLock(() => applyNetworkRuntimeConfigImpl(config));
}

export async function startReverseProxyRuntime(options: ReverseProxyRuntimeConfig): Promise<number> {
  return withRuntimeLock(async () => {
    const config = { ...options, reverseProxyEnabled: true };
    await applyNetworkRuntimeConfigImpl(config);
    const state = await getReverseProxyRuntimeState();
    return state.proxyPort ?? options.port ?? 4433;
  });
}

export async function stopReverseProxyRuntime(): Promise<void> {
  return withRuntimeLock(() => stopNetworkRuntimeImpl());
}

export async function restartReverseProxyRuntime(options: ReverseProxyRuntimeConfig): Promise<number> {
  return withRuntimeLock(async () => {
    await stopNetworkRuntimeImpl();
    const config = { ...options, reverseProxyEnabled: true };
    await applyNetworkRuntimeConfigImpl(config);
    const state = await getReverseProxyRuntimeState();
    return state.proxyPort ?? options.port ?? 4433;
  });
}

function readLogSize(): number {
  if (!existsSync(RUNTIME_LOG_PATH)) return 0;
  try { return statSync(RUNTIME_LOG_PATH).size; } catch { return 0; }
}

export function getReverseProxyRuntimeSnapshotStatus(options?: {
  enabled?: boolean;
  localDomain?: string;
  configuredPort?: number;
}): ServiceStatus & { enabled?: boolean; localDomain?: string | null } {
  const info = readRuntimePidInfo();
  const alive = info?.pid != null && isProcessAlive(info.pid);
  const ready = alive && Boolean(info?.controlPort) && Boolean(info?.proxyPort);
  return {
    id: "reverse-proxy",
    name: "HTTPS Reverse Proxy",
    command: info?.command ?? getNetworkRuntimeCommand().command,
    port: info?.proxyPort ?? options?.configuredPort,
    state: ready ? "running" : "stopped",
    running: ready,
    pid: ready ? info?.pid ?? null : null,
    startedAt: info?.startedAt ?? null,
    uptime: alive && info?.startedAt ? Math.max(0, Date.now() - Date.parse(info.startedAt)) : 0,
    logSize: readLogSize(),
    crashCount: 0,
    errorCount: 0,
    isRuntimeService: true,
    runtimeServiceKind: "reverse-proxy",
    managedByFifonyRuntime: true,
    enabled: options?.enabled ?? false,
    localDomain: options?.localDomain ?? null,
  };
}

export function getMeshRuntimeSnapshotStatus(options?: {
  enabled?: boolean;
  configuredPort?: number;
}): ServiceStatus & { enabled?: boolean } {
  const info = readRuntimePidInfo();
  const alive = info?.pid != null && isProcessAlive(info.pid);
  const ready = alive && Boolean(info?.controlPort) && Boolean(info?.meshPort);
  return {
    id: "mesh",
    name: "Service Mesh",
    command: info?.command ?? getNetworkRuntimeCommand().command,
    port: info?.meshPort ?? options?.configuredPort,
    state: ready ? "running" : "stopped",
    running: ready,
    pid: ready ? info?.pid ?? null : null,
    startedAt: info?.startedAt ?? null,
    uptime: alive && info?.startedAt ? Math.max(0, Date.now() - Date.parse(info.startedAt)) : 0,
    logSize: readLogSize(),
    crashCount: 0,
    errorCount: 0,
    isRuntimeService: true,
    runtimeServiceKind: "mesh",
    managedByFifonyRuntime: true,
    enabled: options?.enabled ?? false,
  };
}

export function getMeshRuntimePortSnapshot(): number | null {
  const info = readRuntimePidInfo();
  return info?.meshPort ?? null;
}

export async function getReverseProxyRuntimeStats(): Promise<JsonRecord | null> {
  const payload = await queryRuntimeControl<{ stats?: JsonRecord | null }>("/stats");
  return payload.ok ? payload.data.stats ?? null : null;
}

export async function getReverseProxyRuntimeGraphSnapshot(): Promise<JsonRecord | null> {
  const payload = await queryRuntimeControl<{ snapshot?: JsonRecord | null }>("/graph");
  return payload.ok ? payload.data.snapshot ?? null : null;
}

export async function getMeshRuntimeState(): Promise<{ running: boolean; port: number | null }> {
  const payload = await queryRuntimeControl<{ running?: boolean; port?: number | null }>("/mesh/status");
  if (!payload.ok) return { running: false, port: null };
  return {
    running: payload.data.running === true,
    port: payload.data.port ?? null,
  };
}

export async function getMeshRuntimeTraffic(limit = 200): Promise<JsonRecord[] | null> {
  const payload = await queryRuntimeControl<{ entries?: JsonRecord[] | null }>(`/mesh/traffic?limit=${limit}`);
  return payload.ok ? payload.data.entries ?? null : null;
}

export async function getMeshRuntimeEvents(afterSeq = 0, limit = 200): Promise<{ events: JsonRecord[]; currentSeq: number | null } | null> {
  const payload = await queryRuntimeControl<{ events?: JsonRecord[] | null; currentSeq?: number | null }>(
    `/mesh/events?afterSeq=${afterSeq}&limit=${limit}`,
  );
  return payload.ok ? {
    events: payload.data.events ?? [],
    currentSeq: typeof payload.data.currentSeq === "number" ? payload.data.currentSeq : null,
  } : null;
}

export async function clearMeshRuntimeTraffic(): Promise<boolean> {
  const payload = await queryRuntimeControl("/mesh/clear", { method: "POST" });
  return payload.ok;
}

export async function getMeshRuntimeStats(): Promise<JsonRecord | null> {
  const payload = await queryRuntimeControl<{ stats?: JsonRecord | null }>("/mesh/stats");
  return payload.ok ? payload.data.stats ?? null : null;
}

export async function getMeshRuntimeGraph(): Promise<{ graph: JsonRecord | null; nativeGraph: JsonRecord | null } | null> {
  const payload = await queryRuntimeControl<{ graph?: JsonRecord | null; nativeGraph?: JsonRecord | null }>("/mesh/graph");
  return payload.ok ? {
    graph: payload.data.graph ?? null,
    nativeGraph: payload.data.nativeGraph ?? null,
  } : null;
}

export async function getMeshRuntimeMetrics(format: "prometheus" | "json" = "prometheus"): Promise<string | null> {
  const payload = await queryRuntimeControl<{ metrics?: string | null }>(`/mesh/metrics?format=${format}`);
  return payload.ok ? payload.data.metrics ?? null : null;
}

export async function getReverseProxyRuntimeState() {
  const info = readRuntimePidInfo();
  const alive = info?.pid != null && isProcessAlive(info.pid);
  if (!info) {
    return { running: false, pid: null, proxyPort: null, controlPort: null, startedAt: null, localDomain: null };
  }
  const status = await queryRuntimeControl<RuntimeStatusResponse>("/status");
  if (status.ok) {
    return {
      running: status.data.reverseProxy?.running ?? false,
      pid: alive ? info.pid : null,
      proxyPort: status.data.reverseProxy?.proxyPort ?? info.proxyPort ?? null,
      controlPort: status.data.controlPort ?? info.controlPort ?? null,
      startedAt: status.data.startedAt ?? info.startedAt ?? null,
      localDomain: status.data.localDomain ?? info.localDomain ?? null,
    };
  }
  return {
    running: false,
    pid: null,
    proxyPort: info.proxyPort ?? null,
    controlPort: info.controlPort ?? null,
    startedAt: info.startedAt ?? null,
    localDomain: info.localDomain ?? null,
  };
}

export {
  getReverseProxyCaCertPath,
  invalidateReverseProxyCert,
};
