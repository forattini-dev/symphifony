import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type {
  IssueEntry,
  RuntimeState,
  WorkflowConfig,
} from "./types.ts";
import { SOURCE_ROOT, TARGET_ROOT, WORKSPACE_ROOT } from "./constants.ts";
import { now, idToSafePath } from "./helpers.ts";
import { logger } from "./logger.ts";
import { markIssueDirty, markIssuePlanDirty } from "./dirty-tracker.ts";
import { getEffectiveAgentProviders } from "./providers.ts";
import { addEvent, transitionIssueState, computeMetrics, getNextRetryAt } from "./issues.ts";
import { compileReview, buildExecutionAudit, persistExecutionAudit } from "./adapters/index.ts";
import { generatePlan } from "./issue-planner.ts";
import { persistState } from "./store.ts";
import { addTokenUsage } from "./directive-parser.ts";
import { runAgentSession, runAgentPipeline } from "./agent-pipeline.ts";
import { computeDiffStats } from "./workspace-diff.ts";
import { ensureWorktreeCommitted, hydrateIssuePathsFromWorkspace, describeRoutingSignals } from "./workspace-merge.ts";
import { prepareWorkspace } from "./workspace-setup.ts";
import { inferCapabilityPaths } from "../routing/capability-resolver.ts";
import { getWorkflowConfig, loadRuntimeSettings } from "./settings.ts";

/**
 * Run a planning job for an issue in the Planning state within a worker slot.
 * Blocks until plan generation completes, writing versioned artifacts to the workspace.
 */
export async function runPlanningJob(
  state: RuntimeState,
  issue: IssueEntry,
): Promise<void> {
  issue.planningStatus = "planning";
  issue.planningStartedAt = now();
  issue.planningError = undefined;
  issue.updatedAt = now();
  markIssueDirty(issue.id);

  // Ensure workspace directory exists (no git worktree — planning only needs file storage)
  const safeId = idToSafePath(issue.id);
  const workspaceDir = join(WORKSPACE_ROOT, safeId);
  mkdirSync(workspaceDir, { recursive: true });

  addEvent(state, issue.id, "info", `Plan generation started for ${issue.identifier} (v${(issue.planVersion ?? 0) + 1}).`);

  try {
    const { plan, usage, prompt } = await generatePlan(
      issue.title,
      issue.description,
      state.config,
      null,
      { persistSession: false },
    );

    issue.plan = plan;
    markIssuePlanDirty(issue.id);
    issue.planVersion = Math.max((issue.planVersion ?? 0), 1);

    // Apply plan suggestions (paths, labels, effort)
    if (plan.suggestedPaths?.length && !(issue.paths?.length)) issue.paths = plan.suggestedPaths;
    if (plan.suggestedLabels?.length && !issue.labels?.length) issue.labels = plan.suggestedLabels;
    if (plan.suggestedEffort && !issue.effort) issue.effort = plan.suggestedEffort;

    // Apply token usage
    if (usage.totalTokens > 0) {
      addTokenUsage(issue, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        model: usage.model,
      }, "planner");
    }

    // Write versioned artifacts to workspace
    const pv = issue.planVersion;
    try {
      writeFileSync(join(workspaceDir, `plan.v${pv}.json`), JSON.stringify(plan, null, 2), "utf8");
      writeFileSync(join(workspaceDir, `plan.v${pv}.prompt.md`), prompt, "utf8");
    } catch (artifactErr) {
      logger.warn({ err: String(artifactErr) }, "[Agent] Failed to write versioned plan artifacts");
    }

    issue.planningStatus = "idle";
    issue.planningStartedAt = undefined;
    issue.updatedAt = now();
    markIssueDirty(issue.id);
    // Issue remains in Planning state — user must approve before execution
    addEvent(state, issue.id, "progress", `Plan v${pv} generated for ${issue.identifier}: ${plan.steps.length} steps, complexity: ${plan.estimatedComplexity}.`);
    if (usage.totalTokens > 0) {
      addEvent(state, issue.id, "info", `Plan tokens (${issue.identifier}): ${usage.totalTokens.toLocaleString()} [${usage.model}]`);
    }
  } catch (error) {
    issue.planningStatus = "idle";
    issue.planningStartedAt = undefined;
    issue.planningError = error instanceof Error ? error.message : String(error);
    issue.updatedAt = now();
    markIssueDirty(issue.id);
    addEvent(state, issue.id, "error", `Plan generation failed for ${issue.identifier}: ${issue.planningError}`);
    logger.error({ err: error }, `[Agent] Planning job failed for ${issue.identifier}`);
  }
}

async function handleReviewStage(
  state: RuntimeState,
  issue: IssueEntry,
  workspacePath: string,
  startTs: number,
  routedProviders: ReturnType<typeof getEffectiveAgentProviders>,
): Promise<void> {
  issue.reviewAttempt = (issue.reviewAttempt ?? 0) + 1;
  markIssueDirty(issue.id);

  const reviewer = routedProviders.find((p) => p.role === "reviewer");
  if (!reviewer) {
    // No reviewer configured → auto-approve
    issue.mergedReason = "Auto-approved: no reviewer configured.";
    await transitionIssueState(issue, "Done", `No reviewer configured; auto-approved for ${issue.identifier}.`);
    addEvent(state, issue.id, "runner", `Issue ${issue.identifier} auto-approved (no reviewer provider).`);
    issue.completedAt = now();
    issue.lastError = undefined;
    return;
  }

  addEvent(state, issue.id, "info", `Review provider: ${reviewer.role}:${reviewer.provider}${reviewer.model ? `/${reviewer.model}` : ""}${reviewer.profile ? `:${reviewer.profile}` : ""}.`);

  // Get diff summary for the review prompt
  let diffSummary = "";
  try {
    if (issue.baseBranch && issue.branchName) {
      const diffResult = execSync(
        `git diff --stat "${issue.baseBranch}"..."${issue.branchName}"`,
        { cwd: TARGET_ROOT, encoding: "utf8", maxBuffer: 512_000, timeout: 10_000 },
      );
      diffSummary = diffResult.trim();
    } else {
      const diffTarget = issue.worktreePath ?? workspacePath;
      const diffResult = execSync(
        `git diff --no-index --stat -- "${SOURCE_ROOT}" "${diffTarget}" 2>/dev/null`,
        { encoding: "utf8", maxBuffer: 512_000, timeout: 10_000 },
      );
      diffSummary = diffResult.trim();
    }
  } catch (err: any) {
    diffSummary = (err.stdout || "").trim();
  }

  const compiled = await compileReview(issue, reviewer, workspacePath, diffSummary);
  const effectiveReviewer = { ...reviewer, command: compiled.command || reviewer.command };
  const reviewPromptFile = join(workspacePath, "review-prompt.md");
  writeFileSync(reviewPromptFile, `${compiled.prompt}\n`, "utf8");
  const reviewResult = await runAgentSession(state, issue, effectiveReviewer, 1, workspacePath, compiled.prompt, reviewPromptFile);
  issue.durationMs = (issue.durationMs ?? 0) + (Date.now() - startTs);
  issue.commandExitCode = reviewResult.code;
  issue.commandOutputTail = reviewResult.output;
  const reviewAudit = buildExecutionAudit(effectiveReviewer, null, issue, Date.now() - startTs, reviewResult.success ? "approved" : reviewResult.continueRequested ? "rework" : "rejected");
  persistExecutionAudit(workspacePath, reviewAudit);
  try {
    const rpv = issue.planVersion ?? 1;
    const rra = issue.reviewAttempt ?? 1;
    const vReviewPromptSrc = join(workspacePath, "review-prompt.md");
    const vReviewAuditSrc = join(workspacePath, "execution-audit.json");
    if (existsSync(vReviewPromptSrc)) {
      writeFileSync(join(workspacePath, `review.v${rpv}a${rra}.prompt.md`), readFileSync(vReviewPromptSrc, "utf8"), "utf8");
    }
    if (existsSync(vReviewAuditSrc)) {
      writeFileSync(join(workspacePath, `review.v${rpv}a${rra}.audit.json`), readFileSync(vReviewAuditSrc, "utf8"), "utf8");
    }
  } catch (vErr) {
    logger.warn({ err: String(vErr) }, "[Agent] Failed to write versioned review artifacts");
  }

  if (reviewResult.success) {
    issue.mergedReason = `Auto-approved by reviewer in ${reviewResult.turns} turn(s).`;
    await transitionIssueState(issue, "Reviewed", `Reviewer completed for ${issue.identifier}.`);
    await transitionIssueState(issue, "Done", `Reviewer approved ${issue.identifier} in ${reviewResult.turns} turn(s).`);
    addEvent(state, issue.id, "runner", `Issue ${issue.identifier} approved by reviewer → Done.`);
    issue.completedAt = now();
    issue.lastError = undefined;
  } else if (reviewResult.continueRequested) {
    await transitionIssueState(issue, "Reviewed", `Reviewer completed for ${issue.identifier}.`);
    await transitionIssueState(issue, "Queued", `Reviewer requested rework for ${issue.identifier}.`);
    issue.nextRetryAt = new Date(Date.now() + 1000).toISOString();
    issue.lastError = undefined;
    addEvent(state, issue.id, "runner", `Issue ${issue.identifier} sent back for rework by reviewer.`);
  } else {
    // Reviewer blocked or failed
    issue.lastError = reviewResult.output;
    issue.attempts += 1;
    if (issue.attempts >= issue.maxAttempts) {
      issue.cancelledReason = `Max attempts reached (${issue.attempts}/${issue.maxAttempts}): reviewer failed or blocked.`;
      await transitionIssueState(issue, "Cancelled", `Review failed, max attempts reached for ${issue.identifier}.`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled after review failure.`);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await transitionIssueState(issue, "Blocked", `Review failed for ${issue.identifier}. Retry at ${issue.nextRetryAt}.`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked after review failure.`);
    }
  }
}

async function handleExecutionStage(
  state: RuntimeState,
  issue: IssueEntry,
  workspacePath: string,
  promptText: string,
  promptFile: string,
  workflowConfig: WorkflowConfig | null,
  workspaceDerivedPaths: string[],
  startTs: number,
  routedProviders: ReturnType<typeof getEffectiveAgentProviders>,
): Promise<void> {
  issue.executeAttempt = (issue.executeAttempt ?? 0) + 1;
  markIssueDirty(issue.id);

  addEvent(state, issue.id, "info",
    `Capability routing selected ${routedProviders.map((p) => `${p.role}:${p.provider}${p.model ? `/${p.model}` : ""}${p.profile ? `:${p.profile}` : ""}${p.reasoningEffort ? ` [${p.reasoningEffort}]` : ""}`).join(", ")}.`);

  const routingSignals = describeRoutingSignals(issue, workspaceDerivedPaths);
  if (routingSignals) {
    addEvent(state, issue.id, "info", `Capability routing signals: ${routingSignals}.`);
  }

  const runResult = await runAgentPipeline(state, issue, workspacePath, promptText, promptFile, workflowConfig);

  issue.durationMs = Date.now() - startTs;
  issue.commandExitCode = runResult.code;
  issue.commandOutputTail = runResult.output;

  if (runResult.success) {
    ensureWorktreeCommitted(issue);

    computeDiffStats(issue);
    if (issue.filesChanged) {
      addEvent(state, issue.id, "info", `Diff: ${issue.filesChanged} files, +${issue.linesAdded || 0} -${issue.linesRemoved || 0} lines.`);
    }

    addEvent(state, issue.id, "info", `Workspace prepared for review on branch ${issue.branchName ?? "workspace"}.`);

    const executor = routedProviders.find((p) => p.role === "executor") || routedProviders[0];
    if (executor && workspacePath) {
      const audit = buildExecutionAudit(executor, null, issue, Date.now() - startTs, "success");
      persistExecutionAudit(workspacePath, audit);

      try {
        const epv = issue.planVersion ?? 1;
        const eea = issue.executeAttempt ?? 1;
        const vExecPromptSrc = join(workspacePath, "prompt.md");
        const vExecAuditSrc = join(workspacePath, "execution-audit.json");
        if (existsSync(vExecPromptSrc)) {
          writeFileSync(join(workspacePath, `execute.v${epv}a${eea}.prompt.md`), readFileSync(vExecPromptSrc, "utf8"), "utf8");
        }
        if (existsSync(vExecAuditSrc)) {
          writeFileSync(join(workspacePath, `execute.v${epv}a${eea}.audit.json`), readFileSync(vExecAuditSrc, "utf8"), "utf8");
        }
      } catch (vErr) {
        logger.warn({ err: String(vErr) }, "[Agent] Failed to write versioned execute artifacts");
      }
    }

    await transitionIssueState(issue, "Reviewing", `Agent execution finished in ${runResult.turns} turn(s) for ${issue.identifier}. Awaiting review.`);
    issue.lastError = undefined;
    addEvent(state, issue.id, "runner", `Issue ${issue.identifier} moved to Reviewing.`);
  } else if (runResult.continueRequested) {
    issue.updatedAt = now();
    issue.commandExitCode = runResult.code;
    issue.commandOutputTail = runResult.output;
    issue.lastError = undefined;
    issue.nextRetryAt = new Date(Date.now() + 1000).toISOString();
    issue.history.push(`[${issue.updatedAt}] Agent requested another turn (${runResult.turns}/${state.config.maxTurns}).`);
    addEvent(state, issue.id, "runner", `Issue ${issue.identifier} queued for next turn.`);
  } else {
    issue.lastError = runResult.output;
    issue.attempts += 1;

    if (issue.attempts >= issue.maxAttempts) {
      issue.commandExitCode = runResult.code;
      issue.cancelledReason = `Max attempts reached (${issue.attempts}/${issue.maxAttempts}): execution failed repeatedly.`;
      await transitionIssueState(issue, "Cancelled", `Max attempts reached (${issue.attempts}/${issue.maxAttempts}).`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled after repeated failures.`);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await transitionIssueState(issue,
        "Blocked",
        `${runResult.blocked ? "Agent requested manual intervention" : "Failure"} on attempt ${issue.attempts}/${issue.maxAttempts}; retry scheduled at ${issue.nextRetryAt}.`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked waiting for retry.`);
    }
  }
}

export async function runIssueOnce(
  state: RuntimeState,
  issue: IssueEntry,
  running: Set<string>,
): Promise<void> {
  const startTs = Date.now();
  const isReviewing = issue.state === "Reviewing";
  const isResuming = issue.state === "Running";
  logger.info({ issueId: issue.id, identifier: issue.identifier, state: issue.state, isReviewing, isResuming, attempt: issue.attempts + 1, maxAttempts: issue.maxAttempts }, "[Agent] Starting issue execution");

  // Planning jobs run in the background without occupying a worker slot.
  // planningStatus="planning" (set immediately by runPlanningJob) acts as the dispatch guard
  // so canRunIssue returns false while planning is in progress, preventing double-dispatch.
  if (issue.state === "Planning") {
    issue.startedAt = issue.startedAt ?? now();
    runPlanningJob(state, issue)
      .catch((err) => logger.error({ err, issueId: issue.id, identifier: issue.identifier }, "[Agent] Unexpected error in background planning job"))
      .finally(() => {
        state.metrics = computeMetrics(state.issues);
        state.updatedAt = now();
        persistState(state).catch(() => {});
      });
    return;
  }

  running.add(issue.id);
  state.metrics.activeWorkers += 1;
  issue.startedAt = issue.startedAt ?? now();

  let workflowConfig: WorkflowConfig | null = null;
  try {
    const settings = await loadRuntimeSettings();
    workflowConfig = getWorkflowConfig(settings);
  } catch {
    // Fall through — use defaults
  }

  if (isReviewing) {
    issue.updatedAt = now();
    issue.history.push(`[${issue.updatedAt}] Review stage started for ${issue.identifier}.`);
    addEvent(state, issue.id, "progress", `Review started for ${issue.identifier}.`);
  } else if (isResuming) {
    await transitionIssueState(issue, "Running", `Resuming runner for ${issue.identifier}.`);
    addEvent(state, issue.id, "progress", `Runner resumed for ${issue.identifier}.`);
  } else {
    if (issue.state !== "Queued") {
      await transitionIssueState(issue, "Queued", `Issue ${issue.identifier} queued for execution.`);
    }
    await transitionIssueState(issue, "Running", `Agent started for ${issue.identifier}.`);
    addEvent(state, issue.id, "progress", `Runner started for ${issue.identifier}.`);
  }

  try {
    const workspaceDerivedPaths = hydrateIssuePathsFromWorkspace(issue);
    if ((issue.paths ?? []).length > 0) {
      issue.inferredPaths = [...new Set([...(issue.inferredPaths ?? []), ...inferCapabilityPaths({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        labels: issue.labels,
        paths: issue.paths,
      })])];
    }

    const { workspacePath, promptText, promptFile } = await prepareWorkspace(issue, state, state.config.defaultBranch);
    addEvent(state, issue.id, "info", `Workspace ready at ${workspacePath}.`);

    const routedProviders = getEffectiveAgentProviders(state, issue, null, workflowConfig);

    if (isReviewing) {
      await handleReviewStage(state, issue, workspacePath, startTs, routedProviders);
      return;
    }

    await handleExecutionStage(state, issue, workspacePath, promptText, promptFile, workflowConfig, workspaceDerivedPaths, startTs, routedProviders);
  } catch (error) {
    issue.attempts += 1;
    issue.lastError = String(error);

    if (issue.attempts >= issue.maxAttempts) {
      issue.cancelledReason = `Max attempts reached (${issue.attempts}/${issue.maxAttempts}): unexpected failure — ${issue.lastError?.slice(0, 120) ?? "unknown error"}.`;
      await transitionIssueState(issue, "Cancelled", `Issue failed unexpectedly: ${issue.lastError}`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled unexpectedly.`);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await transitionIssueState(issue, "Blocked", `Unexpected failure. Retry scheduled at ${issue.nextRetryAt}.`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked after unexpected failure.`);
    }
  } finally {
    const elapsedMs = Date.now() - startTs;
    logger.info({ issueId: issue.id, identifier: issue.identifier, finalState: issue.state, elapsedMs, attempts: issue.attempts }, "[Agent] Issue execution finished");
    issue.updatedAt = now();
    markIssueDirty(issue.id);
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers - 1, 0);
    running.delete(issue.id);
    state.metrics = computeMetrics(state.issues);
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers, 0);
    state.updatedAt = now();
    await persistState(state);
  }
}
