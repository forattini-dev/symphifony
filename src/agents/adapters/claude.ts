import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../../types.ts";
import type { CompiledExecution } from "./types.ts";
import type { ProviderAdapter, ProviderCommandOptions } from "./registry.ts";
import { renderPrompt } from "../prompting.ts";
import { buildFullPlanPrompt, resolveEffortForProvider, extractValidationCommands, buildImagePromptSection } from "./shared.ts";
import { CLAUDE_RESULT_SCHEMA, REVIEW_RESULT_SCHEMA, extractPlanDirs } from "./commands.ts";
import {
  collectProviderUsageSnapshotFromCli,
  type ProviderUsageSnapshot,
  parseClaudeUsageFromStatus,
} from "./usage.ts";

export const CLAUDE_USAGE_COMMAND = "/usage";
export const collectClaudeUsageFromCli = (): Promise<ProviderUsageSnapshot | null> =>
  collectProviderUsageSnapshotFromCli("claude", CLAUDE_USAGE_COMMAND, parseClaudeUsageFromStatus, [
    "--dangerously-skip-permissions",
  ]);

// ── Command builder ───────────────────────────────────────────────────────────

export function buildClaudeCommand(options: ProviderCommandOptions): string {
  // NOTE: do NOT use --bare — it disables OAuth/keychain auth and requires ANTHROPIC_API_KEY
  const parts = ["claude", "--print"];

  if (options.readOnly) {
    // Read-only mode: no file edits, no tool access — safe for planning/review
    parts.push("--permission-mode plan");
  } else if (!options.noToolAccess) {
    parts.push("--dangerously-skip-permissions");
  }

  parts.push("--no-session-persistence", "--output-format json");

  if (options.effort) {
    parts.push(`--effort ${options.effort}`);
  }

  if (options.maxBudgetUsd && options.maxBudgetUsd > 0) {
    parts.push(`--max-budget-usd ${options.maxBudgetUsd}`);
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
  capabilitiesManifest?: string,
): Promise<CompiledExecution> {
  const effort = resolveEffortForProvider(plan, provider.role, config.defaultEffort);

  let prompt = await renderPrompt("compile-execution-claude", {
    isPlanner: provider.role === "planner",
    isReviewer: provider.role === "reviewer",
    profileInstructions: provider.profileInstructions || "",
    skillContext,
    capabilitiesManifest: capabilitiesManifest || "",
    planPrompt: buildFullPlanPrompt(plan),
    suggestedSkills: plan.suggestedSkills ?? [],
    suggestedAgents: plan.suggestedAgents ?? [],
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

  // Claude CLI has no --image flag — embed images in prompt
  if (issue.images?.length) {
    const imageSection = buildImagePromptSection(issue.images);
    if (imageSection) prompt = prompt + "\n\n" + imageSection;
  }

  const isReadOnlyRole = provider.role === "planner" || provider.role === "reviewer";

  const command = buildClaudeCommand({
    model: provider.model,
    effort,
    addDirs: absoluteDirs,
    jsonSchema: CLAUDE_RESULT_SCHEMA,
    readOnly: isReadOnlyRole,
    maxBudgetUsd: config.maxBudgetUsd,
  });

  const env: Record<string, string> = {
    FIFONY_PLAN_COMPLEXITY: plan.estimatedComplexity,
    FIFONY_PLAN_STEPS: String(plan.steps.length),
    FIFONY_EXECUTION_PAYLOAD_FILE: "execution-payload.json",
  };
  if (plan.suggestedPaths?.length) env.FIFONY_PLAN_PATHS = plan.suggestedPaths.join(",");
  if (plan.suggestedSkills?.length) {
    env.FIFONY_PLAN_SKILLS = plan.suggestedSkills.join(",");
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
      skillsActivated: plan.suggestedSkills || [],
      subagentsRequested: plan.suggestedAgents || [],
      phasesCount: plan.phases?.length || 0,
    },
  };
}

export const claudeAdapter: ProviderAdapter = {
  buildCommand: buildClaudeCommand,
  buildReviewCommand: (reviewer, config) => buildClaudeCommand({
    model: reviewer.model,
    effort: reviewer.reasoningEffort,
    jsonSchema: REVIEW_RESULT_SCHEMA,
    readOnly: true,
    maxBudgetUsd: config?.maxBudgetUsd,
  }),
  compile,
};
