import type {
  AgentProviderDefinition,
  IssueEntry,
} from "../types.ts";
import { renderPrompt } from "./prompting.ts";
import { buildRecurringFailureContext } from "./review-failure-history.ts";

/** Build retry context from previous failed attempts for injection into prompts. */
export function buildRetryContext(issue: IssueEntry): string {
  const summaries = issue.previousAttemptSummaries;
  const recurringFailureContext = buildRecurringFailureContext(issue);
  if ((!summaries || summaries.length === 0) && !recurringFailureContext) return "";

  const lines: string[] = [];

  if (summaries && summaries.length > 0) {
    lines.push("## Previous Attempts\n");
    lines.push("The following previous attempts FAILED. Do NOT repeat the same approach. Try a fundamentally different strategy.\n");
  }

  for (let i = 0; i < (summaries?.length ?? 0); i++) {
    const s = summaries![i];
    const phaseLabel = s.phase === "review" ? "review" : s.phase === "crash" ? "crash" : s.phase === "plan" ? "plan" : "execution";
    lines.push(`### Attempt ${i + 1} — ${phaseLabel} failure (plan v${s.planVersion}, exec #${s.executeAttempt})`);

    // Phase-specific preamble
    if (s.phase === "review") {
      lines.push("*The reviewer identified issues with the previous implementation. Focus on addressing the reviewer's feedback — do not redo work that was already approved.*");
    } else if (s.phase === "crash") {
      lines.push("*The agent process crashed or timed out. Simplify the approach — break the work into smaller steps.*");
    }

    // Use structured insights when available (richer than raw error text)
    if (s.insight) {
      lines.push(`**Failure type:** ${s.insight.errorType}`);
      lines.push(`**Root cause:** ${s.insight.rootCause}`);
      if (s.insight.failedCommand) lines.push(`**Failed command:** \`${s.insight.failedCommand}\``);
      if (s.insight.filesInvolved.length > 0) {
        lines.push(`**Files involved:** ${s.insight.filesInvolved.map(f => `\`${f}\``).join(", ")}`);
      }
      lines.push(`**What to do differently:** ${s.insight.suggestion}`);
    } else {
      lines.push(`**Error:** ${s.error}`);
    }

    if (s.outputTail) {
      lines.push(`\n<details><summary>Output tail</summary>\n\n\`\`\`\n${s.outputTail}\n\`\`\`\n</details>`);
    }
    if (s.outputFile) {
      lines.push(`*Full output saved in: outputs/${s.outputFile}*`);
    }
    lines.push("");
  }

  // Append grading failures from last review cycle if available
  if (issue.lastFailedPhase === "review" && issue.gradingReport) {
    const failedCriteria = issue.gradingReport.criteria.filter((c) =>
      c.result === "FAIL" && ((issue.gradingReport?.blockingVerdict ?? "FAIL") === "FAIL" ? c.blocking : true),
    );
    if (failedCriteria.length > 0) {
      lines.push("## Previous Review Grade: FAIL\n");
      lines.push("The automated reviewer graded your last submission and found these specific failures:");
      for (const c of failedCriteria) {
        lines.push(`- **${c.id}** [${c.category}] FAILED: ${c.description} — ${c.evidence}`);
      }
      lines.push("\nYou MUST address ALL of these before submitting. The reviewer will check each one again.\n");
    }
  }

  if (recurringFailureContext) {
    lines.push(recurringFailureContext);
  }

  // Hard limit to ~2000 tokens (~8000 chars)
  const full = lines.join("\n");
  return full.length > 8000 ? full.slice(0, 8000) + "\n[...truncated]" : full;
}

export async function buildPrompt(issue: IssueEntry, _workflowDefinition: null): Promise<string> {
  const rendered = await renderPrompt("workflow-default", { issue, attempt: issue.attempts || 0 });

  if (!issue.plan?.steps?.length) {
    return rendered;
  }

  const planSection = await renderPrompt("workflow-plan-section", {
    estimatedComplexity: issue.plan.estimatedComplexity,
    summary: issue.plan.summary,
    steps: issue.plan.steps.map((step) => ({
      step: step.step,
      action: step.action,
      files: step.files ?? [],
      details: step.details ?? "",
    })),
  });

  return `${rendered}\n\n${planSection}`;
}

// Approximate context window sizes by model name fragment (conservative lower bounds).
// Used to compute context pressure % when the provider doesn't surface this directly.
const CONTEXT_WINDOW_BY_MODEL: Array<[string, number]> = [
  ["claude-3-5", 200_000],
  ["claude-3-7", 200_000],
  ["claude-opus-4", 200_000],
  ["claude-sonnet-4", 200_000],
  ["claude-haiku-4", 200_000],
  ["claude", 200_000],
  ["gemini-2.5", 1_000_000],
  ["gemini-2.0", 1_000_000],
  ["gemini-1.5", 1_000_000],
  ["gemini", 128_000],
  ["gpt-4o", 128_000],
  ["gpt-4", 128_000],
  ["o1", 200_000],
  ["o3", 200_000],
  ["codex", 128_000],
];

export function resolveContextWindow(model: string | undefined): number | null {
  if (!model) return null;
  const lc = model.toLowerCase();
  for (const [fragment, size] of CONTEXT_WINDOW_BY_MODEL) {
    if (lc.includes(fragment)) return size;
  }
  return null;
}

export async function buildTurnPrompt(
  issue: IssueEntry,
  basePrompt: string,
  previousOutput: string,
  turnIndex: number,
  maxTurns: number,
  nextPrompt: string,
): Promise<string> {
  if (turnIndex === 1) return basePrompt;

  const turnsRemaining = maxTurns - turnIndex + 1;
  const isFinalTurns = turnsRemaining <= 2;

  // Compute context pressure from accumulated token usage
  const cumulativeTokens = issue.tokenUsage?.totalTokens ?? 0;
  const contextWindow = resolveContextWindow(issue.tokenUsage?.model);
  const contextWindowPct = contextWindow && cumulativeTokens > 0
    ? Math.round((cumulativeTokens / contextWindow) * 100)
    : null;
  const isContextPressure = contextWindowPct !== null && contextWindowPct >= 70;

  return renderPrompt("agent-turn", {
    issueIdentifier: issue.identifier,
    turnIndex,
    maxTurns,
    turnsRemaining,
    isFinalTurns,
    isContextPressure,
    contextWindowPct: contextWindowPct ?? 0,
    basePrompt,
    continuation: nextPrompt.trim() || "Continue the work, inspect the workspace, and move the issue toward completion.",
    outputTail: previousOutput.trim() || "No previous output captured.",
  });
}

export async function buildProviderBasePrompt(
  provider: AgentProviderDefinition,
  issue: IssueEntry,
  basePrompt: string,
  workspacePath: string,
  skillContext: string,
  capabilitiesManifest?: string,
): Promise<string> {
  return renderPrompt("agent-provider-base", {
    isPlanner: provider.role === "planner",
    isReviewer: provider.role === "reviewer",
    hasImpeccableOverlay: provider.overlays?.includes("impeccable") ?? false,
    hasFrontendDesignOverlay: provider.overlays?.includes("frontend-design") ?? false,
    profileInstructions: provider.profileInstructions || "",
    skillContext,
    capabilitiesManifest: capabilitiesManifest || "",
    capabilityCategory: "",
    selectionReason: provider.selectionReason ?? "",
    overlays: provider.overlays ?? [],
    targetPaths: issue.paths ?? [],
    workspacePath,
    basePrompt,
  });
}
