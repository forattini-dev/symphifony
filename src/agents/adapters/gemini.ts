import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../../types.ts";
import type { CompiledExecution } from "./types.ts";
import type { ProviderAdapter, ProviderCommandOptions } from "./registry.ts";
import { renderPrompt } from "../prompting.ts";
import { buildFullPlanPrompt, resolveEffortForProvider, extractValidationCommands, buildImagePromptSection } from "./shared.ts";
import { REVIEW_RESULT_SCHEMA, extractPlanDirs } from "./commands.ts";

// ── Result contract (embedded in prompt — Gemini CLI has no --json-schema flag) ─

const GEMINI_RESULT_CONTRACT = `
Return a JSON object with this exact schema when finished:
{
  "status": "done" | "continue" | "blocked" | "failed",
  "summary": "one paragraph summary of what was done",
  "root_cause": ["list of root causes found"],
  "changes_made": ["list of files/changes"],
  "validation": { "commands_run": ["..."], "result": "pass" | "partial" | "fail" },
  "open_questions": ["..."],
  "followups": ["..."],
  "nextPrompt": "guidance for next turn if status is continue"
}
`.trim();

// ── Command builder ───────────────────────────────────────────────────────────

export function buildGeminiCommand(options: ProviderCommandOptions): string {
  const parts = ["gemini"];

  if (options.readOnly) {
    // Read-only mode for planning/review — no file edits
    parts.push("--approval-mode plan");
  } else {
    parts.push("--yolo");
  }

  if (options.model) {
    parts.push(`--model ${options.model}`);
  }

  // JSON output enables structured parsing and token tracking
  parts.push("--output-format json");

  if (options.addDirs?.length) {
    parts.push(`--include-directories ${options.addDirs.map((d) => `"${d}"`).join(",")}`);
  }

  // -p triggers non-interactive (headless) mode; stdin provides the prompt content
  parts.push("-p \"\" < \"$FIFONY_PROMPT_FILE\"");
  return parts.join(" ");
}

// ── Adapter ───────────────────────────────────────────────────────────────────

async function compile(
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  plan: IssuePlan,
  config: RuntimeConfig,
  workspacePath: string,
  skillContext: string,
  capabilitiesManifest?: string,
): Promise<CompiledExecution> {
  const effort = resolveEffortForProvider(plan, provider.role, config.defaultEffort) || provider.reasoningEffort;

  let prompt = await renderPrompt("compile-execution-codex", {
    isPlanner: provider.role === "planner",
    isReviewer: provider.role === "reviewer",
    profileInstructions: provider.profileInstructions || "",
    skillContext,
    capabilitiesManifest: capabilitiesManifest || "",
    issueIdentifier: issue.identifier,
    title: issue.title,
    description: issue.description || "(none)",
    workspacePath,
    planPrompt: buildFullPlanPrompt(plan),
    phases: (plan.phases ?? []).map((phase) => ({
      phaseName: phase.phaseName,
      goal: phase.goal,
      outputs: phase.outputs ?? [],
    })),
    suggestedPaths: plan.suggestedPaths ?? [],
    suggestedSkills: plan.suggestedSkills ?? [],
    validationItems: (plan.validation ?? []).map((value) => ({ value })),
    outputContract: GEMINI_RESULT_CONTRACT,
  });

  // Gemini CLI has no --image flag — embed images directly in the prompt
  if (issue.images?.length) {
    const imageSection = buildImagePromptSection(issue.images);
    if (imageSection) prompt = prompt + "\n\n" + imageSection;
  }

  const relativeDirs = extractPlanDirs(plan);
  const codePath = existsSync(join(workspacePath, "worktree")) ? join(workspacePath, "worktree") : workspacePath;
  const absoluteDirs = relativeDirs.map((d) => join(codePath, d));

  const isReadOnlyRole = provider.role === "planner" || provider.role === "reviewer";

  const command = buildGeminiCommand({
    model: provider.model,
    addDirs: absoluteDirs,
    readOnly: isReadOnlyRole,
  });

  const env: Record<string, string> = {
    FIFONY_PLAN_COMPLEXITY: plan.estimatedComplexity,
    FIFONY_PLAN_STEPS: String(plan.steps.length),
    FIFONY_PLAN_PHASES: String(plan.phases?.length || 0),
    FIFONY_EXECUTION_PAYLOAD_FILE: "execution-payload.json",
  };
  if (plan.suggestedPaths?.length) env.FIFONY_PLAN_PATHS = plan.suggestedPaths.join(",");

  const { pre, post } = extractValidationCommands(plan);

  return {
    prompt,
    command,
    env,
    preHooks: pre,
    postHooks: post,
    outputSchema: "",
    payload: null,
    meta: {
      adapter: "gemini",
      reasoningEffort: effort || "default",
      model: provider.model || "default",
      skillsActivated: plan.suggestedSkills || [],
      subagentsRequested: [],
      phasesCount: plan.phases?.length || 0,
    },
  };
}

export const geminiAdapter: ProviderAdapter = {
  buildCommand: buildGeminiCommand,
  buildReviewCommand: (reviewer) => buildGeminiCommand({
    model: reviewer.model,
    readOnly: true,
  }),
  compile,
};
