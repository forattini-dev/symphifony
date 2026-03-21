import type { IssueEntry, RuntimeState } from "../../types.ts";
import { TERMINAL_STATES } from "../../concerns/constants.ts";
import { logger } from "../../concerns/logger.ts";

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

  logger.info("[Queue] Unified work queue ready");
}

export async function stopQueueWorkers(): Promise<void> {
  active = false;
  if (staleInterval) { clearInterval(staleInterval); staleInterval = null; }
  if (persistInterval) { clearInterval(persistInterval); persistInterval = null; }
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

// ── Pre-dispatch guards (absorbed from old canRunIssue) ──────────────────

function issueDepsResolved(issue: IssueEntry): boolean {
  if (!runtimeState || issue.blockedBy.length === 0) return true;
  const map = new Map(runtimeState.issues.map((i) => [i.id, i]));
  return issue.blockedBy.every((depId) => {
    const dep = map.get(depId);
    return dep?.state === "Approved" || dep?.state === "Merged";
  });
}

function canDispatch(issue: IssueEntry, job: JobType): boolean {
  if (!issue.assignedToWorker) return false;
  if (TERMINAL_STATES.has(issue.state)) return false;
  if (running.has(issue.id)) return false;
  if (!issueDepsResolved(issue)) {
    logger.debug({ issueId: issue.id, blockedBy: issue.blockedBy }, "[Queue] Skipping — unresolved deps");
    return false;
  }

  if (job === "plan") {
    if (issue.state !== "Planning") return false;
    if (issue.plan) return false; // plan exists — waiting for approval
    if (issue.planningStatus === "planning") return false;
  }

  if (job === "execute") {
    if (issue.state !== "Queued" && issue.state !== "Running") return false;
  }

  if (job === "review") {
    if (issue.state !== "Reviewing") return false;
  }

  return true;
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
  const { runPlanningJob } = await import("../../agents/issue-runner.ts");
  await runPlanningJob(runtimeState!, issue);
}

async function dispatchExecute(issue: IssueEntry): Promise<void> {
  const { runIssueOnce } = await import("../../agents/issue-runner.ts");
  // Loop: keep running until the issue leaves Queued/Running
  while (active && runtimeState) {
    const current = getCurrentIssue(issue.id);
    if (!current || (current.state !== "Queued" && current.state !== "Running")) break;
    logger.info({ issueId: issue.id, identifier: current.identifier, state: current.state }, "[Queue] Dispatching execute job");
    await runIssueOnce(runtimeState, current, running);
  }
}

async function dispatchReview(issue: IssueEntry): Promise<void> {
  logger.info({ issueId: issue.id, identifier: issue.identifier }, "[Queue] Dispatching review job");
  const { runIssueOnce } = await import("../../agents/issue-runner.ts");
  await runIssueOnce(runtimeState!, issue, running);
}

// ── Stale check (replaces scheduler.ensureNotStale) ───────────────────────

async function checkStaleIssues(): Promise<void> {
  if (!runtimeState) return;
  const { ensureNotStale } = await import("./scheduler.ts");
  await ensureNotStale(runtimeState, runtimeState.config.staleInProgressTimeoutMs);
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
  drain().catch((err) => logger.error({ err }, "[Queue] Drain loop error"));
}

// ── Backwards-compat wrappers (called by FSM entry actions via lazy import) ─

export async function enqueueForPlanning(issue: IssueEntry): Promise<void> {
  return enqueue(issue, "plan");
}

export async function enqueueForExecution(issue: IssueEntry): Promise<void> {
  return enqueue(issue, "execute");
}

export async function enqueueForReview(issue: IssueEntry): Promise<void> {
  return enqueue(issue, "review");
}

// ── State recovery (called once after init) ──────────────────────────────

/**
 * Reconcile in-memory issue states with FSM (source of truth), then enqueue
 * all in-progress issues so the queue picks them up. Call once after initQueueWorkers.
 */
export async function recoverState(): Promise<void> {
  if (!runtimeState) return;

  // 1. Reconcile FSM — persisted FSM state wins over in-memory
  try {
    const { getIssueStateMachinePlugin, ISSUE_STATE_MACHINE_ID } = await import("./issue-state-machine.ts");
    const fsmPlugin = getIssueStateMachinePlugin();
    if (fsmPlugin?.getState) {
      for (const issue of runtimeState.issues) {
        try {
          const fsmState = await fsmPlugin.getState(ISSUE_STATE_MACHINE_ID, issue.id);
          if (fsmState && fsmState !== issue.state) {
            const { parseIssueState } = await import("../../concerns/helpers.ts");
            const normalized = parseIssueState(fsmState) ?? fsmState;
            logger.warn({ issueId: issue.id, memoryState: issue.state, fsmState, normalized }, "[Queue] Reconciling desync — FSM is source of truth");
            issue.state = normalized as typeof issue.state;
          }
        } catch { /* FSM entity may not exist yet */ }
      }
    }
  } catch { /* FSM plugin may not be ready */ }

  // 2. Enqueue all in-progress issues
  for (const issue of runtimeState.issues) {
    try {
      if (issue.state === "Planning" && issue.planningStatus !== "planning") {
        await enqueue(issue, "plan");
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
  const { isAgentStillRunning, cleanStalePidFile } = await import("../../agents/agent.ts");
  const { executeTransition } = await import("./issue-state-machine.ts");
  const { addEvent } = await import("../../domains/issues.ts");

  const candidates = runtimeState.issues.filter((i) => i.state === "Running" || i.state === "Queued");
  logger.debug({ count: candidates.length }, "[Queue] Checking for orphaned agent processes");

  for (const issue of candidates) {
    const { alive, pid } = isAgentStillRunning(issue);
    if (alive && pid) {
      logger.info({ issueId: issue.id, pid: pid.pid }, "[Queue] Agent still alive — keeping Running");
      if (issue.state !== "Running") {
        try { await executeTransition(issue, "RUN", { issue, note: `Orphaned agent (PID ${pid.pid}), still alive — tracking resumed.` }); }
        catch { issue.state = "Running"; }
      }
      addEvent(runtimeState, issue.id, "info", `Orphaned agent (PID ${pid.pid}) still alive — tracking resumed.`);
    } else {
      if (issue.workspacePath) cleanStalePidFile(issue.workspacePath);
      if (issue.state === "Running") {
        issue.lastError = `Agent process crashed (PID ${pid?.pid}) — not found on boot.`;
        issue.lastFailedPhase = "crash";
        issue.attempts = (issue.attempts ?? 0) + 1;
        try { await executeTransition(issue, "REQUEUE", { issue, note: "Agent process not found on boot — marked Queued." }); }
        catch { issue.state = "Queued"; }
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
