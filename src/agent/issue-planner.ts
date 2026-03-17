import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IssuePlan, RuntimeConfig, WorkflowConfig, WorkflowDefinition, RuntimeState, IssueEntry } from "./types.ts";
import { appendFileTail, now, toStringArray, extractJsonObjects, repairTruncatedJson } from "./helpers.ts";
import { detectAvailableProviders } from "./providers.ts";
import { replacePersistedSetting, getSettingStateResource } from "./store.ts";
import { getWorkflowConfig, loadRuntimeSettings } from "./settings.ts";
import { logger } from "./logger.ts";
import { buildClaudeCommand, buildCodexCommand } from "./adapters/commands.ts";
import { record as recordTokens } from "./token-ledger.ts";
import type { AgentTokenUsage } from "./types.ts";
import { renderPrompt } from "../prompting.ts";

// ── Planning session persistence ────────────────────────────────────────────

export type PlanningSessionStatus = "input" | "planning" | "done" | "error" | "interrupted";

export type PlanningSessionUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  promptChars: number;
  outputChars: number;
  durationMs: number;
};

export type PlanningSession = {
  title: string;
  description: string;
  status: PlanningSessionStatus;
  plan: IssuePlan | null;
  error: string | null;
  pid: number | null;
  provider: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  /** Live progress: output bytes received so far (updated during planning) */
  outputBytes: number;
  /** Token usage extracted after planning completes */
  usage: PlanningSessionUsage | null;
};

const PLANNING_SETTING_ID = "planning:active";

function emptySession(): PlanningSession {
  return {
    title: "", description: "", status: "input",
    plan: null, error: null, pid: null, provider: null,
    startedAt: null, completedAt: null, updatedAt: now(),
    outputBytes: 0, usage: null,
  };
}

async function persistSession(session: PlanningSession): Promise<void> {
  session.updatedAt = now();
  try {
    await replacePersistedSetting({
      id: PLANNING_SETTING_ID,
      scope: "runtime",
      value: session,
      source: "system",
      updatedAt: session.updatedAt,
    });
  } catch (error) {
    logger.warn(`Failed to persist planning session: ${String(error)}`);
  }
}

export async function loadPlanningSession(): Promise<PlanningSession | null> {
  const resource = getSettingStateResource();
  if (!resource) return null;
  try {
    const record = await resource.get(PLANNING_SETTING_ID);
    if (record?.value && typeof record.value === "object") {
      return record.value as PlanningSession;
    }
  } catch {
    // not found
  }
  return null;
}

export async function clearPlanningSession(): Promise<void> {
  await persistSession(emptySession());
}

/** Check on boot if a planning process is still alive. */
export async function recoverPlanningSession(): Promise<void> {
  const session = await loadPlanningSession();
  if (!session || session.status !== "planning") return;

  if (session.pid) {
    let alive = false;
    try { process.kill(session.pid, 0); alive = true; } catch {}

    if (alive) {
      logger.info(`Planning process still alive (PID ${session.pid}), keeping status.`);
      return;
    }
  }

  // Process died — mark as interrupted
  session.status = "interrupted";
  session.error = "Planning process was interrupted by server restart.";
  session.pid = null;
  await persistSession(session);
  logger.info("Planning session marked as interrupted (process not found).");
}

// ── Plan JSON schema ────────────────────────────────────────────────────────

const PLAN_JSON_SCHEMA = JSON.stringify({
  type: "object",
  required: ["summary", "steps", "estimatedComplexity", "suggestedPaths", "suggestedLabels"],
  properties: {
    summary: { type: "string" },
    estimatedComplexity: { type: "string", enum: ["trivial", "low", "medium", "high"] },
    assumptions: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "object", properties: { question: { type: "string" }, whyItMatters: { type: "string" }, howToResolve: { type: "string" } }, required: ["question"] } },
    successCriteria: { type: "array", items: { type: "string" } },
    executionStrategy: { type: "object", properties: { approach: { type: "string" }, whyThisApproach: { type: "string" }, alternativesConsidered: { type: "array", items: { type: "string" } } } },
    toolingDecision: { type: "object", properties: {
      shouldUseSkills: { type: "boolean" },
      skillsToUse: { type: "array", items: { type: "object", properties: { name: { type: "string" }, why: { type: "string" } }, required: ["name", "why"] } },
      shouldUseSubagents: { type: "boolean" },
      subagentsToUse: { type: "array", items: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, why: { type: "string" } }, required: ["name", "role", "why"] } },
      decisionSummary: { type: "string" },
    } },
    steps: { type: "array", items: { type: "object", properties: { step: { type: "number" }, action: { type: "string" }, files: { type: "array", items: { type: "string" } }, details: { type: "string" }, ownerType: { type: "string", enum: ["human", "agent", "skill", "subagent", "tool"] }, doneWhen: { type: "string" } }, required: ["step", "action"] } },
    risks: { type: "array", items: { type: "object", properties: { risk: { type: "string" }, impact: { type: "string" }, mitigation: { type: "string" } }, required: ["risk"] } },
    validation: { type: "array", items: { type: "string" } },
    deliverables: { type: "array", items: { type: "string" } },
    suggestedPaths: { type: "array", items: { type: "string" } },
    suggestedLabels: { type: "array", items: { type: "string" } },
    suggestedEffort: { type: "object", properties: { default: { type: "string" }, planner: { type: "string" }, executor: { type: "string" }, reviewer: { type: "string" } } },
  },
});

// ── Prompt ───────────────────────────────────────────────────────────────────

async function buildPlanPrompt(title: string, description: string, fast = false): Promise<string> {
  return renderPrompt("issue-planner", {
    title,
    description: description || "(none provided)",
    fast,
  });
}

// ── Provider command ─────────────────────────────────────────────────────────

function getPlanCommand(provider: string, model?: string): string {
  if (provider === "claude") return buildClaudeCommand({ model, jsonSchema: PLAN_JSON_SCHEMA, noToolAccess: true });
  if (provider === "codex") return buildCodexCommand({ model });
  return "";
}

// ── Parser ───────────────────────────────────────────────────────────────────

function tryBuildPlan(parsed: any): IssuePlan | null {
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed.summary || !Array.isArray(parsed.steps)) return null;

  const complexities = ["trivial", "low", "medium", "high"];

  return {
    summary: String(parsed.summary),
    estimatedComplexity: complexities.includes(parsed.estimatedComplexity) ? parsed.estimatedComplexity
      : complexities.includes(parsed.complexity) ? parsed.complexity : "medium",

    steps: parsed.steps.map((s: any, i: number) => ({
      step: s.step ?? i + 1,
      action: String(s.action || s.description || s.title || s.task_name || ""),
      files: toStringArray(s.files),
      details: s.details ? String(s.details) : undefined,
      ownerType: s.ownerType || s.owner_type || undefined,
      doneWhen: s.doneWhen || s.done_when || undefined,
    })),

    assumptions: toStringArray(parsed.assumptions),
    constraints: toStringArray(parsed.constraints),
    unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns.map((u: any) => ({
      question: String(u.question || ""),
      whyItMatters: String(u.whyItMatters || u.why_it_matters || ""),
      howToResolve: String(u.howToResolve || u.how_to_resolve || ""),
    })) : undefined,
    successCriteria: toStringArray(parsed.successCriteria || parsed.success_criteria),
    risks: Array.isArray(parsed.risks) ? parsed.risks.map((r: any) => ({
      risk: String(r.risk || ""),
      impact: String(r.impact || ""),
      mitigation: String(r.mitigation || ""),
    })) : undefined,
    validation: toStringArray(parsed.validation),
    deliverables: toStringArray(parsed.deliverables),

    executionStrategy: parsed.executionStrategy || parsed.execution_strategy || undefined,
    toolingDecision: parsed.toolingDecision || parsed.tooling_decision || undefined,

    suggestedPaths: toStringArray(parsed.suggestedPaths || parsed.suggested_paths || parsed.paths),
    suggestedLabels: toStringArray(parsed.suggestedLabels || parsed.suggested_labels || parsed.labels),
    suggestedEffort: parsed.suggestedEffort || parsed.suggested_effort || parsed.effort || { default: "medium" },

    provider: "",
    createdAt: now(),
  };
}

function parsePlanOutput(raw: string): IssuePlan | null {
  const text = raw.trim();
  if (!text) return null;

  const candidates: string[] = [];

  // 1. Try to unwrap --output-format json envelope
  try {
    const outer = JSON.parse(text);

    // --json-schema puts structured output in .structured_output (not .result)
    if (outer?.structured_output && typeof outer.structured_output === "object") {
      const plan = tryBuildPlan(outer.structured_output);
      if (plan) return plan;
      // If it didn't validate, still try as a candidate string
      candidates.push(JSON.stringify(outer.structured_output));
    }

    if (outer?.result && typeof outer.result === "string") {
      const result = outer.result;
      candidates.push(result);
      // Also extract any JSON objects embedded in the result string
      candidates.push(...extractJsonObjects(result));
      // Try code blocks inside .result
      const resultCodeBlocks = result.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
      for (const match of resultCodeBlocks) candidates.push(match[1]);
    }
    // If the outer object itself looks like a plan (no .type envelope)
    if (outer?.summary) candidates.push(text);
  } catch {}

  // 2. Try code blocks in full output
  const codeBlocks = text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const match of codeBlocks) candidates.push(match[1]);

  // 3. Extract top-level JSON objects from full text
  candidates.push(...extractJsonObjects(text));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      // Direct plan
      const plan = tryBuildPlan(parsed);
      if (plan) return plan;
      // Envelope with structured_output
      if (parsed?.structured_output && typeof parsed.structured_output === "object") {
        const innerPlan = tryBuildPlan(parsed.structured_output);
        if (innerPlan) return innerPlan;
      }
    } catch {}
  }

  // Last resort: try to repair truncated JSON output
  const repaired = repairTruncatedJson(text);
  if (repaired) {
    try {
      const parsed = JSON.parse(repaired);
      const plan = tryBuildPlan(parsed);
      if (plan) {
        logger.warn("[Planner] Plan parsed from repaired truncated JSON output");
        return plan;
      }
      // Check for envelope
      if (parsed?.structured_output && typeof parsed.structured_output === "object") {
        const innerPlan = tryBuildPlan(parsed.structured_output);
        if (innerPlan) {
          logger.warn("[Planner] Plan parsed from repaired truncated JSON envelope");
          return innerPlan;
        }
      }
    } catch {
      logger.debug("[Planner] JSON repair attempted but result still not parseable");
    }
  }

  return null;
}

// ── Main: generate plan ──────────────────────────────────────────────────────

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

/** Extract token usage from CLI output (Claude JSON or Codex text) */
function extractPlanTokenUsage(raw: string): { inputTokens: number; outputTokens: number; totalTokens: number; model: string } | null {
  // 1. Claude --output-format json: parse the outer JSON envelope
  try {
    const parsed = JSON.parse(raw.trim());

    // Try modelUsage field first (richer data, per-model breakdown)
    if (parsed?.modelUsage && typeof parsed.modelUsage === "object") {
      let totalInput = 0, totalOutput = 0, primaryModel = "";
      let maxTokens = 0;
      for (const [model, data] of Object.entries<any>(parsed.modelUsage)) {
        const inp = Number(data?.inputTokens || 0) + Number(data?.cacheReadInputTokens || 0) + Number(data?.cacheCreationInputTokens || 0);
        const out = Number(data?.outputTokens || 0);
        totalInput += inp;
        totalOutput += out;
        if (inp + out > maxTokens) {
          maxTokens = inp + out;
          primaryModel = model;
        }
      }
      if (totalInput > 0 || totalOutput > 0) {
        return { inputTokens: totalInput, outputTokens: totalOutput, totalTokens: totalInput + totalOutput, model: primaryModel };
      }
    }

    // Fallback: usage field
    const usage = parsed?.usage;
    if (usage && typeof usage === "object") {
      const input = Number(usage.input_tokens) || 0;
      const output = Number(usage.output_tokens) || 0;
      if (input > 0 || output > 0) {
        return {
          inputTokens: input,
          outputTokens: output,
          totalTokens: input + output,
          model: typeof parsed.model === "string" ? parsed.model : "",
        };
      }
    }

    // Fallback: total_cost_usd present means we can at least log the cost
  } catch { /* not JSON — try Codex format */ }

  // 2. Codex: "tokens used\n1,681\n"
  const codexMatch = raw.match(/tokens?\s+used\s*\n\s*([\d,]+)/i);
  if (codexMatch) {
    const total = parseInt(codexMatch[1].replace(/,/g, ""), 10);
    const modelMatch = raw.match(/^model:\s*(.+)$/im);
    if (total > 0) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: total, model: modelMatch?.[1]?.trim() || "" };
    }
  }

  return null;
}

export type GeneratePlanResult = {
  plan: IssuePlan;
  usage: PlanningSessionUsage;
};

export async function generatePlan(
  title: string,
  description: string,
  config: RuntimeConfig,
  workflowDefinition: WorkflowDefinition | null,
  options?: { fast?: boolean },
): Promise<GeneratePlanResult> {
  const fast = options?.fast ?? false;
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

  // Use configured plan provider if available, otherwise fall back to detection
  const preferred = planStageProvider && available.includes(planStageProvider)
    ? planStageProvider
    : available.includes("claude") ? "claude" : available[0];
  if (!preferred) throw new Error("No AI provider available for planning.");

  // Fast mode: same model, effort low (embedded in prompt since CLIs don't support effort flags)
  const effectiveEffort = fast ? "low" : (planStageEffort || "medium");

  const command = getPlanCommand(preferred, planStageModel);
  if (!command) throw new Error(`No command configured for provider ${preferred}.`);

  logger.debug({ provider: preferred, model: planStageModel, effort: effectiveEffort, command: command.slice(0, 120) }, "[Planner] Provider selected for plan generation");

  // Persist: planning started
  const planStartMs = Date.now();
  const session: PlanningSession = {
    title, description, status: "planning",
    plan: null, error: null, pid: null, provider: preferred,
    startedAt: now(), completedAt: null, updatedAt: now(),
    outputBytes: 0, usage: null,
  };
  await persistSession(session);

  const prompt = await buildPlanPrompt(title, description, fast);
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
      },
    });
    child.unref();
    child.stdin?.end();

    // Persist PID
    if (child.pid) {
      session.pid = child.pid;
      persistSession(session).catch(() => {});
    }

    child.stdout?.on("data", (chunk) => {
      stdout = appendFileTail(stdout, String(chunk), 32_000);
      session.outputBytes += String(chunk).length;
      // Persist progress periodically so the UI can show live output size
      const elapsed = Date.now() - planStartMs;
      if (elapsed - lastProgressPersist > PROGRESS_INTERVAL_MS) {
        lastProgressPersist = elapsed;
        persistSession(session).catch(() => {});
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

  logger.debug({ outputLength: output.length }, "[Planner] Plan command completed, parsing output");
  const plan = parsePlanOutput(output);
  if (!plan) {
    const firstBrace = output.indexOf("{");
    const lastBrace = output.lastIndexOf("}");
    const truncationHint = firstBrace >= 0 && lastBrace < firstBrace
      ? " (JSON appears truncated — opening brace found but no matching close)"
      : firstBrace < 0
        ? " (no JSON object found in output)"
        : "";
    // Persist: error
    session.status = "error";
    session.error = `Could not parse plan${truncationHint}. Output length: ${output.length} chars. Tail: ${output.slice(-200)}`;
    session.pid = null;
    await persistSession(session);
    logger.error({ rawOutput: output.slice(0, 2000), outputLength: output.length, firstBrace, lastBrace }, "[Planner] Could not parse plan from AI output");
    throw new Error(session.error);
  }

  plan.provider = planStageModel ? `${preferred}/${planStageModel}` : preferred;

  // Extract token usage from the CLI output
  const durationMs = Date.now() - planStartMs;
  const tokenInfo = extractPlanTokenUsage(output);
  const planUsage: PlanningSessionUsage = {
    inputTokens: tokenInfo?.inputTokens ?? 0,
    outputTokens: tokenInfo?.outputTokens ?? 0,
    totalTokens: tokenInfo?.totalTokens ?? 0,
    model: tokenInfo?.model || planStageModel || preferred,
    promptChars: prompt.length,
    outputChars: output.length,
    durationMs,
  };

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
  await persistSession(session);

  const tokenSummary = planUsage.totalTokens > 0
    ? `, ${planUsage.totalTokens.toLocaleString()} tokens (in: ${planUsage.inputTokens.toLocaleString()}, out: ${planUsage.outputTokens.toLocaleString()})`
    : `, ${planUsage.outputChars.toLocaleString()} output chars`;
  logger.info(`Plan generated for "${title}" via ${planUsage.model}: ${plan.steps.length} steps, complexity: ${plan.estimatedComplexity}${tokenSummary}, ${durationMs}ms`);
  return { plan, usage: planUsage };
}

// ── Refine plan ──────────────────────────────────────────────────────────────

async function buildRefinePrompt(
  title: string,
  description: string,
  currentPlan: IssuePlan,
  feedback: string,
): Promise<string> {
  return renderPrompt("issue-planner-refine", {
    title,
    description: description || "(none provided)",
    currentPlan: JSON.stringify(currentPlan, null, 2),
    feedback,
  });
}

export type RefinePlanResult = {
  plan: IssuePlan;
  usage: PlanningSessionUsage;
};

export async function refinePlan(
  issue: IssueEntry,
  feedback: string,
  config: RuntimeConfig,
  workflowDefinition: WorkflowDefinition | null,
): Promise<RefinePlanResult> {
  if (!issue.plan) throw new Error("Issue has no plan to refine.");

  const providers = detectAvailableProviders();
  const available = providers.filter((p) => p.available).map((p) => p.name);

  // Use the same provider/model/effort logic as generatePlan
  let planStageProvider: string | undefined;
  let planStageModel: string | undefined;
  try {
    const settings = await loadRuntimeSettings();
    const workflowConfig = getWorkflowConfig(settings);
    if (workflowConfig?.plan) {
      planStageProvider = workflowConfig.plan.provider;
      planStageModel = workflowConfig.plan.model;
    }
  } catch {
    // Fall through to default provider selection
  }

  const preferred = planStageProvider && available.includes(planStageProvider)
    ? planStageProvider
    : available.includes("claude") ? "claude" : available[0];
  if (!preferred) throw new Error("No AI provider available for plan refinement.");

  const command = getPlanCommand(preferred, planStageModel);
  if (!command) throw new Error(`No command configured for provider ${preferred}.`);

  const refineStartMs = Date.now();
  const prompt = await buildRefinePrompt(issue.title, issue.description, issue.plan, feedback);
  const tempDir = mkdtempSync(join(tmpdir(), "fifony-refine-"));
  const promptFile = join(tempDir, "fifony-refine-prompt.md");

  writeFileSync(promptFile, `${prompt}\n`, "utf8");

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
      },
    });
    child.unref();
    child.stdin?.end();

    let refineOutputBytes = 0;
    child.stdout?.on("data", (chunk) => {
      stdout = appendFileTail(stdout, String(chunk), 32_000);
      refineOutputBytes += String(chunk).length;
    });
    child.stderr?.on("data", (chunk) => {
      stdout = appendFileTail(stdout, String(chunk), 32_000);
      refineOutputBytes += String(chunk).length;
    });

    const REFINE_TIMEOUT_MS = 1_800_000; // 30 minutes
    const REFINE_STALE_OUTPUT_MS = 300_000; // 5 minutes without output growth

    const timer = setTimeout(() => {
      if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
      else { child.kill("SIGTERM"); }
      reject(new Error("Plan refinement timed out after 30 minutes."));
    }, REFINE_TIMEOUT_MS);

    // Progress watchdog: check PID alive + output growing every 30s
    let lastRefineWatchdogBytes = 0;
    let lastRefineOutputGrowthAt = Date.now();
    const watchdog = setInterval(() => {
      // Check if PID is still alive
      if (child.pid) {
        try { process.kill(child.pid, 0); } catch {
          clearInterval(watchdog);
          clearTimeout(timer);
          reject(new Error(`Refinement process died unexpectedly (PID ${child.pid}).`));
          return;
        }
      }
      // Check if output is still growing
      if (refineOutputBytes > lastRefineWatchdogBytes) {
        lastRefineWatchdogBytes = refineOutputBytes;
        lastRefineOutputGrowthAt = Date.now();
      } else if (Date.now() - lastRefineOutputGrowthAt > REFINE_STALE_OUTPUT_MS) {
        clearInterval(watchdog);
        clearTimeout(timer);
        if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
        else { child.kill("SIGTERM"); }
        reject(new Error(`Refinement process stuck — no output for ${Math.round(REFINE_STALE_OUTPUT_MS / 60_000)} minutes.`));
      }
    }, 30_000);

    child.on("error", () => { clearInterval(watchdog); clearTimeout(timer); reject(new Error("Failed to execute refinement command.")); });
    child.on("close", (code) => {
      clearInterval(watchdog);
      clearTimeout(timer);
      rmSync(tempDir, { recursive: true, force: true });
      if (code !== 0) {
        reject(new Error(`Plan refinement failed (exit ${code}): ${stdout.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
  });

  logger.info({ rawOutput: output.slice(0, 2000) }, `Refine raw output from ${preferred}`);

  const plan = parsePlanOutput(output);
  if (!plan) {
    const firstBrace = output.indexOf("{");
    const lastBrace = output.lastIndexOf("}");
    const truncationHint = firstBrace >= 0 && lastBrace < firstBrace
      ? " (JSON appears truncated — opening brace found but no matching close)"
      : firstBrace < 0
        ? " (no JSON object found in output)"
        : "";
    logger.error({ rawOutput: output.slice(0, 2000), outputLength: output.length, firstBrace, lastBrace }, "Could not parse refined plan from AI output");
    throw new Error(`Could not parse refined plan${truncationHint}. Output length: ${output.length} chars. Tail: ${output.slice(-200)}`);
  }

  plan.provider = planStageModel ? `${preferred}/${planStageModel}` : preferred;

  // Carry over refinement history from the original plan and append the new refinement
  const existingRefinements = issue.plan.refinements ?? [];
  const nextVersion = existingRefinements.length + 1;
  plan.refinements = [
    ...existingRefinements,
    { feedback, at: now(), version: nextVersion },
  ];

  const durationMs = Date.now() - refineStartMs;
  const tokenInfo = extractPlanTokenUsage(output);
  const refineUsage: PlanningSessionUsage = {
    inputTokens: tokenInfo?.inputTokens ?? 0,
    outputTokens: tokenInfo?.outputTokens ?? 0,
    totalTokens: tokenInfo?.totalTokens ?? 0,
    model: tokenInfo?.model || planStageModel || preferred,
    promptChars: prompt.length,
    outputChars: output.length,
    durationMs,
  };

  // Record refinement tokens in the ledger
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

// ── Fire-and-forget wrappers ────────────────────────────────────────────────

export type PlanCallbacks = {
  addEvent: (issueId: string, kind: string, message: string) => void;
  persistState: () => Promise<void>;
  applyUsage: (issue: IssueEntry, usage: PlanningSessionUsage) => void;
  applySuggestions: (issue: IssueEntry, plan: IssuePlan) => void;
};

/**
 * Start plan generation in the background. Returns immediately.
 * Updates issue.plan and broadcasts via WS when done.
 */
export function generatePlanInBackground(
  issue: IssueEntry,
  config: RuntimeConfig,
  workflowDefinition: WorkflowDefinition | null,
  callbacks: PlanCallbacks,
  options?: { fast?: boolean },
): void {
  const { addEvent, persistState, applyUsage, applySuggestions } = callbacks;
  const fast = options?.fast ?? false;

  issue.planningStatus = "planning";
  issue.planningStartedAt = now();
  issue.planningError = undefined;
  issue.updatedAt = now();

  addEvent(issue.id, "info", `${fast ? "Fast plan" : "Plan"} generation starting for ${issue.identifier} (provider detection in progress).`);

  // Fire-and-forget — errors are caught and stored on the issue
  generatePlan(issue.title, issue.description, config, workflowDefinition, { fast })
    .then(async ({ plan, usage }) => {
      issue.plan = plan;
      issue.planningStatus = "idle";
      issue.planningStartedAt = undefined;
      issue.planningError = undefined;
      issue.updatedAt = now();

      applyUsage(issue, usage);
      applySuggestions(issue, plan);

      addEvent(issue.id, "progress", `${fast ? "Fast plan" : "Plan"} generated for ${issue.identifier}: ${plan.steps.length} steps, complexity: ${plan.estimatedComplexity}.`);
      if (usage.totalTokens > 0) {
        addEvent(issue.id, "info", `Plan tokens (${issue.identifier}): ${usage.totalTokens.toLocaleString()} (in: ${usage.inputTokens.toLocaleString()}, out: ${usage.outputTokens.toLocaleString()}) [${usage.model}]`);
      }
      await persistState();
    })
    .catch(async (err) => {
      issue.planningStatus = "idle";
      issue.planningStartedAt = undefined;
      issue.planningError = err instanceof Error ? err.message : String(err);
      issue.updatedAt = now();
      addEvent(issue.id, "error", `Plan generation failed for ${issue.identifier}: ${issue.planningError}`);
      await persistState();
      logger.error({ err }, `Background plan generation failed for ${issue.identifier}`);
    });
}

/**
 * Start plan refinement in the background. Returns immediately.
 * Updates issue.plan and broadcasts via WS when done.
 */
export function refinePlanInBackground(
  issue: IssueEntry,
  feedback: string,
  config: RuntimeConfig,
  workflowDefinition: WorkflowDefinition | null,
  callbacks: PlanCallbacks,
): void {
  const { addEvent, persistState, applyUsage, applySuggestions } = callbacks;

  issue.planningStatus = "refining";
  issue.planningStartedAt = now();
  issue.planningError = undefined;
  issue.updatedAt = now();

  const feedbackSnippet = feedback.length > 60 ? `${feedback.slice(0, 57)}...` : feedback;
  addEvent(issue.id, "info", `Plan refinement starting for ${issue.identifier}: "${feedbackSnippet}".`);

  refinePlan(issue, feedback, config, workflowDefinition)
    .then(async ({ plan, usage }) => {
      issue.plan = plan;
      issue.planningStatus = "idle";
      issue.planningStartedAt = undefined;
      issue.planningError = undefined;
      issue.updatedAt = now();

      applyUsage(issue, usage);
      applySuggestions(issue, plan);

      const feedbackPreview = feedback.length > 80 ? `${feedback.slice(0, 77)}...` : feedback;
      addEvent(issue.id, "progress", `Plan refined for ${issue.identifier}: "${feedbackPreview}" → ${plan.steps.length} steps, complexity: ${plan.estimatedComplexity}.`);
      if (usage.totalTokens > 0) {
        addEvent(issue.id, "info", `Refinement tokens (${issue.identifier}): ${usage.totalTokens.toLocaleString()} (in: ${usage.inputTokens.toLocaleString()}, out: ${usage.outputTokens.toLocaleString()}) [${usage.model}]`);
      }
      await persistState();
    })
    .catch(async (err) => {
      issue.planningStatus = "idle";
      issue.planningStartedAt = undefined;
      issue.planningError = err instanceof Error ? err.message : String(err);
      issue.updatedAt = now();
      addEvent(issue.id, "error", `Plan refinement failed for ${issue.identifier}: ${issue.planningError}`);
      await persistState();
      logger.error({ err }, `Background plan refinement failed for ${issue.identifier}`);
    });
}
