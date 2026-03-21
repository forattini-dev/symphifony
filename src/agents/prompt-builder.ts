import type {
  AgentProviderDefinition,
  IssueEntry,
} from "../types.ts";
import { renderPrompt } from "./prompting.ts";

/** Build retry context from previous failed attempts for injection into prompts. */
export function buildRetryContext(issue: IssueEntry): string {
  const summaries = issue.previousAttemptSummaries;
  if (!summaries || summaries.length === 0) return "";

  const lines = ["## Previous Attempts\n"];
  lines.push("The following previous attempts FAILED. Do NOT repeat the same approach. Try a fundamentally different strategy.\n");

  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
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

export async function buildTurnPrompt(
  issue: IssueEntry,
  basePrompt: string,
  previousOutput: string,
  turnIndex: number,
  maxTurns: number,
  nextPrompt: string,
): Promise<string> {
  if (turnIndex === 1) return basePrompt;

  return renderPrompt("agent-turn", {
    issueIdentifier: issue.identifier,
    turnIndex,
    maxTurns,
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
    capabilityCategory: provider.capabilityCategory || "",
    selectionReason: provider.selectionReason ?? "No additional routing reason.",
    overlays: provider.overlays ?? [],
    targetPaths: issue.paths ?? [],
    workspacePath,
    basePrompt,
  });
}
