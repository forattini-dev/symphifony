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
import {
  addEvent,
  computeMetrics,
  getNextRetryAt,
  issueDependenciesResolved,
  transition,
} from "./issues.ts";
import {
  getIssueCapabilityPriority,
} from "./providers.ts";
import { canRunIssue, issueHasResumableSession, runIssueOnce } from "./agent.ts";

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function installGracefulShutdown(
  state: RuntimeState,
  running: Set<string>,
): void {
  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, persisting state and shutting down...`);
    addEvent(state, undefined, "info", `Graceful shutdown initiated (${signal}).`);
    state.updatedAt = now();
    state.metrics = computeMetrics(state.issues);
    await persistState(state);
    logger.info("State persisted. Exiting.");
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

export function ensureNotStale(state: RuntimeState, staleTimeoutMs: number): void {
  const limit = Date.now() - staleTimeoutMs;
  for (const issue of state.issues) {
    if (
      EXECUTING_STATES.has(issue.state)
      && Date.parse(issue.updatedAt) < limit
      && !TERMINAL_STATES.has(issue.state)
      && !issueHasResumableSession(issue)
    ) {
      issue.attempts += 1;
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      issue.startedAt = undefined;
      transition(issue, "Blocked", `Issue state auto-recovered from stale execution.`);
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
  return state.issues
    .filter((issue) => canRunIssue(issue, running, state) && !isPerStateFull(issue, state, running))
    .sort((a, b) => {
      const stateWeight = (c: IssueEntry) => c.state === "In Progress" ? 0 : c.state === "Blocked" ? 2 : 1;
      const weightDiff = stateWeight(a) - stateWeight(b);
      if (weightDiff !== 0) return weightDiff;
      if (a.priority !== b.priority) return a.priority - b.priority;
      const capabilityDiff = getIssueCapabilityPriority(a, workflowDefinition) - getIssueCapabilityPriority(b, workflowDefinition);
      if (capabilityDiff !== 0) return capabilityDiff;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
}

function validateDispatchConfig(state: RuntimeState): string | null {
  if (!state.config.agentCommand?.trim()) {
    return "No agent command configured.";
  }
  if (state.config.workerConcurrency < 1) {
    return "Worker concurrency must be >= 1.";
  }
  if (state.config.maxTurns < 1) {
    return "Max turns must be >= 1.";
  }
  return null; // valid
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
      ensureNotStale(state, state.config.staleInProgressTimeoutMs);

      // Per-tick dispatch validation (spec §6.3)
      const validationError = validateDispatchConfig(state);
      if (validationError) {
        logger.warn(`Dispatch skipped: ${validationError}`);
      } else {
        const ready = pickNextIssues(state, running, workflowDefinition);
        const slots = state.config.workerConcurrency - running.size;
        if (slots > 0) {
          const next = ready.slice(0, Math.max(0, slots));
          await Promise.all(next.map((issue) => runIssueOnce(state, issue, running, workflowDefinition)));
        }
      }
      state.updatedAt = now();
      await persistState(state);
      logger.debug("Scheduler tick completed.");
      await sleep(state.config.pollIntervalMs);
    }
    return;
  }

  while (!hasTerminalQueue(state) && !shuttingDown) {
    ensureNotStale(state, state.config.staleInProgressTimeoutMs);

    const batchValidationError = validateDispatchConfig(state);
    if (batchValidationError) {
      logger.warn(`Dispatch skipped: ${batchValidationError}`);
      await sleep(state.config.pollIntervalMs);
      continue;
    }

    const ready = pickNextIssues(state, running, workflowDefinition);
    const slots = state.config.workerConcurrency - running.size;
    const next = ready.slice(0, Math.max(0, slots));

    if (next.length === 0 && running.size === 0) {
      if (state.issues.some((issue) => issue.state === "Blocked" && issue.nextRetryAt && issue.attempts < issue.maxAttempts)) {
        await sleep(state.config.pollIntervalMs);
        continue;
      }
      break;
    }

    await Promise.all(next.map((issue) => runIssueOnce(state, issue, running, workflowDefinition)));
    state.updatedAt = now();
    await persistState(state);

    if (running.size === 0) {
      await sleep(state.config.pollIntervalMs);
    }
  }
}
