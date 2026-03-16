import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IssuePlan, RuntimeConfig, WorkflowConfig, WorkflowDefinition } from "./types.ts";
import { appendFileTail, now, toStringArray, extractJsonObjects } from "./helpers.ts";
import { detectAvailableProviders } from "./providers.ts";
import { replacePersistedSetting, getSettingStateResource } from "./store.ts";
import { getWorkflowConfig, loadRuntimeSettings } from "./settings.ts";
import { logger } from "./logger.ts";
import { buildClaudeCommand, buildCodexCommand } from "./adapters/commands.ts";
import { renderPrompt } from "../prompting.ts";

// ── Planning session persistence ────────────────────────────────────────────

export type PlanningSessionStatus = "input" | "planning" | "done" | "error" | "interrupted";

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
};

const PLANNING_SETTING_ID = "planning:active";

function emptySession(): PlanningSession {
  return {
    title: "", description: "", status: "input",
    plan: null, error: null, pid: null, provider: null,
    startedAt: null, completedAt: null, updatedAt: now(),
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

async function buildPlanPrompt(title: string, description: string): Promise<string> {
  return renderPrompt("issue-planner", {
    title,
    description: description || "(none provided)",
  });
}

// ── Provider command ─────────────────────────────────────────────────────────

function getPlanCommand(provider: string, model?: string): string {
  if (provider === "claude") return buildClaudeCommand({ model, jsonSchema: PLAN_JSON_SCHEMA });
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

  try {
    const outer = JSON.parse(text);
    if (outer?.result && typeof outer.result === "string") candidates.push(outer.result);
    if (outer?.summary) candidates.push(text);
  } catch {}

  const codeBlocks = text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const match of codeBlocks) candidates.push(match[1]);

  candidates.push(...extractJsonObjects(text));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      const plan = tryBuildPlan(parsed);
      if (plan) return plan;
    } catch {}
  }

  return null;
}

// ── Main: generate plan ──────────────────────────────────────────────────────

export async function savePlanningInput(title: string, description: string): Promise<PlanningSession> {
  const session: PlanningSession = {
    title, description, status: "input",
    plan: null, error: null, pid: null, provider: null,
    startedAt: null, completedAt: null, updatedAt: now(),
  };
  await persistSession(session);
  return session;
}

export async function generatePlan(
  title: string,
  description: string,
  config: RuntimeConfig,
  workflowDefinition: WorkflowDefinition | null,
): Promise<IssuePlan> {
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

  const command = getPlanCommand(preferred, planStageModel);
  if (!command) throw new Error(`No command configured for provider ${preferred}.`);

  // Persist: planning started
  const session: PlanningSession = {
    title, description, status: "planning",
    plan: null, error: null, pid: null, provider: preferred,
    startedAt: now(), completedAt: null, updatedAt: now(),
  };
  await persistSession(session);

  const prompt = await buildPlanPrompt(title, description);
  const tempDir = mkdtempSync(join(tmpdir(), "fifony-plan-"));
  const promptFile = join(tempDir, "fifony-plan-prompt.md");
  const envFile = join(tempDir, "fifony-plan-env.sh");

  writeFileSync(promptFile, `${prompt}\n`, "utf8");
  writeFileSync(envFile, [
    `export FIFONY_PROMPT_FILE=${JSON.stringify(promptFile)}`,
    `export FIFONY_PROMPT=${JSON.stringify(prompt)}`,
    `export FIFONY_AGENT_PROVIDER=${JSON.stringify(preferred)}`,
  ].join("\n"), "utf8");

  const wrappedCommand = `. "${envFile}" && ${command}`;

  const output = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    const child = spawn(wrappedCommand, {
      shell: true,
      cwd: tempDir,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.unref();
    child.stdin?.end();

    // Persist PID
    if (child.pid) {
      session.pid = child.pid;
      persistSession(session).catch(() => {});
    }

    child.stdout?.on("data", (chunk) => { stdout = appendFileTail(stdout, String(chunk), 32_000); });
    child.stderr?.on("data", (chunk) => { stdout = appendFileTail(stdout, String(chunk), 32_000); });

    const timer = setTimeout(() => {
      if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
      else { child.kill("SIGTERM"); }
      reject(new Error("Plan generation timed out."));
    }, 600_000);

    child.on("error", () => { clearTimeout(timer); reject(new Error("Failed to execute planning command.")); });
    child.on("close", (code) => {
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

  const plan = parsePlanOutput(output);
  if (!plan) {
    // Persist: error
    session.status = "error";
    session.error = `Could not parse plan. Output: ${output.slice(0, 500)}`;
    session.pid = null;
    await persistSession(session);
    logger.error({ rawOutput: output.slice(0, 2000) }, "Could not parse plan from AI output");
    throw new Error(session.error);
  }

  plan.provider = planStageModel ? `${preferred}/${planStageModel}` : preferred;

  // Persist: done with plan
  session.status = "done";
  session.plan = plan;
  session.pid = null;
  session.completedAt = now();
  session.error = null;
  await persistSession(session);

  logger.info(`Plan generated for "${title}" via ${preferred}${planStageModel ? `/${planStageModel}` : ""}${planStageEffort ? ` [${planStageEffort}]` : ""}: ${plan.steps.length} steps, complexity: ${plan.estimatedComplexity}`);
  return plan;
}
