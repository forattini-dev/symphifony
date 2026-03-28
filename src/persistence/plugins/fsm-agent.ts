import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type {
  AcceptanceCriterion,
  AgentProviderDefinition,
  AgentSessionResult,
  GradingCriterion,
  IssueEntry,
  GradingReport,
  HarnessMode,
  ReviewProfile,
  ReviewRun,
  ReviewScope,
  RuntimeState,
  WorkflowConfig,
} from "../../types.ts";
import { SOURCE_ROOT, STATE_ROOT, TARGET_ROOT, TERMINAL_STATES, WORKSPACE_ROOT, DEFAULT_MAX_REVIEW_AUTO_RETRIES, DEFAULT_MAX_TURNS, DEFAULT_MAX_TURNS_BY_MODE, DEFAULT_AUTO_REPLAN_STALL_THRESHOLD, DEFAULT_MAX_CONTEXT_RESETS } from "../../concerns/constants.ts";
import { now, idToSafePath } from "../../concerns/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { markIssueDirty } from "../dirty-tracker.ts";
import { getExecutionProviders, getReviewProvider } from "../../agents/providers.ts";
import {
  applyCheckpointPolicyToPlan,
  applyHarnessModeToPlan,
  recommendCheckpointPolicyForIssue,
  recommendHarnessModeForIssue,
} from "../../agents/harness-policy.ts";
import { addEvent, computeMetrics, getNextRetryAt } from "../../domains/issues.ts";
import { compileReview, buildExecutionAudit, persistExecutionAudit } from "../../agents/adapters/index.ts";
import { generatePlan } from "../../agents/planning/issue-planner.ts";
import { addTokenUsage, extractJsonEnvelopeResult } from "../../agents/directive-parser.ts";
import { runAgentSession, runAgentPipeline } from "../../agents/agent-pipeline.ts";
import { computeDiffStats } from "../../domains/workspace.ts";
import { runValidationGate } from "../../domains/validation.ts";
import { ensureWorktreeCommitted, hydrateIssuePathsFromWorkspace } from "../../domains/workspace.ts";
import { prepareWorkspace } from "../../domains/workspace.ts";
import { getWorkflowConfig, loadRuntimeSettings } from "../settings.ts";
import { getContainer } from "../container.ts";
import { transitionIssueCommand } from "../../commands/transition-issue.command.ts";
import { requestReworkCommand } from "../../commands/request-rework.command.ts";
import {
  approveIssueAfterReviewCommand,
  blockIssueForRetryCommand,
  cancelIssueFromAgentCommand,
  sendIssueToManualDecisionCommand,
  startIssueReviewCommand,
} from "../../commands/agent-issue-outcomes.command.ts";
import { extractFailureInsights } from "../../agents/failure-analyzer.ts";
import { readAgentPid, isProcessAlive } from "../../agents/pid-manager.ts";
import {
  findRecurringBlockingFailures,
  recordReviewFailures,
} from "../../agents/review-failure-history.ts";
import { needsContractNegotiationWork } from "../../domains/contract-negotiation.ts";
import { runContractNegotiation } from "../../agents/contract-negotiation.ts";
import { recordPolicyDecision } from "../../domains/policy-decisions.ts";
import { recordWorkspaceMemoryEvent } from "../../agents/memory-engine.ts";
import {
  attachNodeArtifacts,
  BLUEPRINT_EXECUTION_NODE_IDS,
  buildBlueprintBrief,
  buildHarnessBlueprint,
  finalizeBlueprintRun,
  startBlueprintRun,
  updateBlueprintNodeRun,
  writeBlueprintArtifact,
  writeBlueprintJsonArtifact,
} from "../../agents/blueprints.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Which phase of work an agent is running. */
export type AgentPhase = "plan" | "execute" | "review";

/** Semantic operation type — more granular than phase. */
export type AgentOperation =
  | "plan" | "replan"
  | "execute" | "retry"
  | "review" | "re-review"
  | "enhance" | "merge-fix";

/** Lifecycle state of an agent process (independent of issue FSM state). */
export type AgentState =
  | "idle" | "preparing" | "running"
  | "paused" | "crashed" | "done" | "failed";

/** Persisted job file written to STATE_ROOT/agent-{safeId}.job.json while a phase is active. */
export type AgentJobState = {
  issueId: string;
  identifier: string;
  operation: AgentOperation;
  state: AgentState;
  startedAt: string;
  updatedAt: string;
  workspacePath: string;
  logFile: string;
  turn: number;
  maxTurns: number;
  provider: string;
  role: string;
  crashCount: number;
  lastCrashAt?: string;
};

/** Emitted on every agent state transition (watcher + phase start/end). */
export type AgentTransition = {
  issueId: string;
  identifier: string;
  operation: AgentOperation;
  from: AgentState | "none";
  to: AgentState;
  pid: number | null;
  reason: string;
  at: string;
};

/** Derived status for a single agent — merges job file + live PID check. */
export type AgentStatus = {
  issueId: string;
  identifier: string;
  operation: AgentOperation | null;
  state: AgentState;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  logFile: string | null;
  turn: number;
  crashCount: number;
};

// ── Watcher constant ──────────────────────────────────────────────────────────
export const AGENT_WATCHER_INTERVAL_MS = 5_000;

// ── File helpers ──────────────────────────────────────────────────────────────

function jobStatePath(fifonyDir: string, issueId: string): string {
  return join(fifonyDir, `agent-${idToSafePath(issueId)}.job.json`);
}

/** Path to the live output log written by command-executor inside a workspace. */
export function agentLogPath(workspacePath: string): string {
  return join(workspacePath, "live-output.log");
}

function readJobState(fifonyDir: string, issueId: string): AgentJobState | null {
  const path = jobStatePath(fifonyDir, issueId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AgentJobState;
  } catch {
    return null;
  }
}

function writeJobState(fifonyDir: string, job: AgentJobState): void {
  writeFileSync(jobStatePath(fifonyDir, job.issueId), JSON.stringify(job));
}

/** Remove the job state file for a completed/cleaned agent. */
export function cleanAgentJobState(fifonyDir: string, issueId: string): void {
  try { rmSync(jobStatePath(fifonyDir, issueId), { force: true }); } catch {}
}

// ── Operation derivation ──────────────────────────────────────────────────────

/**
 * Derive the semantic AgentOperation from an issue's current state and counters.
 * Used to annotate job state files and watcher transitions.
 */
export function deriveAgentOperation(issue: IssueEntry): AgentOperation {
  const pv = issue.planVersion ?? 0;
  const ev = issue.executeAttempt ?? 0;
  const rv = issue.reviewAttempt ?? 0;
  const lp = issue.lastFailedPhase;

  if (issue.state === "Planning") return pv > 1 ? "replan" : "plan";
  if (issue.state === "Reviewing") return rv > 1 ? "re-review" : "review";
  // Execute variants
  if (lp === "review") return "re-review"; // rework after reviewer feedback
  if (issue.attempts > 0 && ev > 1) return "retry";
  return "execute";
}

// ── Status read ───────────────────────────────────────────────────────────────

/**
 * Derive the current AgentStatus for an issue by reading its job file and
 * checking whether the recorded PID is still alive.
 */
export function getAgentStatus(
  fifonyDir: string,
  issueId: string,
  identifier: string,
): AgentStatus {
  const job = readJobState(fifonyDir, issueId);

  if (!job) {
    return {
      issueId, identifier,
      operation: null, state: "idle",
      running: false, pid: null,
      startedAt: null, logFile: null,
      turn: 0, crashCount: 0,
    };
  }

  let pid: number | null = null;
  let actualState = job.state;

  if (job.state === "running" || job.state === "preparing") {
    if (job.workspacePath && existsSync(job.workspacePath)) {
      const pidInfo = readAgentPid(job.workspacePath);
      if (pidInfo && isProcessAlive(pidInfo.pid)) {
        pid = pidInfo.pid;
      } else if (pidInfo) {
        actualState = "crashed"; // PID file exists but process is gone
      }
    }
  }

  return {
    issueId, identifier,
    operation: job.operation,
    state: actualState,
    running: actualState === "running" || actualState === "preparing",
    pid,
    startedAt: job.startedAt,
    logFile: job.logFile,
    turn: job.turn,
    crashCount: job.crashCount,
  };
}

// ── Dispatch guard ────────────────────────────────────────────────────────────

/**
 * Returns true if the issue is eligible to be dispatched for the given phase.
 * Called synchronously by the queue drain loop — must not perform any I/O.
 */
export function canDispatchAgent(
  issue: IssueEntry,
  phase: AgentPhase,
  running: ReadonlySet<string>,
  issues: IssueEntry[],
): boolean {
  if (!issue.assignedToWorker) return false;
  if (TERMINAL_STATES.has(issue.state)) return false;
  if (running.has(issue.id)) return false;

  // Dependency check
  if (issue.blockedBy.length > 0) {
    const map = new Map(issues.map((i) => [i.id, i]));
    const depsResolved = issue.blockedBy.every((depId) => {
      const dep = map.get(depId);
      return dep?.state === "Approved" || dep?.state === "Merged";
    });
    if (!depsResolved) {
      logger.debug({ issueId: issue.id, blockedBy: issue.blockedBy }, "[AgentFSM] Skipping — unresolved deps");
      return false;
    }
  }

  if (phase === "plan") {
    if (issue.state !== "Planning") return false;
    if (issue.planningStatus === "planning") return false;
    if (issue.plan) return needsContractNegotiationWork(issue);
  }

  if (phase === "execute") {
    if (issue.state !== "Queued" && issue.state !== "Running") return false;
  }

  if (phase === "review") {
    if (issue.state !== "Reviewing") return false;
  }

  return true;
}

// ── Replan failure context builder ────────────────────────────────────────────

/**
 * Builds a structured failure context string from previous execution and review failures.
 * Injected into the planning prompt when replanning so the planner knows what went wrong
 * and can produce a fundamentally different approach instead of regenerating the same plan.
 */
function buildReplanFailureContext(issue: IssueEntry): string | null {
  const currentPlanVersion = issue.planVersion ?? 0;
  if (currentPlanVersion < 1) return null; // first plan — no history to inject

  const prevPlanVersion = currentPlanVersion - 1;
  const parts: string[] = [];

  // Execution failures from the previous plan version
  const execFailures = (issue.previousAttemptSummaries ?? [])
    .filter((s) => s.planVersion === prevPlanVersion);

  if (execFailures.length > 0) {
    parts.push("### Execution failures from the previous plan:");
    for (const summary of execFailures.slice(-3)) {
      const insight = summary.insight;
      if (insight && insight.errorType !== "unknown") {
        parts.push(`- Attempt ${summary.executeAttempt}: \`${insight.errorType}\` — ${insight.rootCause}`);
        if (insight.filesInvolved.length > 0) {
          parts.push(`  Files involved: ${insight.filesInvolved.slice(0, 3).join(", ")}`);
        }
        parts.push(`  Suggestion: ${insight.suggestion}`);
      } else {
        parts.push(`- Attempt ${summary.executeAttempt}: ${(summary.error ?? "").slice(0, 200)}`);
      }
    }

    // Highlight stall pattern if the last two failures share an error type
    const lastTypes = execFailures.slice(-2).map((s) => s.insight?.errorType).filter((t): t is string => !!t && t !== "unknown");
    if (lastTypes.length >= 2 && lastTypes[0] === lastTypes[1]) {
      parts.push(`\n**Stall pattern**: \`${lastTypes[0]}\` errors repeated across multiple attempts. The previous approach was fundamentally broken for this problem. Produce a plan that avoids this class of error entirely.`);
    }
  }

  // Blocking review failures from the previous plan version
  const reviewFailures = (issue.reviewFailureHistory ?? [])
    .filter((r) => r.planVersion === prevPlanVersion && r.blocking);

  if (reviewFailures.length > 0) {
    const uniqueByCriterion = new Map<string, typeof reviewFailures[0]>();
    for (const record of reviewFailures) {
      if (!uniqueByCriterion.has(record.criterionId)) {
        uniqueByCriterion.set(record.criterionId, record);
      }
    }
    parts.push("\n### Blocking review failures from the previous plan:");
    for (const record of uniqueByCriterion.values()) {
      parts.push(`- **${record.criterionId}** [${record.category}]: ${record.description}`);
      parts.push(`  Reviewer evidence: ${record.evidence.slice(0, 300)}`);
    }
    parts.push("\nThe new plan MUST include steps that directly address each of the above blocking failures.");
  }

  if (parts.length === 0) return null;

  return [
    `## Replan Context (Plan v${prevPlanVersion} failed → now planning v${currentPlanVersion})`,
    "",
    "This is not the first plan for this issue. Previous attempts failed.",
    "**You MUST produce a fundamentally different approach.** Do not reproduce the same steps or implementation strategy that led to the failures below.",
    "",
    ...parts,
  ].join("\n");
}

// ── Plan phase ────────────────────────────────────────────────────────────────

/**
 * Run a planning job for an issue in the Planning state.
 * Blocks until plan generation completes, writing versioned artifacts to the workspace.
 * Issue stays in Planning state — the user must approve before execution.
 */
export async function runPlanPhase(
  state: RuntimeState,
  issue: IssueEntry,
  fifonyDir = STATE_ROOT,
  onTransition?: (t: AgentTransition) => void,
): Promise<void> {
  const _op = deriveAgentOperation(issue);
  const safeId = idToSafePath(issue.id);
  const workspaceDir = join(WORKSPACE_ROOT, safeId);
  const _job: AgentJobState = {
    issueId: issue.id, identifier: issue.identifier,
    operation: _op, state: "preparing",
    startedAt: now(), updatedAt: now(),
    workspacePath: workspaceDir, logFile: agentLogPath(workspaceDir),
    turn: 0, maxTurns: 1,
    provider: state.config.agentProvider ?? "unknown", role: "planner",
    crashCount: 0,
  };
  writeJobState(fifonyDir, _job);
  onTransition?.({ issueId: issue.id, identifier: issue.identifier, operation: _op, from: "none", to: "preparing", pid: null, reason: "plan phase starting", at: now() });

  issue.planningStatus = "planning";
  issue.planningStartedAt = now();
  issue.planningError = undefined;
  issue.updatedAt = now();
  markIssueDirty(issue.id);
  // Immediately push state so the frontend shows the planning indicator right away.
  import("../store.ts").then(({ persistState }) => persistState(state).catch(() => {})).catch(() => {});

  // Ensure workspace directory exists (no git worktree — planning only needs file storage)
  mkdirSync(workspaceDir, { recursive: true });

  const revalidatingExistingPlan = !!issue.plan?.steps?.length;
  addEvent(
    state,
    issue.id,
    "info",
    revalidatingExistingPlan
      ? `Plan readiness check started for ${issue.identifier} (v${issue.planVersion ?? 1}).`
      : `Plan generation started for ${issue.identifier} (v${(issue.planVersion ?? 0) + 1}).`,
  );

  try {
    if (issue.plan?.steps?.length) {
      const workflowConfig = getWorkflowConfig(await loadRuntimeSettings());
      const negotiation = await runContractNegotiation(state, issue, workflowConfig, workspaceDir);
      issue.planningStatus = "idle";
      issue.planningStartedAt = undefined;
      issue.updatedAt = now();
      markIssueDirty(issue.id);
      if (negotiation.approved) {
        addEvent(state, issue.id, "progress", `Existing plan v${issue.planVersion ?? 1} revalidated for ${issue.identifier}.`);
      }
      return;
    }

    const failureContext = buildReplanFailureContext(issue) ?? undefined;
    if (failureContext) {
      addEvent(state, issue.id, "info", `Injecting replan failure context into plan prompt (v${issue.planVersion ?? 1}).`);
    }
    const { plan, usage, prompt } = await generatePlan(
      issue.title,
      issue.description,
      state.config,
      null,
      { persistSession: false, failureContext },
    );

    const plannedIssue: IssueEntry = {
      ...issue,
      plan,
      reviewProfile: undefined,
    };
    const harnessRecommendation = state.config.adaptiveHarnessSelection === false
      ? null
      : recommendHarnessModeForIssue(
        state.issues.filter((entry) => entry.id !== issue.id),
        plannedIssue,
        plan.harnessMode,
        state.config.adaptivePolicyMinSamples ?? 3,
      );
    if (harnessRecommendation && harnessRecommendation.mode !== plan.harnessMode) {
      const previousMode = plan.harnessMode;
      applyHarnessModeToPlan(plan, harnessRecommendation.mode);
      recordPolicyDecision(issue, {
        id: `policy.plan.v${Math.max((issue.planVersion ?? 0) + 1, 1)}.harness-mode`,
        kind: "harness-mode",
        scope: "planning",
        planVersion: Math.max((issue.planVersion ?? 0) + 1, 1),
        basis: harnessRecommendation.basis,
        from: previousMode,
        to: plan.harnessMode,
        rationale: harnessRecommendation.rationale,
        recordedAt: now(),
        profile: harnessRecommendation.profile.primary,
      });
      addEvent(
        state,
        issue.id,
        "info",
        `Adaptive harness policy changed ${issue.identifier} from ${previousMode} to ${plan.harnessMode}: ${harnessRecommendation.rationale}`,
      );
    }

    const checkpointRecommendation = state.config.adaptiveHarnessSelection === false
      ? null
      : recommendCheckpointPolicyForIssue(
        state.issues.filter((entry) => entry.id !== issue.id),
        plannedIssue,
        plan.executionContract.checkpointPolicy,
        state.config.adaptivePolicyMinSamples ?? 3,
      );
    if (checkpointRecommendation && checkpointRecommendation.checkpointPolicy !== plan.executionContract.checkpointPolicy) {
      const previousCheckpointPolicy = plan.executionContract.checkpointPolicy;
      applyCheckpointPolicyToPlan(plan, checkpointRecommendation.checkpointPolicy);
      recordPolicyDecision(issue, {
        id: `policy.plan.v${Math.max((issue.planVersion ?? 0) + 1, 1)}.checkpoint-policy`,
        kind: "checkpoint-policy",
        scope: "planning",
        planVersion: Math.max((issue.planVersion ?? 0) + 1, 1),
        basis: checkpointRecommendation.basis,
        from: previousCheckpointPolicy,
        to: plan.executionContract.checkpointPolicy,
        rationale: checkpointRecommendation.rationale,
        recordedAt: now(),
        profile: checkpointRecommendation.profile.primary,
      });
      addEvent(
        state,
        issue.id,
        "info",
        `Adaptive checkpoint policy changed ${issue.identifier} from ${previousCheckpointPolicy} to ${plan.executionContract.checkpointPolicy}: ${checkpointRecommendation.rationale}`,
      );
    }

    issue.plan = plan;
    issue.planVersion = Math.max((issue.planVersion ?? 0), 1);

    // Save plan to issue_plans resource (1:N model — marks previous plans as not current)
    try {
      const { savePlanForIssue } = await import("../store.ts");
      await savePlanForIssue(issue.id, plan, issue.planVersion);
      logger.debug({ issueId: issue.id, planVersion: issue.planVersion }, "[AgentFSM] Plan saved to issue_plans resource");
    } catch (err) {
      logger.warn({ err: String(err), issueId: issue.id }, "[AgentFSM] Failed to save plan");
    }

    // Apply plan suggestions (paths, effort)
    if (plan.suggestedPaths?.length && !(issue.paths?.length)) issue.paths = plan.suggestedPaths;
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
      logger.warn({ err: String(artifactErr) }, "[AgentFSM] Failed to write versioned plan artifacts");
    }

    const workflowConfig = getWorkflowConfig(await loadRuntimeSettings());
    await runContractNegotiation(state, issue, workflowConfig, workspaceDir);

    // Contract negotiation is a quality check — its failure does not block the plan.
    // Clear any planningError it may have set so the user sees a clean PendingApproval.
    issue.planningError = undefined;
    issue.planningStatus = "idle";
    issue.planningStartedAt = undefined;
    issue.updatedAt = now();
    markIssueDirty(issue.id);
    addEvent(state, issue.id, "progress", `Plan v${pv} generated for ${issue.identifier}: ${plan.steps.length} steps, complexity: ${plan.estimatedComplexity}.`);
    if (usage.totalTokens > 0) {
      addEvent(state, issue.id, "info", `Plan tokens (${issue.identifier}): ${usage.totalTokens.toLocaleString()} [${usage.model}]`);
    }

    // Guard: if this plan job's issue reference is stale (user deleted + re-created
    // the issue while this job was running), skip the FSM transition entirely.
    // A stale job holds a reference to the OLD object (no longer in state.issues),
    // so transitioning it would corrupt the new issue's state in the DB while the
    // in-memory new issue stays stuck in Planning.
    const liveIssue = state.issues.find((i) => i.id === issue.id);
    if (liveIssue !== issue) {
      logger.warn({ issueId: issue.id, identifier: issue.identifier }, "[AgentFSM] Plan job completed for stale issue reference — skipping PLANNED transition");
    } else {
      // Transition Planning → PendingApproval. Without this, the issue stays
      // in Planning state indefinitely — the PLANNED event was never fired.
      try {
        const { transitionIssue } = await import("../../domains/issues.ts");
        await transitionIssue(issue, "PLANNED", { issue });
        // executeTransition already calls triggerImmediatePersist() after the transition,
        // so the frontend sees PendingApproval without waiting for the 5s persist interval.
      } catch (transErr) {
        logger.warn({ err: transErr, issueId: issue.id }, "[AgentFSM] PLANNED transition failed after plan generation");
      }
    }
  } catch (error) {
    issue.planningStatus = "idle";
    issue.planningStartedAt = undefined;
    issue.planningError = error instanceof Error ? error.message : String(error);
    issue.updatedAt = now();
    markIssueDirty(issue.id);
    addEvent(state, issue.id, "error", `Plan generation failed for ${issue.identifier}: ${issue.planningError}`);
    logger.error({ err: error }, `[AgentFSM] Planning job failed for ${issue.identifier}`);
  } finally {
    cleanAgentJobState(fifonyDir, issue.id);
    onTransition?.({ issueId: issue.id, identifier: issue.identifier, operation: _op, from: "preparing", to: "done", pid: null, reason: "plan phase complete", at: now() });
  }
}

// ── Review grading helpers ────────────────────────────────────────────────────

function extractGradingReport(text: string): GradingReport | null {
  const candidates = [text];
  const envelopeResult = extractJsonEnvelopeResult(text);
  if (envelopeResult) candidates.push(envelopeResult);

  for (const candidate of candidates) {
    const match = candidate.match(/```json grading_report\n([\s\S]+?)```/);
    if (!match) continue;
    try {
      return JSON.parse(match[1]) as GradingReport;
    } catch { continue; }
  }
  return null;
}

function buildGradingFailureSummary(report: GradingReport, failureScope: "all" | "blocking" = "all"): string {
  const failed = report.criteria.filter((c) => c.result === "FAIL" && (failureScope === "all" || c.blocking));
  if (failed.length === 0) return "Reviewer graded FAIL but no specific criteria listed.";
  return failed.map((c) => `${c.id} [${c.category}]: ${c.description} — ${c.evidence}`).join("\n");
}

export function resolveHarnessMode(issue: IssueEntry): HarnessMode {
  return issue.plan?.harnessMode ?? "standard";
}

/** Complexity-based reduction for maxTurns within each mode. */
const COMPLEXITY_TURN_FACTOR: Record<string, number> = {
  trivial: 0.3,  // solo 10 → 3, standard 20 → 6
  low: 0.5,      // solo 10 → 5, standard 20 → 10
  medium: 1.0,
  high: 1.0,
};

/** Resolve the effective maxTurns for an issue — user config overrides mode defaults. */
export function resolveMaxTurns(issue: IssueEntry, config: RuntimeState["config"]): number {
  if (config.maxTurns) return config.maxTurns;
  const mode = resolveHarnessMode(issue);
  const base = DEFAULT_MAX_TURNS_BY_MODE[mode] ?? DEFAULT_MAX_TURNS;
  const complexity = issue.plan?.estimatedComplexity;
  const factor = (complexity && COMPLEXITY_TURN_FACTOR[complexity]) ?? 1.0;
  return Math.max(3, Math.round(base * factor));
}

export function requiresCheckpointReview(issue: IssueEntry): boolean {
  return resolveHarnessMode(issue) === "contractual"
    && issue.plan?.executionContract?.checkpointPolicy === "checkpointed"
    && !issue.checkpointPassedAt;
}

function findCriterionById(issue: IssueEntry, criterionId: string): AcceptanceCriterion | undefined {
  return issue.plan?.acceptanceCriteria.find((criterion) => criterion.id === criterionId);
}

function synthesizeMissingCriterion(expected: AcceptanceCriterion, scope: ReviewScope): GradingCriterion {
  if (!expected.blocking) {
    return {
      id: expected.id,
      description: expected.description,
      category: expected.category,
      verificationMethod: expected.verificationMethod,
      evidenceExpected: expected.evidenceExpected,
      blocking: expected.blocking,
      weight: expected.weight,
      result: "SKIP",
      evidence: scope === "checkpoint"
        ? "Checkpoint gate deferred this advisory criterion; it remains visible for final review."
        : "Reviewer did not evaluate this advisory criterion. It remains a non-blocking follow-up item.",
    };
  }

  return {
    id: expected.id,
    description: expected.description,
    category: expected.category,
    verificationMethod: expected.verificationMethod,
    evidenceExpected: expected.evidenceExpected,
    blocking: expected.blocking,
    weight: expected.weight,
    result: "FAIL",
    evidence: "Reviewer did not evaluate this required blocking criterion.",
  };
}

export function applyHarnessReviewPolicy(issue: IssueEntry, report: GradingReport, scope: ReviewScope = "final"): GradingReport {
  const harnessMode = resolveHarnessMode(issue);
  const criteria = [...report.criteria];

  if (harnessMode === "contractual") {
    const expectedCriteria = issue.plan?.acceptanceCriteria ?? [];
    for (const expected of expectedCriteria) {
      const found = criteria.find((criterion) => criterion.id === expected.id);
      if (!found) {
        criteria.push(synthesizeMissingCriterion(expected, scope));
      }
    }

    for (const criterion of criteria) {
      const canonical = findCriterionById(issue, criterion.id);
      if (canonical) {
        criterion.category = canonical.category;
        criterion.verificationMethod = canonical.verificationMethod;
        criterion.evidenceExpected = canonical.evidenceExpected;
        criterion.blocking = canonical.blocking;
        criterion.weight = canonical.weight;
      }
      if (criterion.blocking && criterion.result === "SKIP") {
        criterion.result = "FAIL";
        criterion.evidence = criterion.evidence
          ? `${criterion.evidence} Reviewer skipped a blocking contractual criterion.`
          : "Reviewer skipped a blocking contractual criterion.";
      }
    }
  }

  const blockingVerdict = criteria.some((criterion) => criterion.blocking && criterion.result === "FAIL") ? "FAIL" : "PASS";
  const overallVerdict = criteria.some((criterion) => criterion.result === "FAIL") ? "FAIL" : "PASS";
  return { ...report, scope, overallVerdict, blockingVerdict, criteria };
}

async function finalizeReviewSuccess(
  state: RuntimeState,
  issue: IssueEntry,
  container: ReturnType<typeof getContainer>,
  completionNote: string,
): Promise<void> {
  const autoReviewApproval = state.config.autoReviewApproval !== false;

  issue.mergedReason = autoReviewApproval
    ? completionNote
    : `${completionNote} Waiting for manual approval.`;
  await sendIssueToManualDecisionCommand(issue, completionNote, container);
  if (!autoReviewApproval) return;

  const validation = await runValidationGate(issue, state.config);
  if (validation) {
    issue.validationResult = validation;
    markIssueDirty(issue.id);
    if (!validation.passed) {
      addEvent(state, issue.id, "error", `Validation gate failed for ${issue.identifier}: ${validation.command}`);
      logger.warn({ issueId: issue.id, command: validation.command }, "[AgentFSM] Validation gate failed after successful review path");
      return;
    }
    addEvent(state, issue.id, "info", `Validation gate passed for ${issue.identifier}.`);
  }

  await approveIssueAfterReviewCommand(issue, completionNote, container);
}

const FRONTEND_EXTS = [".jsx", ".tsx", ".css", ".vue", ".svelte"];

function hasFrontendChanges(issue: IssueEntry, diffSummary: string): boolean {
  if (issue.paths?.some((p) => FRONTEND_EXTS.some((ext) => p.endsWith(ext)))) return true;
  if (FRONTEND_EXTS.some((ext) => diffSummary.includes(ext))) return true;
  return false;
}

function ensurePlaywrightMcpConfig(stateRoot: string): string | null {
  try {
    execSync("npx --yes @playwright/mcp@latest --version 2>/dev/null", { stdio: "pipe", timeout: 5_000 });
  } catch {
    return null;
  }
  const configPath = join(stateRoot, "playwright-mcp.json");
  if (!existsSync(configPath)) {
    try {
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
        },
      }, null, 2), "utf8");
    } catch {
      return null;
    }
  }
  return configPath;
}

type ReviewEvaluation = {
  reviewer: AgentProviderDefinition;
  reviewResult: AgentSessionResult;
  gradingReport: GradingReport | null;
};

function resolveReviewCycle(issue: IssueEntry, scope: ReviewScope): number {
  return scope === "checkpoint" ? 100 + (issue.checkpointAttempt ?? 1) : 1;
}

function resolveReviewAttemptNumber(issue: IssueEntry, scope: ReviewScope): number {
  return scope === "checkpoint" ? (issue.checkpointAttempt ?? 1) : (issue.reviewAttempt ?? 1);
}

function resolveReviewArtifactPrefix(issue: IssueEntry, scope: ReviewScope): string {
  const planVersion = issue.planVersion ?? 1;
  const attempt = resolveReviewAttemptNumber(issue, scope);
  return `${scope}.v${planVersion}a${attempt}`;
}

function resolveReviewPromptPath(workspacePath: string, scope: ReviewScope): string {
  return join(workspacePath, scope === "checkpoint" ? "checkpoint-review-prompt.md" : "review-prompt.md");
}

function resolveReviewRunId(issue: IssueEntry, scope: ReviewScope): string {
  return `review.${resolveReviewArtifactPrefix(issue, scope)}`;
}

function upsertReviewRun(issue: IssueEntry, reviewRun: ReviewRun): ReviewRun {
  const existingRuns = Array.isArray(issue.reviewRuns) ? issue.reviewRuns : [];
  const nextRuns = [...existingRuns];
  const index = nextRuns.findIndex((entry) => entry.id === reviewRun.id);
  if (index >= 0) {
    nextRuns[index] = {
      ...nextRuns[index],
      ...reviewRun,
      routing: {
        ...nextRuns[index].routing,
        ...reviewRun.routing,
      },
    };
  } else {
    nextRuns.push(reviewRun);
  }

  nextRuns.sort((left, right) => {
    const leftAt = Date.parse(left.completedAt ?? left.startedAt);
    const rightAt = Date.parse(right.completedAt ?? right.startedAt);
    if (!Number.isNaN(leftAt) && !Number.isNaN(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
    return left.id.localeCompare(right.id);
  });

  issue.reviewRuns = nextRuns;
  markIssueDirty(issue.id);
  return nextRuns.find((entry) => entry.id === reviewRun.id) ?? reviewRun;
}

function startReviewRun(
  issue: IssueEntry,
  scope: ReviewScope,
  reviewer: AgentProviderDefinition,
  reviewProfile: ReviewProfile,
  promptFile: string,
  startedAt: string,
): ReviewRun {
  return upsertReviewRun(issue, {
    id: resolveReviewRunId(issue, scope),
    scope,
    planVersion: issue.planVersion ?? 1,
    attempt: resolveReviewAttemptNumber(issue, scope),
    cycle: resolveReviewCycle(issue, scope),
    status: "running",
    reviewProfile,
    routing: {
      provider: reviewer.provider,
      model: reviewer.model,
      reasoningEffort: reviewer.reasoningEffort,
      overlays: reviewer.overlays ?? [],
      selectionReason: reviewer.selectionReason,
    },
    promptFile,
    startedAt,
  });
}

function completeReviewRun(
  issue: IssueEntry,
  reviewRunId: string,
  reviewResult: AgentSessionResult | null,
  gradingReport: GradingReport | null,
  completedAt: string,
  error?: string,
): ReviewRun | null {
  const existing = (issue.reviewRuns ?? []).find((entry) => entry.id === reviewRunId);
  if (!existing) return null;

  const failedCriteria = gradingReport?.criteria.filter((criterion) => criterion.result === "FAIL") ?? [];
  return upsertReviewRun(issue, {
    ...existing,
    status: error ? "crashed" : "completed",
    completedAt,
    sessionSuccess: reviewResult?.success,
    continueRequested: reviewResult?.continueRequested,
    blocked: reviewResult?.blocked,
    exitCode: reviewResult?.code,
    turns: reviewResult?.turns,
    overallVerdict: gradingReport?.overallVerdict,
    blockingVerdict: gradingReport?.blockingVerdict,
    criteriaCount: gradingReport?.criteria.length,
    failedCriteriaCount: failedCriteria.length,
    blockingFailedCriteriaCount: failedCriteria.filter((criterion) => criterion.blocking).length,
    advisoryFailedCriteriaCount: failedCriteria.filter((criterion) => !criterion.blocking).length,
    error,
  });
}

function buildRecurringBlockingFailureSummary(
  issue: IssueEntry,
  scope: ReviewScope,
  gradingReport: GradingReport,
): string | null {
  const patterns = findRecurringBlockingFailures(issue, gradingReport, scope, 2);
  if (patterns.length === 0) return null;
  const header = scope === "checkpoint"
    ? "Recurring checkpoint failures detected."
    : "Recurring final review failures detected.";
  const details = patterns.map((pattern) => {
    const attempts = pattern.attempts.sort((left, right) => left - right).join(", ");
    return `${pattern.criterionId} [${pattern.category}] failed ${pattern.count} time(s) across attempt(s) ${attempts}: ${pattern.description}`;
  });
  return `${header}\n${details.map((detail) => `- ${detail}`).join("\n")}`;
}

function recordReviewMemoryEvent(
  issue: IssueEntry,
  workspacePath: string,
  scope: ReviewScope,
  verdict: "pass" | "fail",
  summary: string,
  gradingReport?: GradingReport | null,
): void {
  recordWorkspaceMemoryEvent(issue, workspacePath, {
    id: `${scope}-${verdict}-v${issue.planVersion ?? 1}-a${resolveReviewAttemptNumber(issue, scope)}`,
    kind: scope === "checkpoint"
      ? verdict === "pass" ? "checkpoint-pass" : "checkpoint-failure"
      : verdict === "pass" ? "review-pass" : "review-failure",
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    title: scope === "checkpoint"
      ? verdict === "pass" ? "Checkpoint review passed" : "Checkpoint review failed"
      : verdict === "pass" ? "Final review passed" : "Final review failed",
    summary,
    details: gradingReport?.criteria
      ?.filter((criterion) => criterion.result === "FAIL")
      .slice(0, 4)
      .map((criterion) => `${criterion.id}: ${criterion.evidence}`),
    source: "review",
    createdAt: now(),
    planVersion: issue.planVersion,
    reviewAttempt: resolveReviewAttemptNumber(issue, scope),
    reviewScope: scope,
    persistLongTerm: verdict === "fail",
    tags: [scope, verdict],
  });
}

function computeDiffSummary(issue: IssueEntry, workspacePath: string): string {
  try {
    if (issue.baseBranch && issue.branchName) {
      const diffResult = execSync(
        `git diff --stat "${issue.baseBranch}"..."${issue.branchName}"`,
        { cwd: TARGET_ROOT, encoding: "utf8", maxBuffer: 512_000, timeout: 10_000 },
      );
      return diffResult.trim();
    }

    const diffTarget = issue.worktreePath ?? workspacePath;
    const diffResult = execSync(
      `git diff --no-index --stat -- "${SOURCE_ROOT}" "${diffTarget}" 2>/dev/null`,
      { encoding: "utf8", maxBuffer: 512_000, timeout: 10_000 },
    );
    return diffResult.trim();
  } catch (err: any) {
    return (err.stdout || "").trim();
  }
}

async function runScopedReviewEvaluation(
  state: RuntimeState,
  issue: IssueEntry,
  workspacePath: string,
  reviewer: AgentProviderDefinition | null,
  scope: ReviewScope,
): Promise<ReviewEvaluation | null> {
  if (!reviewer) return null;
  const blueprint = issue.plan ? buildHarnessBlueprint(issue.plan, state.config) : null;
  const blueprintRun = blueprint ? startBlueprintRun(issue, blueprint, "review") : null;
  if (issue.plan && blueprint) {
    issue.plan.blueprint = blueprint;
    issue.plan.executionContract.blueprintId = blueprint.id;
    issue.plan.executionContract.delegationPolicy = blueprint.delegationPolicy;
    issue.plan.executionContract.budgetPolicy = blueprint.budgetPolicy;
  }
  const reviewNodeId = scope === "checkpoint"
    ? BLUEPRINT_EXECUTION_NODE_IDS.checkpointReview
    : BLUEPRINT_EXECUTION_NODE_IDS.finalReview;

  const diffSummary = computeDiffSummary(issue, workspacePath);
  const playwrightConfigPath = (state.config.enablePlaywrightReview && hasFrontendChanges(issue, diffSummary))
    ? ensurePlaywrightMcpConfig(STATE_ROOT)
    : null;

  const compiled = await compileReview(issue, reviewer, workspacePath, diffSummary, state.config, playwrightConfigPath ?? undefined, scope);
  issue.reviewProfile = compiled.meta.reviewProfile;
  markIssueDirty(issue.id);
  const effectiveReviewer = { ...reviewer, command: compiled.command || reviewer.command };
  const reviewPromptFile = resolveReviewPromptPath(workspacePath, scope);
  const reviewRunStartedAt = now();
  const reviewRunId = startReviewRun(
    issue,
    scope,
    effectiveReviewer,
    compiled.meta.reviewProfile,
    reviewPromptFile,
    reviewRunStartedAt,
  ).id;
  writeFileSync(reviewPromptFile, `${compiled.prompt}\n`, "utf8");
  if (blueprint && blueprintRun) {
    updateBlueprintNodeRun(blueprintRun, reviewNodeId, "running");
    const nodeArtifacts = [
      writeBlueprintArtifact(
        workspacePath,
        blueprintRun.id,
        reviewNodeId,
        "brief",
        buildBlueprintBrief(issue, issue.plan!, blueprint, blueprint.nodes.find((entry) => entry.id === reviewNodeId)!, effectiveReviewer),
      ),
      writeBlueprintJsonArtifact(
        workspacePath,
        blueprintRun.id,
        reviewNodeId,
        "inputs",
        {
          scope,
          reviewer: {
            provider: effectiveReviewer.provider,
            model: effectiveReviewer.model,
            reasoningEffort: effectiveReviewer.reasoningEffort,
          },
          diffSummary,
          playwrightConfigPath,
        },
      ),
    ];
    attachNodeArtifacts(blueprintRun, reviewNodeId, nodeArtifacts);
  }

  const reviewStartedAt = Date.now();

  try {
    const reviewResult = await runAgentSession(
      state,
      issue,
      effectiveReviewer,
      resolveReviewCycle(issue, scope),
      workspacePath,
      compiled.prompt,
      reviewPromptFile,
    );
    issue.durationMs = (issue.durationMs ?? 0) + (Date.now() - reviewStartedAt);
    issue.commandExitCode = reviewResult.code;
    issue.commandOutputTail = reviewResult.output;

    const rawGradingReport = extractGradingReport(reviewResult.output);
    // In contractual mode, a missing grading report when the reviewer FAILED (not succeeded)
    // indicates a reviewer crash — not a structured code quality FAIL. Don't synthesize a
    // 100% FAIL report that wastes the review budget on infrastructure problems.
    const isReviewerCrash = !rawGradingReport && !reviewResult.success && resolveHarnessMode(issue) === "contractual";
    const gradingReport = rawGradingReport
      ? applyHarnessReviewPolicy(issue, rawGradingReport, scope)
      : (resolveHarnessMode(issue) === "contractual" && !isReviewerCrash)
        ? applyHarnessReviewPolicy(issue, {
          scope,
          overallVerdict: "FAIL",
          blockingVerdict: "FAIL",
          reviewAttempt: resolveReviewAttemptNumber(issue, scope),
          criteria: [],
        }, scope)
        : null;

    if (isReviewerCrash) {
      addEvent(state, issue.id, "error", `Reviewer crashed or produced no grading report for ${issue.identifier}. Treating as infrastructure failure, not code quality FAIL.`);
    }

    if (gradingReport) {
      gradingReport.scope = scope;
      gradingReport.reviewAttempt = resolveReviewAttemptNumber(issue, scope);
    }

    const auditResult = gradingReport
      ? scope === "checkpoint"
        ? gradingReport.blockingVerdict === "PASS" ? "checkpoint-approved" : "checkpoint-rework"
        : gradingReport.blockingVerdict === "PASS" ? "approved" : "rework"
      : scope === "checkpoint"
        ? reviewResult.success ? "checkpoint-approved" : reviewResult.continueRequested ? "checkpoint-rework" : "checkpoint-rejected"
        : reviewResult.success ? "approved" : reviewResult.continueRequested ? "rework" : "rejected";
    const reviewAudit = buildExecutionAudit(
      effectiveReviewer,
      null,
      issue,
      Date.now() - reviewStartedAt,
      auditResult,
    );
    persistExecutionAudit(workspacePath, reviewAudit);

    try {
      const artifactPrefix = resolveReviewArtifactPrefix(issue, scope);
      const reviewPromptSrc = resolveReviewPromptPath(workspacePath, scope);
      const reviewAuditSrc = join(workspacePath, "execution-audit.json");
      if (existsSync(reviewPromptSrc)) {
        writeFileSync(join(workspacePath, `${artifactPrefix}.prompt.md`), readFileSync(reviewPromptSrc, "utf8"), "utf8");
      }
      if (existsSync(reviewAuditSrc)) {
        writeFileSync(join(workspacePath, `${artifactPrefix}.audit.json`), readFileSync(reviewAuditSrc, "utf8"), "utf8");
      }
    } catch (vErr) {
      logger.warn({ err: String(vErr), scope }, "[AgentFSM] Failed to write versioned review artifacts");
    }

    const completedReviewRun = completeReviewRun(issue, reviewRunId, reviewResult, gradingReport, now());
    if (completedReviewRun && gradingReport) {
      recordReviewFailures(issue, completedReviewRun, gradingReport, completedReviewRun.completedAt ?? now());
      markIssueDirty(issue.id);
    }

    if (blueprint && blueprintRun) {
      const reviewArtifacts = [
        writeBlueprintArtifact(
          workspacePath,
          blueprintRun.id,
          reviewNodeId,
          "result",
          reviewResult.output || "",
        ),
      ];
      if (gradingReport) {
        reviewArtifacts.push(
          writeBlueprintJsonArtifact(
            workspacePath,
            blueprintRun.id,
            reviewNodeId,
            "evidence",
            gradingReport,
          ),
        );
      }
      attachNodeArtifacts(blueprintRun, reviewNodeId, reviewArtifacts);
      updateBlueprintNodeRun(
        blueprintRun,
        reviewNodeId,
        reviewResult.success && (!gradingReport || gradingReport.blockingVerdict === "PASS") ? "completed" : "failed",
        reviewResult.success ? {} : { error: reviewResult.output.slice(-4000) },
      );

      const handoffNodeId = BLUEPRINT_EXECUTION_NODE_IDS.handoff;
      updateBlueprintNodeRun(blueprintRun, handoffNodeId, "running");
      const handoffArtifacts = [
        writeBlueprintArtifact(
          workspacePath,
          blueprintRun.id,
          handoffNodeId,
          "resume",
          `# Review Handoff\n\n${scope} review completed for ${issue.identifier}.\n`,
        ),
      ];
      attachNodeArtifacts(blueprintRun, handoffNodeId, handoffArtifacts);
      updateBlueprintNodeRun(blueprintRun, handoffNodeId, "completed");
      finalizeBlueprintRun(
        blueprintRun,
        reviewResult.success && (!gradingReport || gradingReport.blockingVerdict === "PASS") ? "completed" : "failed",
      );
    }

    return {
      reviewer: effectiveReviewer,
      reviewResult,
      gradingReport,
    };
  } catch (error) {
    if (blueprintRun) {
      updateBlueprintNodeRun(blueprintRun, reviewNodeId, "failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      finalizeBlueprintRun(blueprintRun, "failed");
    }
    completeReviewRun(
      issue,
      reviewRunId,
      null,
      null,
      now(),
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

async function runCheckpointReviewOnce(
  state: RuntimeState,
  issue: IssueEntry,
  workspacePath: string,
  reviewer: AgentProviderDefinition | null,
): Promise<"passed" | "requeued" | "replanned" | "blocked"> {
  const container = getContainer();
  const maxAutoRetries = state.config.maxReviewAutoRetries ?? DEFAULT_MAX_REVIEW_AUTO_RETRIES;

  issue.checkpointAttempt = (issue.checkpointAttempt ?? 0) + 1;
  issue.checkpointStatus = "pending";
  issue.checkpointPassedAt = undefined;
  markIssueDirty(issue.id);
  addEvent(state, issue.id, "progress", `Checkpoint review started for ${issue.identifier} (attempt ${issue.checkpointAttempt}).`);

  const evaluation = await runScopedReviewEvaluation(state, issue, workspacePath, reviewer, "checkpoint");
  if (!evaluation) {
    issue.checkpointStatus = "failed";
    issue.lastError = "Contractual checkpoint requires a reviewer provider.";
    issue.lastFailedPhase = "review";
    markIssueDirty(issue.id);
    await transitionIssueCommand(
      { issue, target: "Blocked", note: `No reviewer configured; contractual checkpoint cannot run for ${issue.identifier}.` },
      container,
    );
    return "blocked";
  }

  const { reviewResult, gradingReport } = evaluation;
  if (gradingReport) {
    issue.checkpointReport = gradingReport;
    markIssueDirty(issue.id);
  }

  const checkpointFailure = gradingReport
    ? gradingReport.blockingVerdict === "FAIL"
    : reviewResult.continueRequested;
  if (checkpointFailure) {
    const failureSummary = gradingReport
      ? buildGradingFailureSummary(gradingReport, "blocking")
      : (reviewResult.output || "Checkpoint reviewer requested rework.");
    const recurringFailureSummary = gradingReport
      ? buildRecurringBlockingFailureSummary(issue, "checkpoint", gradingReport)
      : null;
    issue.checkpointStatus = "failed";
    issue.lastError = recurringFailureSummary ?? failureSummary;
    issue.lastFailedPhase = "review";
    markIssueDirty(issue.id);
    recordReviewMemoryEvent(issue, workspacePath, "checkpoint", "fail", recurringFailureSummary ?? failureSummary, gradingReport);

    if (recurringFailureSummary && (issue.planVersion ?? 1) < 4) {
      recordPolicyDecision(issue, {
        id: `policy.checkpoint.v${issue.planVersion ?? 1}a${issue.checkpointAttempt ?? 1}.review-recovery`,
        kind: "review-recovery",
        scope: "checkpoint-review",
        planVersion: issue.planVersion ?? 1,
        attempt: issue.checkpointAttempt ?? 1,
        basis: "runtime",
        from: "rework",
        to: "replan",
        rationale: recurringFailureSummary,
        recordedAt: now(),
        profile: issue.reviewProfile?.primary,
        reviewScope: "checkpoint",
      });
      addEvent(
        state,
        issue.id,
        "runner",
        `Auto-replan triggered for ${issue.identifier}: checkpoint is failing on the same blocking criteria repeatedly.`,
      );
      const { replanIssueCommand } = await import("../../commands/replan-issue.command.ts");
      await replanIssueCommand({ issue }, container);
      return "replanned";
    }

    if ((issue.checkpointAttempt ?? 1) <= maxAutoRetries) {
      addEvent(state, issue.id, "runner", `Checkpoint review failed for ${issue.identifier} (attempt ${issue.checkpointAttempt}/${maxAutoRetries}). Re-executing.`);
      await transitionIssueCommand(
        { issue, target: "Queued", note: `Checkpoint review failed for ${issue.identifier}. Re-executing against reviewer feedback.` },
        container,
      );
      return "requeued";
    }

    addEvent(state, issue.id, "runner", `Checkpoint review failed for ${issue.identifier}; auto-retry budget exhausted.`);
    await transitionIssueCommand(
      { issue, target: "Blocked", note: `Checkpoint review failed after ${issue.checkpointAttempt} attempt(s). Human intervention required.` },
      container,
    );
    return "blocked";
  }

  if (!reviewResult.success && !gradingReport) {
    issue.checkpointStatus = "failed";
    issue.lastError = reviewResult.output;
    issue.lastFailedPhase = "review";
    markIssueDirty(issue.id);
    await transitionIssueCommand(
      { issue, target: "Blocked", note: `Checkpoint review did not complete successfully for ${issue.identifier}.` },
      container,
    );
    return "blocked";
  }

  issue.checkpointStatus = "passed";
  issue.checkpointPassedAt = now();
  issue.lastError = undefined;
  issue.lastFailedPhase = undefined;
  markIssueDirty(issue.id);
  recordReviewMemoryEvent(issue, workspacePath, "checkpoint", "pass", "Checkpoint review cleared the blocking gate.", gradingReport);
  addEvent(state, issue.id, "info", `Checkpoint review passed for ${issue.identifier}.`);
  return "passed";
}

// ── Review phase internals ────────────────────────────────────────────────────

async function runReviewOnce(
  state: RuntimeState,
  issue: IssueEntry,
  workspacePath: string,
  reviewer: AgentProviderDefinition | null,
): Promise<void> {
  issue.reviewAttempt = (issue.reviewAttempt ?? 0) + 1;
  markIssueDirty(issue.id);

  const container = getContainer();
  const harnessMode = resolveHarnessMode(issue);

  if (harnessMode === "solo") {
    addEvent(state, issue.id, "info", `Harness mode for ${issue.identifier}: solo — skipping automated reviewer.`);
    await finalizeReviewSuccess(
      state,
      issue,
      container,
      `Solo harness completed for ${issue.identifier}; awaiting approval semantics.`,
    );
    return;
  }

  if (!reviewer) {
    if (harnessMode === "contractual") {
      issue.mergedReason = "Contractual harness requires review evidence; manual review required.";
      await sendIssueToManualDecisionCommand(issue, `No reviewer configured; contractual mode requires manual review for ${issue.identifier}.`, container);
      return;
    }
    await finalizeReviewSuccess(
      state,
      issue,
      container,
      `No reviewer configured for ${issue.identifier}; using standard fallback completion path.`,
    );
    return;
  }

  addEvent(
    state,
    issue.id,
    "info",
    `Review provider: ${reviewer.role}:${reviewer.provider}${reviewer.model ? `/${reviewer.model}` : ""}${reviewer.reasoningEffort ? ` [${reviewer.reasoningEffort}]` : ""}${reviewer.overlays?.length ? ` overlays=${reviewer.overlays.join(",")}` : ""}${reviewer.selectionReason ? ` — ${reviewer.selectionReason}` : ""}.`,
  );

  const evaluation = await runScopedReviewEvaluation(state, issue, workspacePath, reviewer, "final");
  if (!evaluation) {
    if (harnessMode === "contractual") {
      issue.mergedReason = "Contractual harness requires review evidence; manual review required.";
      await sendIssueToManualDecisionCommand(issue, `No reviewer configured; contractual mode requires manual review for ${issue.identifier}.`, container);
      return;
    }
    await finalizeReviewSuccess(
      state,
      issue,
      container,
      `No reviewer configured for ${issue.identifier}; using standard fallback completion path.`,
    );
    return;
  }

  const { reviewResult, gradingReport } = evaluation;
  if (gradingReport) {
    gradingReport.reviewAttempt = issue.reviewAttempt ?? 1;
    gradingReport.scope = "final";
    issue.gradingReport = gradingReport;
    markIssueDirty(issue.id);
  }

  const maxAutoRetries = state.config.maxReviewAutoRetries ?? DEFAULT_MAX_REVIEW_AUTO_RETRIES;

  const recurringFailureSummary = gradingReport?.blockingVerdict === "FAIL"
    ? buildRecurringBlockingFailureSummary(issue, "final", gradingReport)
    : null;
  if (recurringFailureSummary && (issue.planVersion ?? 1) < 4) {
    recordPolicyDecision(issue, {
      id: `policy.final.v${issue.planVersion ?? 1}a${issue.reviewAttempt ?? 1}.review-recovery`,
      kind: "review-recovery",
      scope: "final-review",
      planVersion: issue.planVersion ?? 1,
      attempt: issue.reviewAttempt ?? 1,
      basis: "runtime",
      from: "rework",
      to: "replan",
      rationale: recurringFailureSummary,
      recordedAt: now(),
      profile: issue.reviewProfile?.primary,
      reviewScope: "final",
    });
    issue.lastError = recurringFailureSummary;
    issue.lastFailedPhase = "review";
    markIssueDirty(issue.id);
    addEvent(
      state,
      issue.id,
      "runner",
      `Auto-replan triggered for ${issue.identifier}: final review is failing on the same blocking criteria repeatedly.`,
    );
    const { replanIssueCommand } = await import("../../commands/replan-issue.command.ts");
    await replanIssueCommand({ issue }, container);
    return;
  }

  // Auto-requeue path: structured FAIL verdict within retry budget
  if (gradingReport?.blockingVerdict === "FAIL" && (issue.reviewAttempt ?? 1) <= maxAutoRetries) {
    const failureSummary = buildGradingFailureSummary(gradingReport, "blocking");
    recordReviewMemoryEvent(issue, workspacePath, "final", "fail", failureSummary, gradingReport);
    addEvent(state, issue.id, "runner", `Review graded FAIL for ${issue.identifier} (attempt ${issue.reviewAttempt}/${maxAutoRetries}). Auto-requeueing.`);
    logger.info({ issueId: issue.id, attempt: issue.reviewAttempt, maxAutoRetries }, "[AgentFSM] FAIL grade — auto-requeueing for rework");
    await requestReworkCommand(
      { issue, reviewerFeedback: failureSummary, note: `Graded FAIL on ${gradingReport.criteria.filter((c) => c.result === "FAIL" && c.blocking).length} blocking criterion(a). Re-executing.` },
      container,
    );
    return;
  }

  // Budget exhausted with FAIL: escalate to human with context
  if (gradingReport?.blockingVerdict === "FAIL") {
    recordReviewMemoryEvent(issue, workspacePath, "final", "fail", buildGradingFailureSummary(gradingReport, "blocking"), gradingReport);
    addEvent(state, issue.id, "runner", `Review graded FAIL for ${issue.identifier} — auto-retry budget exhausted. Escalating to human.`);
    logger.warn({ issueId: issue.id, maxAutoRetries }, "[AgentFSM] FAIL grade — budget exhausted, escalating to human");
    issue.lastError = buildGradingFailureSummary(gradingReport, "blocking");
    issue.lastFailedPhase = "review";
    await sendIssueToManualDecisionCommand(issue, `Reviewer graded FAIL after ${issue.reviewAttempt} attempt(s). Human review required.`, container);
    return;
  }

  if (gradingReport?.overallVerdict === "FAIL" && gradingReport.blockingVerdict === "PASS") {
    addEvent(state, issue.id, "info", `Reviewer reported non-blocking findings for ${issue.identifier}; proceeding without rework.`);
  }

  if (gradingReport?.blockingVerdict === "PASS") {
    recordReviewMemoryEvent(issue, workspacePath, "final", "pass", `Reviewer cleared the blocking gate for ${issue.identifier}.`, gradingReport);
    await finalizeReviewSuccess(
      state,
      issue,
      container,
      `Reviewer cleared the blocking gate for ${issue.identifier} in ${reviewResult.turns} turn(s).`,
    );
  } else if (reviewResult.success) {
    await finalizeReviewSuccess(
      state,
      issue,
      container,
      `Reviewer approved ${issue.identifier} in ${reviewResult.turns} turn(s).`,
    );
  } else if (reviewResult.continueRequested) {
    await requestReworkCommand(
      { issue, reviewerFeedback: reviewResult.output, note: `Reviewer requested rework for ${issue.identifier}.` },
      container,
    );
  } else {
    issue.lastError = reviewResult.output;
    issue.lastFailedPhase = "review";
    issue.attempts += 1;
    if (issue.attempts >= issue.maxAttempts) {
      await blockIssueForRetryCommand(issue, `Review failed — max attempts reached (${issue.attempts}/${issue.maxAttempts}) for ${issue.identifier}. Manual intervention required.`, container);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await blockIssueForRetryCommand(issue, `Review failed for ${issue.identifier}. Retry at ${issue.nextRetryAt}.`, container);
    }
  }
}

// ── Execute phase internals ───────────────────────────────────────────────────

async function runExecuteOnce(
  state: RuntimeState,
  issue: IssueEntry,
  workspacePath: string,
  promptText: string,
  promptFile: string,
  workflowConfig: WorkflowConfig | null,
  startTs: number,
  executeProviders: AgentProviderDefinition[],
  reviewer: AgentProviderDefinition | null,
): Promise<void> {
  const container = getContainer();
  issue.executeAttempt = (issue.executeAttempt ?? 0) + 1;
  container.issueRepository.markDirty(issue.id);

  container.eventStore.addEvent(issue.id, "info",
    `Agent providers: ${[
      ...executeProviders,
      ...(reviewer ? [reviewer] : []),
    ].map((p) => `${p.role}:${p.provider}${p.model ? `/${p.model}` : ""}${p.reasoningEffort ? ` [${p.reasoningEffort}]` : ""}`).join(", ")}.`);

  const runResult = await runAgentPipeline(state, issue, workspacePath, promptText, promptFile, workflowConfig);

  issue.durationMs = Date.now() - startTs;
  issue.commandExitCode = runResult.code;
  issue.commandOutputTail = runResult.output;

  if (runResult.success) {
    ensureWorktreeCommitted(issue);
    computeDiffStats(issue);
    container.issueRepository.markDirty(issue.id);
    if (issue.filesChanged) {
      container.eventStore.addEvent(issue.id, "info", `Diff: ${issue.filesChanged} files, +${issue.linesAdded || 0} -${issue.linesRemoved || 0} lines.`);
    }
    container.eventStore.addEvent(issue.id, "info", `Workspace prepared for review on branch ${issue.branchName ?? "workspace"}.`);

    const executor = executeProviders.find((p) => p.role === "executor") || executeProviders[0];
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
        logger.warn({ err: String(vErr) }, "[AgentFSM] Failed to write versioned execute artifacts");
      }
    }

    if (requiresCheckpointReview(issue)) {
      const checkpointOutcome = await runCheckpointReviewOnce(state, issue, workspacePath, reviewer);
      if (checkpointOutcome !== "passed") return;
    }

    // Pre-review fast validation gate — shift feedback left (reuse testCommand config)
    const preReviewValidation = await runValidationGate(issue, state.config);
    if (preReviewValidation) {
      issue.preReviewValidation = preReviewValidation;
      markIssueDirty(issue.id);
      container.eventStore.addEvent(issue.id, "info",
        `Pre-review gate: ${preReviewValidation.passed ? "PASS" : "FAIL"} — \`${preReviewValidation.command}\``);

      if (!preReviewValidation.passed) {
        issue.lastError = `Pre-review validation gate failed:\n${preReviewValidation.output}`;
        issue.lastFailedPhase = "execute";
        issue.attempts += 1;
        if (issue.attempts >= issue.maxAttempts) {
          await blockIssueForRetryCommand(issue, `Pre-review validation gate failed — max attempts reached (${issue.attempts}/${issue.maxAttempts}). Manual intervention required.`, container);
        } else {
          issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
          await blockIssueForRetryCommand(issue, `Pre-review validation gate failed on attempt ${issue.attempts}/${issue.maxAttempts}. Retry scheduled at ${issue.nextRetryAt}.`, container);
        }
        return;
      }
    }

    await startIssueReviewCommand(issue, `Agent execution finished in ${runResult.turns} turn(s) for ${issue.identifier}. Awaiting review.`, container);
  } else if (runResult.continueRequested) {
    issue.updatedAt = now();
    issue.commandExitCode = runResult.code;
    issue.commandOutputTail = runResult.output;
    issue.lastError = undefined;
    issue.nextRetryAt = new Date(Date.now() + 1000).toISOString();
    issue.history.push(`[${issue.updatedAt}] Agent requested another turn (${runResult.turns}/${resolveMaxTurns(issue, state.config)}).`);
    container.eventStore.addEvent(issue.id, "runner", `Issue ${issue.identifier} queued for next turn.`);
    if ((runResult as { contextReset?: boolean }).contextReset) {
      container.eventStore.addEvent(issue.id, "runner", `Context reset ${issue.contextResetCount}/${state.config.maxContextResets ?? DEFAULT_MAX_CONTEXT_RESETS}: new session will start from handoff.`);
    }
  } else {
    issue.lastError = runResult.output;
    issue.lastFailedPhase = "execute";
    issue.attempts += 1;

    // Stall detection: if the same error type repeats N times, auto-replan to break the loop
    if (state.config.autoReplanOnStall && issue.attempts < issue.maxAttempts) {
      const stallThreshold = state.config.autoReplanStallThreshold ?? DEFAULT_AUTO_REPLAN_STALL_THRESHOLD;
      const currentInsight = extractFailureInsights(runResult.output ?? "", runResult.code);
      const prev = issue.previousAttemptSummaries ?? [];
      const recentTypes = prev.slice(-(stallThreshold - 1)).map((s) => s.insight?.errorType);
      const stallDetected =
        recentTypes.length >= stallThreshold - 1 &&
        currentInsight.errorType !== "unknown" &&
        recentTypes.every((t) => t === currentInsight.errorType);

      if (stallDetected && (issue.planVersion ?? 1) < 4) {
        logger.warn({ issueId: issue.id, errorType: currentInsight.errorType, planVersion: issue.planVersion },
          "[AgentFSM] Stall detected — triggering auto-replan");
        container.eventStore.addEvent(issue.id, "runner",
          `Auto-replan: "${currentInsight.errorType}" repeated ${stallThreshold}× — replanning to break the loop.`);
        // BFS finds path: Running → Blocked → Planning
        const { replanIssueCommand } = await import("../../commands/replan-issue.command.ts");
        await replanIssueCommand({ issue }, container);
        return;
      }
    }

    if (issue.attempts >= issue.maxAttempts) {
      issue.commandExitCode = runResult.code;
      await blockIssueForRetryCommand(issue, `Execution failed — max attempts reached (${issue.attempts}/${issue.maxAttempts}). Manual intervention required.`, container);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await blockIssueForRetryCommand(issue, `${runResult.blocked ? "Agent requested manual intervention" : "Failure"} on attempt ${issue.attempts}/${issue.maxAttempts}; retry scheduled at ${issue.nextRetryAt}.`, container);
    }
  }
}

// ── Phase entry points ────────────────────────────────────────────────────────

/**
 * Run the review phase for an issue in Reviewing state.
 */
export async function runReviewPhase(
  state: RuntimeState,
  issue: IssueEntry,
  running: Set<string>,
  fifonyDir = STATE_ROOT,
  onTransition?: (t: AgentTransition) => void,
): Promise<void> {
  const startTs = Date.now();
  logger.info({ issueId: issue.id, identifier: issue.identifier, state: issue.state, attempt: issue.attempts + 1 }, "[AgentFSM] Review phase starting");

  const _op = deriveAgentOperation(issue);
  const _workspacePath = issue.workspacePath ?? join(WORKSPACE_ROOT, idToSafePath(issue.id));
  writeJobState(fifonyDir, {
    issueId: issue.id, identifier: issue.identifier,
    operation: _op, state: "preparing",
    startedAt: now(), updatedAt: now(),
    workspacePath: _workspacePath, logFile: agentLogPath(_workspacePath),
    turn: 0, maxTurns: 1,
    provider: state.config.agentProvider ?? "unknown", role: "reviewer",
    crashCount: 0,
  });
  onTransition?.({ issueId: issue.id, identifier: issue.identifier, operation: _op, from: "none", to: "preparing", pid: null, reason: "review phase starting", at: now() });

  running.add(issue.id);
  issue.startedAt = issue.startedAt ?? now();
  const container = getContainer();

  issue.updatedAt = now();
  issue.history.push(`[${issue.updatedAt}] Review stage started for ${issue.identifier}.`);
  container.eventStore.addEvent(issue.id, "progress", `Review started for ${issue.identifier}.`);

  let workflowConfig: WorkflowConfig | null = null;
  try {
    const settings = await loadRuntimeSettings();
    workflowConfig = getWorkflowConfig(settings);
  } catch { /* use defaults */ }

  try {
    const workspaceDerivedPaths = hydrateIssuePathsFromWorkspace(issue);
    void workspaceDerivedPaths; // used for side effects (path hydration)
    const { workspacePath } = await prepareWorkspace(issue, state, state.config.defaultBranch);
    container.issueRepository.markDirty(issue.id);
    container.eventStore.addEvent(issue.id, "info", `Workspace ready at ${workspacePath}.`);
    const { startIssueLogBroadcasting: _startReviewLog } = await import("./issue-log-broadcaster.ts");
    _startReviewLog(issue.id, workspacePath);

    const reviewer = getReviewProvider(state, issue, workflowConfig);

    // Warn if Playwright review is enabled but no service is configured
    if (state.config.enablePlaywrightReview && hasFrontendChanges(issue, "")) {
      const services = state.config.services ?? [];
      if (services.length === 0) {
        container.eventStore.addEvent(issue.id, "info",
          `Playwright review is enabled but no services are configured. ` +
          `Go to Settings → Services and add one so the reviewer can navigate to localhost:5173.`);
      }
    }

    if (requiresCheckpointReview(issue)) {
      issue.lastError = "Contractual checkpoint review must pass before final review can start.";
      issue.lastFailedPhase = "review";
      await blockIssueForRetryCommand(issue, `Checkpoint review missing for ${issue.identifier}. Re-run execution before final review.`, container);
      return;
    }
    await runReviewOnce(state, issue, workspacePath, reviewer);
  } catch (error) {
    issue.attempts += 1;
    issue.lastError = String(error);
    issue.lastFailedPhase = "review";

    if (issue.attempts >= issue.maxAttempts) {
      await blockIssueForRetryCommand(issue, `Unexpected failure — max attempts reached (${issue.attempts}/${issue.maxAttempts}): ${issue.lastError?.slice(0, 120) ?? "unknown error"}. Manual intervention required.`, container);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await blockIssueForRetryCommand(issue, `Unexpected failure. Retry scheduled at ${issue.nextRetryAt}.`, container);
    }
  } finally {
    const elapsedMs = Date.now() - startTs;
    logger.info({ issueId: issue.id, identifier: issue.identifier, finalState: issue.state, elapsedMs, attempts: issue.attempts }, "[AgentFSM] Review phase finished");
    issue.updatedAt = now();
    container.issueRepository.markDirty(issue.id);
    running.delete(issue.id);
    state.metrics = computeMetrics(state.issues);
    state.updatedAt = now();
    await container.persistencePort.persistState(state);
    cleanAgentJobState(fifonyDir, issue.id);
    onTransition?.({ issueId: issue.id, identifier: issue.identifier, operation: _op, from: "running", to: "done", pid: null, reason: "review phase complete", at: now() });
    import("./issue-log-broadcaster.ts").then(({ stopIssueLogBroadcasting }) => stopIssueLogBroadcasting(issue.id)).catch(() => {});
  }
}


/**
 * Run the execute phase for an issue in Queued/Running state.
 * Loops until the issue leaves Queued/Running (multi-turn support).
 */
export async function runExecutePhase(
  state: RuntimeState,
  issue: IssueEntry,
  running: Set<string>,
  active: () => boolean,
  getCurrentIssue: (id: string) => IssueEntry | undefined,
  fifonyDir = STATE_ROOT,
  onTransition?: (t: AgentTransition) => void,
): Promise<void> {
  const startTs = Date.now();
  logger.info({ issueId: issue.id, identifier: issue.identifier, state: issue.state, attempt: issue.attempts + 1 }, "[AgentFSM] Execute phase starting");

  const _op = deriveAgentOperation(issue);
  const _initWorkspacePath = issue.workspacePath ?? join(WORKSPACE_ROOT, idToSafePath(issue.id));
  const _jobInit: AgentJobState = {
    issueId: issue.id, identifier: issue.identifier,
    operation: _op, state: "preparing",
    startedAt: now(), updatedAt: now(),
    workspacePath: _initWorkspacePath, logFile: agentLogPath(_initWorkspacePath),
    turn: 0, maxTurns: resolveMaxTurns(issue, state.config),
    provider: state.config.agentProvider ?? "unknown", role: "executor",
    crashCount: 0,
  };
  writeJobState(fifonyDir, _jobInit);
  onTransition?.({ issueId: issue.id, identifier: issue.identifier, operation: _op, from: "none", to: "preparing", pid: null, reason: "execute phase starting", at: now() });

  running.add(issue.id);
  issue.startedAt = issue.startedAt ?? now();
  const container = getContainer();

  // Transition to Running if not already there
  if (issue.state === "Running") {
    await transitionIssueCommand({ issue, target: "Running", note: `Resuming runner for ${issue.identifier}.` }, container);
    container.eventStore.addEvent(issue.id, "progress", `Runner resumed for ${issue.identifier}.`);
  } else {
    if (issue.state !== "Queued") {
      await transitionIssueCommand({ issue, target: "Queued", note: `Issue ${issue.identifier} queued for execution.` }, container);
    }
    await transitionIssueCommand({ issue, target: "Running", note: `Agent started for ${issue.identifier}.` }, container);
    container.eventStore.addEvent(issue.id, "progress", `Runner started for ${issue.identifier}.`);
  }
  // executeTransition already calls triggerImmediatePersist() after the Running transition.

  let workflowConfig: WorkflowConfig | null = null;
  try {
    const settings = await loadRuntimeSettings();
    workflowConfig = getWorkflowConfig(settings);
  } catch { /* use defaults */ }

  // Multi-turn loop: keep executing until the issue leaves Queued/Running
  let current: IssueEntry | undefined = issue;
  try {
    while (active() && current) {
      if (current.state !== "Queued" && current.state !== "Running") break;

      const workspaceDerivedPaths = hydrateIssuePathsFromWorkspace(current);
      void workspaceDerivedPaths;

      const { workspacePath, promptText, promptFile } = await prepareWorkspace(current, state, state.config.defaultBranch);
      container.issueRepository.markDirty(current.id);
      // Update job state now that workspacePath is known and process is about to run
      const _turnNum = (readJobState(fifonyDir, issue.id)?.turn ?? 0) + 1;
      writeJobState(fifonyDir, { ..._jobInit, workspacePath, logFile: agentLogPath(workspacePath), state: "running", turn: _turnNum, updatedAt: now() });

      // Persist workspace fields so they survive restarts
      try {
        const { getIssueStateResource } = await import("../store.ts");
        const res = getIssueStateResource();
        if (res) {
          await (res as any).patch(current.id, {
            branchName: current.branchName,
            baseBranch: current.baseBranch,
            workspacePath: current.workspacePath,
            worktreePath: current.worktreePath,
          });
        }
      } catch { /* non-critical */ }

      container.eventStore.addEvent(current.id, "info", `Workspace ready at ${workspacePath}.`);
      const { startIssueLogBroadcasting } = await import("./issue-log-broadcaster.ts");
      startIssueLogBroadcasting(current.id, workspacePath);
      const executeProviders = getExecutionProviders(state, current, workflowConfig);
      const reviewer = getReviewProvider(state, current, workflowConfig);
      await runExecuteOnce(state, current, workspacePath, promptText, promptFile, workflowConfig, startTs, executeProviders, reviewer);

      // Refresh current issue state for the next iteration
      current = getCurrentIssue(issue.id);
    }
  } catch (error) {
    const target = current ?? issue;
    target.attempts += 1;
    target.lastError = String(error);
    target.lastFailedPhase = target.lastFailedPhase ?? "execute";

    if (target.attempts >= target.maxAttempts) {
      await blockIssueForRetryCommand(target, `Unexpected failure — max attempts reached (${target.attempts}/${target.maxAttempts}): ${target.lastError?.slice(0, 120) ?? "unknown error"}. Manual intervention required.`, container);
    } else {
      target.nextRetryAt = getNextRetryAt(target, state.config.retryDelayMs);
      await blockIssueForRetryCommand(target, `Unexpected failure. Retry scheduled at ${target.nextRetryAt}.`, container);
    }
  } finally {
    const finalIssue = getCurrentIssue(issue.id) ?? issue;
    const elapsedMs = Date.now() - startTs;
    logger.info({ issueId: issue.id, identifier: issue.identifier, finalState: finalIssue.state, elapsedMs, attempts: finalIssue.attempts }, "[AgentFSM] Execute phase finished");
    finalIssue.updatedAt = now();
    container.issueRepository.markDirty(issue.id);
    running.delete(issue.id);
    state.metrics = computeMetrics(state.issues);
    state.updatedAt = now();
    await container.persistencePort.persistState(state);
    cleanAgentJobState(fifonyDir, issue.id);
    onTransition?.({ issueId: issue.id, identifier: issue.identifier, operation: _op, from: "running", to: "done", pid: null, reason: "execute phase complete", at: now() });
    import("./issue-log-broadcaster.ts").then(({ stopIssueLogBroadcasting }) => stopIssueLogBroadcasting(issue.id)).catch(() => {});
  }
}

// ── Watcher tick ──────────────────────────────────────────────────────────────

function tickOneAgent(
  issue: IssueEntry,
  fifonyDir: string,
): AgentTransition | null {
  const job = readJobState(fifonyDir, issue.id);
  if (!job) return null;
  if (job.state === "done" || job.state === "failed" || job.state === "idle" || job.state === "crashed") return null;

  if (job.state === "running" || job.state === "preparing") {
    if (!job.workspacePath || !existsSync(job.workspacePath)) return null;
    const pidInfo = readAgentPid(job.workspacePath);
    const alive = pidInfo ? isProcessAlive(pidInfo.pid) : false;

    if (!alive && pidInfo) {
      const crashCount = (job.crashCount ?? 0) + 1;
      writeJobState(fifonyDir, { ...job, state: "crashed", crashCount, lastCrashAt: now(), updatedAt: now() });
      logger.warn({ issueId: issue.id, identifier: issue.identifier, crashCount }, "[AgentFSM] FSM: running → crashed (PID gone)");
      return {
        issueId: issue.id, identifier: issue.identifier,
        operation: job.operation, from: "running", to: "crashed",
        pid: null, reason: `agent process died (crash #${crashCount})`, at: now(),
      };
    }
  }

  return null;
}

export function tickAgentWatcher(
  issues: IssueEntry[],
  fifonyDir: string,
): AgentTransition[] {
  const transitions: AgentTransition[] = [];
  for (const issue of issues) {
    if (issue.state !== "Running" && issue.state !== "Reviewing" && issue.state !== "Planning") continue;
    try {
      const t = tickOneAgent(issue, fifonyDir);
      if (t) transitions.push(t);
    } catch (err) {
      logger.warn({ err, issueId: issue.id }, "[AgentFSM] Watcher tick error");
    }
  }
  return transitions;
}

// ── Watcher lifecycle ─────────────────────────────────────────────────────────

export function initAgentWatcher(
  getIssues: () => IssueEntry[],
  fifonyDir: string,
  onTransition: (t: AgentTransition) => void,
): { stop: () => void } {
  const intervalId = setInterval(() => {
    const issues = getIssues();
    if (issues.length === 0) return;
    const transitions = tickAgentWatcher(issues, fifonyDir);
    for (const t of transitions) onTransition(t);
  }, AGENT_WATCHER_INTERVAL_MS);

  return { stop: () => clearInterval(intervalId) };
}

// ── Boot reconciliation ───────────────────────────────────────────────────────

/**
 * Called at boot: scan job state files for all issues and mark any with a dead
 * PID as "crashed" so the UI reflects reality without waiting for a watcher tick.
 */
export function reconcileAgentStates(
  issues: IssueEntry[],
  fifonyDir: string,
): AgentTransition[] {
  const transitions: AgentTransition[] = [];
  for (const issue of issues) {
    const job = readJobState(fifonyDir, issue.id);
    if (!job) continue;
    if (job.state === "done" || job.state === "failed" || job.state === "idle" || job.state === "crashed") continue;

    if (job.state === "running" || job.state === "preparing") {
      const pidInfo = job.workspacePath && existsSync(job.workspacePath)
        ? readAgentPid(job.workspacePath)
        : null;
      const alive = pidInfo ? isProcessAlive(pidInfo.pid) : false;

      if (!alive) {
        const crashCount = (job.crashCount ?? 0) + 1;
        writeJobState(fifonyDir, { ...job, state: "crashed", crashCount, lastCrashAt: now(), updatedAt: now() });
        logger.info({ issueId: issue.id, identifier: issue.identifier, crashCount }, "[AgentFSM] Boot: agent process dead → crashed");
        transitions.push({
          issueId: issue.id, identifier: issue.identifier,
          operation: job.operation, from: job.state, to: "crashed",
          pid: null, reason: "agent process not found at boot", at: now(),
        });
      }
    }
  }
  return transitions;
}
