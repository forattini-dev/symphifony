import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { IssuePlan, RuntimeConfig, IssueEntry, AgentTokenUsage } from "./types.ts";
import { now } from "./helpers.ts";
import { logger } from "./logger.ts";
import { record as recordTokens } from "./token-ledger.ts";
import { type PlanningSessionUsage } from "./planning-session.ts";
import { parsePlanOutput, extractPlanTokenUsage } from "./planning-parser.ts";
import {
  buildRefinePrompt,
  getPlanCommand,
  savePlanDebugFiles,
  resolvePlanStageConfig,
  runPlanningProcess,
} from "./planning-prompts.ts";

// ── Public types ──────────────────────────────────────────────────────────────

export type RefinePlanResult = {
  plan: IssuePlan;
  usage: PlanningSessionUsage;
};

// ── Refine plan ───────────────────────────────────────────────────────────────

export async function refinePlan(
  issue: IssueEntry,
  feedback: string,
  config: RuntimeConfig,
  _workflowDefinition: null,
): Promise<RefinePlanResult> {
  if (!issue.plan) throw new Error("Issue has no plan to refine.");

  const { provider: preferred, model: planStageModel } = await resolvePlanStageConfig(config);

  const refineStartMs = Date.now();
  const prompt = await buildRefinePrompt(issue.title, issue.description, issue.plan, feedback);

  let plan: IssuePlan | null = null;
  let refineUsage: PlanningSessionUsage;

  {
    const command = getPlanCommand(preferred, planStageModel);
    if (!command) throw new Error(`No command configured for provider ${preferred}.`);

    const tempDir = mkdtempSync(join(tmpdir(), "fifony-refine-"));
    const promptFile = join(tempDir, "fifony-refine-prompt.md");
    writeFileSync(promptFile, `${prompt}\n`, "utf8");

    const output = await runPlanningProcess({
      command,
      tempDir,
      promptFile,
      provider: preferred,
    }).finally(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    logger.info({ rawOutput: output.slice(0, 2000) }, `Refine raw output from ${preferred}`);
    savePlanDebugFiles("refine-cli", prompt, output);

    plan = parsePlanOutput(output);

    const durationMs = Date.now() - refineStartMs;
    const tokenInfo = extractPlanTokenUsage(output);
    refineUsage = {
      inputTokens: tokenInfo?.inputTokens ?? 0,
      outputTokens: tokenInfo?.outputTokens ?? 0,
      totalTokens: tokenInfo?.totalTokens ?? 0,
      model: tokenInfo?.model || planStageModel || preferred,
      promptChars: prompt.length,
      outputChars: output.length,
      durationMs,
    };
  }

  if (!plan) {
    logger.error("[Planner] Could not parse refined plan from AI output");
    throw new Error("Could not parse refined plan from AI output.");
  }

  plan.provider = planStageModel ? `${preferred}/${planStageModel}` : preferred;

  const existingRefinements = issue.plan.refinements ?? [];
  const nextVersion = existingRefinements.length + 1;
  plan.refinements = [
    ...existingRefinements,
    { feedback, at: now(), version: nextVersion },
  ];

  const durationMs = Date.now() - refineStartMs;
  refineUsage.durationMs = durationMs;

  if (refineUsage.totalTokens > 0) {
    const tokenUsage: AgentTokenUsage = {
      inputTokens: refineUsage.inputTokens,
      outputTokens: refineUsage.outputTokens,
      totalTokens: refineUsage.totalTokens,
      model: refineUsage.model,
    };
    recordTokens({ id: issue.id, identifier: issue.identifier, title: issue.title } as IssueEntry, tokenUsage, "planner");
  }

  const tokenSummary = refineUsage.totalTokens > 0
    ? `, ${refineUsage.totalTokens.toLocaleString()} tokens (in: ${refineUsage.inputTokens.toLocaleString()}, out: ${refineUsage.outputTokens.toLocaleString()})`
    : `, ${refineUsage.outputChars.toLocaleString()} output chars`;
  logger.info(`Plan refined for "${issue.title}" via ${refineUsage.model}: ${plan.steps.length} steps, complexity: ${plan.estimatedComplexity}${tokenSummary}, ${durationMs}ms`);
  return { plan, usage: refineUsage };
}
