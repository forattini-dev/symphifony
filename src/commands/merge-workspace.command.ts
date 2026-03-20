import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { IssueEntry, RuntimeState } from "../types.ts";
import type { IIssueRepository, IEventStore, IPersistencePort } from "../ports/index.ts";
import { transitionIssueCommand } from "./transition-issue.command.ts";
import { mergeWorkspace } from "../agents/agent.ts";
import { cleanWorkspace } from "../domains/workspace.ts";
import { TARGET_ROOT } from "../concerns/constants.ts";
import { now } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { parseDiffStats, syncIssueDiffStatsToStore } from "../domains/workspace.ts";

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

  if (!["Done", "Reviewing", "Reviewed"].includes(issue.state)) {
    throw new Error(`Issue ${issue.identifier} is in state ${issue.state}. Merge is only allowed in Reviewing, Reviewed, or Done state.`);
  }

  // Auto-transition to Done if still in review
  if (issue.state === "Reviewing" || issue.state === "Reviewed") {
    await transitionIssueCommand(
      { issue, target: "Done", note: "Approved and merged by user." },
      deps,
    );
    deps.eventStore.addEvent(issue.id, "state", `${issue.identifier} approved — moved to Done before merge.`);
  }

  const wp = issue.worktreePath ?? issue.workspacePath;
  if (!wp || !existsSync(wp)) {
    throw new Error("No workspace found for this issue.");
  }

  // Compute line stats from git diff before merge
  if (issue.branchName && issue.baseBranch) {
    try {
      const stat = execSync(
        `git diff --shortstat "${issue.baseBranch}"..."${issue.branchName}"`,
        { encoding: "utf8", cwd: TARGET_ROOT, stdio: "pipe", timeout: 10_000 },
      );
      parseDiffStats(issue, stat);
      await syncIssueDiffStatsToStore(issue);
    } catch { /* non-critical */ }
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

  const result = mergeWorkspace(issue);
  issue.mergeResult = {
    copied: result.copied.length,
    deleted: result.deleted.length,
    skipped: result.skipped.length,
    conflicts: result.conflicts.length,
  };

  if (result.conflicts.length === 0) {
    issue.mergedAt = now();
    if (!issue.mergedReason) issue.mergedReason = "Merged by user via PreviewModal.";
    // Cleanup worktree + branch after successful merge
    if (issue.workspacePath) {
      try {
        await cleanWorkspace(issue.id, issue, state);
        issue.workspacePath = undefined as any;
        issue.worktreePath = undefined as any;
      } catch { /* non-critical */ }
    }
  }

  const conflictMsg = result.conflicts.length > 0
    ? ` ${result.conflicts.length} conflict(s): ${result.conflicts.join(", ")}.`
    : "";
  deps.eventStore.addEvent(issue.id, "merge", `Workspace merged: ${result.copied.length} file(s) copied, ${result.deleted.length} deleted.${conflictMsg}`);

  if (result.conflicts.length > 0) {
    deps.eventStore.addEvent(issue.id, "error", `Merge conflicts: ${result.conflicts.join(", ")}`);
  }

  await deps.persistencePort.persistState(state);

  return result;
}
