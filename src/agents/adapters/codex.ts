import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../../types.ts";
import type { CompiledExecution } from "./types.ts";
import type { ProviderAdapter, ProviderCommandOptions } from "./registry.ts";
import { renderPrompt } from "../prompting.ts";
import { buildFullPlanPrompt, resolveEffortForProvider, extractValidationCommands } from "./shared.ts";
import { REVIEW_RESULT_SCHEMA, extractPlanDirs } from "./commands.ts";

// ── Result contract (embedded in prompt — no --json-schema flag in codex) ────

const CODEX_RESULT_CONTRACT = `
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

export function buildCodexCommand(options: ProviderCommandOptions): string {
  const parts = ["codex", "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];

  if (options.model && options.model !== "codex") {
    parts.push(`--model ${options.model}`);
  }

  if (options.effort) {
    // Codex uses -c config overrides, not a dedicated --effort flag
    parts.push(`-c reasoning_effort="${options.effort}"`);
  }

  if (options.addDirs?.length) {
    for (const dir of options.addDirs) {
      parts.push(`--add-dir "${dir}"`);
    }
  }

  if (options.imagePaths?.length) {
    for (const img of options.imagePaths) {
      parts.push(`--image "${img}"`);
    }
  }

  if (options.search) {
    parts.push("--search");
  }

  parts.push("< \"$FIFONY_PROMPT_FILE\"");
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

  const prompt = await renderPrompt("compile-execution-codex", {
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
    outputContract: CODEX_RESULT_CONTRACT,
  });

  const relativeDirs = extractPlanDirs(plan);
  const codePath = existsSync(join(workspacePath, "worktree")) ? join(workspacePath, "worktree") : workspacePath;
  const absoluteDirs = relativeDirs.map((d) => join(codePath, d));

  const command = buildCodexCommand({
    model: provider.model,
    addDirs: absoluteDirs,
    effort,
    imagePaths: issue.images?.filter((p) => existsSync(p)),
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
      adapter: "codex",
      reasoningEffort: effort || "default",
      model: provider.model || "default",
      skillsActivated: plan.suggestedSkills || [],
      subagentsRequested: [],
      phasesCount: plan.phases?.length || 0,
    },
  };
}

export const codexAdapter: ProviderAdapter = {
  buildCommand: buildCodexCommand,
  buildReviewCommand: (reviewer, _config) => buildCodexCommand({
    model: reviewer.model,
    effort: reviewer.reasoningEffort,
    // Codex has no --permission-mode or --approval-mode equivalent for read-only review
  }),
  compile,
};
