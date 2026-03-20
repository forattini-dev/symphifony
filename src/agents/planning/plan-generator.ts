import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { IssuePlan, RuntimeConfig, IssueEntry, AgentTokenUsage } from "../../types.ts";
import { now } from "../../concerns/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { record as recordTokens } from "../../domains/tokens.ts";
import { persistSession, type PlanningSession, type PlanningSessionUsage } from "./planning-session.ts";
import { parsePlanOutput, extractPlanTokenUsage } from "./planning-parser.ts";
import {
  buildPlanPrompt,
  getPlanCommand,
  savePlanDebugFiles,
  resolvePlanStageConfig,
  runPlanningProcess,
} from "./planning-prompts.ts";

// ── Public types ──────────────────────────────────────────────────────────────

export type GeneratePlanResult = {
  plan: IssuePlan;
  usage: PlanningSessionUsage;
  prompt: string;
};

// ── savePlanningInput ─────────────────────────────────────────────────────────

export async function savePlanningInput(title: string, description: string): Promise<PlanningSession> {
  const session: PlanningSession = {
    title, description, status: "input",
    plan: null, error: null, pid: null, provider: null,
    startedAt: null, completedAt: null, updatedAt: now(),
    outputBytes: 0, usage: null,
  };
  await persistSession(session);
  return session;
}

// ── Main: generate plan ───────────────────────────────────────────────────────

export async function generatePlan(
  title: string,
  description: string,
  config: RuntimeConfig,
  _workflowDefinition: null,
  options?: { fast?: boolean; persistSession?: boolean; images?: string[] },
): Promise<GeneratePlanResult> {
  const fast = options?.fast ?? false;
  const images = options?.images;
  const shouldPersistSession = options?.persistSession !== false; // default true
  logger.info({ title: title.slice(0, 80), fast }, "[Planner] Starting plan generation");

  const { provider: preferred, model: planStageModel, effort: planStageEffort } = await resolvePlanStageConfig(config);

  // Fast mode: same model, effort low (embedded in prompt since CLIs don't support effort flags)
  const effectiveEffort = fast ? "low" : (planStageEffort || "medium");
  void effectiveEffort; // used in prompt logic

  // Persist: planning started
  const planStartMs = Date.now();
  const session: PlanningSession = {
    title, description, status: "planning",
    plan: null, error: null, pid: null, provider: preferred,
    startedAt: now(), completedAt: null, updatedAt: now(),
    outputBytes: 0, usage: null,
  };
  if (shouldPersistSession) await persistSession(session);

  const prompt = await buildPlanPrompt(title, description, fast, images);

  let plan: IssuePlan | null = null;
  let planUsage: PlanningSessionUsage;

  {
    const command = getPlanCommand(preferred, planStageModel, images);
    if (!command) throw new Error(`No command configured for provider ${preferred}.`);

    logger.debug({ provider: preferred, model: planStageModel, command: command.slice(0, 120) }, "[Planner] Provider selected for plan generation");

    const tempDir = mkdtempSync(join(tmpdir(), "fifony-plan-"));
    const promptFile = join(tempDir, "fifony-plan-prompt.md");
    writeFileSync(promptFile, `${prompt}\n`, "utf8");

    // Track output bytes live — persist progress periodically so the UI can show it
    let lastProgressPersist = 0;
    const PROGRESS_INTERVAL_MS = 2000;

    const output = await runPlanningProcess({
      command,
      tempDir,
      promptFile,
      provider: preferred,
      extraEnv: images?.length ? { FIFONY_IMAGE_PATHS: images.join(",") } : {},
      onPid: (pid) => {
        session.pid = pid;
        if (shouldPersistSession) persistSession(session).catch(() => {});
      },
      onChunk: (bytes) => {
        session.outputBytes = bytes;
        if (shouldPersistSession) {
          const elapsed = Date.now() - planStartMs;
          if (elapsed - lastProgressPersist > PROGRESS_INTERVAL_MS) {
            lastProgressPersist = elapsed;
            persistSession(session).catch(() => {});
          }
        }
      },
    }).finally(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    logger.info({ rawOutput: output.slice(0, 2000) }, `Plan raw output from ${preferred}`);
    savePlanDebugFiles("cli", prompt, output);

    logger.debug({ outputLength: output.length }, "[Planner] Plan command completed, parsing output");
    plan = parsePlanOutput(output);

    const durationMs = Date.now() - planStartMs;
    const tokenInfo = extractPlanTokenUsage(output);
    planUsage = {
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
    const durationMs = Date.now() - planStartMs;
    session.status = "error";
    session.error = `Could not parse plan from AI output. Duration: ${durationMs}ms`;
    session.pid = null;
    if (shouldPersistSession) await persistSession(session);
    logger.error({ durationMs }, "[Planner] Could not parse plan from AI output");
    throw new Error(session.error);
  }

  plan.provider = planStageModel ? `${preferred}/${planStageModel}` : preferred;

  if (planUsage.totalTokens > 0) {
    const tokenUsage: AgentTokenUsage = {
      inputTokens: planUsage.inputTokens,
      outputTokens: planUsage.outputTokens,
      totalTokens: planUsage.totalTokens,
      model: planUsage.model,
    };
    recordTokens({ id: "planning", identifier: "PLAN", title } as IssueEntry, tokenUsage, "planner");
  }

  session.status = "done";
  session.plan = plan;
  session.pid = null;
  session.completedAt = now();
  session.error = null;
  session.usage = planUsage;
  if (shouldPersistSession) await persistSession(session);

  const tokenSummary = planUsage.totalTokens > 0
    ? `, ${planUsage.totalTokens.toLocaleString()} tokens (in: ${planUsage.inputTokens.toLocaleString()}, out: ${planUsage.outputTokens.toLocaleString()})`
    : `, ${planUsage.outputChars.toLocaleString()} output chars`;
  logger.info(`Plan generated for "${title}" via ${planUsage.model}: ${plan.steps.length} steps, complexity: ${plan.estimatedComplexity}${tokenSummary}, ${planUsage.durationMs}ms`);
  return { plan, usage: planUsage, prompt };
}
