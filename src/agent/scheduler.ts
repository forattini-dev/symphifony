import type {
  IssueEntry,
  JsonRecord,
  ParallelismAnalysis,
  RuntimeState,
  WorkflowDefinition,
} from "./types.ts";
import { EXECUTING_STATES, TERMINAL_STATES } from "./constants.ts";
import { now, sleep, normalizeState, toStringValue } from "./helpers.ts";
import { logger } from "./logger.ts";
import { persistState } from "./store.ts";
import { hasDirtyState, markIssueDirty } from "./dirty-tracker.ts";
import { detectAvailableProviders, resolveDefaultProvider, getProviderDefaultCommand } from "./providers.ts";
import {
  addEvent,
  computeMetrics,
  getNextRetryAt,
  issueDependenciesResolved,
  transitionIssueState,
} from "./issues.ts";
import {
  getIssueCapabilityPriority,
} from "./providers.ts";
import { canRunIssue, issueHasResumableSession, runIssueOnce } from "./agent.ts";

let shuttingDown = false;
let lastPersistAt = 0;
const PERSIST_DEBOUNCE_MS = 5000;

// ── Wake signal ─────────────────────────────────────────────────────────────
let schedulerWakeResolve: (() => void) | null = null;

export function wakeScheduler(): void {
  schedulerWakeResolve?.();
}

// ── Adaptive polling ────────────────────────────────────────────────────────
const IDLE_POLL_MS = 5000;
const ACTIVE_POLL_MS = 500;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function installGracefulShutdown(
  state: RuntimeState,
  running: Set<string>,
): void {
  const handler = async (signal: string) => {
    if (shuttingDown) {
      logger.warn(`Received ${signal} again, forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);
    addEvent(state, undefined, "info", `Graceful shutdown initiated (${signal}).`);

    // Mark running issues as Interrupted so they resume on next boot
    for (const issue of state.issues) {
      if (running.has(issue.id) && (issue.state === "Running" || issue.state === "In Review")) {
        try {
          await transitionIssueState(issue, "Interrupted", `Interrupted by ${signal} — will resume on next start.`, { fallbackToLocal: true });
        } catch {
          // Issue may already be in a terminal state; proceed with shutdown regardless
          logger.warn(`Could not transition issue ${issue.identifier} to Interrupted during shutdown.`);
        }
        addEvent(state, issue.id, "info", `Issue ${issue.identifier} interrupted by shutdown.`);
      }
    }

    state.updatedAt = now();
    state.metrics = computeMetrics(state.issues);
    try {
      await persistState(state);
      logger.info("State persisted.");
    } catch (error) {
      logger.error(`Failed to persist state during shutdown: ${String(error)}`);
    }
    logger.info("Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

export function analyzeParallelizability(issues: IssueEntry[]): ParallelismAnalysis {
  const todo = issues.filter((issue) =>
    issue.state === "Todo"
    && issue.assignedToWorker
    && issue.blockedBy.length === 0,
  );

  if (todo.length === 0) {
    return {
      canParallelize: false,
      maxSafeParallelism: 0,
      reason: "No runnable issues in Todo state.",
      groups: [],
    };
  }

  // Build path overlap graph
  const getIssuePaths = (issue: IssueEntry): Set<string> =>
    new Set([...(issue.paths ?? []), ...(issue.inferredPaths ?? [])]);

  const hasPathOverlap = (a: IssueEntry, b: IssueEntry): boolean => {
    const pathsA = getIssuePaths(a);
    const pathsB = getIssuePaths(b);
    if (pathsA.size === 0 || pathsB.size === 0) return false;
    for (const p of pathsA) {
      if (pathsB.has(p)) return true;
    }
    return false;
  };

  // Build dependency graph among todo issues
  const todoIds = new Set(todo.map((i) => i.id));
  const hasDep = (a: IssueEntry, b: IssueEntry): boolean =>
    a.blockedBy.includes(b.id) || b.blockedBy.includes(a.id);

  // Group independent issues using greedy coloring
  const groups: string[][] = [];
  const assigned = new Set<string>();

  for (const issue of todo) {
    if (assigned.has(issue.id)) continue;

    let placed = false;
    for (const group of groups) {
      const canJoin = group.every((memberId) => {
        const member = todo.find((i) => i.id === memberId)!;
        return !hasPathOverlap(issue, member) && !hasDep(issue, member);
      });

      if (canJoin) {
        group.push(issue.id);
        assigned.add(issue.id);
        placed = true;
        break;
      }
    }

    if (!placed) {
      groups.push([issue.id]);
      assigned.add(issue.id);
    }
  }

  const maxSafe = Math.max(...groups.map((g) => g.length));
  const conflictingPairs = todo.filter((a, i) =>
    todo.slice(i + 1).some((b) => hasPathOverlap(a, b)),
  ).length;

  const reason = conflictingPairs > 0
    ? `${conflictingPairs} issue(s) share file paths with other issues. Maximum safe parallelism is ${maxSafe}.`
    : `All ${todo.length} runnable issues have independent paths. Safe to parallelize up to ${maxSafe}.`;

  return {
    canParallelize: maxSafe > 1,
    maxSafeParallelism: maxSafe,
    reason,
    groups,
  };
}

export async function ensureNotStale(state: RuntimeState, staleTimeoutMs: number): Promise<void> {
  const limit = Date.now() - staleTimeoutMs;
  for (const issue of state.issues) {
    if (
      EXECUTING_STATES.has(issue.state)
      && Date.parse(issue.updatedAt) < limit
      && !TERMINAL_STATES.has(issue.state)
      && !issueHasResumableSession(issue)
    ) {
      const staleMinutes = Math.round((Date.now() - Date.parse(issue.updatedAt)) / 60_000);
      logger.info({ issueId: issue.id, identifier: issue.identifier, state: issue.state, updatedAt: issue.updatedAt }, "[Scheduler] Recovering stale issue");
      issue.attempts += 1;
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      issue.startedAt = undefined;
      markIssueDirty(issue.id);
      await transitionIssueState(issue, "Blocked", `Issue state auto-recovered from stale execution.`);
      addEvent(state, issue.id, "info", `Issue ${issue.identifier} was stale for over ${staleMinutes} minute(s) in ${issue.state} state, moved to Blocked for retry.`);
    }
  }
}

function isPerStateFull(issue: IssueEntry, state: RuntimeState, running: Set<string>): boolean {
  const byState = state.config.maxConcurrentByState;
  if (!byState || Object.keys(byState).length === 0) return false;
  const stateKey = issue.state.toLowerCase();
  const limit = byState[stateKey];
  if (limit === undefined) return false;
  const count = state.issues.filter((i) => running.has(i.id) && i.state.toLowerCase() === stateKey).length;
  return count >= limit;
}

export function pickNextIssues(
  state: RuntimeState,
  running: Set<string>,
  workflowDefinition: WorkflowDefinition | null,
): IssueEntry[] {
  const candidates = state.issues
    .filter((issue) => canRunIssue(issue, running, state) && !isPerStateFull(issue, state, running));
  if (candidates.length > 0) {
    logger.debug({ candidates: candidates.map((i) => ({ id: i.identifier, state: i.state, priority: i.priority })) }, "[Scheduler] Eligible candidates for dispatch");
  }
  return candidates
    .sort((a, b) => {
      const stateWeight = (c: IssueEntry) => c.state === "Running" ? 0 : c.state === "Blocked" ? 2 : 1;
      const weightDiff = stateWeight(a) - stateWeight(b);
      if (weightDiff !== 0) return weightDiff;
      if (a.priority !== b.priority) return a.priority - b.priority;
      const capabilityDiff = getIssueCapabilityPriority(a, workflowDefinition) - getIssueCapabilityPriority(b, workflowDefinition);
      if (capabilityDiff !== 0) return capabilityDiff;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
}

let lastDispatchWarning = "";

function validateDispatchConfig(state: RuntimeState): string | null {
  if (!state.config.agentCommand?.trim()) {
    // Self-healing: try to auto-detect a provider
    const detected = detectAvailableProviders();
    const provider = resolveDefaultProvider(detected);
    if (provider) {
      const command = getProviderDefaultCommand(provider);
      if (command) {
        state.config.agentProvider = provider;
        state.config.agentCommand = command;
        logger.info(`Self-healed: auto-detected provider ${provider} → ${command}`);
        return null;
      }
    }
    return "No agent command configured. Install claude or codex, or set FIFONY_AGENT_COMMAND.";
  }
  if (state.config.workerConcurrency < 1) {
    return "Worker concurrency must be >= 1.";
  }
  if (state.config.maxTurns < 1) {
    return "Max turns must be >= 1.";
  }
  return null; // valid
}

function warnOncePerMessage(message: string): void {
  if (message === lastDispatchWarning) return;
  lastDispatchWarning = message;
  logger.warn(`Dispatch skipped: ${message}`);
}

export function hasTerminalQueue(state: RuntimeState): boolean {
  return state.issues.every((issue) => TERMINAL_STATES.has(issue.state) || issue.attempts >= issue.maxAttempts);
}

export async function scheduler(
  state: RuntimeState,
  running: Set<string>,
  runForever: boolean,
  workflowDefinition: WorkflowDefinition | null,
): Promise<void> {
  if (runForever) {
    while (!shuttingDown) {
      await ensureNotStale(state, state.config.staleInProgressTimeoutMs);

      // Per-tick dispatch validation (spec §6.3)
      const validationError = validateDispatchConfig(state);
      if (validationError) {
        warnOncePerMessage(validationError);
      } else {
        const ready = pickNextIssues(state, running, workflowDefinition);
        const slots = state.config.workerConcurrency - running.size;
        if (slots > 0 && ready.length > 0) {
          const next = ready.slice(0, Math.max(0, slots));
          logger.debug({ slots, readyCount: ready.length, dispatching: next.map((i) => i.identifier) }, "[Scheduler] Dispatching issues");
          await Promise.all(next.map((issue) => runIssueOnce(state, issue, running, workflowDefinition)));
        } else if (ready.length > 0 && slots <= 0) {
          logger.debug({ runningCount: running.size, readyCount: ready.length, concurrency: state.config.workerConcurrency }, "[Scheduler] No slots available, waiting");
        }
      }
      state.updatedAt = now();
      const shouldPersist = hasDirtyState() || Date.now() - lastPersistAt > PERSIST_DEBOUNCE_MS;
      if (shouldPersist) {
        await persistState(state);
        lastPersistAt = Date.now();
      }
      logger.debug({ runningCount: running.size, issueCount: state.issues.length, dirty: hasDirtyState() }, "[Scheduler] Tick completed");
      const effectivePoll = running.size > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS;
      await Promise.race([
        sleep(effectivePoll),
        new Promise<void>((resolve) => { schedulerWakeResolve = resolve; }),
      ]);
      schedulerWakeResolve = null;
    }
    return;
  }

  while (!hasTerminalQueue(state) && !shuttingDown) {
    await ensureNotStale(state, state.config.staleInProgressTimeoutMs);

    const batchValidationError = validateDispatchConfig(state);
    if (batchValidationError) {
      warnOncePerMessage(batchValidationError);
      await sleep(state.config.pollIntervalMs);
      continue;
    }

    const ready = pickNextIssues(state, running, workflowDefinition);
    const slots = state.config.workerConcurrency - running.size;
    const next = ready.slice(0, Math.max(0, slots));

    if (next.length === 0 && running.size === 0) {
      if (state.issues.some((issue) => issue.state === "Blocked" && issue.nextRetryAt && issue.attempts < issue.maxAttempts)) {
        logger.debug("[Scheduler] Batch mode: waiting for blocked issues to become eligible for retry");
        await sleep(state.config.pollIntervalMs);
        continue;
      }
      logger.debug("[Scheduler] Batch mode: no more work to do, exiting loop");
      break;
    }

    if (next.length > 0) {
      logger.debug({ slots, dispatching: next.map((i) => i.identifier) }, "[Scheduler] Batch mode: dispatching issues");
    }
    await Promise.all(next.map((issue) => runIssueOnce(state, issue, running, workflowDefinition)));
    state.updatedAt = now();
    await persistState(state);

    if (running.size === 0) {
      await sleep(state.config.pollIntervalMs);
    }
  }
}
