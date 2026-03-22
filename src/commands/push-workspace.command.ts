import { execFileSync, execSync } from "node:child_process";
import type { IssueEntry, RuntimeState } from "../types.ts";
import type { IIssueRepository, IEventStore, IPersistencePort } from "../ports/index.ts";
import { transitionIssueCommand } from "./transition-issue.command.ts";
import {
  assertIssueHasGitWorktree,
  computeDiffStats,
  ensureGitRepoReadyForWorktrees,
  ensureWorktreeCommitted,
} from "../domains/workspace.ts";
import { runValidationGate } from "../domains/validation.ts";
import { TARGET_ROOT } from "../concerns/constants.ts";
import { logger } from "../concerns/logger.ts";

export type PushWorkspaceInput = {
  issue: IssueEntry;
  state: RuntimeState;
};

export type PushWorkspaceResult = {
  prUrl: string;
  ghAvailable: boolean;
};

/** Check if the `gh` CLI is available in PATH. */
export function isGhAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Get the remote compare URL as fallback when `gh` is not available. */
export function getCompareUrl(branchName: string, baseBranch: string): string {
  try {
    const remote = execSync("git remote get-url origin", { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe" }).trim();
    const cleanRemote = remote.replace(/\.git$/, "");
    return `${cleanRemote}/compare/${baseBranch}...${branchName}`;
  } catch {
    return `(branch pushed: ${branchName})`;
  }
}

/** Try to find an existing open PR for the given branch. Returns URL or null. */
export function findExistingPr(branchName: string): string | null {
  try {
    const result = execFileSync(
      "gh", ["pr", "view", branchName, "--json", "url,state", "--jq", 'select(.state == "OPEN") | .url'],
      { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe", timeout: 15_000 },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

/** Create a new PR via `gh`. Returns URL or throws on failure. */
export function createPr(branchName: string, baseBranch: string, title: string, body: string): string {
  // execFileSync with array args — no shell injection possible
  return execFileSync(
    "gh", ["pr", "create", "--head", branchName, "--base", baseBranch, "--title", title, "--body", body],
    { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe", timeout: 30_000 },
  ).trim();
}

export async function pushWorkspaceCommand(
  input: PushWorkspaceInput,
  deps: {
    issueRepository: IIssueRepository;
    eventStore: IEventStore;
    persistencePort: IPersistencePort;
  },
): Promise<PushWorkspaceResult> {
  const { issue, state } = input;

  if (!["Approved", "Reviewing", "PendingDecision"].includes(issue.state)) {
    throw new Error(`Issue ${issue.identifier} is in state ${issue.state}. Push is only allowed in Reviewing, PendingDecision, or Approved state.`);
  }

  ensureGitRepoReadyForWorktrees(TARGET_ROOT, "push issue branches");
  assertIssueHasGitWorktree(issue, "push");

  // Auto-transition to Approved if still in review
  if (issue.state === "Reviewing" || issue.state === "PendingDecision") {
    await transitionIssueCommand(
      { issue, target: "Approved", note: "Approved and pushed by user." },
      deps,
    );
  }

  ensureWorktreeCommitted(issue);

  // Run validation gate before push (async — does not block event loop)
  const validation = await runValidationGate(issue, state.config);
  if (validation) {
    issue.validationResult = validation;
    if (!validation.passed) {
      throw new Error(`Validation gate failed (${validation.command}): ${validation.output.slice(0, 500)}`);
    }
  }

  computeDiffStats(issue);

  // Build PR body (safe — not interpolated into shell commands)
  const planSummary = issue.plan?.summary ?? issue.title;
  let diffStat = "";
  try {
    diffStat = execSync(
      `git diff --stat "${issue.baseBranch}"..."${issue.branchName}"`,
      { cwd: TARGET_ROOT, encoding: "utf8", maxBuffer: 512_000, timeout: 10_000, stdio: "pipe" },
    ).trim();
  } catch {}
  const body = `## Summary\n${planSummary}\n\n## Diff Stats\n\`\`\`\n${diffStat || "No diff stats available"}\n\`\`\`\n\n*Automated by fifony*`;

  // Push branch (branchName is "fifony/{uuid}" — safe for shell)
  execSync(`git push -u origin "${issue.branchName}"`, { cwd: TARGET_ROOT, stdio: "pipe" });

  const prBase = state.config.prBaseBranch || issue.baseBranch;
  const ghAvailable = isGhAvailable();
  let prUrl: string;

  if (!ghAvailable) {
    // gh CLI not installed — provide compare URL, not an error
    prUrl = getCompareUrl(issue.branchName, prBase);
    logger.info({ issueId: issue.id, prUrl }, "[Push] gh CLI not available — using compare URL");
  } else {
    // Check for existing open PR first
    const existingUrl = findExistingPr(issue.branchName);
    if (existingUrl) {
      prUrl = existingUrl;
      logger.info({ issueId: issue.id, prUrl }, "[Push] Existing open PR found");
    } else {
      // Create new PR — execFileSync with args array, no shell injection
      try {
        prUrl = createPr(issue.branchName, prBase, issue.title, body);
        logger.info({ issueId: issue.id, prUrl }, "[Push] PR created");
      } catch (err: any) {
        // gh IS installed but PR creation failed — surface the real error
        const ghError = (err.stderr || err.stdout || String(err)).toString().slice(0, 500);
        logger.error({ issueId: issue.id, ghError }, "[Push] gh pr create failed");
        // Still fallback to compare URL so the push is not wasted
        prUrl = getCompareUrl(issue.branchName, prBase);
        deps.eventStore.addEvent(issue.id, "error", `gh pr create failed: ${ghError}. Branch was pushed — use the compare URL to create the PR manually.`);
      }
    }
  }

  issue.prUrl = prUrl;

  // Transition Done → Merged
  if (!issue.mergedReason) issue.mergedReason = "Pushed to origin and PR created.";
  await transitionIssueCommand(
    { issue, target: "Merged", note: `Branch ${issue.branchName} pushed. PR: ${prUrl}` },
    deps,
  );

  deps.eventStore.addEvent(issue.id, "merge", `PR created: ${prUrl}`);
  await deps.persistencePort.persistState(state);

  return { prUrl, ghAvailable };
}
