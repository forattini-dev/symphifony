import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentProviderDefinition,
  AgentSessionResult,
  ContractNegotiationConcern,
  ContractNegotiationDecision,
  ContractNegotiationRun,
  ContractNegotiationStatus,
  IssueEntry,
  RuntimeState,
  WorkflowConfig,
} from "../types.ts";
import { DEFAULT_MAX_CONTRACT_NEGOTIATION_ROUNDS, WORKSPACE_ROOT } from "../concerns/constants.ts";
import { idToSafePath, now } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { compileContractNegotiation } from "./adapters/index.ts";
import { runAgentSession } from "./agent-pipeline.ts";
import {
  applyCheckpointPolicyToPlan,
  applyHarnessModeToPlan,
  recommendCheckpointPolicyForIssue,
  recommendHarnessModeForIssue,
} from "./harness-policy.ts";
import { getReviewProvider } from "./providers.ts";
import { refinePlan } from "./planning/issue-planner.ts";
import { addTokenUsage } from "./directive-parser.ts";
import { markIssueDirty } from "../persistence/dirty-tracker.ts";
import { addEvent } from "../domains/issues.ts";
import { requiresContractNegotiation } from "../domains/contract-negotiation.ts";
import { recordPolicyDecision } from "../domains/policy-decisions.ts";
import { savePlanForIssue } from "../persistence/store.ts";
import { recordWorkspaceMemoryEvent } from "./memory-engine.ts";

export type ContractNegotiationResult = {
  status: ContractNegotiationStatus;
  approved: boolean;
  rounds: number;
  reviewer?: AgentProviderDefinition;
  decision?: ContractNegotiationDecision;
};

function resolvePlanningWorkspace(issue: IssueEntry): string {
  return join(WORKSPACE_ROOT, idToSafePath(issue.id));
}

function resolveNegotiationRunId(issue: IssueEntry, round: number): string {
  return `contract.v${issue.planVersion ?? 1}a${round}`;
}

function resolveNegotiationPromptPath(workspacePath: string, issue: IssueEntry, round: number): string {
  return join(workspacePath, `${resolveNegotiationRunId(issue, round)}.prompt.md`);
}

function resolveNegotiationDecisionPath(workspacePath: string, issue: IssueEntry, round: number): string {
  return join(workspacePath, `${resolveNegotiationRunId(issue, round)}.decision.json`);
}

function resolveNegotiationPlanSnapshotPath(workspacePath: string, issue: IssueEntry, round: number): string {
  return join(workspacePath, `plan.v${issue.planVersion ?? 1}.contract-r${round}.json`);
}

function upsertContractNegotiationRun(issue: IssueEntry, run: ContractNegotiationRun): ContractNegotiationRun {
  const existingRuns = Array.isArray(issue.contractNegotiationRuns) ? issue.contractNegotiationRuns : [];
  const nextRuns = [...existingRuns];
  const index = nextRuns.findIndex((entry) => entry.id === run.id);
  if (index >= 0) {
    nextRuns[index] = {
      ...nextRuns[index],
      ...run,
      routing: {
        ...nextRuns[index].routing,
        ...run.routing,
      },
    };
  } else {
    nextRuns.push(run);
  }

  nextRuns.sort((left, right) => {
    const leftAt = Date.parse(left.completedAt ?? left.startedAt);
    const rightAt = Date.parse(right.completedAt ?? right.startedAt);
    if (!Number.isNaN(leftAt) && !Number.isNaN(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
    return left.id.localeCompare(right.id);
  });

  issue.contractNegotiationRuns = nextRuns;
  markIssueDirty(issue.id);
  return nextRuns.find((entry) => entry.id === run.id) ?? run;
}

function startContractNegotiationRun(
  issue: IssueEntry,
  reviewer: AgentProviderDefinition,
  round: number,
  promptFile: string,
  startedAt: string,
  reviewProfile: NonNullable<ContractNegotiationRun["reviewProfile"]>,
): ContractNegotiationRun {
  return upsertContractNegotiationRun(issue, {
    id: resolveNegotiationRunId(issue, round),
    planVersion: issue.planVersion ?? 1,
    attempt: round,
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

function completeContractNegotiationRun(
  issue: IssueEntry,
  round: number,
  reviewResult: AgentSessionResult | null,
  decision: ContractNegotiationDecision | null,
  completedAt: string,
  options?: { appliedRefinement?: boolean; error?: string },
): ContractNegotiationRun | null {
  const existing = (issue.contractNegotiationRuns ?? []).find((entry) => entry.id === resolveNegotiationRunId(issue, round));
  if (!existing) return null;

  const concerns = decision?.concerns ?? [];
  const completedRun = upsertContractNegotiationRun(issue, {
    ...existing,
    status: options?.error ? "crashed" : "completed",
    completedAt,
    sessionSuccess: reviewResult?.success,
    continueRequested: reviewResult?.continueRequested,
    blocked: reviewResult?.blocked,
    exitCode: reviewResult?.code,
    turns: reviewResult?.turns,
    decisionStatus: decision?.status,
    summary: decision?.summary,
    rationale: decision?.rationale,
    concerns,
    concernsCount: concerns.length,
    blockingConcernsCount: concerns.filter((concern) => concern.severity === "blocking").length,
    advisoryConcernsCount: concerns.filter((concern) => concern.severity !== "blocking").length,
    appliedRefinement: options?.appliedRefinement ?? existing.appliedRefinement,
    error: options?.error,
  });
  if (issue.workspacePath && completedRun.status === "completed" && decision) {
    recordWorkspaceMemoryEvent(issue, issue.workspacePath, {
      id: `contract-${completedRun.id}`,
      kind: "contract-negotiation",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      title: decision.status === "approved" ? "Contract approved" : "Contract revision requested",
      summary: decision.summary || (decision.status === "approved"
        ? "Execution contract approved before implementation."
        : "Execution contract required revision before implementation."),
      details: concerns.slice(0, 3).map((concern) => `${concern.id} [${concern.severity}] ${concern.requiredChange}`),
      source: "planning",
      createdAt: completedRun.completedAt ?? completedRun.startedAt,
      planVersion: completedRun.planVersion,
      persistLongTerm: concerns.some((concern) => concern.severity === "blocking"),
      tags: [decision.status, "contract"],
    });
  }
  return completedRun;
}

/** Try to extract the "result" field from a --output-format json CLI envelope.
 *  Handles trailing garbage (ANSI escapes, fifony suffixes) that break JSON.parse
 *  on the raw text by isolating the outermost JSON object first. */
function extractJsonEnvelopeResult(text: string): string | null {
  // Fast path: try the full text as-is
  try {
    const env = JSON.parse(text.trim()) as Record<string, unknown>;
    if (env && typeof env === "object" && typeof env.result === "string") return env.result;
  } catch { /* trailing garbage — fall through */ }

  // Isolate the JSON object: find first '{' and scan backward from end for last '}'
  const start = text.indexOf("{");
  if (start < 0) return null;
  const end = text.lastIndexOf("}");
  if (end <= start) return null;
  try {
    const env = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (env && typeof env === "object" && typeof env.result === "string") return env.result;
  } catch { /* still not valid JSON */ }

  // Last resort: regex-extract the result field value from the raw JSON text.
  // This handles severely truncated envelopes where only part of the JSON survived.
  const m = text.match(/"result"\s*:\s*"([\s\S]+)/);
  if (m) {
    // Unescape the JSON string content until an unescaped quote closes it
    let raw = "";
    let i = 0;
    const src = m[1];
    while (i < src.length) {
      if (src[i] === "\\" && i + 1 < src.length) {
        const next = src[i + 1];
        if (next === "n") { raw += "\n"; i += 2; continue; }
        if (next === "t") { raw += "\t"; i += 2; continue; }
        if (next === '"') { raw += '"'; i += 2; continue; }
        if (next === "\\") { raw += "\\"; i += 2; continue; }
        raw += next; i += 2; continue;
      }
      if (src[i] === '"') break; // unescaped quote = end of string value
      raw += src[i]; i += 1;
    }
    if (raw.length > 100) return raw;
  }

  return null;
}

export function extractContractDecision(text: string): ContractNegotiationDecision | null {
  // Collect candidate texts: the raw output AND the unwrapped result from a
  // --output-format json envelope (Claude CLI JSON-encodes the result, so
  // JSON.parse restores the original newlines needed for regex matching).
  const candidates: string[] = [text];
  const envelopeResult = extractJsonEnvelopeResult(text);
  if (envelopeResult) candidates.push(envelopeResult);

  for (const candidate of candidates) {
    const match = candidate.match(/```json contract_decision\n([\s\S]+?)```/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]) as Partial<ContractNegotiationDecision>;
      const status = parsed.status === "approved" || parsed.status === "revise" ? parsed.status : null;
      if (!status) continue;
      const concerns = Array.isArray(parsed.concerns)
        ? parsed.concerns.filter((concern): concern is ContractNegotiationConcern => {
          if (!concern || typeof concern !== "object") return false;
          const record = concern as Record<string, unknown>;
          return typeof record.id === "string"
            && (record.severity === "blocking" || record.severity === "advisory")
            && typeof record.area === "string"
            && typeof record.problem === "string"
            && typeof record.requiredChange === "string";
        })
        : [];
      return {
        status,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
        concerns,
      };
    } catch { /* bad JSON in the block, try next candidate */ }
  }
  return null;
}

export function buildContractNegotiationFeedback(decision: ContractNegotiationDecision): string {
  const lines = [
    "Contract negotiation requested plan revisions before execution.",
    decision.summary ? `Summary: ${decision.summary}` : "",
    decision.rationale ? `Rationale: ${decision.rationale}` : "",
    "",
    "Revise the plan so the contract is concrete, testable, and enforceable.",
  ].filter(Boolean);

  if (decision.concerns.length > 0) {
    lines.push("", "Required contract fixes:");
    for (const concern of decision.concerns) {
      lines.push(
        `${concern.id} [${concern.severity}/${concern.area}] ${concern.problem}`,
        `Required change: ${concern.requiredChange}`,
      );
    }
  }

  lines.push(
    "",
    "Return a fully revised plan with updated acceptanceCriteria, executionContract, steps, validation, and harnessMode where needed.",
  );

  return lines.join("\n");
}

async function applyRefinedPlan(
  state: RuntimeState,
  issue: IssueEntry,
  workspacePath: string,
  feedback: string,
  round: number,
): Promise<void> {
  const { plan, usage } = await refinePlan(issue, feedback, state.config, null);
  issue.plan = plan;
  issue.updatedAt = now();
  const harnessRecommendation = state.config.adaptiveHarnessSelection === false
    ? null
    : recommendHarnessModeForIssue(
      state.issues.filter((entry) => entry.id !== issue.id),
      issue,
      plan.harnessMode,
      state.config.adaptivePolicyMinSamples ?? 3,
    );
  if (harnessRecommendation && harnessRecommendation.mode !== plan.harnessMode) {
    const previousMode = plan.harnessMode;
    applyHarnessModeToPlan(plan, harnessRecommendation.mode);
    recordPolicyDecision(issue, {
      id: `policy.contract.v${issue.planVersion ?? 1}.r${round}.harness-mode`,
      kind: "harness-mode",
      scope: "planning",
      planVersion: issue.planVersion ?? 1,
      attempt: round,
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
      `Adaptive harness policy changed ${issue.identifier} from ${previousMode} to ${plan.harnessMode} during contract refinement: ${harnessRecommendation.rationale}`,
    );
  }
  const checkpointRecommendation = state.config.adaptiveHarnessSelection === false
    ? null
    : recommendCheckpointPolicyForIssue(
      state.issues.filter((entry) => entry.id !== issue.id),
      issue,
      plan.executionContract.checkpointPolicy,
      state.config.adaptivePolicyMinSamples ?? 3,
    );
  if (checkpointRecommendation && checkpointRecommendation.checkpointPolicy !== plan.executionContract.checkpointPolicy) {
    const previousCheckpointPolicy = plan.executionContract.checkpointPolicy;
    applyCheckpointPolicyToPlan(plan, checkpointRecommendation.checkpointPolicy);
    recordPolicyDecision(issue, {
      id: `policy.contract.v${issue.planVersion ?? 1}.r${round}.checkpoint-policy`,
      kind: "checkpoint-policy",
      scope: "planning",
      planVersion: issue.planVersion ?? 1,
      attempt: round,
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
      `Adaptive checkpoint policy changed ${issue.identifier} from ${previousCheckpointPolicy} to ${plan.executionContract.checkpointPolicy} during contract refinement: ${checkpointRecommendation.rationale}`,
    );
  }
  if (plan.suggestedPaths?.length && !(issue.paths?.length)) issue.paths = plan.suggestedPaths;
  if (plan.suggestedEffort && !issue.effort) issue.effort = plan.suggestedEffort;
  if (usage.totalTokens > 0) {
    addTokenUsage(issue, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      model: usage.model,
    }, "planner");
  }

  markIssueDirty(issue.id);
  await savePlanForIssue(issue.id, plan, issue.planVersion ?? 1);

  writeFileSync(join(workspacePath, `plan.v${issue.planVersion ?? 1}.json`), JSON.stringify(plan, null, 2), "utf8");
  writeFileSync(resolveNegotiationPlanSnapshotPath(workspacePath, issue, round), JSON.stringify(plan, null, 2), "utf8");
}

export async function runContractNegotiation(
  state: RuntimeState,
  issue: IssueEntry,
  workflowConfig?: WorkflowConfig | null,
  workspacePath = resolvePlanningWorkspace(issue),
  maxRounds = DEFAULT_MAX_CONTRACT_NEGOTIATION_ROUNDS,
): Promise<ContractNegotiationResult> {
  mkdirSync(workspacePath, { recursive: true });

  if (!issue.plan?.steps?.length) {
    issue.contractNegotiationStatus = "failed";
    issue.planningError = `Contract negotiation cannot start for ${issue.identifier} because no plan is available.`;
    markIssueDirty(issue.id);
    return { status: "failed", approved: false, rounds: 0 };
  }

  if (!requiresContractNegotiation(issue)) {
    issue.contractNegotiationStatus = "skipped";
    issue.contractNegotiationAttempt = 0;
    issue.planningError = undefined;
    markIssueDirty(issue.id);
    return { status: "skipped", approved: true, rounds: 0 };
  }

  issue.contractNegotiationStatus = "running";
  issue.planningError = undefined;
  markIssueDirty(issue.id);
  addEvent(state, issue.id, "info", `Contract negotiation started for ${issue.identifier}.`);

  for (let round = 1; round <= maxRounds; round += 1) {
    issue.contractNegotiationAttempt = round;
    issue.contractNegotiationStatus = "running";
    markIssueDirty(issue.id);

    const reviewer = getReviewProvider(state, issue, workflowConfig ?? null);
    const compiled = await compileContractNegotiation(issue, reviewer, workspacePath, round, maxRounds);
    issue.reviewProfile = compiled.meta.reviewProfile;
    markIssueDirty(issue.id);

    const effectiveReviewer = { ...reviewer, command: compiled.command || reviewer.command };
    const promptFile = resolveNegotiationPromptPath(workspacePath, issue, round);
    const decisionFile = resolveNegotiationDecisionPath(workspacePath, issue, round);
    writeFileSync(promptFile, `${compiled.prompt}\n`, "utf8");

    const startedAt = now();
    startContractNegotiationRun(issue, effectiveReviewer, round, promptFile, startedAt, compiled.meta.reviewProfile);
    addEvent(state, issue.id, "progress", `Contract negotiation round ${round}/${maxRounds} started for ${issue.identifier}.`);

    let reviewResult: AgentSessionResult;
    try {
      reviewResult = await runAgentSession(
        state,
        issue,
        effectiveReviewer,
        200 + round,
        workspacePath,
        compiled.prompt,
        promptFile,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      completeContractNegotiationRun(issue, round, null, null, now(), { error: message });
      issue.contractNegotiationStatus = "failed";
      issue.planningError = `Contract negotiation crashed for ${issue.identifier}: ${message}`;
      markIssueDirty(issue.id);
      logger.error({ err: error, issueId: issue.id, round }, "[Planning] Contract negotiation crashed");
      return { status: "failed", approved: false, rounds: round, reviewer: effectiveReviewer };
    }

    const decision = extractContractDecision(reviewResult.output);
    if (!decision) {
      completeContractNegotiationRun(issue, round, reviewResult, null, now(), {
        error: "Reviewer did not emit a parseable contract_decision block.",
      });
      issue.contractNegotiationStatus = "failed";
      issue.planningError = `Contract negotiation failed for ${issue.identifier}: reviewer did not emit a parseable contract_decision block.`;
      markIssueDirty(issue.id);
      logger.warn({ issueId: issue.id, round }, "[Planning] Contract negotiation output was not parseable");
      return { status: "failed", approved: false, rounds: round, reviewer: effectiveReviewer };
    }

    writeFileSync(decisionFile, JSON.stringify(decision, null, 2), "utf8");

    if (decision.status === "approved" && !reviewResult.success) {
      completeContractNegotiationRun(issue, round, reviewResult, decision, now(), {
        error: "Reviewer approved the contract but did not finish the session successfully.",
      });
      issue.contractNegotiationStatus = "failed";
      issue.planningError = `Contract negotiation failed for ${issue.identifier}: reviewer returned an inconsistent approval.`;
      markIssueDirty(issue.id);
      return {
        status: "failed",
        approved: false,
        rounds: round,
        reviewer: effectiveReviewer,
        decision,
      };
    }

    if (decision.status === "approved" && reviewResult.success) {
      completeContractNegotiationRun(issue, round, reviewResult, decision, now());
      issue.contractNegotiationStatus = "approved";
      issue.planningError = undefined;
      markIssueDirty(issue.id);
      addEvent(state, issue.id, "info", `Contract negotiation approved for ${issue.identifier} in round ${round}/${maxRounds}.`);
      return {
        status: "approved",
        approved: true,
        rounds: round,
        reviewer: effectiveReviewer,
        decision,
      };
    }

    completeContractNegotiationRun(issue, round, reviewResult, decision, now());

    if (round >= maxRounds) {
      issue.contractNegotiationStatus = "failed";
      issue.planningError = decision.summary
        ? `Contract negotiation failed for ${issue.identifier}: ${decision.summary}`
        : `Contract negotiation failed for ${issue.identifier} after ${round} round(s).`;
      markIssueDirty(issue.id);
      addEvent(state, issue.id, "error", `Contract negotiation failed for ${issue.identifier} after ${round} round(s).`);
      return {
        status: "failed",
        approved: false,
        rounds: round,
        reviewer: effectiveReviewer,
        decision,
      };
    }

    const feedback = buildContractNegotiationFeedback(decision);
    addEvent(state, issue.id, "info", `Contract negotiation requested contract revisions for ${issue.identifier}; planner is refining round ${round}.`);
    await applyRefinedPlan(state, issue, workspacePath, feedback, round);
    completeContractNegotiationRun(issue, round, reviewResult, decision, now(), { appliedRefinement: true });
  }

  issue.contractNegotiationStatus = "failed";
  issue.planningError = `Contract negotiation failed for ${issue.identifier}.`;
  markIssueDirty(issue.id);
  return { status: "failed", approved: false, rounds: maxRounds };
}
