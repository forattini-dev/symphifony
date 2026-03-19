import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IssuePlan, RuntimeConfig, IssueEntry, AgentTokenUsage } from "./types.ts";
import { appendFileTail, now } from "./helpers.ts";
import { detectAvailableProviders } from "./providers.ts";
import { getWorkflowConfig, loadRuntimeSettings } from "./settings.ts";
import { logger } from "./logger.ts";
import { record as recordTokens } from "./token-ledger.ts";
import { STATE_ROOT } from "./constants.ts";
import { persistSession, type PlanningSession, type PlanningSessionUsage } from "./planning-session.ts";
import { parsePlanOutput, tryBuildPlan, extractPlanTokenUsage } from "./planning-parser.ts";
import { buildPlanPrompt, getPlanCommand } from "./planning-prompts.ts";

// ── Debug helpers ─────────────────────────────────────────────────────────────

function savePlanDebugFiles(slug: string, prompt: string, output: string): void {
  try {
    const debugDir = join(STATE_ROOT, "debug");
    mkdirSync(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    writeFileSync(join(debugDir, `plan-${slug}-${ts}-prompt.md`), prompt, "utf8");
    if (output) writeFileSync(join(debugDir, `plan-${slug}-${ts}-output.txt`), output, "utf8");
  } catch {
    // non-critical
  }
}

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
  const providers = detectAvailableProviders();
  const available = providers.filter((p) => p.available).map((p) => p.name);

  // Load WorkflowConfig from settings to use the plan stage configuration
  let planStageProvider: string | undefined;
  let planStageModel: string | undefined;
  let planStageEffort: string | undefined;
  try {
    const settings = await loadRuntimeSettings();
    const workflowConfig = getWorkflowConfig(settings);
    if (workflowConfig?.plan) {
      planStageProvider = workflowConfig.plan.provider;
      planStageModel = workflowConfig.plan.model;
      planStageEffort = workflowConfig.plan.effort;
    }
  } catch {
    // Fall through to default provider selection
  }

  // Provider selection: respect the user's explicit configuration. If no provider is
  // configured (or it's unavailable), fall back to claude (best structured-output support)
  // then whatever's available.
  const configuredProvider = planStageProvider && available.includes(planStageProvider) ? planStageProvider : null;
  const preferred = configuredProvider
    ?? (available.includes("claude") ? "claude" : available[0]);
  if (!preferred) throw new Error("No AI provider available for planning.");

  // If provider changed (configured wasn't available → fallback), the model may belong
  // to the original provider and must not be forwarded — it would be rejected by the new CLI.
  if (preferred !== configuredProvider) planStageModel = undefined;

  // Fast mode: same model, effort low (embedded in prompt since CLIs don't support effort flags)
  const effectiveEffort = fast ? "low" : (planStageEffort || "medium");

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

  // ── All providers: spawn CLI process ──
  {
    const command = getPlanCommand(preferred, planStageModel, images);
    if (!command) throw new Error(`No command configured for provider ${preferred}.`);

    logger.debug({ provider: preferred, model: planStageModel, effort: effectiveEffort, command: command.slice(0, 120) }, "[Planner] Provider selected for plan generation");

    const tempDir = mkdtempSync(join(tmpdir(), "fifony-plan-"));
    const promptFile = join(tempDir, "fifony-plan-prompt.md");

    writeFileSync(promptFile, `${prompt}\n`, "utf8");

    // Track output bytes live — persist progress periodically so the UI can show it
    let lastProgressPersist = 0;
    const PROGRESS_INTERVAL_MS = 2000;

    const output = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      const child = spawn(command, {
        shell: true,
        cwd: tempDir,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          FIFONY_PROMPT_FILE: promptFile,
          FIFONY_AGENT_PROVIDER: preferred,
          ...(images?.length ? { FIFONY_IMAGE_PATHS: images.join(",") } : {}),
        },
      });
      child.unref();
      child.stdin?.end();

      // Persist PID
      if (child.pid) {
        session.pid = child.pid;
        if (shouldPersistSession) persistSession(session).catch(() => {});
      }

      child.stdout?.on("data", (chunk) => {
        stdout = appendFileTail(stdout, String(chunk), 32_000);
        session.outputBytes += String(chunk).length;
        // Persist progress periodically so the UI can show live output size
        if (shouldPersistSession) {
          const elapsed = Date.now() - planStartMs;
          if (elapsed - lastProgressPersist > PROGRESS_INTERVAL_MS) {
            lastProgressPersist = elapsed;
            persistSession(session).catch(() => {});
          }
        }
      });
      child.stderr?.on("data", (chunk) => {
        stdout = appendFileTail(stdout, String(chunk), 32_000);
        session.outputBytes += String(chunk).length;
      });

      const PLAN_TIMEOUT_MS = 1_800_000; // 30 minutes
      const STALE_OUTPUT_MS = 300_000;   // 5 minutes without output growth → stuck

      const timer = setTimeout(() => {
        if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
        else { child.kill("SIGTERM"); }
        reject(new Error("Plan generation timed out after 30 minutes."));
      }, PLAN_TIMEOUT_MS);

      // Progress watchdog: check PID alive + output growing every 30s
      let lastWatchdogBytes = 0;
      let lastOutputGrowthAt = Date.now();
      const watchdog = setInterval(() => {
        // Check if PID is still alive
        if (child.pid) {
          try { process.kill(child.pid, 0); } catch {
            clearInterval(watchdog);
            clearTimeout(timer);
            reject(new Error(`Planning process died unexpectedly (PID ${child.pid}).`));
            return;
          }
        }
        // Check if output is still growing
        if (session.outputBytes > lastWatchdogBytes) {
          lastWatchdogBytes = session.outputBytes;
          lastOutputGrowthAt = Date.now();
        } else if (Date.now() - lastOutputGrowthAt > STALE_OUTPUT_MS) {
          clearInterval(watchdog);
          clearTimeout(timer);
          if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
          else { child.kill("SIGTERM"); }
          reject(new Error(`Planning process stuck — no output for ${Math.round(STALE_OUTPUT_MS / 60_000)} minutes.`));
        }
      }, 30_000);

      child.on("error", () => { clearInterval(watchdog); clearTimeout(timer); reject(new Error("Failed to execute planning command.")); });
      child.on("close", (code) => {
        clearInterval(watchdog);
        clearTimeout(timer);
        rmSync(tempDir, { recursive: true, force: true });
        if (code !== 0) {
          reject(new Error(`Planning failed (exit ${code}): ${stdout.slice(0, 500)}`));
          return;
        }
        resolve(stdout);
      });
    });

    logger.info({ rawOutput: output.slice(0, 2000) }, `Plan raw output from ${preferred}`);
    savePlanDebugFiles("cli", prompt, output);

    logger.debug({ outputLength: output.length }, "[Planner] Plan command completed, parsing output");
    plan = parsePlanOutput(output);

    // Extract token usage from the CLI output
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
    // Persist: error
    session.status = "error";
    session.error = `Could not parse plan from AI output. Duration: ${durationMs}ms`;
    session.pid = null;
    if (shouldPersistSession) await persistSession(session);
    logger.error({ durationMs }, "[Planner] Could not parse plan from AI output");
    throw new Error(session.error);
  }

  plan.provider = planStageModel ? `${preferred}/${planStageModel}` : preferred;

  // Record planning tokens in the ledger (counted as "planner" phase)
  if (planUsage.totalTokens > 0) {
    const tokenUsage: AgentTokenUsage = {
      inputTokens: planUsage.inputTokens,
      outputTokens: planUsage.outputTokens,
      totalTokens: planUsage.totalTokens,
      model: planUsage.model,
    };
    // Use a synthetic issue for the ledger record
    recordTokens({ id: "planning", identifier: "PLAN", title } as IssueEntry, tokenUsage, "planner");
  }

  // Persist: done with plan + usage
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
