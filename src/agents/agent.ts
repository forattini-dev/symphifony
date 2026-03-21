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
export { mergeWorkspace, hydrateIssuePathsFromWorkspace, describeRoutingSignals, shouldSkipMergePath, ensureWorktreeCommitted } from "../domains/workspace.ts";
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

// ── Public functions consumed by queue-workers.ts / api-server.ts ────────

import type { IssueEntry } from "../types.ts";
import { isAgentStillRunning } from "./pid-manager.ts";

export { isAgentStillRunning };
export { runIssueOnce } from "./issue-runner.ts";

export function issueHasResumableSession(issue: IssueEntry): boolean {
  return Boolean(issue.workspacePath) && issue.state === "Running";
}
