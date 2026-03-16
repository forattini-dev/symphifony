import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../types.ts";
import type { CompiledExecution } from "./index.ts";
import {
  buildFullPlanPrompt,
  buildToolingSection,
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

export function compileForClaude(
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  plan: IssuePlan,
  config: RuntimeConfig,
  workspacePath: string,
  skillContext: string,
): CompiledExecution {
  const effort = resolveEffortForProvider(plan, provider.role, config.defaultEffort);
  // Claude caps at "high"
  const claudeEffort = effort === "extra-high" ? "high" : effort;

  // ── Build maximalist prompt ──────────────────────────────────────────────
  const sections: string[] = [];

  // Role instructions
  if (provider.role === "planner") {
    sections.push("Role: planner. Analyze the issue and prepare an execution plan.");
  } else if (provider.role === "reviewer") {
    sections.push("Role: reviewer. Inspect and review the implementation critically.");
  } else {
    sections.push("Role: executor. Implement the required changes.");
  }

  // Profile instructions
  if (provider.profileInstructions) {
    sections.push("", "## Agent Profile", provider.profileInstructions);
  }

  // Skill context
  if (skillContext) sections.push("", skillContext);

  // Plan — the core
  sections.push("", buildFullPlanPrompt(plan));

  // Claude-specific: subagent instructions
  if (plan.toolingDecision?.shouldUseSubagents && plan.toolingDecision.subagentsToUse?.length) {
    sections.push("", "## Subagent Strategy (Claude-specific)");
    sections.push("You have access to the Agent tool for spawning subagents. Use them for:");
    for (const sa of plan.toolingDecision.subagentsToUse) {
      sections.push(`- **${sa.name}** (${sa.role}): ${sa.why}`);
    }
    sections.push("", "Launch subagents for independent subtasks to maximize parallelism.");
    sections.push("Use the main thread for coordination and integration.");
  }

  // Claude-specific: skill activation
  if (plan.toolingDecision?.shouldUseSkills && plan.toolingDecision.skillsToUse?.length) {
    sections.push("", "## Skills to Activate");
    for (const skill of plan.toolingDecision.skillsToUse) {
      sections.push(`- Invoke **/${skill.name}** — ${skill.why}`);
    }
  }

  // Path focus
  if (plan.suggestedPaths?.length) {
    sections.push("", `Target paths: ${plan.suggestedPaths.join(", ")}`);
  }

  // Workspace
  sections.push("", `Workspace: ${workspacePath}`);

  // Issue context
  sections.push(
    "",
    `Issue: ${issue.identifier}`,
    `Title: ${issue.title}`,
    `Description: ${issue.description || "(none)"}`,
  );

  // Structured payload reference
  sections.push(
    "",
    "## Structured Input",
    "The file `fifony-execution-payload.json` in the workspace contains the canonical structured data for this task.",
    "Use it as the source of truth for constraints, success criteria, execution intent, and plan details.",
    "If there is any conflict between this prompt and the structured fields in the payload, prioritize the payload.",
  );

  // Enforcement
  if (plan.validation?.length) {
    sections.push("", "## Pre-completion enforcement");
    sections.push("Before reporting done, verify:");
    plan.validation.forEach((v) => sections.push(`- ${v}`));
  }

  const prompt = sections.join("\n");

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
