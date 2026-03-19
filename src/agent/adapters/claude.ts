import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../types.ts";
import type { CompiledExecution } from "./types.ts";
import type { ProviderAdapter, ProviderCommandOptions } from "./registry.ts";
import { renderPrompt } from "../../prompting.ts";
import { buildFullPlanPrompt, resolveEffortForProvider, extractValidationCommands } from "./shared.ts";
import { CLAUDE_RESULT_SCHEMA, REVIEW_RESULT_SCHEMA, extractPlanDirs } from "./commands.ts";

// ── Command builder ───────────────────────────────────────────────────────────

export function buildClaudeCommand(options: ProviderCommandOptions): string {
  const parts = ["claude", "--print"];

  if (!options.noToolAccess) {
    parts.push("--dangerously-skip-permissions");
  }

  parts.push("--no-session-persistence", "--output-format json");

  if (options.effort) {
    parts.push(`--effort ${options.effort}`);
  }

  if (options.jsonSchema) {
    parts.push(`--json-schema '${options.jsonSchema}'`);
  }

  if (options.addDirs?.length) {
    for (const dir of options.addDirs) {
      parts.push(`--add-dir "${dir}"`);
    }
  }

  if (options.model && options.model !== "claude") {
    parts.splice(1, 0, `--model ${options.model}`);
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
): Promise<CompiledExecution> {
  const effort = resolveEffortForProvider(plan, provider.role, config.defaultEffort);

  const prompt = await renderPrompt("compile-execution-claude", {
    isPlanner: provider.role === "planner",
    isReviewer: provider.role === "reviewer",
    profileInstructions: provider.profileInstructions || "",
    skillContext,
    planPrompt: buildFullPlanPrompt(plan),
    subagentsToUse: plan.toolingDecision?.shouldUseSubagents ? (plan.toolingDecision.subagentsToUse ?? []) : [],
    skillsToUse: plan.toolingDecision?.shouldUseSkills ? (plan.toolingDecision.skillsToUse ?? []) : [],
    suggestedPaths: plan.suggestedPaths ?? [],
    workspacePath,
    issueIdentifier: issue.identifier,
    title: issue.title,
    description: issue.description || "(none)",
    validationItems: (plan.validation ?? []).map((value) => ({ value })),
  });

  const relativeDirs = extractPlanDirs(plan);
  const codePath = existsSync(join(workspacePath, "worktree")) ? join(workspacePath, "worktree") : workspacePath;
  const absoluteDirs = relativeDirs.map((d) => join(codePath, d));

  const command = buildClaudeCommand({
    model: provider.model,
    effort,
    addDirs: absoluteDirs,
    jsonSchema: CLAUDE_RESULT_SCHEMA,
  });

  const env: Record<string, string> = {
    FIFONY_PLAN_COMPLEXITY: plan.estimatedComplexity,
    FIFONY_PLAN_STEPS: String(plan.steps.length),
    FIFONY_EXECUTION_PAYLOAD_FILE: "fifony-execution-payload.json",
  };
  if (plan.suggestedPaths?.length) env.FIFONY_PLAN_PATHS = plan.suggestedPaths.join(",");
  if (plan.toolingDecision?.skillsToUse?.length) {
    env.FIFONY_PLAN_SKILLS = plan.toolingDecision.skillsToUse.map((s) => s.name).join(",");
  }

  const { pre, post } = extractValidationCommands(plan);

  return {
    prompt,
    command,
    env,
    preHooks: pre,
    postHooks: post,
    outputSchema: CLAUDE_RESULT_SCHEMA,
    payload: null,
    meta: {
      adapter: "claude",
      reasoningEffort: effort || "default",
      model: provider.model || "default",
      skillsActivated: plan.toolingDecision?.skillsToUse?.map((s) => s.name) || [],
      subagentsRequested: plan.toolingDecision?.subagentsToUse?.map((a) => a.name) || [],
      phasesCount: plan.phases?.length || 0,
    },
  };
}

export const claudeAdapter: ProviderAdapter = {
  buildCommand: buildClaudeCommand,
  buildReviewCommand: (reviewer) => buildClaudeCommand({
    model: reviewer.model,
    effort: reviewer.reasoningEffort,
    jsonSchema: REVIEW_RESULT_SCHEMA,
  }),
  compile,
};
