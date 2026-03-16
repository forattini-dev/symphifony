import type {
  DetectedProvider,
  EffortConfig,
  JsonRecord,
  PipelineStageConfig,
  ReasoningEffort,
  RuntimeConfig,
  RuntimeSettingRecord,
  RuntimeSettingScope,
  RuntimeSettingSource,
  WorkflowConfig,
} from "./types.ts";
import { clamp, now } from "./helpers.ts";
import { loadPersistedSettings, replacePersistedSetting } from "./store.ts";
import { getProviderDefaultCommand, normalizeAgentProvider } from "./providers.ts";

export const SETTING_ID_POLL_INTERVAL_MS = "runtime.pollIntervalMs";
export const SETTING_ID_WORKER_CONCURRENCY = "runtime.workerConcurrency";
export const SETTING_ID_COMMAND_TIMEOUT_MS = "runtime.commandTimeoutMs";
export const SETTING_ID_MAX_ATTEMPTS_DEFAULT = "runtime.maxAttemptsDefault";
export const SETTING_ID_MAX_TURNS = "runtime.maxTurns";
export const SETTING_ID_RETRY_DELAY_MS = "runtime.retryDelayMs";
export const SETTING_ID_STALE_IN_PROGRESS_TIMEOUT_MS = "runtime.staleInProgressTimeoutMs";
export const SETTING_ID_LOG_LINES_TAIL = "runtime.logLinesTail";
export const SETTING_ID_MAX_CONCURRENT_BY_STATE = "runtime.maxConcurrentByState";
export const SETTING_ID_AGENT_PROVIDER = "runtime.agentProvider";
export const SETTING_ID_AGENT_COMMAND = "runtime.agentCommand";
export const SETTING_ID_DEFAULT_EFFORT = "runtime.defaultEffort";
export const SETTING_ID_DETECTED_PROVIDERS = "providers.detected";
export const SETTING_ID_UI_THEME = "ui.theme";
export const SETTING_ID_UI_NOTIFICATIONS_ENABLED = "ui.notifications.enabled";
export const SETTING_ID_WORKFLOW_CONFIG = "runtime.workflowConfig";

export async function loadRuntimeSettings(): Promise<RuntimeSettingRecord[]> {
  return loadPersistedSettings();
}

export const RUNTIME_CONFIG_SETTING_IDS = new Set<string>([
  SETTING_ID_POLL_INTERVAL_MS,
  SETTING_ID_WORKER_CONCURRENCY,
  SETTING_ID_COMMAND_TIMEOUT_MS,
  SETTING_ID_MAX_ATTEMPTS_DEFAULT,
  SETTING_ID_MAX_TURNS,
  SETTING_ID_RETRY_DELAY_MS,
  SETTING_ID_STALE_IN_PROGRESS_TIMEOUT_MS,
  SETTING_ID_LOG_LINES_TAIL,
  SETTING_ID_MAX_CONCURRENT_BY_STATE,
  SETTING_ID_AGENT_PROVIDER,
  SETTING_ID_AGENT_COMMAND,
  SETTING_ID_DEFAULT_EFFORT,
]);

const VALID_REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "extra-high"]);

function parseIntegerSetting(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeMaxConcurrentByState(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const result: Record<string, number> = {};
  for (const [key, rawLimit] of Object.entries(value as JsonRecord)) {
    const limit = parseIntegerSetting(rawLimit);
    if (!limit || limit < 1) continue;
    const normalizedKey = key.trim().toLowerCase();
    if (!normalizedKey) continue;
    result[normalizedKey] = limit;
  }

  return result;
}

function sanitizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === "string" && VALID_REASONING_EFFORTS.has(value as ReasoningEffort)
    ? value as ReasoningEffort
    : undefined;
}

function sanitizeDefaultEffort(value: unknown): EffortConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as JsonRecord;
  const next: EffortConfig = {};
  const keys: Array<keyof EffortConfig> = ["default", "planner", "executor", "reviewer"];

  for (const key of keys) {
    const effort = sanitizeReasoningEffort(raw[key]);
    if (effort) {
      next[key] = effort;
    }
  }

  return Object.keys(next).length > 0 ? next : {};
}

function buildRuntimeConfigSettings(
  config: RuntimeConfig,
  source: RuntimeSettingSource,
): RuntimeSettingRecord[] {
  const updatedAt = now();
  return [
    { id: SETTING_ID_POLL_INTERVAL_MS, scope: "runtime", value: config.pollIntervalMs, source, updatedAt },
    { id: SETTING_ID_WORKER_CONCURRENCY, scope: "runtime", value: config.workerConcurrency, source, updatedAt },
    { id: SETTING_ID_COMMAND_TIMEOUT_MS, scope: "runtime", value: config.commandTimeoutMs, source, updatedAt },
    { id: SETTING_ID_MAX_ATTEMPTS_DEFAULT, scope: "runtime", value: config.maxAttemptsDefault, source, updatedAt },
    { id: SETTING_ID_MAX_TURNS, scope: "runtime", value: config.maxTurns, source, updatedAt },
    { id: SETTING_ID_RETRY_DELAY_MS, scope: "runtime", value: config.retryDelayMs, source, updatedAt },
    {
      id: SETTING_ID_STALE_IN_PROGRESS_TIMEOUT_MS,
      scope: "runtime",
      value: config.staleInProgressTimeoutMs,
      source,
      updatedAt,
    },
    { id: SETTING_ID_LOG_LINES_TAIL, scope: "runtime", value: config.logLinesTail, source, updatedAt },
    { id: SETTING_ID_MAX_CONCURRENT_BY_STATE, scope: "runtime", value: config.maxConcurrentByState, source, updatedAt },
    { id: SETTING_ID_AGENT_PROVIDER, scope: "runtime", value: config.agentProvider, source, updatedAt },
    { id: SETTING_ID_AGENT_COMMAND, scope: "runtime", value: config.agentCommand, source, updatedAt },
    { id: SETTING_ID_DEFAULT_EFFORT, scope: "runtime", value: config.defaultEffort, source, updatedAt },
  ];
}

export function applyPersistedSettings(config: RuntimeConfig, settings: RuntimeSettingRecord[]): RuntimeConfig {
  let nextConfig = { ...config };
  let agentProviderOverridden = false;
  let agentCommandOverridden = false;

  for (const setting of settings) {
    switch (setting.id) {
      case SETTING_ID_POLL_INTERVAL_MS: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null) {
          nextConfig.pollIntervalMs = clamp(parsed, 200, 10_000);
        }
        break;
      }
      case SETTING_ID_WORKER_CONCURRENCY: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null) {
          nextConfig.workerConcurrency = clamp(parsed, 1, 16);
        }
        break;
      }
      case SETTING_ID_COMMAND_TIMEOUT_MS: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null) {
          nextConfig.commandTimeoutMs = clamp(parsed, 1_000, 600_000);
        }
        break;
      }
      case SETTING_ID_MAX_ATTEMPTS_DEFAULT: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null) {
          nextConfig.maxAttemptsDefault = clamp(parsed, 1, 10);
        }
        break;
      }
      case SETTING_ID_MAX_TURNS: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null) {
          nextConfig.maxTurns = clamp(parsed, 1, 16);
        }
        break;
      }
      case SETTING_ID_RETRY_DELAY_MS: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null) {
          nextConfig.retryDelayMs = Math.max(0, parsed);
        }
        break;
      }
      case SETTING_ID_STALE_IN_PROGRESS_TIMEOUT_MS: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null) {
          nextConfig.staleInProgressTimeoutMs = Math.max(0, parsed);
        }
        break;
      }
      case SETTING_ID_LOG_LINES_TAIL: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null) {
          nextConfig.logLinesTail = clamp(parsed, 1_000, 200_000);
        }
        break;
      }
      case SETTING_ID_MAX_CONCURRENT_BY_STATE: {
        const parsed = sanitizeMaxConcurrentByState(setting.value);
        if (parsed) {
          nextConfig.maxConcurrentByState = parsed;
        }
        break;
      }
      case SETTING_ID_AGENT_PROVIDER: {
        if (typeof setting.value === "string") {
          nextConfig.agentProvider = normalizeAgentProvider(setting.value);
          agentProviderOverridden = true;
        }
        break;
      }
      case SETTING_ID_AGENT_COMMAND: {
        nextConfig.agentCommand = typeof setting.value === "string" ? setting.value.trim() : "";
        agentCommandOverridden = true;
        break;
      }
      case SETTING_ID_DEFAULT_EFFORT: {
        const parsed = sanitizeDefaultEffort(setting.value);
        if (parsed) {
          nextConfig.defaultEffort = parsed;
        }
        break;
      }
      default:
        break;
    }
  }

  if (agentProviderOverridden && !agentCommandOverridden) {
    nextConfig.agentCommand = getProviderDefaultCommand(
      nextConfig.agentProvider,
      nextConfig.defaultEffort?.default,
    );
  }

  return nextConfig;
}

export function inferSettingScope(settingId: string): RuntimeSettingScope {
  if (settingId.startsWith("runtime.")) return "runtime";
  if (settingId.startsWith("providers.")) return "providers";
  if (settingId.startsWith("ui.")) return "ui";
  return "system";
}

export async function persistSetting(
  id: string,
  value: unknown,
  options: {
    scope?: RuntimeSettingScope;
    source?: RuntimeSettingSource;
  } = {},
): Promise<RuntimeSettingRecord> {
  const setting: RuntimeSettingRecord = {
    id,
    scope: options.scope ?? inferSettingScope(id),
    value,
    source: options.source ?? "user",
    updatedAt: now(),
  };
  await replacePersistedSetting(setting);
  return setting;
}

export async function persistWorkerConcurrencySetting(value: number, source: RuntimeSettingRecord["source"] = "user"): Promise<void> {
  await persistSetting(
    SETTING_ID_WORKER_CONCURRENCY,
    clamp(Math.round(value), 1, 16),
    { scope: "runtime", source },
  );
}

export async function persistDetectedProvidersSetting(providers: DetectedProvider[]): Promise<void> {
  await persistSetting(
    SETTING_ID_DETECTED_PROVIDERS,
    {
      providers,
      detectedAt: now(),
    },
    { scope: "providers", source: "detected" },
  );
}

export async function persistRuntimeConfigSettings(
  config: RuntimeConfig,
  source: RuntimeSettingSource = "system",
): Promise<void> {
  await Promise.all(
    buildRuntimeConfigSettings(config, source).map((setting) =>
      replacePersistedSetting(setting),
    ),
  );
}

export async function syncRuntimeConfigSettings(
  config: RuntimeConfig,
  settings: RuntimeSettingRecord[],
): Promise<void> {
  const existingById = new Map(settings.map((setting) => [setting.id, setting]));
  const desiredSettings = buildRuntimeConfigSettings(config, "system");

  await Promise.all(
    desiredSettings.map(async (setting) => {
      const existing = existingById.get(setting.id);
      if (existing?.source === "user") return;
      await replacePersistedSetting({
        ...setting,
        source: existing?.source === "workflow" ? "workflow" : "system",
      });
    }),
  );
}

// ── Workflow Config (pipeline stage configuration) ────────────────────────

function isValidStage(v: unknown): v is PipelineStageConfig {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.provider === "string" && typeof s.model === "string" && typeof s.effort === "string";
}

/** Build a default workflow config from detected providers */
export function buildDefaultWorkflowConfig(detectedProviders: DetectedProvider[]): WorkflowConfig {
  const available = detectedProviders.filter((p) => p.available);
  const hasClaude = available.some((p) => p.name === "claude");
  const hasCodex = available.some((p) => p.name === "codex");

  const claudeDefault: PipelineStageConfig = { provider: "claude", model: "claude-sonnet-4-6", effort: "medium" };
  const codexDefault: PipelineStageConfig = { provider: "codex", model: "o4-mini", effort: "medium" };

  // Default: claude for plan+review (better reasoning), codex for execute (better code)
  if (hasClaude && hasCodex) {
    return {
      plan: { provider: "claude", model: "claude-sonnet-4-6", effort: "high" },
      execute: { provider: "codex", model: "o4-mini", effort: "medium" },
      review: { provider: "claude", model: "claude-sonnet-4-6", effort: "medium" },
    };
  }
  if (hasClaude) {
    return { plan: { ...claudeDefault, effort: "high" }, execute: claudeDefault, review: claudeDefault };
  }
  if (hasCodex) {
    return { plan: { ...codexDefault, effort: "high" }, execute: codexDefault, review: codexDefault };
  }
  return { plan: claudeDefault, execute: codexDefault, review: claudeDefault };
}

/** Load workflow config from settings */
export function getWorkflowConfig(settings: RuntimeSettingRecord[]): WorkflowConfig | null {
  const setting = settings.find((s) => s.id === SETTING_ID_WORKFLOW_CONFIG);
  if (!setting?.value || typeof setting.value !== "object") return null;
  const wf = setting.value as Record<string, unknown>;
  if (isValidStage(wf.plan) && isValidStage(wf.execute) && isValidStage(wf.review)) {
    return wf as unknown as WorkflowConfig;
  }
  return null;
}

/** Persist workflow config */
export async function persistWorkflowConfig(config: WorkflowConfig): Promise<void> {
  await persistSetting(SETTING_ID_WORKFLOW_CONFIG, config, { scope: "runtime", source: "user" });
}
