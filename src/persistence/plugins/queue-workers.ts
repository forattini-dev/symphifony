import type { IssueEntry, RuntimeState } from "../../types.ts";
import { STATE_ROOT, TERMINAL_STATES } from "../../concerns/constants.ts";
import { logger } from "../../concerns/logger.ts";
import { syncIssueStateInMemory, syncIssueStateFromFsm } from "../../domains/issue-state.ts";
import {
  canDispatchManagedAgent,
  runManagedExecuteJob,
  runManagedReviewJob,
  runPlanningJob,
} from "../../domains/agents.ts";
import { transitionIssue } from "../../domains/issues.ts";

// ── Job types — phase ordering determines dispatch order ──────────────────
// review > execute > plan: finish closest-to-done first (pipeline drain)

export type JobType = "plan" | "execute" | "review";

const PHASE_ORDER: Record<JobType, number> = { review: 0, execute: 1, plan: 2 };

type QueueEntry = {
  issueId: string;
  job: JobType;
  enqueuedAt: number;
};

// ── State ─────────────────────────────────────────────────────────────────

let runtimeState: RuntimeState | null = null;
let active = false;

/** Shared set of issue IDs currently being processed — visible to all workers. */
const running = new Set<string>();

/** Pending work entries, sorted on dequeue. */
const queue: QueueEntry[] = [];

/** How many workers are currently executing (semaphore counter). */
let inflight = 0;

/** Promise resolvers waiting for a free worker slot. */
const waiters: Array<() => void> = [];

/** Stale check interval handle. */
let staleInterval: ReturnType<typeof setInterval> | null = null;

/** Persist debounce state. */
let persistInterval: ReturnType<typeof setInterval> | null = null;

/** Analytics broadcast interval handle. */
let analyticsInterval: ReturnType<typeof setInterval> | null = null;

/** Blocked retry check interval handle. */
let blockedRetryInterval: ReturnType<typeof setInterval> | null = null;

// ── Lifecycle ─────────────────────────────────────────────────────────────

export async function initQueueWorkers(state: RuntimeState): Promise<void> {
  runtimeState = state;
  active = true;

  // Periodic stale check — replaces the old scheduler loop
  staleInterval = setInterval(() => {
    if (!active || !runtimeState) return;
    checkStaleIssues().catch((err) =>
      logger.error({ err }, "[Queue] Stale check failed"),
    );
  }, 30_000); // every 30s (FSM cron triggers handle the 10-min stale timeout)

  // Periodic persist — replaces the boot.ts persist loop
  persistInterval = setInterval(() => {
    if (!active || !runtimeState) return;
    import("../store.ts").then(({ persistState }) =>
      persistState(runtimeState!).catch(() => {}),
    ).catch(() => {});
  }, 5_000);

  // Wire analytics broadcaster + periodic push to WS room subscribers
  import("./analytics-broadcaster.ts").then(({ initAnalyticsBroadcaster, pushAllAnalytics }) => {
    initAnalyticsBroadcaster(state);
    analyticsInterval = setInterval(() => {
      if (!active || !runtimeState) return;
      pushAllAnalytics(runtimeState).catch((err) =>
        logger.error({ err }, "[Queue] Analytics broadcast failed"),
      );
    }, 30_000);
  }).catch((err) => logger.error({ err }, "[Queue] Failed to init analytics broadcaster"));

  // Periodic auto-retry: unblock issues whose nextRetryAt has arrived
  blockedRetryInterval = setInterval(() => {
    if (!active || !runtimeState) return;
    autoRetryBlockedIssues(runtimeState).catch((err) =>
      logger.error({ err }, "[Queue] Blocked retry check failed"),
    );
  }, 10_000); // every 10s

  logger.info("[Queue] Unified work queue ready");
}

export async function stopQueueWorkers(): Promise<void> {
  active = false;
  if (staleInterval) { clearInterval(staleInterval); staleInterval = null; }
  if (persistInterval) { clearInterval(persistInterval); persistInterval = null; }
  if (analyticsInterval) { clearInterval(analyticsInterval); analyticsInterval = null; }
  if (blockedRetryInterval) { clearInterval(blockedRetryInterval); blockedRetryInterval = null; }
  runtimeState = null;
  queue.length = 0;
  waiters.length = 0;
  logger.info("[Queue] Workers stopped");
}

export function areQueueWorkersActive(): boolean {
  return active;
}

// ── Semaphore ─────────────────────────────────────────────────────────────

function maxSlots(): number {
  return runtimeState?.config.workerConcurrency ?? 2;
}

async function acquireSlot(): Promise<void> {
  if (inflight < maxSlots()) {
    inflight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inflight++;
}

function releaseSlot(): void {
  inflight = Math.max(inflight - 1, 0);
  if (runtimeState) {
    runtimeState.metrics.activeWorkers = inflight;
  }
  const next = waiters.shift();
  if (next) next();
}

// ── Pre-dispatch guard ────────────────────────────────────────────────────

function canDispatch(issue: IssueEntry, job: JobType): boolean {
  return canDispatchManagedAgent(issue, job, running, runtimeState?.issues ?? []);
}

// ── Internal helpers ──────────────────────────────────────────────────────

function getCurrentIssue(id: string): IssueEntry | undefined {
  return runtimeState?.issues.find((i) => i.id === id);
}

function isAlreadyQueued(issueId: string, job: JobType): boolean {
  return queue.some((e) => e.issueId === issueId && e.job === job);
}

/** Sort: phase order first, then enqueue time (FIFO within same phase). */
function sortQueue(): void {
  queue.sort((a, b) => {
    const phaseA = PHASE_ORDER[a.job];
    const phaseB = PHASE_ORDER[b.job];
    if (phaseA !== phaseB) return phaseA - phaseB;
    return a.enqueuedAt - b.enqueuedAt;
  });
}

// ── Dispatch logic per job type ───────────────────────────────────────────

async function dispatchPlan(issue: IssueEntry): Promise<void> {
  logger.info({ issueId: issue.id, identifier: issue.identifier }, "[Queue] Dispatching plan job");
  await runPlanningJob(runtimeState!, issue, STATE_ROOT);
}

async function dispatchExecute(issue: IssueEntry): Promise<void> {
  logger.info({ issueId: issue.id, identifier: issue.identifier }, "[Queue] Dispatching execute job");
  await runManagedExecuteJob(
    runtimeState!,
    issue,
    running,
    () => active,
    (id) => getCurrentIssue(id),
    STATE_ROOT,
  );
}

async function dispatchReview(issue: IssueEntry): Promise<void> {
  logger.info({ issueId: issue.id, identifier: issue.identifier }, "[Queue] Dispatching review job");
  await runManagedReviewJob(runtimeState!, issue, running, STATE_ROOT);
}

// ── Stale check (replaces scheduler.ensureNotStale) ───────────────────────

async function checkStaleIssues(): Promise<void> {
  if (!runtimeState) return;
  const { ensureNotStale } = await import("./scheduler.ts");
  await ensureNotStale(runtimeState, runtimeState.config.staleInProgressTimeoutMs);
}

// ── Auto-retry Blocked issues whose nextRetryAt has arrived ──────────────

async function autoRetryBlockedIssues(state: RuntimeState): Promise<void> {
  const now = Date.now();
  for (const issue of state.issues) {
    if (issue.state !== "Blocked") continue;
    if (!issue.nextRetryAt) continue;
    if (issue.attempts >= issue.maxAttempts) continue; // budget exhausted — needs human
    const retryAt = new Date(issue.nextRetryAt).getTime();
    if (isNaN(retryAt) || retryAt > now) continue;
    try {
      const { transitionIssue } = await import("../../domains/issues.ts");
      issue.nextRetryAt = undefined;
      await transitionIssue(issue, "UNBLOCK", { note: `Auto-retry: nextRetryAt reached.` });
      logger.info({ issueId: issue.id, identifier: issue.identifier }, "[Queue] Auto-retried blocked issue");
    } catch (err) {
      logger.warn({ err: String(err), issueId: issue.id }, "[Queue] Failed to auto-retry blocked issue");
    }
  }
}

// ── Drain loop ────────────────────────────────────────────────────────────

let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (active && queue.length > 0) {
      sortQueue();
      const entry = queue.shift();
      if (!entry) break;

      const issue = getCurrentIssue(entry.issueId);
      if (!issue || !canDispatch(issue, entry.job)) continue;

      // Planning doesn't occupy a worker slot — fire and forget
      if (entry.job === "plan") {
        dispatchPlan(issue).catch((err) =>
          logger.error({ err, issueId: issue.id }, "[Queue] Plan job failed"),
        );
        continue;
      }

      // Execute/review: acquire a worker slot, run, release
      await acquireSlot();
      if (runtimeState) runtimeState.metrics.activeWorkers = inflight;
      (async () => {
        try {
          if (entry.job === "execute") await dispatchExecute(issue);
          else if (entry.job === "review") await dispatchReview(issue);
        } catch (err) {
          logger.error({ err, issueId: issue.id, job: entry.job }, "[Queue] Job failed");
        } finally {
          releaseSlot();
          // After releasing, try to drain more work
          if (queue.length > 0) drain().catch(() => {});
        }
      })();
    }
  } finally {
    draining = false;
  }
}

// ── Public API: single enqueue entrypoint ─────────────────────────────────

export async function enqueue(issue: IssueEntry, job: JobType): Promise<void> {
  if (!active || !runtimeState) return;
  if (isAlreadyQueued(issue.id, job)) {
    logger.debug({ issueId: issue.id, job }, "[Queue] Already queued, skipping");
    return;
  }
  queue.push({ issueId: issue.id, job, enqueuedAt: Date.now() });
  // Defer drain to next macrotask — FSM entry actions call enqueue() before
  // transitionIssue() updates issue.state in memory, so draining synchronously
  // would see the old state in canDispatch() and discard the job.
  setImmediate(() => {
    drain().catch((err) => logger.error({ err }, "[Queue] Drain loop error"));
  });
}

// ── State recovery (called once after init) ──────────────────────────────

/**
 * Reconcile in-memory issue states with FSM (source of truth), then enqueue
 * all in-progress issues so the queue picks them up. Call once after initQueueWorkers.
 */
export async function recoverState(): Promise<void> {
  if (!runtimeState) return;

  // 1. Reconcile FSM — persisted FSM state wins over in-memory
  await Promise.all(
    runtimeState.issues.map(async (issue) => {
      const result = await syncIssueStateFromFsm(issue, {
        reason: "Recovering queue state from FSM source of truth.",
      });
      if (result.changed) {
        logger.warn(
          { issueId: issue.id, memoryState: result.previousState, fsmState: result.currentState },
          "[Queue] Reconciling desync — FSM is source of truth",
        );
      }
    }),
  );

  // 2. Enqueue all in-progress issues
  for (const issue of runtimeState.issues) {
    try {
      if (issue.state === "Planning") {
        // Reset stale planningStatus from a previous crashed session
        if (issue.planningStatus === "planning") {
          logger.info({ issueId: issue.id, identifier: issue.identifier }, "[Queue] Clearing stale planningStatus from previous session");
          issue.planningStatus = "idle";
        }
        if (!issue.plan) {
          await enqueue(issue, "plan");
        }
      } else if (issue.state === "Queued" || issue.state === "Running") {
        await enqueue(issue, "execute");
      } else if (issue.state === "Reviewing") {
        await enqueue(issue, "review");
      }
    } catch (err) {
      logger.error({ err, issueId: issue.id, state: issue.state }, "[Queue] Failed to enqueue for recovery");
    }
  }
}

// ── Boot recovery ─────────────────────────────────────────────────────────

/**
 * Recover orphaned agent processes from a previous session.
 * Alive PIDs are kept running; dead PIDs are transitioned to Queued with crash context.
 */
export async function recoverOrphans(): Promise<void> {
  if (!runtimeState) return;
  const { isAgentStillRunning, cleanStalePidFile, isDaemonAlive, isDaemonSocketReady } = await import("../../agents/agent.ts");
  const { addEvent } = await import("../../domains/issues.ts");

  const candidates = runtimeState.issues.filter((i) => i.state === "Running" || i.state === "Queued");
  logger.debug({ count: candidates.length }, "[Queue] Checking for orphaned agent processes");

  for (const issue of candidates) {
    const wp = issue.workspacePath;

    // Check if the PTY daemon is alive — daemon survives fifony crashes and
    // keeps the agent running + writing to live-output.log
    if (wp && isDaemonAlive(wp) && isDaemonSocketReady(wp)) {
      logger.info({ issueId: issue.id }, "[Queue] PTY daemon still alive — reattaching");
      if (issue.state !== "Running") {
        try {
          await transitionIssue(issue, "RUN", { issue, note: "PTY daemon still alive on boot — reattaching." });
        } catch {
          syncIssueStateInMemory(issue, "Running", {
            reason: "PTY daemon still alive; fallback sync to Running after transition failure.",
          });
        }
      }
      addEvent(runtimeState, issue.id, "info", "PTY daemon still alive — reattached and monitoring.");
      // Re-enqueue as execute: the dispatcher will call runExecutePhase which
      // will spawn a new runCommandWithTimeout. Since the daemon is alive,
      // runCommandWithTimeout connects to the existing socket instead of spawning.
      await enqueue(issue, "execute");
      continue;
    }

    const { alive, pid } = isAgentStillRunning(issue);
    if (alive && pid) {
      logger.info({ issueId: issue.id, pid: pid.pid }, "[Queue] Agent still alive — keeping Running");
      if (issue.state !== "Running") {
        try {
          await transitionIssue(issue, "RUN", { issue, note: `Orphaned agent (PID ${pid.pid}), still alive — tracking resumed.` });
        } catch {
          syncIssueStateInMemory(issue, "Running", {
            reason: `Orphaned agent (PID ${pid.pid}) still alive; fallback sync to Running after transition failure.`,
          });
        }
      }
      addEvent(runtimeState, issue.id, "info", `Orphaned agent (PID ${pid.pid}) still alive — tracking resumed.`);
    } else {
      if (wp) cleanStalePidFile(wp);
      if (issue.state === "Running") {
        issue.lastError = `Agent process crashed (PID ${pid?.pid}) — not found on boot.`;
        issue.lastFailedPhase = "crash";
        issue.attempts = (issue.attempts ?? 0) + 1;
        try {
          await transitionIssue(issue, "REQUEUE", {
            issue,
            note: "Agent process not found on boot — marked Queued.",
          });
        } catch {
          syncIssueStateInMemory(issue, "Queued", {
            reason: `Agent process (PID ${pid?.pid}) missing on boot; fallback sync to Queued after transition failure.`,
          });
        }
        addEvent(runtimeState, issue.id, "info", `Agent for ${issue.identifier} not found — marked Queued.`);
      }
    }
  }
}

/**
 * Clean workspaces for terminal issues (Merged/Cancelled) in background.
 */
export function cleanTerminalWorkspaces(): void {
  if (!runtimeState) return;
  const terminals = runtimeState.issues.filter((i) => TERMINAL_STATES.has(i.state));
  if (terminals.length === 0) return;
  logger.info({ count: terminals.length }, "[Queue] Scheduling terminal workspace cleanup in background");
  const state = runtimeState;
  setImmediate(async () => {
    const { cleanWorkspace } = await import("../../agents/agent.ts");
    for (const issue of terminals) {
      try { await cleanWorkspace(issue.id, issue, state); } catch {}
    }
    logger.info("[Queue] Terminal workspace cleanup complete");
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────

export async function getQueueStats(): Promise<Record<string, unknown>> {
  return {
    pending: queue.length,
    inflight,
    maxSlots: maxSlots(),
    running: [...running],
    breakdown: {
      plan: queue.filter((e) => e.job === "plan").length,
      execute: queue.filter((e) => e.job === "execute").length,
      review: queue.filter((e) => e.job === "review").length,
    },
  };
}
