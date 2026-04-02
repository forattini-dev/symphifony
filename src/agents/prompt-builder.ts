import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  AgentProviderDefinition,
  IssueEntry,
} from "../types.ts";
import { renderPrompt } from "./prompting.ts";
import { buildRecurringFailureContext } from "./review-failure-history.ts";
import { loadCrossAttemptAnalysis } from "../domains/cross-attempt-analysis.ts";
import { traceDir } from "../domains/trace-bundle.ts";
import { findSimilarIssueTraces, persistSimilarTraceSelection, type SimilarTraceHit } from "../domains/trace-retrieval.ts";

/** Build retry context from previous failed attempts for injection into prompts. */
/** Render a single attempt summary in full detail. */
function renderAttemptFull(s: NonNullable<IssueEntry["previousAttemptSummaries"]>[number], index: number): string {
  const lines: string[] = [];
  const phaseLabel = s.phase === "review" ? "review" : s.phase === "crash" ? "crash" : s.phase === "plan" ? "plan" : "execution";
  lines.push(`### Attempt ${index + 1} — ${phaseLabel} failure (plan v${s.planVersion}, exec #${s.executeAttempt})`);

  if (s.phase === "review") {
    lines.push("*The reviewer identified issues with the previous implementation. Focus on addressing the reviewer's feedback — do not redo work that was already approved.*");
  } else if (s.phase === "crash") {
    lines.push("*The agent process crashed or timed out. Simplify the approach — break the work into smaller steps.*");
  }

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
  return lines.join("\n");
}

/** Render an attempt as a compressed one-liner (for older attempts when there are 3+). */
function renderAttemptCompressed(s: NonNullable<IssueEntry["previousAttemptSummaries"]>[number], index: number): string {
  const phaseLabel = s.phase === "review" ? "review" : s.phase === "crash" ? "crash" : s.phase === "plan" ? "plan" : "exec";
  const errorType = s.insight?.errorType ?? "unknown";
  const rootCause = s.insight?.rootCause ?? s.error?.slice(0, 120) ?? "no details";
  const suggestion = s.insight?.suggestion ?? "";
  return `- **Attempt ${index + 1}** (${phaseLabel}, v${s.planVersion}a${s.executeAttempt}): ${errorType} — ${rootCause}${suggestion ? ` → ${suggestion}` : ""}`;
}

const DEFAULT_RETRY_CONTEXT_MAX_CHARS = 10_000;
const TRACE_REFERENCE_ATTEMPTS = 2;

function hasTraceArtifacts(issue: IssueEntry, worktreePath: string): boolean {
  return (issue.previousAttemptSummaries ?? []).some((summary) =>
    existsSync(traceDir(worktreePath, summary.planVersion, summary.executeAttempt)),
  );
}

function findLastDirectiveRelativePath(worktreePath: string, attemptTraceDir: string): string | null {
  const turnsDir = join(attemptTraceDir, "turns");
  if (!existsSync(turnsDir)) return null;
  try {
    const directives = readdirSync(turnsDir)
      .filter((entry) => entry.endsWith(".directive.json"))
      .sort((left, right) => left.localeCompare(right));
    if (directives.length === 0) return null;
    return relative(worktreePath, join(turnsDir, directives[directives.length - 1]!));
  } catch {
    return null;
  }
}

function renderTraceAttempt(
  worktreePath: string,
  summary: NonNullable<IssueEntry["previousAttemptSummaries"]>[number],
  index: number,
): string {
  const tracePath = traceDir(worktreePath, summary.planVersion, summary.executeAttempt);
  if (!existsSync(tracePath)) {
    return renderAttemptFull(summary, index);
  }

  const handoffPath = relative(worktreePath, join(tracePath, "handoff.md"));
  const checkpointPath = relative(worktreePath, join(tracePath, "checkpoint.json"));
  const railsPath = relative(worktreePath, join(tracePath, "rails.json"));
  const manifestPath = relative(worktreePath, join(tracePath, "attempt.json"));
  const diffPatchPath = relative(worktreePath, join(tracePath, "diff.patch"));
  const lastDirectivePath = findLastDirectiveRelativePath(worktreePath, tracePath);
  const lines = [
    renderAttemptFull(summary, index).trimEnd(),
    "**Trace files to inspect selectively:**",
  ];
  if (existsSync(join(tracePath, "handoff.md"))) {
    lines.push(`- \`${handoffPath}\` *(start here for the concise resume summary)*`);
  }
  if (existsSync(join(tracePath, "checkpoint.json"))) {
    lines.push(`- \`${checkpointPath}\``);
  }
  if (existsSync(join(tracePath, "rails.json"))) {
    lines.push(`- \`${railsPath}\` *(active harness rails, budgets, and policy decisions)*`);
  }
  lines.push(`- \`${manifestPath}\``);
  if (lastDirectivePath) {
    lines.push(`- \`${lastDirectivePath}\``);
  }
  if (existsSync(join(tracePath, "diff.patch"))) {
    lines.push(`- \`${diffPatchPath}\``);
  }
  lines.push("*Start with the handoff/checkpoint artifacts, then inspect raw artifacts only if they matter for the failure mode before retrying the same path.*");
  lines.push("");
  return lines.join("\n");
}

function renderCrossAttemptContext(issue: IssueEntry, worktreePath: string): string {
  const currentTraceDir = traceDir(worktreePath, issue.planVersion ?? 1, issue.executeAttempt ?? 1);
  const analysis = loadCrossAttemptAnalysis(currentTraceDir);
  if (!analysis) return "";

  const analysisPath = relative(worktreePath, join(currentTraceDir, "cross-attempt.json"));
  const lines = [
    "## Cross-Attempt Patterns\n",
    `Read \`${analysisPath}\` if you need the full deterministic comparison.`,
    ...analysis.summary.map((entry) => `- ${entry}`),
    "",
  ];
  return lines.join("\n");
}

function renderSimilarIssueTraceContext(
  worktreePath: string,
  currentTraceDir: string,
  hits: SimilarTraceHit[],
): string {
  if (hits.length === 0) return "";

  const selectionArtifactPath = relative(worktreePath, join(currentTraceDir, "similar-traces.json"));

  const lines = [
    "## Similar Prior Failures Across Issues\n",
    "These traces come from other issues with overlapping failure signals. Reuse them only if the match is real, and start with the handoff/checkpoint artifacts before opening raw diffs.\n",
    `Read \`${selectionArtifactPath}\` if you need the full ranked selection and scoring rationale.`,
  ];

  for (const hit of hits) {
    lines.push(`- **${hit.issueIdentifier}** (score ${hit.score}): ${hit.reasons.join("; ")}`);
    if (hit.files.handoff) {
      lines.push(`  - \`${hit.files.handoff}\``);
    }
    if (hit.files.checkpoint) {
      lines.push(`  - \`${hit.files.checkpoint}\``);
    }
    lines.push(`  - \`${hit.files.attempt}\``);
    if (hit.files.diffPatch) {
      lines.push(`  - \`${hit.files.diffPatch}\``);
    }
  }

  lines.push("");
  return lines.join("\n");
}

export function buildRetryContext(
  issue: IssueEntry,
  worktreePath?: string,
  options: { maxChars?: number } = {},
): string {
  const summaries = issue.previousAttemptSummaries;
  const recurringFailureContext = buildRecurringFailureContext(issue);
  if ((!summaries || summaries.length === 0) && !recurringFailureContext) return "";

  const lines: string[] = [];
  const maxChars = options.maxChars ?? DEFAULT_RETRY_CONTEXT_MAX_CHARS;
  const canUseTraceRefs = Boolean(worktreePath && hasTraceArtifacts(issue, worktreePath));
  const currentTraceDir = worktreePath ? traceDir(worktreePath, issue.planVersion ?? 1, issue.executeAttempt ?? 1) : "";
  const crossAttemptContext = worktreePath ? renderCrossAttemptContext(issue, worktreePath) : "";
  const similarIssueTraceHits = worktreePath ? findSimilarIssueTraces(issue, worktreePath, { maxResults: 2 }) : [];
  if (worktreePath && currentTraceDir && similarIssueTraceHits.length > 0) {
    persistSimilarTraceSelection(currentTraceDir, issue, similarIssueTraceHits);
  }
  const similarIssueTraceContext = worktreePath
    ? renderSimilarIssueTraceContext(worktreePath, currentTraceDir, similarIssueTraceHits)
    : "";

  if (summaries && summaries.length > 0) {
    lines.push("## Previous Attempts\n");
    lines.push("The following previous attempts FAILED. Do NOT repeat the same approach. Try a fundamentally different strategy.\n");
    if (canUseTraceRefs) {
      lines.push("This context is not fully self-contained. Read the referenced trace files selectively before repeating the same implementation path.\n");
    } else {
      lines.push("**This context is self-contained** — all evidence you need is below. Do not assume prior knowledge. Read the specific errors, file paths, and suggestions carefully before starting.\n");
    }
  }

  if (crossAttemptContext) {
    lines.push(crossAttemptContext);
  }

  if (similarIssueTraceContext) {
    lines.push(similarIssueTraceContext);
  }

  if (canUseTraceRefs && summaries && summaries.length > 0) {
    const recentAttempts = summaries.slice(-TRACE_REFERENCE_ATTEMPTS);
    lines.push("### Most Relevant Prior Attempts\n");
    for (let i = 0; i < recentAttempts.length; i++) {
      const absoluteIndex = summaries.length - recentAttempts.length + i;
      lines.push(renderTraceAttempt(worktreePath!, recentAttempts[i], absoluteIndex));
    }
  } else if (summaries && summaries.length >= 5) {
    // Smart context selection for 5+ attempts: cluster by error type, deduplicate,
    // show pattern summary + latest 2 in full. Prevents context saturation.
    // Inspired by Claude Code's memory relevance selection via side-query.
    const olderAttempts = summaries.slice(0, -2);
    const recentAttempts = summaries.slice(-2);

    // Cluster older attempts by error type
    const clusters = new Map<string, typeof olderAttempts>();
    for (const s of olderAttempts) {
      const key = s.insight?.errorType ?? "unknown";
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key)!.push(s);
    }

    lines.push(`### Failure Pattern Summary (${olderAttempts.length} earlier attempts)\n`);
    lines.push("These error types have been encountered — avoid all of them:\n");
    for (const [errorType, attempts] of clusters) {
      const representative = attempts[attempts.length - 1]; // latest in cluster
      const suggestion = representative.insight?.suggestion ?? "";
      lines.push(`- **${errorType}** (${attempts.length}×): ${representative.insight?.rootCause ?? representative.error?.slice(0, 120) ?? "unknown"}${suggestion ? ` → *${suggestion}*` : ""}`);
      // If cluster has diverse files, list them for avoidance
      const allFiles = [...new Set(attempts.flatMap((a) => a.insight?.filesInvolved ?? []))];
      if (allFiles.length > 0) {
        lines.push(`  Files involved: ${allFiles.slice(0, 5).map(f => `\`${f}\``).join(", ")}${allFiles.length > 5 ? ` (+${allFiles.length - 5} more)` : ""}`);
      }
    }
    lines.push("");

    lines.push("### Recent Attempts (detailed)\n");
    for (let i = 0; i < recentAttempts.length; i++) {
      lines.push(renderAttemptFull(recentAttempts[i], olderAttempts.length + i));
    }
  } else if (summaries && summaries.length >= 3) {
    // Context compression: compress older attempts, keep latest 2 in full detail
    const olderAttempts = summaries.slice(0, -2);
    const recentAttempts = summaries.slice(-2);

    lines.push(`### Earlier Attempts (compressed, ${olderAttempts.length} total)\n`);
    for (let i = 0; i < olderAttempts.length; i++) {
      lines.push(renderAttemptCompressed(olderAttempts[i], i));
    }
    lines.push("");

    lines.push("### Recent Attempts (detailed)\n");
    for (let i = 0; i < recentAttempts.length; i++) {
      lines.push(renderAttemptFull(recentAttempts[i], olderAttempts.length + i));
    }
  } else {
    // Few attempts — render all in full detail
    for (let i = 0; i < (summaries?.length ?? 0); i++) {
      lines.push(renderAttemptFull(summaries![i], i));
    }
  }

  // Append grading failures from last review cycle if available
  if (issue.lastFailedPhase === "review" && issue.gradingReport) {
    const failedCriteria = issue.gradingReport.criteria.filter((c) =>
      c.result === "FAIL" && ((issue.gradingReport?.blockingVerdict ?? "FAIL") === "FAIL" ? c.blocking : true),
    );
    if (failedCriteria.length > 0) {
      lines.push("## Previous Review Grade: FAIL\n");
      lines.push("The automated reviewer graded your last submission and found these **specific failures with concrete evidence**. Each item below tells you exactly what was wrong and where. Fix the root cause for each — don't just make the symptom go away:");
      for (const c of failedCriteria) {
        lines.push(`- **${c.id}** [${c.category}] FAILED: ${c.description}`);
        lines.push(`  Evidence: ${c.evidence}`);
      }
      lines.push("\nYou MUST address ALL of these before submitting. The reviewer will check each one again with the same criteria.\n");
    }
  }

  if (recurringFailureContext) {
    lines.push(recurringFailureContext);
  }

  // Hard limit to keep retry prompts bounded even with trace references.
  const full = lines.join("\n");
  return full.length > maxChars ? full.slice(0, maxChars) + "\n[...truncated]" : full;
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
