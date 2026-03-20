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
} from "../types.ts";
import { SOURCE_ROOT, TARGET_ROOT, WORKSPACE_ROOT } from "../concerns/constants.ts";
import { now, idToSafePath } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { markIssueDirty, markIssuePlanDirty } from "../persistence/dirty-tracker.ts";
import { getEffectiveAgentProviders } from "./providers.ts";
import { addEvent, computeMetrics, getNextRetryAt } from "../domains/issues.ts";
import { compileReview, buildExecutionAudit, persistExecutionAudit } from "./adapters/index.ts";
import { generatePlan } from "./planning/issue-planner.ts";
import { persistState } from "../persistence/store.ts";
import { addTokenUsage } from "./directive-parser.ts";
import { runAgentSession, runAgentPipeline } from "./agent-pipeline.ts";
import { computeDiffStats, syncIssueDiffStatsToStore } from "../domains/workspace.ts";
import { ensureWorktreeCommitted, hydrateIssuePathsFromWorkspace, describeRoutingSignals } from "../domains/workspace.ts";
import { prepareWorkspace } from "../domains/workspace.ts";
import { inferCapabilityPaths } from "../routing/capability-resolver.ts";
import { getWorkflowConfig, loadRuntimeSettings } from "../persistence/settings.ts";
import { getContainer } from "../persistence/container.ts";
import { transitionIssueCommand } from "../commands/transition-issue.command.ts";

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

  const container = getContainer();
  const reviewer = routedProviders.find((p) => p.role === "reviewer");
  if (!reviewer) {
    // No reviewer configured → auto-approve
    issue.mergedReason = "Auto-approved: no reviewer configured.";
    await transitionIssueCommand({ issue, target: "Done", note: `No reviewer configured; auto-approved for ${issue.identifier}.` }, container);
    // completedAt and lastError handled by FSM onEnterDone
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
    await transitionIssueCommand({ issue, target: "Reviewed", note: `Reviewer completed for ${issue.identifier}.` }, container);
    await transitionIssueCommand({ issue, target: "Done", note: `Reviewer approved ${issue.identifier} in ${reviewResult.turns} turn(s).` }, container);
    // completedAt and lastError are set by FSM onEnterDone
  } else if (reviewResult.continueRequested) {
    await transitionIssueCommand({ issue, target: "Reviewed", note: `Reviewer completed for ${issue.identifier}.` }, container);
    await transitionIssueCommand({ issue, target: "Queued", note: `Reviewer requested rework for ${issue.identifier}.` }, container);
    // nextRetryAt and lastError are cleared by FSM onEnterQueued
    container.eventStore.addEvent(issue.id, "runner", `Issue ${issue.identifier} sent back for rework by reviewer.`);
  } else {
    // Reviewer blocked or failed
    issue.lastError = reviewResult.output;
    issue.attempts += 1;
    if (issue.attempts >= issue.maxAttempts) {
      issue.cancelledReason = `Max attempts reached (${issue.attempts}/${issue.maxAttempts}): reviewer failed or blocked.`;
      await transitionIssueCommand({ issue, target: "Cancelled", note: `Review failed, max attempts reached for ${issue.identifier}.` }, container);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await transitionIssueCommand({ issue, target: "Blocked", note: `Review failed for ${issue.identifier}. Retry at ${issue.nextRetryAt}.` }, container);
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
  const container = getContainer();
  issue.executeAttempt = (issue.executeAttempt ?? 0) + 1;
  container.issueRepository.markDirty(issue.id);

  container.eventStore.addEvent(issue.id, "info",
    `Capability routing selected ${routedProviders.map((p) => `${p.role}:${p.provider}${p.model ? `/${p.model}` : ""}${p.profile ? `:${p.profile}` : ""}${p.reasoningEffort ? ` [${p.reasoningEffort}]` : ""}`).join(", ")}.`);

  const routingSignals = describeRoutingSignals(issue, workspaceDerivedPaths);
  if (routingSignals) {
    container.eventStore.addEvent(issue.id, "info", `Capability routing signals: ${routingSignals}.`);
  }

  const runResult = await runAgentPipeline(state, issue, workspacePath, promptText, promptFile, workflowConfig);

  issue.durationMs = Date.now() - startTs;
  issue.commandExitCode = runResult.code;
  issue.commandOutputTail = runResult.output;

  if (runResult.success) {
    ensureWorktreeCommitted(issue);

    computeDiffStats(issue);
    container.issueRepository.markDirty(issue.id);
    await syncIssueDiffStatsToStore(issue).catch(() => {});
    if (issue.filesChanged) {
      container.eventStore.addEvent(issue.id, "info", `Diff: ${issue.filesChanged} files, +${issue.linesAdded || 0} -${issue.linesRemoved || 0} lines.`);
    }

    container.eventStore.addEvent(issue.id, "info", `Workspace prepared for review on branch ${issue.branchName ?? "workspace"}.`);

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

    await transitionIssueCommand({ issue, target: "Reviewing", note: `Agent execution finished in ${runResult.turns} turn(s) for ${issue.identifier}. Awaiting review.` }, container);
  } else if (runResult.continueRequested) {
    issue.updatedAt = now();
    issue.commandExitCode = runResult.code;
    issue.commandOutputTail = runResult.output;
    issue.lastError = undefined;
    issue.nextRetryAt = new Date(Date.now() + 1000).toISOString();
    issue.history.push(`[${issue.updatedAt}] Agent requested another turn (${runResult.turns}/${state.config.maxTurns}).`);
    container.eventStore.addEvent(issue.id, "runner", `Issue ${issue.identifier} queued for next turn.`);
  } else {
    issue.lastError = runResult.output;
    issue.attempts += 1;

    if (issue.attempts >= issue.maxAttempts) {
      issue.commandExitCode = runResult.code;
      issue.cancelledReason = `Max attempts reached (${issue.attempts}/${issue.maxAttempts}): execution failed repeatedly.`;
      await transitionIssueCommand({ issue, target: "Cancelled", note: `Max attempts reached (${issue.attempts}/${issue.maxAttempts}).` }, container);
      // FSM onEnterCancelled emits the state event
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await transitionIssueCommand({ issue, target: "Blocked", note: `${runResult.blocked ? "Agent requested manual intervention" : "Failure"} on attempt ${issue.attempts}/${issue.maxAttempts}; retry scheduled at ${issue.nextRetryAt}.` }, container);
      // FSM onEnterBlocked emits the error event
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

  const container = getContainer();

  if (isReviewing) {
    issue.updatedAt = now();
    issue.history.push(`[${issue.updatedAt}] Review stage started for ${issue.identifier}.`);
    container.eventStore.addEvent(issue.id, "progress", `Review started for ${issue.identifier}.`);
  } else if (isResuming) {
    await transitionIssueCommand({ issue, target: "Running", note: `Resuming runner for ${issue.identifier}.` }, container);
    container.eventStore.addEvent(issue.id, "progress", `Runner resumed for ${issue.identifier}.`);
  } else {
    if (issue.state !== "Queued") {
      await transitionIssueCommand({ issue, target: "Queued", note: `Issue ${issue.identifier} queued for execution.` }, container);
    }
    await transitionIssueCommand({ issue, target: "Running", note: `Agent started for ${issue.identifier}.` }, container);
    container.eventStore.addEvent(issue.id, "progress", `Runner started for ${issue.identifier}.`);
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
    container.issueRepository.markDirty(issue.id);
    // Persist workspace fields via resource.patch so they survive restarts
    try {
      const { getIssueStateResource } = await import("../persistence/store.ts");
      const res = getIssueStateResource();
      if (res) {
        await (res as any).patch(issue.id, {
          branchName: issue.branchName,
          baseBranch: issue.baseBranch,
          workspacePath: issue.workspacePath,
          worktreePath: issue.worktreePath,
        });
      }
    } catch { /* non-critical */ }
    container.eventStore.addEvent(issue.id, "info", `Workspace ready at ${workspacePath}.`);

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
      await transitionIssueCommand({ issue, target: "Cancelled", note: `Issue failed unexpectedly: ${issue.lastError}` }, container);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await transitionIssueCommand({ issue, target: "Blocked", note: `Unexpected failure. Retry scheduled at ${issue.nextRetryAt}.` }, container);
    }
  } finally {
    const elapsedMs = Date.now() - startTs;
    logger.info({ issueId: issue.id, identifier: issue.identifier, finalState: issue.state, elapsedMs, attempts: issue.attempts }, "[Agent] Issue execution finished");
    issue.updatedAt = now();
    container.issueRepository.markDirty(issue.id);
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers - 1, 0);
    running.delete(issue.id);
    state.metrics = computeMetrics(state.issues);
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers, 0);
    state.updatedAt = now();
    await container.persistencePort.persistState(state);
  }
}
