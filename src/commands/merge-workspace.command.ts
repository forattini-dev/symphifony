import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import type { IssueEntry, RuntimeState } from "../types.ts";
import type { IIssueRepository, IEventStore, IPersistencePort } from "../ports/index.ts";
import { transitionIssueCommand } from "./transition-issue.command.ts";
import { mergeWorkspace } from "../agents/agent.ts";
import { cleanWorkspace, rebaseWorktree } from "../domains/workspace.ts";
import { TARGET_ROOT } from "../concerns/constants.ts";
import { logger } from "../concerns/logger.ts";
import { ensureGitRepoReadyForWorktrees, parseDiffStats } from "../domains/workspace.ts";
import { runValidationGate } from "../domains/validation.ts";
import { now } from "../concerns/helpers.ts";
import { resolveConflictsWithAgent } from "../domains/merge-conflict-resolver.ts";
import { resolvePlanStageConfig } from "../agents/planning/planning-prompts.ts";

export type MergeWorkspaceInput = {
  issue: IssueEntry;
  state: RuntimeState;
  /** When true, a test squash is already applied to TARGET_ROOT — commit it instead of doing git merge --no-ff */
  squashAlreadyApplied?: boolean;
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
  const { issue, state, squashAlreadyApplied } = input;

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

  // Run validation gate before merge
  const validation = await runValidationGate(issue, state.config);
  if (validation) {
    issue.validationResult = validation;
    if (!validation.passed) {
      throw new Error(`Validation gate failed (${validation.command}): ${validation.output.slice(0, 500)}`);
    }
  }

  // ── Auto-rebase: bring issue branch up to date with base before merge ──
  // This resolves trivial conflicts caused by parallel issues that merged first.
  if (!squashAlreadyApplied && issue.worktreePath && issue.baseBranch) {
    try {
      const rebase = rebaseWorktree(issue);
      issue.rebaseResult = { success: rebase.success, conflictFiles: rebase.conflictFiles, rebasedAt: now() };
      deps.issueRepository.markDirty(issue.id);

      if (rebase.success) {
        deps.eventStore.addEvent(issue.id, "info", `Auto-rebase onto ${issue.baseBranch} succeeded — branch is up to date.`);
        logger.info({ issueId: issue.id, baseBranch: issue.baseBranch }, "[Merge] Auto-rebase succeeded");
      } else {
        const files = rebase.conflictFiles.join(", ");
        deps.eventStore.addEvent(issue.id, "error", `Auto-rebase onto ${issue.baseBranch} failed — ${rebase.conflictFiles.length} conflict(s): ${files}. Proceeding with direct merge attempt.`);
        logger.warn({ issueId: issue.id, conflictFiles: rebase.conflictFiles }, "[Merge] Auto-rebase failed, will attempt direct merge");
      }
    } catch (err) {
      logger.warn({ issueId: issue.id, err: String(err) }, "[Merge] Auto-rebase threw unexpectedly, skipping");
    }
  }

  let result: MergeWorkspaceResult;

  if (squashAlreadyApplied) {
    // Test squash already applied to TARGET_ROOT — commit it directly
    try {
      execSync("git add -A", { cwd: TARGET_ROOT, stdio: "pipe", timeout: 10_000 });
      execSync(
        `git commit -m "fifony: merge ${issue.identifier}"`,
        { cwd: TARGET_ROOT, stdio: "pipe", timeout: 10_000 },
      );
      logger.info({ issueId: issue.id }, "[Merge] Committed existing test squash");
    } catch (err: any) {
      throw new Error(`Failed to commit test squash: ${err.stderr || err.stdout || String(err)}`);
    }
    issue.testApplied = false;
    result = { copied: [], deleted: [], skipped: [], conflicts: [] };
  } else {
    // Clear residual squash from index (safety)
    try {
      const indexStatus = execSync("git diff --cached --name-only", { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe" }).trim();
      const wtStatus = execSync("git diff --name-only", { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe" }).trim();
      if (indexStatus && !wtStatus) {
        execSync("git reset --hard HEAD", { cwd: TARGET_ROOT, stdio: "pipe" });
        logger.info({ issueId: issue.id }, "[Command] Cleared residual squash from index before merge");
      }
    } catch { /* non-critical */ }

    // Standard git merge --no-ff (don't abort on conflict — agent may resolve)
    const mergeResult = mergeWorkspace(issue, /* abortOnConflict */ false);
    result = mergeResult;

    // ── Layer 2: Agent-based conflict resolution ──────────────────────────
    if (result.conflicts.length > 0) {
      deps.eventStore.addEvent(issue.id, "info", `Merge conflicts in ${result.conflicts.length} file(s): ${result.conflicts.join(", ")}. Attempting agent-based resolution...`);
      logger.info({ issueId: issue.id, conflicts: result.conflicts }, "[Merge] Conflicts detected — spawning agent to resolve");

      try {
        const { provider, model } = await resolvePlanStageConfig(state.config);
        const resolution = await resolveConflictsWithAgent({
          issue,
          conflictFiles: result.conflicts,
          provider,
          model,
          targetRoot: TARGET_ROOT,
        });

        if (resolution.resolved) {
          // Agent resolved all conflicts — complete the merge commit
          try {
            execSync("git add -A", { cwd: TARGET_ROOT, stdio: "pipe", timeout: 10_000 });
            execSync(
              `git commit --no-edit`,
              { cwd: TARGET_ROOT, stdio: "pipe", timeout: 10_000 },
            );
            result.conflicts = [];
            deps.eventStore.addEvent(issue.id, "info", `Agent (${resolution.provider}) resolved ${resolution.resolvedFiles.length} conflict(s) in ${Math.round(resolution.durationMs / 1000)}s.`);
            logger.info({ issueId: issue.id, provider: resolution.provider, durationMs: resolution.durationMs }, "[Merge] Agent resolved all conflicts — merge committed");
          } catch (commitErr) {
            // Commit failed even after resolution — abort
            try { execSync("git merge --abort", { cwd: TARGET_ROOT, stdio: "pipe" }); } catch {}
            deps.eventStore.addEvent(issue.id, "error", `Agent resolved conflicts but merge commit failed: ${String(commitErr)}`);
            logger.error({ issueId: issue.id, err: String(commitErr) }, "[Merge] Commit after conflict resolution failed");
          }
        } else {
          // Agent failed to resolve — abort the merge
          try { execSync("git merge --abort", { cwd: TARGET_ROOT, stdio: "pipe" }); } catch {}
          deps.eventStore.addEvent(issue.id, "error", `Agent-based conflict resolution failed (${resolution.provider}, ${Math.round(resolution.durationMs / 1000)}s). ${resolution.resolvedFiles.length}/${result.conflicts.length} files resolved.`);
          logger.warn({ issueId: issue.id, resolvedFiles: resolution.resolvedFiles, provider: resolution.provider }, "[Merge] Agent failed to resolve all conflicts");
        }

        // Store resolution info on the issue
        issue.mergeResult = {
          ...issue.mergeResult!,
          conflictResolution: {
            resolved: resolution.resolved,
            provider: resolution.provider,
            resolvedFiles: resolution.resolvedFiles,
            durationMs: resolution.durationMs,
            output: resolution.output.slice(-500),
            resolvedAt: resolution.resolvedAt,
          },
        };
      } catch (err) {
        // Resolution threw — abort merge and continue with normal conflict flow
        try { execSync("git merge --abort", { cwd: TARGET_ROOT, stdio: "pipe" }); } catch {}
        deps.eventStore.addEvent(issue.id, "error", `Agent conflict resolution threw: ${String(err)}`);
        logger.error({ issueId: issue.id, err: String(err) }, "[Merge] Conflict resolution threw unexpectedly");
      }
    }
  }

  issue.mergeResult = {
    copied: result.copied.length,
    deleted: result.deleted.length,
    skipped: result.skipped.length,
    conflicts: result.conflicts.length,
    conflictFiles: result.conflicts.length > 0 ? result.conflicts : undefined,
    ...(issue.mergeResult?.conflictResolution ? { conflictResolution: issue.mergeResult.conflictResolution } : {}),
  };

  if (result.conflicts.length > 0) {
    deps.eventStore.addEvent(issue.id, "error", `Merge aborted — ${result.conflicts.length} conflict(s) remain: ${result.conflicts.join(", ")}`);
    await deps.persistencePort.persistState(state);
    return result;
  }

  // Success: transition → Merged (FSM handles: completedAt, mergedAt, event)
  if (!issue.mergedReason) issue.mergedReason = squashAlreadyApplied ? "Approved and shipped after testing." : "Merged by user.";
  await transitionIssueCommand(
    { issue, target: "Merged", note: `Workspace merged for ${issue.identifier}.` },
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
