import type { IssueEntry, RuntimeState } from "../../types.ts";
import { logger } from "../../concerns/logger.ts";

let runtimeState: RuntimeState | null = null;
let active = false;

export async function initQueueWorkers(state: RuntimeState): Promise<void> {
  runtimeState = state;
  active = true;
  logger.info("[QueueWorkers] Workers ready (direct dispatch)");
}

export async function stopQueueWorkers(): Promise<void> {
  active = false;
  runtimeState = null;
  logger.info("[QueueWorkers] Workers stopped");
}

export function areQueueWorkersActive(): boolean {
  return active;
}

function getCurrentIssue(id: string): IssueEntry | undefined {
  return runtimeState?.issues.find((i) => i.id === id);
}

// ── Dispatch: call handlers directly, no queue middleware ─────────────────

export async function enqueueForPlanning(issue: IssueEntry): Promise<void> {
  if (!active || !runtimeState) return;
  const current = getCurrentIssue(issue.id);
  if (!current || current.state !== "Planning") {
    logger.debug({ issueId: issue.id, state: current?.state }, "[QueueWorkers:plan] Skipping — not in Planning state");
    return;
  }
  if (current.planningStatus === "planning") {
    logger.debug({ issueId: issue.id }, "[QueueWorkers:plan] Already planning, skipping");
    return;
  }
  logger.info({ issueId: issue.id, identifier: current.identifier }, "[QueueWorkers:plan] Dispatching planning job");
  try {
    const { runPlanningJob } = await import("../../agents/issue-runner.ts");
    await runPlanningJob(runtimeState, current);
  } catch (error) {
    logger.error({ err: error, issueId: issue.id }, "[QueueWorkers:plan] Planning job failed");
  }
}

export async function enqueueForExecution(issue: IssueEntry): Promise<void> {
  if (!active || !runtimeState) return;
  const running = new Set<string>();
  const { runIssueOnce } = await import("../../agents/issue-runner.ts");

  // Loop: keep running until the issue leaves Running/Queued state (e.g., moves to Reviewing/Done/Blocked)
  while (active && runtimeState) {
    const current = getCurrentIssue(issue.id);
    if (!current || (current.state !== "Queued" && current.state !== "Running")) {
      logger.debug({ issueId: issue.id, state: current?.state }, "[QueueWorkers:execute] Issue no longer in Queued/Running — stopping dispatch loop");
      break;
    }
    logger.info({ issueId: issue.id, identifier: current.identifier, state: current.state }, "[QueueWorkers:execute] Dispatching execution job");
    try {
      await runIssueOnce(runtimeState, current, running);
    } catch (error) {
      logger.error({ err: error, issueId: issue.id }, "[QueueWorkers:execute] Execution job failed");
      break;
    }
  }
}

export async function enqueueForReview(issue: IssueEntry): Promise<void> {
  if (!active || !runtimeState) return;
  const current = getCurrentIssue(issue.id);
  if (!current || current.state !== "Reviewing") {
    logger.debug({ issueId: issue.id, state: current?.state }, "[QueueWorkers:review] Skipping — not in Reviewing state");
    return;
  }
  logger.info({ issueId: issue.id, identifier: current.identifier }, "[QueueWorkers:review] Dispatching review job");
  const running = new Set<string>();
  try {
    const { runIssueOnce } = await import("../../agents/issue-runner.ts");
    await runIssueOnce(runtimeState, current, running);
  } catch (error) {
    logger.error({ err: error, issueId: issue.id }, "[QueueWorkers:review] Review job failed");
  }
}

export async function getQueueStats(): Promise<Record<string, unknown>> {
  return { plan: null, execute: null, review: null };
}
