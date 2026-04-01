import { join } from "node:path";
import { execSync } from "node:child_process";
import type { IssueEntry, RuntimeState, AgentProviderDefinition, ParallelSubTask } from "../types.ts";
import { createGitWorktree } from "../domains/workspace.ts";
import { now } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { addEvent } from "../domains/issues.ts";
import { markIssueDirty } from "../persistence/dirty-tracker.ts";
import { runAgentSession } from "./agent-pipeline.ts";
import { broadcastIssueProgress, sendToAllClients } from "../routes/websocket.ts";

/** Broadcast parallel subtask state to all WS clients. */
function broadcastSubTaskState(issue: IssueEntry, phase: "started" | "completed"): void {
  const tasks = (issue.parallelSubTasks ?? []).map((t) => ({
    id: t.id,
    label: t.label,
    status: t.status,
    result: t.result?.slice(0, 200),
  }));
  sendToAllClients(JSON.stringify({
    type: "issue:subtasks",
    issueId: issue.id,
    identifier: issue.identifier,
    phase,
    tasks,
  }));
}

export async function spawnParallelSubTasks(
  state: RuntimeState,
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  cycle: number,
  basePromptText: string,
  basePromptFile: string,
): Promise<boolean> {
  const subTaskDefs = issue.plan?.executionContract?.parallelSubTasks;
  if (!subTaskDefs || subTaskDefs.length < 2) return false;

  // Initialize tracking
  issue.parallelSubTasks = subTaskDefs.map((def) => ({
    id: def.id,
    label: def.label,
    stepIndices: def.steps,
    status: "pending" as const,
    startedAt: now(),
  }));
  markIssueDirty(issue.id);

  const mainWorktree = issue.workspacePath!;

  // Dynamic fanout — configurable, adapts to capacity
  const configuredFanout = state.config.maxParallelSubTasks ?? 3;
  const maxFanout = Math.min(subTaskDefs.length, configuredFanout);
  const activeTasks = issue.parallelSubTasks.slice(0, maxFanout);

  for (const subTask of activeTasks) {
    const subWorktreePath = join(mainWorktree, `subtask-${subTask.id}`);
    try {
      // Build a minimal IssueEntry-like object for createGitWorktree
      const subIssue: IssueEntry = {
        ...issue,
        id: `${issue.id}-sub-${subTask.id}`,
        identifier: `${issue.identifier}-sub-${subTask.id}`,
      };
      await createGitWorktree(subIssue, subWorktreePath);
      subTask.worktreePath = subWorktreePath;
    } catch (err) {
      logger.error({ err, issueId: issue.id, subTaskId: subTask.id }, "[Parallel] Failed to create sub-worktree");
      subTask.status = "failed";
      subTask.result = String(err);
    }
  }
  markIssueDirty(issue.id);

  // Build per-subtask prompts
  function buildSubTaskPrompt(subTask: ParallelSubTask, base: string): string {
    const steps = subTask.stepIndices
      .map((i) => issue.plan?.steps?.[i])
      .filter(Boolean)
      .map((s, idx) => `${idx + 1}. [${s!.action}] ${s!.step}`)
      .join("\n");
    return `${base}\n\n## Your Sub-Task: ${subTask.label}\n\nFocus ONLY on these steps:\n${steps}\n\nIgnore steps not listed above.`;
  }

  // Run all sub-tasks in parallel with per-subtask WS broadcasts
  const readyTasks = activeTasks.filter((t) => t.worktreePath && t.status !== "failed");
  addEvent(state, issue.id, "info", `Spawning ${readyTasks.length} parallel sub-agents: ${readyTasks.map((t) => t.label).join(", ")}.`);

  // Broadcast initial state: all subtasks starting
  broadcastSubTaskState(issue, "started");

  const results = await Promise.allSettled(
    readyTasks.map(async (subTask) => {
      const subStartTs = Date.now();
      subTask.status = "running";
      markIssueDirty(issue.id);
      addEvent(state, issue.id, "runner", `Sub-task "${subTask.label}" started.`);

      // Broadcast per-subtask start
      broadcastIssueProgress({
        issueId: issue.id,
        identifier: issue.identifier,
        phase: "turn_started",
        turn: 1,
        maxTurns: 1,
        role: `subtask:${subTask.id}`,
        provider: provider.provider,
        elapsedMs: 0,
      });

      const subPrompt = buildSubTaskPrompt(subTask, basePromptText);
      try {
        const result = await runAgentSession(state, issue, provider, cycle, subTask.worktreePath!, subPrompt, basePromptFile);
        subTask.status = result.success ? "done" : "failed";
        subTask.result = result.output?.slice(-500) ?? "";
        subTask.completedAt = now();
        subTask.tokenUsage = issue.tokenUsage;
        markIssueDirty(issue.id);

        // Broadcast per-subtask completion
        broadcastIssueProgress({
          issueId: issue.id,
          identifier: issue.identifier,
          phase: "turn_completed",
          turn: 1,
          maxTurns: 1,
          role: `subtask:${subTask.id}`,
          provider: provider.provider,
          elapsedMs: Date.now() - subStartTs,
          directiveStatus: result.success ? "done" : "failed",
          directiveSummary: subTask.label,
        });

        addEvent(state, issue.id, "runner",
          `Sub-task "${subTask.label}" ${result.success ? "completed" : "failed"} (${Math.round((Date.now() - subStartTs) / 1000)}s).`);

        return { subTask, result };
      } catch (err) {
        subTask.status = "failed";
        subTask.result = String(err);
        subTask.completedAt = now();
        markIssueDirty(issue.id);
        addEvent(state, issue.id, "error", `Sub-task "${subTask.label}" crashed: ${String(err).slice(0, 200)}`);
        throw err;
      }
    }),
  );

  // Broadcast final state: all subtasks done
  broadcastSubTaskState(issue, "completed");

  // Merge successful sub-worktrees into main worktree via cherry-pick
  const successful = results
    .filter((r): r is PromiseFulfilledResult<{ subTask: ParallelSubTask; result: ReturnType<typeof runAgentSession> extends Promise<infer U> ? U : never }> => r.status === "fulfilled" && (r.value as { result: { success: boolean } }).result.success)
    .map((r) => (r as PromiseFulfilledResult<{ subTask: ParallelSubTask; result: { success: boolean } }>).value.subTask);

  for (const subTask of successful) {
    try {
      // Get the branch ref of the sub-worktree
      const subBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: subTask.worktreePath,
        timeout: 10_000,
        encoding: "utf8",
      }).trim();

      // Get commits in sub-worktree not in main
      const log = execSync(`git log --oneline HEAD..${subBranch}`, { cwd: mainWorktree, timeout: 10_000, encoding: "utf8" }).trim();
      if (log) {
        execSync(`git cherry-pick --allow-empty ${subBranch}`, { cwd: mainWorktree, timeout: 30_000 });
      }
    } catch (err) {
      logger.warn({ err, issueId: issue.id, subTaskId: subTask.id }, "[Parallel] Cherry-pick failed, sub-task changes may need manual merge");
      addEvent(state, issue.id, "warn", `Sub-task "${subTask.label}" merge conflict — changes may need manual review.`);
    }
  }

  const anyFailed = activeTasks.some((t) => t.status === "failed");
  return !anyFailed;
}
