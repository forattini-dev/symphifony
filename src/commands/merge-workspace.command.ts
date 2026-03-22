import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { IssueEntry, RuntimeState } from "../types.ts";
import type { IIssueRepository, IEventStore, IPersistencePort } from "../ports/index.ts";
import { transitionIssueCommand } from "./transition-issue.command.ts";
import { mergeWorkspace } from "../agents/agent.ts";
import { cleanWorkspace } from "../domains/workspace.ts";
import { TARGET_ROOT } from "../concerns/constants.ts";
import { logger } from "../concerns/logger.ts";
import { ensureGitRepoReadyForWorktrees, parseDiffStats } from "../domains/workspace.ts";
import { runValidationGate } from "../domains/validation.ts";

export type MergeWorkspaceInput = {
  issue: IssueEntry;
  state: RuntimeState;
};

export type MergeWorkspaceResult = {
  copied: string[];
  deleted: string[];
  skipped: string[];
  conflicts: string[];
};

export async function mergeWorkspaceCommand(
  input: MergeWorkspaceInput,
  deps: {
    issueRepository: IIssueRepository;
    eventStore: IEventStore;
    persistencePort: IPersistencePort;
  },
): Promise<MergeWorkspaceResult> {
  const { issue, state } = input;

  if (!["Approved", "Reviewing", "PendingDecision"].includes(issue.state)) {
    throw new Error(`Issue ${issue.identifier} is in state ${issue.state}. Merge is only allowed in Reviewing, PendingDecision, or Approved state.`);
  }

  ensureGitRepoReadyForWorktrees(TARGET_ROOT, "merge issues");

  // Auto-transition to Approved if still in review
  if (issue.state === "Reviewing" || issue.state === "PendingDecision") {
    await transitionIssueCommand(
      { issue, target: "Approved", note: "Approved and merged by user." },
      deps,
    );
  }

  const wp = issue.worktreePath ?? issue.workspacePath;
  if (!wp || !existsSync(wp)) {
    throw new Error(`No mergeable workspace found for ${issue.identifier}. This issue likely ran before git was initialized for the project. Re-run the issue after git setup.`);
  }

  // Compute diff stats BEFORE the git merge (branch still diverged from base)
  if (issue.branchName && issue.baseBranch) {
    try {
      const stat = execSync(
        `git diff --stat "${issue.baseBranch}"..."${issue.branchName}"`,
        { encoding: "utf8", cwd: TARGET_ROOT, stdio: "pipe", maxBuffer: 512_000, timeout: 10_000 },
      );
      parseDiffStats(issue, stat);
      logger.info({ issueId: issue.id, linesAdded: issue.linesAdded, linesRemoved: issue.linesRemoved, filesChanged: issue.filesChanged }, "[Merge] Diff stats computed");
    } catch (err) {
      logger.warn({ err: String(err), issueId: issue.id }, "[Merge] Failed to compute diff stats");
    }
  }

  // Clear residual squash from index
  try {
    const indexStatus = execSync("git diff --cached --name-only", { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe" }).trim();
    const wtStatus = execSync("git diff --name-only", { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe" }).trim();
    if (indexStatus && !wtStatus) {
      execSync("git reset --hard HEAD", { cwd: TARGET_ROOT, stdio: "pipe" });
      logger.info({ issueId: issue.id }, "[Command] Cleared residual squash from index before merge");
    }
  } catch { /* non-critical */ }

  // Run validation gate before merge
  const validation = await runValidationGate(issue, state.config);
  if (validation) {
    issue.validationResult = validation;
    if (!validation.passed) {
      throw new Error(`Validation gate failed (${validation.command}): ${validation.output.slice(0, 500)}`);
    }
  }

  // Perform the actual git merge
  const result = mergeWorkspace(issue);
  issue.mergeResult = {
    copied: result.copied.length,
    deleted: result.deleted.length,
    skipped: result.skipped.length,
    conflicts: result.conflicts.length,
    conflictFiles: result.conflicts.length > 0 ? result.conflicts : undefined,
  };

  if (result.conflicts.length > 0) {
    // Conflicts: do NOT transition to Merged — stay in Done
    deps.eventStore.addEvent(issue.id, "error", `Merge conflicts: ${result.conflicts.join(", ")}`);
    await deps.persistencePort.persistState(state);
    return result;
  }

  // Success: transition Done → Merged (FSM handles: completedAt, mergedAt, EC add(), event)
  if (!issue.mergedReason) issue.mergedReason = "Merged by user via PreviewModal.";
  await transitionIssueCommand(
    { issue, target: "Merged", note: `Workspace merged: ${result.copied.length} file(s) copied, ${result.deleted.length} deleted.` },
    deps,
  );

  // Cleanup worktree + branch after successful merge
  if (issue.workspacePath) {
    try {
      await cleanWorkspace(issue.id, issue, state);
      issue.workspacePath = undefined as any;
      issue.worktreePath = undefined as any;
    } catch { /* non-critical */ }
  }

  await deps.persistencePort.persistState(state);
  return result;
}
