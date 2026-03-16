import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../types.ts";
import type { CompiledExecution } from "./index.ts";
import {
  buildFullPlanPrompt,
  resolveEffortForProvider,
  extractValidationCommands,
} from "./shared.ts";

// Codex uses a textual result contract embedded in the prompt (no --json-schema flag)
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

export function compileForCodex(
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  plan: IssuePlan,
  config: RuntimeConfig,
  workspacePath: string,
  skillContext: string,
): CompiledExecution {
  const effort = resolveEffortForProvider(plan, provider.role, config.defaultEffort);

  // ── Build maximalist prompt ──────────────────────────────────────────────
  const sections: string[] = [];

  // Role
  if (provider.role === "reviewer") {
    sections.push("Role: reviewer. Inspect and review the implementation critically.");
  } else if (provider.role === "planner") {
    sections.push("Role: planner. Analyze and prepare an execution plan.");
  } else {
    sections.push("Role: executor. Implement the required changes in the workspace.");
  }

  // Profile
  if (provider.profileInstructions) {
    sections.push("", "## Agent Profile", provider.profileInstructions);
  }

  // Skills
  if (skillContext) sections.push("", skillContext);

  // Issue context
  sections.push(
    "",
    `Issue: ${issue.identifier}`,
    `Title: ${issue.title}`,
    `Description: ${issue.description || "(none)"}`,
    `Workspace: ${workspacePath}`,
  );

  // Plan — the core
  sections.push("", buildFullPlanPrompt(plan));

  // Codex-specific: checkpoint-based execution
  if (plan.phases?.length) {
    sections.push("", "## Checkpoint Execution (Codex mode)");
    sections.push("Execute in strict phases. After each phase, verify outputs before proceeding.");
    for (const phase of plan.phases) {
      sections.push(`- **${phase.phaseName}**: ${phase.goal}`);
      if (phase.outputs?.length) sections.push(`  Checkpoint: verify ${phase.outputs.join(", ")} before next phase.`);
    }
  } else {
    sections.push("", "## Execution Order");
    sections.push("Execute steps in order. Verify each step's 'doneWhen' criterion before proceeding.");
  }

  // Path focus
  if (plan.suggestedPaths?.length) {
    sections.push("", `Target paths: ${plan.suggestedPaths.join(", ")}`);
    sections.push("Focus changes on these paths. Do not make unnecessary changes elsewhere.");
  }

  // Codex-specific: tooling delegation as structured instructions
  if (plan.toolingDecision?.shouldUseSkills && plan.toolingDecision.skillsToUse?.length) {
    sections.push("", "## Specialized Procedures");
    for (const skill of plan.toolingDecision.skillsToUse) {
      sections.push(`- Apply **${skill.name}** procedure: ${skill.why}`);
    }
  }

  // Enforcement
  if (plan.validation?.length) {
    sections.push("", "## Pre-completion checks");
    sections.push("Before reporting done, run:");
    plan.validation.forEach((v) => sections.push(`- ${v}`));
  }

  // Result contract (Codex doesn't have --json-schema)
  sections.push("", "## Output Format", "", CODEX_RESULT_CONTRACT);

  const prompt = sections.join("\n");

  // ── Build command ────────────────────────────────────────────────────────
  const cmdParts = ["codex", "exec", "--skip-git-repo-check"];

  // Codex doesn't support --reasoning-effort as a flag (effort is model selection)
  // Add full-auto for medium+ complexity when executor role
  if (provider.role === "executor" && (plan.estimatedComplexity === "medium" || plan.estimatedComplexity === "high")) {
    // full-auto allows unrestricted workspace writes
  }

  cmdParts.push("< \"$SYMPHIFONY_PROMPT_FILE\"");
  const command = cmdParts.join(" ");

  // ── Env vars ─────────────────────────────────────────────────────────────
  const env: Record<string, string> = {
    SYMPHIFONY_PLAN_COMPLEXITY: plan.estimatedComplexity,
    SYMPHIFONY_PLAN_STEPS: String(plan.steps.length),
    SYMPHIFONY_PLAN_PHASES: String(plan.phases?.length || 0),
  };
  if (plan.suggestedPaths?.length) env.SYMPHIFONY_PLAN_PATHS = plan.suggestedPaths.join(",");

  // ── Hooks ────────────────────────────────────────────────────────────────
  const { pre, post } = extractValidationCommands(plan);

  return {
    prompt,
    command,
    env,
    preHooks: pre,
    postHooks: post,
    outputSchema: "",
    meta: {
      adapter: "codex",
      reasoningEffort: effort || "default",
      skillsActivated: plan.toolingDecision?.skillsToUse?.map((s) => s.name) || [],
      subagentsRequested: [], // Codex doesn't have native subagents
      phasesCount: plan.phases?.length || 0,
    },
  };
}
