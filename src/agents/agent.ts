/**
 * agent.ts — public entry point
 *
 * Re-exports the full agent API consumed by scheduler.ts, api-server.ts, and other modules.
 * Implementation is split across the following modules:
 *   directive-parser.ts   — output parsing, token extraction, directive normalization
 *   pid-manager.ts        — PID file management and process liveness checks
 *   workspace-diff.ts     — diff computation and changed-path inference
 *   workspace-merge.ts    — worktree commit, merge, path hydration, routing signals
 *   session-state.ts      — session/pipeline state load, persist, and snapshot helpers
 *   prompt-builder.ts     — prompt construction for sessions, turns, and providers
 *   command-executor.ts   — runCommandWithTimeout and runHook
 *   workspace-setup.ts    — workspace creation, git worktree, and cleanWorkspace
 *   agent-pipeline.ts     — runAgentSession, runAgentPipeline, runPlanningJob, runIssueOnce
 */

// ── Re-exports from directive-parser ──────────────────────────────────────
export { addTokenUsage, readAgentDirective, extractTokenUsage, tryParseJsonOutput } from "./directive-parser.ts";

// ── Re-exports from pid-manager ───────────────────────────────────────────
export { readAgentPid, isProcessAlive, cleanStalePidFile } from "./pid-manager.ts";
export type { AgentPidInfo } from "./pid-manager.ts";

// ── Re-exports from workspace-diff ────────────────────────────────────────
export { computeDiffStats, inferChangedWorkspacePaths, parseDiffStats } from "../domains/workspace.ts";

// ── Re-exports from workspace-merge ───────────────────────────────────────
export { mergeWorkspace, pushWorktreeBranch, hydrateIssuePathsFromWorkspace, describeRoutingSignals, shouldSkipMergePath, ensureWorktreeCommitted } from "../domains/workspace.ts";
export type { MergeResult } from "../domains/workspace.ts";

// ── Re-exports from session-state ─────────────────────────────────────────
export {
  loadAgentPipelineState,
  loadAgentPipelineSnapshotForIssue,
  loadAgentSessionSnapshotsForIssue,
} from "./session-state.ts";

// ── Re-exports from prompt-builder ────────────────────────────────────────
export { buildPrompt, buildTurnPrompt, buildProviderBasePrompt } from "./prompt-builder.ts";

// ── Re-exports from command-executor ──────────────────────────────────────
export { runCommandWithTimeout, runHook } from "./command-executor.ts";

// ── Re-exports from workspace-setup ───────────────────────────────────────
export { cleanWorkspace, prepareWorkspace, createGitWorktree } from "../domains/workspace.ts";

// ── Re-exports from agent-pipeline ────────────────────────────────────────
export { runAgentPipeline, runAgentSession } from "./agent-pipeline.ts";

// ── Re-exports from issue-runner ──────────────────────────────────────────
export { runPlanningJob } from "./issue-runner.ts";

// ── Public functions consumed by scheduler.ts / api-server.ts ─────────────

import type { IssueEntry, RuntimeState } from "../types.ts";
import { TERMINAL_STATES } from "../concerns/constants.ts";
import { logger } from "../concerns/logger.ts";
import { isAgentStillRunning } from "./pid-manager.ts";

export { isAgentStillRunning };
export { runIssueOnce } from "./issue-runner.ts";

export function issueHasResumableSession(issue: IssueEntry): boolean {
  return Boolean(issue.workspacePath) && issue.state === "Running";
}

function issueDepsResolved(issue: IssueEntry, allIssues: IssueEntry[]): boolean {
  if (issue.blockedBy.length === 0) return true;
  const map = new Map(allIssues.map((entry) => [entry.id, entry]));
  return issue.blockedBy.every((depId) => {
    const dep = map.get(depId);
    return dep?.state === "Done";
  });
}

export function canRunIssue(issue: IssueEntry, running: Set<string>, state: RuntimeState): boolean {
  if (!issue.assignedToWorker) return false;
  if (running.has(issue.id)) return false;
  if (TERMINAL_STATES.has(issue.state)) return false;

  // Planning state: only dispatch when no plan exists yet and no job is active
  if (issue.state === "Planning") {
    if (issue.plan) return false; // plan already generated — waiting for user approval
    return issue.planningStatus === "idle" || !issue.planningStatus;
  }

  // Don't spawn a new agent if one is still alive from a previous session
  const { alive } = isAgentStillRunning(issue);
  if (alive) {
    logger.debug({ issueId: issue.id, identifier: issue.identifier }, "[Agent] Skipping issue — agent still alive from previous session");
    return false;
  }

  if (issue.state === "Blocked") {
    if (!issue.nextRetryAt) return false;
    if (issue.attempts >= issue.maxAttempts) {
      logger.debug({ issueId: issue.id, identifier: issue.identifier, attempts: issue.attempts, maxAttempts: issue.maxAttempts }, "[Agent] Skipping blocked issue — max attempts reached");
      return false;
    }
    if (Date.parse(issue.nextRetryAt) > Date.now()) return false;
  }

  if (!issueDepsResolved(issue, state.issues)) {
    logger.debug({ issueId: issue.id, identifier: issue.identifier, blockedBy: issue.blockedBy }, "[Agent] Skipping issue — unresolved dependencies");
    return false;
  }

  if (issue.state === "Queued") return true;
  if (issue.state === "Blocked") return true;
  if (issue.state === "Running" && issueHasResumableSession(issue)) return true;
  if (issue.state === "Reviewing") return true;

  return false;
}
