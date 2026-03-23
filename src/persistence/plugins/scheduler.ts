import type {
  IssueEntry,
  ParallelismAnalysis,
  RuntimeState,
} from "../../types.ts";
import { EXECUTING_STATES, TERMINAL_STATES, COMPLETED_STATES } from "../../concerns/constants.ts";
import { now } from "../../concerns/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { persistState } from "../store.ts";
import { computeMetrics, getNextRetryAt } from "../../domains/issues.ts";
import { getContainer } from "../container.ts";
import { transitionIssueCommand } from "../../commands/transition-issue.command.ts";
import { issueHasResumableSession, isAgentStillRunning } from "../../agents/agent.ts";

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function installGracefulShutdown(
  state: RuntimeState,
): void {
  const handler = async (signal: string) => {
    if (shuttingDown) {
      logger.warn(`Received ${signal} again, forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);
    const container = getContainer();
    container.eventStore.addEvent(undefined, "info", `Graceful shutdown initiated (${signal}).`);

    // Mark running/reviewing issues as Queued so they resume on next boot
    for (const issue of state.issues) {
      if (issue.state === "Running" || issue.state === "Reviewing") {
        try {
          await transitionIssueCommand({ issue, target: "Queued", note: `Interrupted by ${signal} — queued for resume on next start.`, fallbackToLocal: true }, container);
        } catch {
          logger.warn(`Could not transition issue ${issue.identifier} to Queued during shutdown.`);
        }
        container.eventStore.addEvent(issue.id, "info", `Issue ${issue.identifier} queued for resume on next start.`);
      }

      if (issue.state === "Planning" && issue.planningStatus === "planning") {
        issue.planningStatus = "idle";
        issue.planningError = `Interrupted by ${signal} — will resume.`;
        issue.planningStartedAt = undefined;
        container.issueRepository.markDirty(issue.id);
        container.eventStore.addEvent(issue.id, "info", `Planning for ${issue.identifier} interrupted by shutdown — will resume.`);
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
    issue.state === "PendingApproval"
    && issue.assignedToWorker
    && issue.blockedBy.length === 0,
  );

  if (todo.length === 0) {
    return {
      canParallelize: false,
      maxSafeParallelism: 0,
      reason: "No runnable issues in Planned state.",
      groups: [],
    };
  }

  const getIssuePaths = (issue: IssueEntry): Set<string> =>
    new Set([...(issue.paths ?? [])]);

  const hasPathOverlap = (a: IssueEntry, b: IssueEntry): boolean => {
    const pathsA = getIssuePaths(a);
    const pathsB = getIssuePaths(b);
    if (pathsA.size === 0 || pathsB.size === 0) return false;
    for (const p of pathsA) {
      if (pathsB.has(p)) return true;
    }
    return false;
  };

  const hasDep = (a: IssueEntry, b: IssueEntry): boolean =>
    a.blockedBy.includes(b.id) || b.blockedBy.includes(a.id);

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
  const container = getContainer();

  for (const issue of state.issues) {
    if (issue.state !== "Planning" || issue.planningStatus !== "planning") continue;
    if (!issue.planningStartedAt) continue;
    const elapsed = Date.now() - Date.parse(issue.planningStartedAt);
    if (elapsed > staleTimeoutMs) {
      issue.planningStatus = "idle";
      issue.planningError = "Planning worker stalled — auto-recovered.";
      issue.planningStartedAt = undefined;
      container.issueRepository.markDirty(issue.id);
      container.eventStore.addEvent(issue.id, "info", `Planning for ${issue.identifier} recovered from stale.`);
      logger.info({ issueId: issue.id, identifier: issue.identifier, elapsed }, "[Scheduler] Recovered stale planning job");
    }
  }

  for (const issue of state.issues) {
    if (!EXECUTING_STATES.has(issue.state)) continue;
    if (issueHasResumableSession(issue)) continue;

    const agentStatus = isAgentStillRunning(issue);
    const pidDead = agentStatus.pid !== null && !agentStatus.alive;

    if (pidDead) {
      logger.info({ issueId: issue.id, identifier: issue.identifier, state: issue.state, pid: agentStatus.pid?.pid }, "[Scheduler] PID dead — silently recovering to Queued");
      issue.startedAt = undefined;
      // Capture crash context so onEnterQueued can generate insights
      issue.lastError = `Agent process died unexpectedly (PID ${agentStatus.pid!.pid}).`;
      issue.lastFailedPhase = "crash";
      issue.attempts = (issue.attempts ?? 0) + 1;
      container.issueRepository.markDirty(issue.id);
      await transitionIssueCommand({ issue, target: "Queued", note: `Agent process died (PID ${agentStatus.pid!.pid}) — auto-recovering.` }, container);
      container.eventStore.addEvent(issue.id, "info", `Issue ${issue.identifier} agent process died (PID ${agentStatus.pid!.pid}), silently recovered to Queued.`);
      continue;
    }

    if (Date.parse(issue.updatedAt) < limit) {
      const staleMinutes = Math.round((Date.now() - Date.parse(issue.updatedAt)) / 60_000);
      const reason = `Stale execution — no updates for over ${staleMinutes} minute(s) in ${issue.state} state.`;
      logger.info({ issueId: issue.id, identifier: issue.identifier, state: issue.state, updatedAt: issue.updatedAt }, "[Scheduler] Recovering stale issue → Blocked");
      issue.lastFailedPhase = issue.state === "Reviewing" ? "review" : "execute";
      issue.attempts += 1;
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      issue.startedAt = undefined;
      container.issueRepository.markDirty(issue.id);
      await transitionIssueCommand({ issue, target: "Blocked", note: reason }, container);
      container.eventStore.addEvent(issue.id, "info", `Issue ${issue.identifier} was stale for over ${staleMinutes} minute(s) in ${issue.state} state, moved to Blocked for retry.`);
    }
  }
}

export function hasTerminalQueue(state: RuntimeState): boolean {
  return state.issues.every((issue) => COMPLETED_STATES.has(issue.state) || issue.attempts >= issue.maxAttempts);
}
