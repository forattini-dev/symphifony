import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../types.ts";
import type { CompiledExecution } from "./index.ts";
import { renderPrompt } from "../../prompting.ts";
import {
  buildFullPlanPrompt,
  resolveEffortForProvider,
  extractValidationCommands,
} from "./shared.ts";

const CLAUDE_RESULT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "continue", "blocked", "failed"] },
    summary: { type: "string" },
    nextPrompt: { type: "string" },
  },
  required: ["status"],
});

export async function compileForClaude(
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  plan: IssuePlan,
  config: RuntimeConfig,
  workspacePath: string,
  skillContext: string,
): Promise<CompiledExecution> {
  const effort = resolveEffortForProvider(plan, provider.role, config.defaultEffort);
  // Claude caps at "high"
  const claudeEffort = effort === "extra-high" ? "high" : effort;
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

  // ── Build command ────────────────────────────────────────────────────────
  const cmdParts = [
    "claude",
    "--print",
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--output-format json",
    `--json-schema '${CLAUDE_RESULT_SCHEMA}'`,
  ];

  if (claudeEffort) cmdParts.splice(2, 0, `--reasoning-effort ${claudeEffort}`);
  // Inject --model from provider definition (set by WorkflowConfig)
  if (provider.model) cmdParts.splice(2, 0, `--model ${provider.model}`);
  cmdParts.push("< \"$FIFONY_PROMPT_FILE\"");

  const command = cmdParts.join(" ");

  // ── Env vars ─────────────────────────────────────────────────────────────
  const env: Record<string, string> = {
    FIFONY_PLAN_COMPLEXITY: plan.estimatedComplexity,
    FIFONY_PLAN_STEPS: String(plan.steps.length),
  };
  if (plan.suggestedPaths?.length) env.FIFONY_PLAN_PATHS = plan.suggestedPaths.join(",");
  if (plan.toolingDecision?.skillsToUse?.length) {
    env.FIFONY_PLAN_SKILLS = plan.toolingDecision.skillsToUse.map((s) => s.name).join(",");
  }

  // ── Hooks ────────────────────────────────────────────────────────────────
  const { pre, post } = extractValidationCommands(plan);

  // Point to payload file
  env.FIFONY_EXECUTION_PAYLOAD_FILE = "fifony-execution-payload.json";

  return {
    prompt,
    command,
    env,
    preHooks: pre,
    postHooks: post,
    outputSchema: CLAUDE_RESULT_SCHEMA,
    payload: null, // Set by compileExecution() after adapter returns
    meta: {
      adapter: "claude",
      reasoningEffort: claudeEffort || "default",
      model: provider.model || "default",
      skillsActivated: plan.toolingDecision?.skillsToUse?.map((s) => s.name) || [],
      subagentsRequested: plan.toolingDecision?.subagentsToUse?.map((a) => a.name) || [],
      phasesCount: plan.phases?.length || 0,
    },
  };
}
