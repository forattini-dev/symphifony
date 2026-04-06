import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn, execSync } from "node:child_process";
import { isProcessAlive } from "../../agents/pid-manager.ts";
import { logger } from "../../concerns/logger.ts";
import { now } from "../../concerns/helpers.ts";
import type { ServiceEntry, ServiceState, ServiceStatus } from "../../types.ts";
import { buildServiceCommand } from "../../domains/service-env.ts";
import type { ServiceEnvironment } from "../../domains/service-env.ts";
import { getMeshRuntimePortSnapshot } from "./reverse-proxy-server.ts";
import { buildProxyEnvVars } from "../../domains/traffic-proxy.ts";
import { S3DB_SERVICES_RESOURCE } from "../../concerns/constants.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Milliseconds the process must stay alive before "starting" → "running" */
const STARTING_GRACE_MS = 3_000;
/** Milliseconds after SIGTERM before we force SIGKILL */
const STOPPING_KILL_MS = 5_000;
/** Watcher tick interval */
export const SERVICE_WATCHER_INTERVAL_MS = 5_000;

// ── Persisted PID file type ───────────────────────────────────────────────────

export type ServicePidInfo = {
  pid: number;
  command: string;
  startedAt: string;
  /** FSM state — absent in legacy pid files (migrated on first read) */
  state: ServiceState;
  /** How many times this service has crashed since last manual start */
  crashCount: number;
  lastCrashAt?: string;
  /** ISO timestamp when SIGTERM was sent — for STOPPING_KILL_MS enforcement */
  stoppingAt?: string;
  /** ISO timestamp when auto-restart may fire next */
  nextRetryAt?: string;
};

// ── FSM transition record ─────────────────────────────────────────────────────

export type ServiceTransition = {
  id: string;
  from: ServiceState | "none";
  to: ServiceState;
  pid: number | null;
  reason: string;
};

// ── File helpers ──────────────────────────────────────────────────────────────

function pidPath(fifonyDir: string, id: string): string {
  return join(fifonyDir, `service-${id}.pid`);
}

export function serviceLogPath(fifonyDir: string, id: string): string {
  return join(fifonyDir, `service-${id}.log`);
}

export function serviceLogGenerationPath(fifonyDir: string, id: string, generation: number): string {
  const base = serviceLogPath(fifonyDir, id);
  return generation === 0 ? base : `${base}.${generation}`;
}

/**
 * Rotate service logs: keep last 3 executions.
 * .log → .log.1, .log.1 → .log.2, .log.2 deleted.
 * Skips rotation if the current log is empty.
 */
function rotateServiceLogs(fifonyDir: string, id: string): void {
  const base = serviceLogPath(fifonyDir, id);
  // Skip rotation if current log doesn't exist or is empty
  try {
    if (!existsSync(base) || statSync(base).size === 0) return;
  } catch { return; }
  // Delete oldest
  try { if (existsSync(`${base}.2`)) rmSync(`${base}.2`); } catch {}
  // .1 → .2
  try { if (existsSync(`${base}.1`)) renameSync(`${base}.1`, `${base}.2`); } catch {}
  // current → .1
  try { renameSync(base, `${base}.1`); } catch {}
  // Clear error count cache for all generations
  errorCountCache.delete(base);
  errorCountCache.delete(`${base}.1`);
  errorCountCache.delete(`${base}.2`);
}

const ERROR_PATTERN = /\b(ERROR|Exception|FATAL|FAIL)\b/gi;

/** Cached error count per log file — only re-scans when file size changes. */
const errorCountCache = new Map<string, { size: number; count: number }>();

/**
 * Count error-like occurrences in a service log.
 * Uses file size as a cursor — only reads new bytes since last check.
 * O(1) stat + O(delta) read instead of O(8KB) every call.
 */
function countLogErrors(logFile: string): number {
  if (!existsSync(logFile)) return 0;
  try {
    const size = statSync(logFile).size;
    if (size === 0) { errorCountCache.delete(logFile); return 0; }

    const cached = errorCountCache.get(logFile);

    // File truncated (service restarted) — re-scan from scratch
    if (cached && size < cached.size) {
      errorCountCache.delete(logFile);
      return countLogErrors(logFile);
    }

    // No new bytes — return cached count
    if (cached && size === cached.size) return cached.count;

    // Read only the new bytes since last check (or last 8KB on first scan)
    const readFrom = cached ? cached.size : Math.max(0, size - 8192);
    const readSize = size - readFrom;
    if (readSize <= 0) return cached?.count ?? 0;

    const fd = openSync(logFile, "r");
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, readFrom);
    closeSync(fd);
    const matches = buf.toString("utf8").match(ERROR_PATTERN);
    const delta = matches ? matches.length : 0;
    const total = (cached?.count ?? 0) + delta;

    errorCountCache.set(logFile, { size, count: total });
    return total;
  } catch {
    return 0;
  }
}

function readPidInfo(fifonyDir: string, id: string): ServicePidInfo | null {
  const path = pidPath(fifonyDir, id);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as ServicePidInfo;
    if (!data?.pid || typeof data.pid !== "number") return null;
    // Migrate legacy pid files that pre-date the FSM (no `state` field)
    if (!data.state) {
      data.state = isProcessAlive(data.pid) ? "running" : "crashed";
      data.crashCount ??= 0;
    }
    return data;
  } catch {
    return null;
  }
}

function writePidInfo(fifonyDir: string, id: string, info: ServicePidInfo): void {
  writeFileSync(pidPath(fifonyDir, id), JSON.stringify(info));
}

function removePidInfo(fifonyDir: string, id: string): void {
  try { rmSync(pidPath(fifonyDir, id), { force: true }); } catch {}
}

// ── Process spawn ─────────────────────────────────────────────────────────────

function spawnProcess(
  entry: ServiceEntry,
  targetRoot: string,
  fifonyDir: string,
  globalEnv?: ServiceEnvironment,
): { pid: number; command: string } {
  const cwd = entry.cwd ? resolve(targetRoot, entry.cwd) : targetRoot;
  const log = serviceLogPath(fifonyDir, entry.id);
  // Merge mesh proxy env vars if the proxy is running
  let mergedGlobalEnv = globalEnv;
  const proxyPort = getMeshRuntimePortSnapshot();
  if (proxyPort) {
    const dashPort = Number(process.env.FIFONY_PORT ?? 4000);
    mergedGlobalEnv = { ...(globalEnv ?? {}), ...buildProxyEnvVars(proxyPort, entry.id, dashPort) };
  }
  const enforcedEnv: ServiceEnvironment = entry.port
    ? {
      PORT: String(entry.port),
    }
    : {};
  const command = buildServiceCommand(entry.command, mergedGlobalEnv, entry.env, enforcedEnv);
  // Rotate previous log into history, then truncate for the new session
  rotateServiceLogs(fifonyDir, entry.id);
  try { writeFileSync(log, ""); } catch {}
  // Use fd inheritance — OS redirects child stdout/stderr to file.
  // This works after child.unref() because the OS, not Node.js, handles the I/O.
  const logFd = openSync(log, "a");
  const child = spawn(command, [], {
    shell: true,
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  try { closeSync(logFd); } catch {}
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`Failed to spawn service process: ${command}`);
  }
  return { pid: child.pid, command };
}

// ── Port cleanup helper ──────────────────────────────────────────────────────

/**
 * Kill any process listening on the given port.
 * Catches orphaned child processes (e.g. Vite workers) that survived the
 * process-group kill because they called setsid() or escaped the group.
 */
function killProcessesOnPort(port: number): void {
  try {
    const pids = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, { encoding: "utf8" }).trim();
    if (!pids) return;
    for (const pidStr of pids.split("\n")) {
      const pid = parseInt(pidStr.trim(), 10);
      if (!isNaN(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    logger.debug({ port, pids }, "[ServiceFSM] Killed orphaned processes on port");
  } catch {
    // lsof may not be available — non-critical
  }
}

// ── Auto-restart helpers ──────────────────────────────────────────────────────

function autoRestartBackoffMs(crashCount: number): number {
  // Exponential: 1s, 2s, 4s, 8s, 16s, 32s … capped at 60s
  return Math.min(Math.pow(2, crashCount) * 1_000, 60_000);
}

// ── Status derivation ─────────────────────────────────────────────────────────

export function getServiceStatus(entry: ServiceEntry, fifonyDir: string): ServiceStatus {
  const info = readPidInfo(fifonyDir, entry.id);
  const alive = info !== null && isProcessAlive(info.pid);

  // Reconcile stored state with live process reality
  let state: ServiceState;
  if (!info) {
    state = "stopped";
  } else if (info.state === "stopping") {
    state = alive ? "stopping" : "stopped";
  } else if (info.state === "starting" || info.state === "running") {
    state = alive ? info.state : "crashed";
  } else {
    state = info.state; // "crashed" or "stopped"
  }

  const logFile = serviceLogPath(fifonyDir, entry.id);
  let logSize = 0;
  if (existsSync(logFile)) {
    try { logSize = statSync(logFile).size; } catch {}
  }

  const startedAt = info?.startedAt ?? null;
  const running = state === "starting" || state === "running";
  const uptime = startedAt && running ? Date.now() - Date.parse(startedAt) : 0;

  return {
    id: entry.id,
    name: entry.name,
    command: entry.command,
    cwd: entry.cwd,
    env: entry.env,
    autoStart: entry.autoStart,
    autoRestart: entry.autoRestart,
    maxCrashes: entry.maxCrashes,
    port: entry.port,
    state,
    running,
    pid: alive ? (info?.pid ?? null) : null,
    startedAt,
    uptime: Number.isFinite(uptime) ? uptime : 0,
    logSize,
    crashCount: info?.crashCount ?? 0,
    errorCount: countLogErrors(logFile),
    nextRetryAt: info?.nextRetryAt,
  };
}

export function getAllServiceStatuses(
  entries: ServiceEntry[],
  fifonyDir: string,
): ServiceStatus[] {
  return entries.map((e) => getServiceStatus(e, fifonyDir));
}

// ── Log reader ────────────────────────────────────────────────────────────────

function readLogFileTail(filePath: string, bytes: number): string {
  if (!existsSync(filePath)) return "";
  try {
    const size = statSync(filePath).size;
    const readSize = Math.min(size, bytes);
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, Math.max(0, size - readSize));
    closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

export function readServiceLogTail(id: string, fifonyDir: string, bytes = 8192): string {
  return readLogFileTail(serviceLogPath(fifonyDir, id), bytes);
}

export function readServiceLogGenerationTail(id: string, fifonyDir: string, generation: number, bytes = 16_384): string {
  return readLogFileTail(serviceLogGenerationPath(fifonyDir, id, generation), bytes);
}

/** Returns which log generations (0=current, 1=previous, 2=oldest) exist for a service. */
export function listServiceLogGenerations(fifonyDir: string, id: string): number[] {
  const base = serviceLogPath(fifonyDir, id);
  const generations: number[] = [];
  if (existsSync(base)) generations.push(0);
  if (existsSync(`${base}.1`)) generations.push(1);
  if (existsSync(`${base}.2`)) generations.push(2);
  return generations;
}

// ── Boot helpers ──────────────────────────────────────────────────────────────

/**
 * Called at boot: reconcile live process state with persisted pid files.
 * Dead processes are marked as "crashed" so the UI can show them correctly.
 */
export function reconcileServiceStates(entries: ServiceEntry[], fifonyDir: string): void {
  for (const entry of entries) {
    const info = readPidInfo(fifonyDir, entry.id);
    if (!info) continue;
    if (info.state === "stopped") continue;
    if (!isProcessAlive(info.pid)) {
      // Process is dead but port may still be held by orphaned children
      if (entry.port) killProcessesOnPort(entry.port);
      const crashCount = (info.crashCount ?? 0) + 1;
      writePidInfo(fifonyDir, entry.id, {
        ...info,
        state: "crashed",
        crashCount,
        lastCrashAt: now(),
      });
      logger.info({ id: entry.id, crashCount }, "[Service] Boot: process dead → crashed (port cleaned)");
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Declarative StateMachinePlugin config (mirrors issueStateMachineConfig) ──
// ══════════════════════════════════════════════════════════════════════════════

export const SERVICE_STATE_MACHINE_ID = "service-lifecycle";

/** Watcher interval for function triggers — same as SERVICE_WATCHER_INTERVAL_MS. */
const TRIGGER_INTERVAL_MS = SERVICE_WATCHER_INTERVAL_MS;

// ── Injected runtime context ────────────────────────────────────────────────
// The state machine config is static, but actions need runtime refs (fifonyDir,
// targetRoot, globalEnv, service entries). These are injected after boot.

type ServiceRuntimeContext = {
  fifonyDir: string;
  targetRoot: string;
  getEntries: () => ServiceEntry[];
  getGlobalEnv: () => ServiceEnvironment;
  getServiceEnv?: (serviceId: string) => ServiceEnvironment;
  onTransition?: (t: ServiceTransition) => void;
};

let serviceRuntime: ServiceRuntimeContext | null = null;

export function setServiceRuntime(ctx: ServiceRuntimeContext | null): void {
  serviceRuntime = ctx;
}

export function getServiceRuntime(): ServiceRuntimeContext | null {
  return serviceRuntime;
}

// ── Resource-level state API (set after plugin binds to service resource) ────

type ServiceResourceStateApi = {
  send: (entityId: string, event: string, context?: Record<string, unknown>) => Promise<unknown>;
  get: (entityId: string) => Promise<string>;
  initialize: (entityId: string, context?: Record<string, unknown>) => Promise<unknown>;
};

let serviceResourceStateApi: ServiceResourceStateApi | null = null;

export function setServiceResourceStateApi(api: ServiceResourceStateApi | null): void {
  serviceResourceStateApi = api;
}

/**
 * Send an FSM event for a service entity via the StateMachinePlugin.
 * Auto-initializes the entity if it hasn't been seen by the plugin yet.
 */
/**
 * Execute a service FSM event with side effects.
 * Plugin actions/triggers are unreliable — side effects are applied inline here.
 */
export async function sendServiceEvent(
  entityId: string,
  event: string,
  context: Record<string, unknown> = {},
): Promise<{ pid?: number; state: string }> {
  if (!serviceRuntime) throw new Error("Service runtime not initialized");
  const { fifonyDir, targetRoot, getEntries, getGlobalEnv, onTransition } = serviceRuntime;
  const entry = (getEntries() ?? []).find((e) => e.id === entityId);

  if (event === "START") {
    // Kill existing process if any
    const existing = readPidInfo(fifonyDir, entityId);
    if (existing && isProcessAlive(existing.pid)) {
      try { process.kill(-existing.pid, "SIGKILL"); } catch {}
      try { process.kill(existing.pid, "SIGKILL"); } catch {}
    }
    // Kill orphaned processes on the configured port (escaped children from previous runs)
    if (entry?.port) killProcessesOnPort(entry.port);
    if (!entry) throw new Error(`Service entry not found: ${entityId}`);
    const globalEnv = getGlobalEnv() ?? {};
    const serviceVaulterEnv = serviceRuntime.getServiceEnv?.(entityId) ?? {};
    const effectiveEntry = Object.keys(serviceVaulterEnv).length > 0
      ? { ...entry, env: { ...serviceVaulterEnv, ...(entry.env ?? {}) } }
      : entry;
    const spawned = spawnProcess(effectiveEntry, targetRoot, fifonyDir, globalEnv);
    writePidInfo(fifonyDir, entityId, {
      pid: spawned.pid,
      command: spawned.command,
      startedAt: now(),
      state: "starting",
      crashCount: 0,
    });
    const transition: ServiceTransition = {
      id: entityId,
      from: "stopped",
      to: "starting",
      reason: "manual start",
      pid: spawned.pid,
    };
    onTransition?.(transition);
    logger.info({ id: entityId, pid: spawned.pid }, "[ServiceFSM] START → starting");
    return { pid: spawned.pid, state: "starting" };
  }

  if (event === "STOP") {
    const info = readPidInfo(fifonyDir, entityId);
    if (!info || info.state === "stopped") return { state: "stopped" };
    // Use stopCommand if available
    if (entry?.stopCommand) {
      try {
        const cwd = entry.cwd ? join(targetRoot, entry.cwd) : targetRoot;
        execSync(entry.stopCommand, { cwd, stdio: "pipe", timeout: 15_000 });
        logger.info({ id: entityId, stopCommand: entry.stopCommand }, "[ServiceFSM] stopCommand executed");
      } catch (err) {
        logger.warn({ err, id: entityId }, "[ServiceFSM] stopCommand failed, falling back to SIGTERM");
        if (isProcessAlive(info.pid)) {
          try { process.kill(-info.pid, "SIGTERM"); } catch {}
        }
      }
    } else if (isProcessAlive(info.pid)) {
      try { process.kill(-info.pid, "SIGTERM"); } catch {}
      try { process.kill(info.pid, "SIGTERM"); } catch {}
    }
    writePidInfo(fifonyDir, entityId, { ...info, state: "stopping", stoppingAt: now() });
    const transition = { id: entityId, from: info.state, to: "stopping" as ServiceState, reason: "manual stop", pid: info.pid };
    onTransition?.(transition);
    logger.info({ id: entityId, pid: info.pid }, "[ServiceFSM] STOP → stopping");
    return { state: "stopping" };
  }

  throw new Error(`Unknown service event: ${event}`);
}

/** Shape injected by StateMachinePlugin into action/guard callbacks. */
type ServiceMachine = {
  database: any;
  machineId: string;
  entityId: string;
};

/** Resolve the ServiceEntry for an entity (by id) from the runtime context. */
function resolveServiceEntry(entityId: string): ServiceEntry | null {
  if (!serviceRuntime) return null;
  return (serviceRuntime.getEntries() ?? []).find((e) => e.id === entityId) ?? null;
}

// ── Config ──────────────────────────────────────────────────────────────────

export const serviceStateMachineConfig = {
  persistTransitions: true,
  workerId: `fifony-svc-${process.pid}`,
  lockTimeout: 5_000,
  lockTTL: 30,
  enableFunctionTriggers: true,
  triggerCheckInterval: TRIGGER_INTERVAL_MS,

  stateMachines: {
    [SERVICE_STATE_MACHINE_ID]: {
      resource: S3DB_SERVICES_RESOURCE,
      stateField: "state",
      initialState: "stopped",
      autoCleanup: false,

      states: {
        stopped: {
          on: { START: "starting" },
          entry: "onEnterStopped",
        },

        starting: {
          on: {
            GRACE_ELAPSED: "running",
            PROCESS_DIED: "crashed",
            STOP: "stopping",
          },
          entry: "spawnService",
          triggers: [{
            type: "function" as const,
            interval: TRIGGER_INTERVAL_MS,
            condition: async (context: Record<string, unknown>, entityId: string): Promise<boolean> => {
              if (!serviceRuntime) return false;
              const info = readPidInfo(serviceRuntime.fifonyDir, entityId);
              if (!info) return false;
              const alive = isProcessAlive(info.pid);
              if (!alive) return true; // will fire PROCESS_DIED
              const ageMs = Date.now() - Date.parse(info.startedAt);
              return ageMs >= STARTING_GRACE_MS; // will fire GRACE_ELAPSED
            },
            sendEvent: "GRACE_ELAPSED", // default event; overridden by eventName resolver below
            eventName: (context: Record<string, unknown>): string => {
              // Determine which event to fire based on process state
              const entityId = (context as any).entityId ?? (context as any).id ?? "";
              if (!serviceRuntime || !entityId) return "PROCESS_DIED";
              const info = readPidInfo(serviceRuntime.fifonyDir, entityId as string);
              if (!info || !isProcessAlive(info.pid)) return "PROCESS_DIED";
              return "GRACE_ELAPSED";
            },
          }],
        },

        running: {
          on: {
            PROCESS_DIED: "crashed",
            STOP: "stopping",
          },
          entry: "onEnterRunning",
          triggers: [{
            type: "function" as const,
            interval: TRIGGER_INTERVAL_MS,
            condition: async (context: Record<string, unknown>, entityId: string): Promise<boolean> => {
              if (!serviceRuntime) return false;
              const info = readPidInfo(serviceRuntime.fifonyDir, entityId);
              if (!info) return true; // no pid info means dead
              return !isProcessAlive(info.pid);
            },
            sendEvent: "PROCESS_DIED",
          }],
        },

        stopping: {
          on: {
            PROCESS_EXITED: "stopped",
            KILL_TIMEOUT: "stopped",
          },
          entry: "sendSigterm",
          triggers: [{
            type: "function" as const,
            interval: TRIGGER_INTERVAL_MS,
            condition: async (context: Record<string, unknown>, entityId: string): Promise<boolean> => {
              if (!serviceRuntime) return false;
              const info = readPidInfo(serviceRuntime.fifonyDir, entityId);
              if (!info) return true; // already gone
              const alive = isProcessAlive(info.pid);
              if (!alive) return true; // exited
              // Check kill timeout
              const stoppingAgeMs = info.stoppingAt
                ? Date.now() - Date.parse(info.stoppingAt)
                : STOPPING_KILL_MS + 1;
              return stoppingAgeMs >= STOPPING_KILL_MS;
            },
            sendEvent: "PROCESS_EXITED", // default
            eventName: (context: Record<string, unknown>): string => {
              const entityId = (context as any).entityId ?? (context as any).id ?? "";
              if (!serviceRuntime || !entityId) return "PROCESS_EXITED";
              const info = readPidInfo(serviceRuntime.fifonyDir, entityId as string);
              if (!info || !isProcessAlive(info.pid)) return "PROCESS_EXITED";
              // Still alive but kill timeout expired
              return "KILL_TIMEOUT";
            },
          }],
        },

        crashed: {
          on: {
            AUTO_RESTART: "starting",
            START: "starting",
            STOP: "stopping",
          },
          entry: "recordCrash",
          triggers: [{
            type: "function" as const,
            interval: TRIGGER_INTERVAL_MS,
            condition: async (context: Record<string, unknown>, entityId: string): Promise<boolean> => {
              if (!serviceRuntime) return false;
              const entry = resolveServiceEntry(entityId);
              if (!entry) return false;
              const info = readPidInfo(serviceRuntime.fifonyDir, entityId);
              if (!info) return false;
              const autoRestart = entry.autoRestart ?? false;
              const maxCrashes = entry.maxCrashes ?? 5;
              if (!autoRestart || (info.crashCount ?? 0) >= maxCrashes) return false;
              // Backoff elapsed?
              const nextRetryMs = info.nextRetryAt ? Date.parse(info.nextRetryAt) : 0;
              return Date.now() >= nextRetryMs;
            },
            sendEvent: "AUTO_RESTART",
          }],
        },
      },
    },
  },

  // ── Actions ────────────────────────────────────────────────────────────────
  // (context, event, machine) — context is the payload from send()

  actions: {
    spawnService: async (context: Record<string, unknown>, _event: string, machine: ServiceMachine) => {
      if (!serviceRuntime) {
        logger.warn({ entityId: machine.entityId }, "[ServiceFSM] spawnService called but runtime not set");
        return;
      }
      const entry = resolveServiceEntry(machine.entityId);
      if (!entry) {
        logger.warn({ entityId: machine.entityId }, "[ServiceFSM] spawnService — entry not found");
        return;
      }

      const { fifonyDir, targetRoot } = serviceRuntime;
      const globalEnv = serviceRuntime.getGlobalEnv();
      const serviceVaulterEnv = serviceRuntime.getServiceEnv?.(entry.id) ?? {};
      const effectiveEntry = Object.keys(serviceVaulterEnv).length > 0
        ? { ...entry, env: { ...serviceVaulterEnv, ...(entry.env ?? {}) } }
        : entry;

      // Kill existing process if any (idempotent)
      const existing = readPidInfo(fifonyDir, entry.id);
      if (existing && isProcessAlive(existing.pid)) {
        try { process.kill(-existing.pid, "SIGKILL"); } catch {}
        try { process.kill(existing.pid, "SIGKILL"); } catch {}
      }

      const spawned = spawnProcess(effectiveEntry, targetRoot, fifonyDir, globalEnv);

      // Determine crash count: manual START resets, AUTO_RESTART preserves
      const isAutoRestart = _event === "AUTO_RESTART";
      const prevCrashCount = existing?.crashCount ?? 0;

      writePidInfo(fifonyDir, entry.id, {
        pid: spawned.pid,
        command: spawned.command,
        startedAt: now(),
        state: "starting",
        crashCount: isAutoRestart ? prevCrashCount : 0,
      });

      logger.info(
        { id: entry.id, pid: spawned.pid, event: _event },
        `[ServiceFSM] spawnService → starting (${isAutoRestart ? "auto-restart" : "manual"})`,
      );

      serviceRuntime.onTransition?.({
        id: entry.id,
        from: (context as any).previousState ?? "none",
        to: "starting",
        pid: spawned.pid,
        reason: isAutoRestart ? `auto-restart (crash #${prevCrashCount})` : "manual start",
      });
    },

    sendSigterm: async (context: Record<string, unknown>, _event: string, machine: ServiceMachine) => {
      if (!serviceRuntime) return;
      const { fifonyDir, targetRoot } = serviceRuntime;
      const entry = resolveServiceEntry(machine.entityId);
      const info = readPidInfo(fifonyDir, machine.entityId);
      if (!info) return;

      // If the service has a custom stop command, run it instead of killing the PID
      if (entry?.stopCommand) {
        try {
          const cwd = entry.cwd ? join(targetRoot, entry.cwd) : targetRoot;
          execSync(entry.stopCommand, { cwd, stdio: "pipe", timeout: 15_000 });
          logger.info({ id: machine.entityId, stopCommand: entry.stopCommand }, "[ServiceFSM] stopCommand executed");
        } catch (err) {
          logger.warn({ err, id: machine.entityId }, "[ServiceFSM] stopCommand failed, falling back to SIGTERM");
          if (isProcessAlive(info.pid)) {
            try { process.kill(-info.pid, "SIGTERM"); } catch {}
          }
        }
      } else if (isProcessAlive(info.pid)) {
        try { process.kill(-info.pid, "SIGTERM"); } catch {}
      }

      writePidInfo(fifonyDir, machine.entityId, {
        ...info,
        state: "stopping",
        stoppingAt: now(),
      });

      logger.info({ id: machine.entityId, pid: info.pid, hasStopCommand: !!entry?.stopCommand }, "[ServiceFSM] sendSigterm → stopping");

      serviceRuntime.onTransition?.({
        id: machine.entityId,
        from: (context as any).previousState ?? "running",
        to: "stopping",
        pid: info.pid,
        reason: "manual stop",
      });
    },

    recordCrash: async (context: Record<string, unknown>, _event: string, machine: ServiceMachine) => {
      if (!serviceRuntime) return;
      const { fifonyDir } = serviceRuntime;
      const entry = resolveServiceEntry(machine.entityId);
      const info = readPidInfo(fifonyDir, machine.entityId);
      if (!info) return;

      const crashCount = (info.crashCount ?? 0) + 1;
      const maxCrashes = entry?.maxCrashes ?? 5;
      const autoRestart = entry?.autoRestart ?? false;
      const nextRetryAt =
        autoRestart && crashCount < maxCrashes
          ? new Date(Date.now() + autoRestartBackoffMs(crashCount)).toISOString()
          : undefined;

      writePidInfo(fifonyDir, machine.entityId, {
        ...info,
        state: "crashed",
        crashCount,
        lastCrashAt: now(),
        nextRetryAt,
      });

      logger.warn(
        { id: machine.entityId, crashCount, nextRetryAt },
        "[ServiceFSM] recordCrash → crashed",
      );

      serviceRuntime.onTransition?.({
        id: machine.entityId,
        from: (context as any).previousState ?? "running",
        to: "crashed",
        pid: null,
        reason: `process died (crash #${crashCount})`,
      });
    },

    onEnterStopped: async (context: Record<string, unknown>, _event: string, machine: ServiceMachine) => {
      if (!serviceRuntime) return;
      const { fifonyDir } = serviceRuntime;

      // KILL_TIMEOUT: force kill the process before cleanup
      if (_event === "KILL_TIMEOUT") {
        const info = readPidInfo(fifonyDir, machine.entityId);
        if (info && isProcessAlive(info.pid)) {
          try { process.kill(-info.pid, "SIGKILL"); } catch {}
          try { process.kill(info.pid, "SIGKILL"); } catch {}
        }
        logger.info({ id: machine.entityId }, "[ServiceFSM] onEnterStopped — SIGKILL after stop timeout");
      }

      // Clean up pid file
      removePidInfo(fifonyDir, machine.entityId);
      logger.info({ id: machine.entityId, event: _event }, "[ServiceFSM] onEnterStopped — pid file removed");

      serviceRuntime.onTransition?.({
        id: machine.entityId,
        from: (context as any).previousState ?? "stopping",
        to: "stopped",
        pid: null,
        reason: _event === "KILL_TIMEOUT" ? "SIGKILL after stop timeout" : "process exited",
      });
    },

    onEnterRunning: async (context: Record<string, unknown>, _event: string, machine: ServiceMachine) => {
      if (!serviceRuntime) return;
      const { fifonyDir } = serviceRuntime;
      const info = readPidInfo(fifonyDir, machine.entityId);

      // Update pid file state to "running"
      if (info) {
        writePidInfo(fifonyDir, machine.entityId, { ...info, state: "running" });
      }

      logger.info({ id: machine.entityId, pid: info?.pid }, "[ServiceFSM] onEnterRunning — grace period elapsed");

      serviceRuntime.onTransition?.({
        id: machine.entityId,
        from: "starting",
        to: "running",
        pid: info?.pid ?? null,
        reason: "startup grace period elapsed",
      });
    },
  },

  // ── Guards ─────────────────────────────────────────────────────────────────

  guards: {
    graceElapsed: async (context: Record<string, unknown>, _event: string, machine: ServiceMachine): Promise<boolean> => {
      if (!serviceRuntime) return false;
      const info = readPidInfo(serviceRuntime.fifonyDir, machine.entityId);
      if (!info) return false;
      if (!isProcessAlive(info.pid)) return false;
      const ageMs = Date.now() - Date.parse(info.startedAt);
      return ageMs >= STARTING_GRACE_MS;
    },

    canAutoRestart: async (context: Record<string, unknown>, _event: string, machine: ServiceMachine): Promise<boolean> => {
      if (!serviceRuntime) return false;
      const entry = resolveServiceEntry(machine.entityId);
      if (!entry) return false;
      const info = readPidInfo(serviceRuntime.fifonyDir, machine.entityId);
      if (!info) return false;
      const autoRestart = entry.autoRestart ?? false;
      const maxCrashes = entry.maxCrashes ?? 5;
      if (!autoRestart || (info.crashCount ?? 0) >= maxCrashes) return false;
      const nextRetryMs = info.nextRetryAt ? Date.parse(info.nextRetryAt) : 0;
      return Date.now() >= nextRetryMs;
    },
  },
};

// ── Legacy service watcher (function triggers unreliable — keep this as primary) ──

function tickOne(
  entry: ServiceEntry,
  globalEnv: ServiceEnvironment,
  fifonyDir: string,
  targetRoot: string,
): ServiceTransition | null {
  const info = readPidInfo(fifonyDir, entry.id);
  if (!info) return null;

  const alive = isProcessAlive(info.pid);
  const nowMs = Date.now();
  const maxCrashes = entry.maxCrashes ?? 5;

  switch (info.state) {
    case "starting": {
      if (!alive) {
        const crashCount = (info.crashCount ?? 0) + 1;
        const nextRetryAt = (entry.autoRestart ?? false) && crashCount < maxCrashes
          ? new Date(nowMs + autoRestartBackoffMs(crashCount)).toISOString()
          : undefined;
        writePidInfo(fifonyDir, entry.id, { ...info, state: "crashed", crashCount, lastCrashAt: now(), nextRetryAt });
        return { id: entry.id, from: "starting", to: "crashed", reason: `died during startup (crash #${crashCount})`, pid: info.pid };
      }
      const ageMs = nowMs - Date.parse(info.startedAt);
      if (ageMs >= STARTING_GRACE_MS) {
        writePidInfo(fifonyDir, entry.id, { ...info, state: "running" });
        return { id: entry.id, from: "starting", to: "running", reason: "startup grace period elapsed", pid: info.pid };
      }
      return null;
    }
    case "running": {
      if (!alive) {
        const crashCount = (info.crashCount ?? 0) + 1;
        const nextRetryAt = (entry.autoRestart ?? false) && crashCount < maxCrashes
          ? new Date(nowMs + autoRestartBackoffMs(crashCount)).toISOString()
          : undefined;
        writePidInfo(fifonyDir, entry.id, { ...info, state: "crashed", crashCount, lastCrashAt: now(), nextRetryAt });
        return { id: entry.id, from: "running", to: "crashed", reason: `process died unexpectedly (crash #${crashCount})`, pid: info.pid };
      }
      return null;
    }
    case "stopping": {
      if (!alive) {
        if (entry.port) killProcessesOnPort(entry.port);
        removePidInfo(fifonyDir, entry.id);
        return { id: entry.id, from: "stopping", to: "stopped", reason: "process exited", pid: null };
      }
      const stoppingAgeMs = info.stoppingAt ? nowMs - Date.parse(info.stoppingAt) : STOPPING_KILL_MS + 1;
      if (stoppingAgeMs >= STOPPING_KILL_MS) {
        try { process.kill(-info.pid, "SIGKILL"); } catch {}
        try { process.kill(info.pid, "SIGKILL"); } catch {}
        if (entry.port) killProcessesOnPort(entry.port);
        removePidInfo(fifonyDir, entry.id);
        return { id: entry.id, from: "stopping", to: "stopped", reason: "SIGKILL after timeout", pid: info.pid };
      }
      return null;
    }
    case "crashed": {
      if (!(entry.autoRestart ?? false) || (info.crashCount ?? 0) >= maxCrashes) return null;
      const nextRetryMs = info.nextRetryAt ? Date.parse(info.nextRetryAt) : 0;
      if (nowMs < nextRetryMs) return null;
      const globalEnvMerged = globalEnv ?? {};
      const spawned = spawnProcess(entry, targetRoot, fifonyDir, globalEnvMerged);
      writePidInfo(fifonyDir, entry.id, { pid: spawned.pid, command: spawned.command, startedAt: now(), state: "starting", crashCount: info.crashCount ?? 0 });
      return { id: entry.id, from: "crashed", to: "starting", reason: `auto-restart after backoff (crash #${info.crashCount})`, pid: spawned.pid };
    }
    case "stopped":
    default:
      return null;
  }
}

export function tickServiceWatcher(
  entries: ServiceEntry[],
  globalEnv: ServiceEnvironment,
  fifonyDir: string,
  targetRoot: string,
): ServiceTransition[] {
  const transitions: ServiceTransition[] = [];
  for (const entry of entries) {
    try {
      const t = tickOne(entry, globalEnv, fifonyDir, targetRoot);
      if (t) transitions.push(t);
    } catch (err) {
      logger.warn({ err, id: entry.id }, "[Service] Watcher tick error");
    }
  }
  return transitions;
}

export function initServiceWatcher(
  getEntries: () => ServiceEntry[],
  getGlobalEnv: () => ServiceEnvironment,
  fifonyDir: string,
  targetRoot: string,
  onTransition: (t: ServiceTransition) => void,
): { stop: () => void } {
  const id = setInterval(() => {
    const transitions = tickServiceWatcher(getEntries(), getGlobalEnv(), fifonyDir, targetRoot);
    for (const t of transitions) onTransition(t);
  }, SERVICE_WATCHER_INTERVAL_MS);
  return { stop: () => clearInterval(id) };
}
