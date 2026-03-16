import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../types.ts";
import type { CompiledExecution } from "./index.ts";
import { renderPrompt } from "../../prompting.ts";
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

export async function compileForCodex(
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  plan: IssuePlan,
  config: RuntimeConfig,
  workspacePath: string,
  skillContext: string,
): Promise<CompiledExecution> {
  const effort = resolveEffortForProvider(plan, provider.role, config.defaultEffort);
  const prompt = await renderPrompt("compile-execution-codex", {
    isPlanner: provider.role === "planner",
    isReviewer: provider.role === "reviewer",
    profileInstructions: provider.profileInstructions || "",
    skillContext,
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
    skillsToUse: plan.toolingDecision?.shouldUseSkills ? (plan.toolingDecision.skillsToUse ?? []) : [],
    validationItems: (plan.validation ?? []).map((value) => ({ value })),
    outputContract: CODEX_RESULT_CONTRACT,
  });

  // ── Build command ────────────────────────────────────────────────────────
  const cmdParts = ["codex", "exec", "--skip-git-repo-check"];

  // Inject --model from provider definition (set by WorkflowConfig)
  if (provider.model && provider.model !== "codex") {
    cmdParts.push(`--model ${provider.model}`);
  }

  // Inject --add-dir for relevant directories from the plan
  if (plan.suggestedPaths?.length) {
    const dirs = new Set<string>();
    for (const p of plan.suggestedPaths) {
      // Extract directory portion (e.g. "src/runtime/agent.ts" → "src/runtime")
      const lastSlash = p.lastIndexOf("/");
      if (lastSlash > 0) dirs.add(p.slice(0, lastSlash));
      else if (!p.includes(".")) dirs.add(p); // bare directory name like "src"
    }
    for (const dir of dirs) {
      cmdParts.push(`--add-dir ${dir}`);
    }
  }

  cmdParts.push("< \"$FIFONY_PROMPT_FILE\"");
  const command = cmdParts.join(" ");

  // ── Env vars ─────────────────────────────────────────────────────────────
  const env: Record<string, string> = {
    FIFONY_PLAN_COMPLEXITY: plan.estimatedComplexity,
    FIFONY_PLAN_STEPS: String(plan.steps.length),
    FIFONY_PLAN_PHASES: String(plan.phases?.length || 0),
  };
  if (plan.suggestedPaths?.length) env.FIFONY_PLAN_PATHS = plan.suggestedPaths.join(",");

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
    outputSchema: "",
    payload: null, // Set by compileExecution() after adapter returns
    meta: {
      adapter: "codex",
      reasoningEffort: effort || "default",
      model: provider.model || "default",
      skillsActivated: plan.toolingDecision?.skillsToUse?.map((s) => s.name) || [],
      subagentsRequested: [], // Codex doesn't have native subagents
      phasesCount: plan.phases?.length || 0,
    },
  };
}
