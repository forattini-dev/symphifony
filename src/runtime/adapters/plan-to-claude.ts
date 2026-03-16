import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../types.ts";
import type { CompiledExecution } from "./index.ts";
import { renderPrompt } from "../../prompting.ts";
import { buildFullPlanPrompt, resolveEffortForProvider, extractValidationCommands } from "./shared.ts";
import { buildClaudeCommand, CLAUDE_RESULT_SCHEMA } from "./commands.ts";

export async function compileForClaude(
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

  const command = buildClaudeCommand({
    model: provider.model,
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
