import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, ReviewProfile, ReviewScope } from "../../types.ts";
import type { CompiledContractNegotiation, CompiledExecution, CompiledReview, ExecutionAudit } from "./types.ts";
import { buildExecutionPayload, buildFullPlanPrompt, deriveExecutionContract, normalizeAcceptanceCriteria } from "./shared.ts";
import { ADAPTERS } from "./registry.ts";
import { renderPrompt } from "../prompting.ts";
import { deriveReviewProfile } from "../review-profile.ts";

export type { CompiledExecution, CompiledReview, ExecutionAudit };
export type { CompiledContractNegotiation };

function buildReviewScopeConfig(scope: ReviewScope): {
  label: string;
  goal: string;
  verdictRule: string;
  instructions: string[];
} {
  if (scope === "checkpoint") {
    return {
      label: "checkpoint gate",
      goal: "Decide whether the implementation is ready to advance from execution into final review.",
      verdictRule: "Set overallVerdict to FAIL if any criterion fails. Set blockingVerdict to FAIL only if a blocking criterion fails. The checkpoint gate passes when blockingVerdict is PASS, even if advisory criteria fail.",
      instructions: [
        "Prioritize execution readiness, contractual blocking criteria, and obvious regressions.",
        "Treat missing or skipped blocking criteria as FAIL. Advisory issues may remain advisory.",
        "If blockingVerdict is PASS, emit FIFONY_STATUS=done and clearly separate any non-blocking follow-up items.",
      ],
    };
  }

  return {
    label: "final review",
    goal: "Decide whether the implementation satisfies the contract well enough to leave automated review.",
    verdictRule: "Set overallVerdict to FAIL if any criterion fails. Set blockingVerdict to FAIL only if a blocking criterion fails. The final review gate passes when blockingVerdict is PASS; advisory failures must still be reported as non-blocking findings.",
    instructions: [
      "Evaluate the full contract, including blocking and advisory criteria.",
      "Do not soften blocking failures. Advisory findings should be explicit but must remain non-blocking.",
      "If blockingVerdict is PASS, emit FIFONY_STATUS=done and list any advisory follow-ups separately.",
    ],
  };
}

// ── Compile execution ────────────────────────────────────────────────────────

export async function compileExecution(
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  config: RuntimeConfig,
  workspacePath: string,
  skillContext: string,
  capabilitiesManifest?: string,
): Promise<CompiledExecution | null> {
  const plan = issue.plan;
  if (!plan?.steps?.length) return null;

  const adapter = ADAPTERS[provider.provider];
  if (!adapter) return null;

  const payload = buildExecutionPayload(issue, provider, plan, workspacePath);
  const compiled = await adapter.compile(issue, provider, plan, config, workspacePath, skillContext, capabilitiesManifest);
  compiled.payload = payload;
  return compiled;
}

// ── Shared reviewer template vars ────────────────────────────────────────────

function buildReviewerTemplateVars(reviewer: AgentProviderDefinition, reviewProfile: ReviewProfile) {
  return {
    reviewerProvider: reviewer.provider,
    reviewerModel: reviewer.model || "",
    reviewerEffort: reviewer.reasoningEffort || "",
    reviewerSelectionReason: reviewer.selectionReason || "",
    reviewerOverlays: (reviewer.overlays ?? []).map((value) => ({ value })),
    reviewProfile,
    reviewProfileSecondary: reviewProfile.secondary.map((value) => ({ value })),
    reviewProfileRationale: reviewProfile.rationale.map((value) => ({ value })),
    reviewProfileFocusAreas: reviewProfile.focusAreas.map((value) => ({ value })),
    reviewProfileFailureModes: reviewProfile.failureModes.map((value) => ({ value })),
    reviewProfileEvidencePriorities: reviewProfile.evidencePriorities.map((value) => ({ value })),
  };
}

// ── Compile review ───────────────────────────────────────────────────────────

export async function compileReview(
  issue: IssueEntry,
  reviewer: AgentProviderDefinition,
  workspacePath: string,
  diffSummary: string,
  config?: RuntimeConfig,
  playwrightMcpConfigPath?: string,
  scope: ReviewScope = "final",
): Promise<CompiledReview> {
  const plan = issue.plan;
  const acceptanceCriteria = plan ? normalizeAcceptanceCriteria(plan) : [];
  const executionContract = plan ? deriveExecutionContract(plan) : null;
  const reviewProfile = deriveReviewProfile(issue);
  const scopeConfig = buildReviewScopeConfig(scope);

  const hasFrontendChanges = !!playwrightMcpConfigPath;

  // Light review: skip adversarial persona, grading_report, and heavy structured
  // output for trivial/low complexity solo issues. Just a pass/fail check.
  const complexity = issue.plan?.estimatedComplexity;
  const harnessMode = issue.plan?.harnessMode ?? "standard";
  const lightReview = (complexity === "trivial" || complexity === "low")
    && (harnessMode === "solo" || harnessMode === "standard");

  const prompt = await renderPrompt("compile-review", {
    issueIdentifier: issue.identifier,
    title: issue.title,
    description: issue.description || "(none)",
    workspacePath,
    planPrompt: plan ? buildFullPlanPrompt(plan) : "",
    acceptanceCriteria,
    deliverables: (executionContract?.deliverables ?? []).map((value) => ({ value })),
    requiredChecks: (executionContract?.requiredChecks ?? []).map((value) => ({ value })),
    requiredEvidence: (executionContract?.requiredEvidence ?? []).map((value) => ({ value })),
    executionContract,
    reviewScope: scope,
    reviewScopeLabel: scopeConfig.label,
    reviewScopeGoal: scopeConfig.goal,
    reviewScopeVerdictRule: scopeConfig.verdictRule,
    reviewScopeInstructions: scopeConfig.instructions.map((value) => ({ value })),
    ...buildReviewerTemplateVars(reviewer, reviewProfile),
    diffSummary,
    hasFrontendChanges,
    images: issue.images?.length ? issue.images : undefined,
    preReviewValidation: issue.preReviewValidation ?? null,
    lightReview,
  });

  const adapter = ADAPTERS[reviewer.provider];
  let command = adapter
    ? adapter.buildReviewCommand(reviewer, config)
    : reviewer.command;

  if (playwrightMcpConfigPath) {
    // Inject Playwright MCP before the stdin redirect
    command = command.replace(/ < "\$FIFONY_PROMPT_FILE"$/, ` --mcp-config "${playwrightMcpConfigPath}" < "$FIFONY_PROMPT_FILE"`);
  }

  return {
    prompt,
    command,
    meta: {
      scope,
      reviewProfile,
    },
  };
}

export async function compileContractNegotiation(
  issue: IssueEntry,
  reviewer: AgentProviderDefinition,
  workspacePath: string,
  round: number,
  maxRounds: number,
): Promise<CompiledContractNegotiation> {
  const plan = issue.plan;
  const acceptanceCriteria = plan ? normalizeAcceptanceCriteria(plan) : [];
  const executionContract = plan ? deriveExecutionContract(plan) : null;
  const reviewProfile = deriveReviewProfile(issue);
  const priorNegotiationRuns = Array.isArray(issue.contractNegotiationRuns) ? issue.contractNegotiationRuns : [];
  const previousRun = [...priorNegotiationRuns]
    .filter((entry) => entry.status === "completed")
    .sort((left, right) => Date.parse(right.completedAt ?? right.startedAt) - Date.parse(left.completedAt ?? left.startedAt))[0];

  const prompt = await renderPrompt("compile-contract-negotiation", {
    issueIdentifier: issue.identifier,
    title: issue.title,
    description: issue.description || "(none)",
    workspacePath,
    round,
    maxRounds,
    planPrompt: plan ? buildFullPlanPrompt(plan) : "",
    acceptanceCriteria,
    deliverables: (executionContract?.deliverables ?? []).map((value) => ({ value })),
    requiredChecks: (executionContract?.requiredChecks ?? []).map((value) => ({ value })),
    requiredEvidence: (executionContract?.requiredEvidence ?? []).map((value) => ({ value })),
    executionContract,
    ...buildReviewerTemplateVars(reviewer, reviewProfile),
    currentNegotiationStatus: issue.contractNegotiationStatus || "",
    priorNegotiationSummary: previousRun?.summary
      ? `${previousRun.summary}\n${previousRun.rationale ? `Reason: ${previousRun.rationale}` : ""}`.trim()
      : "",
  });

  const adapter = ADAPTERS[reviewer.provider];
  // Contract negotiation must NOT use --json-schema: the agent needs to emit a
  // free-form ```json contract_decision``` block which is incompatible with a
  // forced JSON schema. Use the plain read-only base command instead.
  const command = adapter
    ? adapter.buildCommand({ model: reviewer.model, effort: reviewer.reasoningEffort, readOnly: true })
    : reviewer.command;

  return {
    prompt,
    command,
    meta: {
      reviewProfile,
      round,
      maxRounds,
    },
  };
}

// ── Audit ────────────────────────────────────────────────────────────────────

export function buildExecutionAudit(
  provider: AgentProviderDefinition,
  compiled: CompiledExecution | null,
  issue: IssueEntry,
  durationMs: number,
  result: string,
): ExecutionAudit {
  return {
    runtime: provider.provider,
    model: provider.model || compiled?.meta.model || "default",
    effort: provider.reasoningEffort || compiled?.meta.reasoningEffort || "default",
    role: provider.role,
    skillsActivated: compiled?.meta.skillsActivated || [],
    subagentsRequested: compiled?.meta.subagentsRequested || [],
    durationMs,
    tokenUsage: issue.tokenUsage ?? null,
    diffStats: issue.filesChanged != null
      ? { filesChanged: issue.filesChanged, linesAdded: issue.linesAdded || 0, linesRemoved: issue.linesRemoved || 0 }
      : null,
    result,
    compiledAt: compiled ? new Date().toISOString() : "",
    completedAt: new Date().toISOString(),
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

export function persistCompilationArtifacts(workspacePath: string, compiled: CompiledExecution): void {
  try {
    writeFileSync(
      join(workspacePath, "compiled-execution.json"),
      JSON.stringify({
        adapter: compiled.meta.adapter,
        model: compiled.meta.model,
        reasoningEffort: compiled.meta.reasoningEffort,
        providerCapabilities: compiled.meta.providerCapabilities,
        skillsActivated: compiled.meta.skillsActivated,
        subagentsRequested: compiled.meta.subagentsRequested,
        phasesCount: compiled.meta.phasesCount,
        preHooks: compiled.preHooks,
        postHooks: compiled.postHooks,
        hasOutputSchema: !!compiled.outputSchema,
        hasPayload: !!compiled.payload,
        command: compiled.command,
        promptLength: compiled.prompt.length,
        compiledAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );
  } catch { /* optional audit data */ }

  try {
    writeFileSync(join(workspacePath, "prompt.md"), compiled.prompt, "utf8");
  } catch { /* optional */ }

  if (compiled.payload) {
    try {
      writeFileSync(
        join(workspacePath, "execution-payload.json"),
        JSON.stringify(compiled.payload, null, 2),
        "utf8",
      );
    } catch { /* optional */ }
  }
}

export function persistExecutionAudit(workspacePath: string, audit: ExecutionAudit): void {
  try {
    writeFileSync(
      join(workspacePath, "execution-audit.json"),
      JSON.stringify(audit, null, 2),
      "utf8",
    );
  } catch { /* optional audit data */ }
}
