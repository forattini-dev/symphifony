import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { appendFileTail } from "./helpers.ts";
import type { IssuePlan, RuntimeConfig, PipelineStageConfig } from "./types.ts";
import { PLAN_JSON_SCHEMA } from "./planning-schema.ts";
import { ADAPTERS } from "./adapters/registry.ts";
import { CLAUDE_RESULT_SCHEMA } from "./adapters/commands.ts";
import { renderPrompt } from "../prompting.ts";
import { STATE_ROOT } from "./constants.ts";
import { detectAvailableProviders } from "./providers.ts";
import { getWorkflowConfig, loadRuntimeSettings } from "./settings.ts";

// ── Prompt builders ───────────────────────────────────────────────────────────

export async function buildPlanPrompt(title: string, description: string, fast = false, images?: string[]): Promise<string> {
  return renderPrompt("issue-planner", {
    title,
    description: description || "(none provided)",
    fast,
    images: images?.length ? images : undefined,
  });
}

export async function buildRefinePrompt(
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

// ── Provider command ──────────────────────────────────────────────────────────

export function getPlanCommand(provider: string, model?: string, imagePaths?: string[]): string {
  const adapter = ADAPTERS[provider];
  if (!adapter) return "";
  const jsonSchema = provider === "claude" ? PLAN_JSON_SCHEMA : undefined;
  return adapter.buildCommand({ model, imagePaths, jsonSchema, noToolAccess: provider === "claude" });
}

// ── Shared: debug file saving ─────────────────────────────────────────────────

export function savePlanDebugFiles(slug: string, prompt: string, output: string): void {
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

// ── Shared: provider resolution ───────────────────────────────────────────────

export type PlanStageConfig = {
  provider: string;
  model: string | undefined;
  effort: string | undefined;
};

export async function resolvePlanStageConfig(config: RuntimeConfig): Promise<PlanStageConfig> {
  const providers = detectAvailableProviders();
  const available = providers.filter((p) => p.available).map((p) => p.name);

  let configuredProvider: string | undefined;
  let configuredModel: string | undefined;
  let configuredEffort: string | undefined;

  try {
    const settings = await loadRuntimeSettings();
    const workflowConfig = getWorkflowConfig(settings);
    if (workflowConfig?.plan) {
      configuredProvider = workflowConfig.plan.provider;
      configuredModel = workflowConfig.plan.model;
      configuredEffort = workflowConfig.plan.effort;
    }
  } catch {
    // fall through to defaults
  }

  const provider =
    (configuredProvider && available.includes(configuredProvider)) ? configuredProvider :
    (config.agentProvider && available.includes(config.agentProvider)) ? config.agentProvider :
    available[0];

  if (!provider) throw new Error("No AI provider available for planning.");

  // If the configured provider wasn't available and we fell back, discard its model
  // to avoid passing a model ID that belongs to a different CLI.
  const model = provider === configuredProvider ? configuredModel : undefined;

  return { provider, model, effort: configuredEffort };
}

// ── Shared: subprocess runner ─────────────────────────────────────────────────

const PLAN_TIMEOUT_MS = 1_800_000;   // 30 minutes
const PLAN_STALE_OUTPUT_MS = 300_000; // 5 minutes without output growth

export async function runPlanningProcess(options: {
  command: string;
  tempDir: string;
  promptFile: string;
  provider: string;
  extraEnv?: Record<string, string>;
  onPid?: (pid: number) => void;
  onChunk?: (bytes: number) => void;
}): Promise<string> {
  const { command, tempDir, promptFile, provider, extraEnv = {}, onPid, onChunk } = options;

  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    const child = spawn(command, {
      shell: true,
      cwd: tempDir,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FIFONY_PROMPT_FILE: promptFile, FIFONY_AGENT_PROVIDER: provider, ...extraEnv },
    });
    child.unref();
    child.stdin?.end();

    if (child.pid) onPid?.(child.pid);

    let outputBytes = 0;
    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      stdout = appendFileTail(stdout, text, 32_000);
      outputBytes += text.length;
      onChunk?.(outputBytes);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const timer = setTimeout(() => {
      if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
      else { child.kill("SIGTERM"); }
      reject(new Error("Plan generation timed out after 30 minutes."));
    }, PLAN_TIMEOUT_MS);

    let lastWatchdogBytes = 0;
    let lastGrowthAt = Date.now();
    const watchdog = setInterval(() => {
      if (child.pid) {
        try { process.kill(child.pid, 0); } catch {
          clearInterval(watchdog);
          clearTimeout(timer);
          reject(new Error(`Planning process died unexpectedly (PID ${child.pid}).`));
          return;
        }
      }
      if (outputBytes > lastWatchdogBytes) {
        lastWatchdogBytes = outputBytes;
        lastGrowthAt = Date.now();
      } else if (Date.now() - lastGrowthAt > PLAN_STALE_OUTPUT_MS) {
        clearInterval(watchdog);
        clearTimeout(timer);
        if (child.pid) { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
        else { child.kill("SIGTERM"); }
        reject(new Error(`Planning process stuck — no output for ${Math.round(PLAN_STALE_OUTPUT_MS / 60_000)} minutes.`));
      }
    }, 30_000);

    child.on("error", () => { clearInterval(watchdog); clearTimeout(timer); reject(new Error("Failed to execute planning command.")); });
    child.on("close", (code) => {
      clearInterval(watchdog);
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Planning failed (exit ${code}): ${stdout.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
  });
}
