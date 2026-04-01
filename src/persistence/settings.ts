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
} from "../types.ts";
import type { DiscoveredModel } from "../agents/providers.ts";
import { clamp, now, toBooleanValue } from "../concerns/helpers.ts";
import {
  DEFAULT_ADAPTIVE_POLICY_MIN_SAMPLES,
  DEFAULT_AUTO_REPLAN_STALL_THRESHOLD,
  DEFAULT_MAX_REVIEW_AUTO_RETRIES,
} from "../concerns/constants.ts";
import { normalizeServiceEnvironment } from "../domains/service-env.ts";
import { loadPersistedSettings, replacePersistedSetting } from "./store.ts";
import { getProviderDefaultCommand, normalizeAgentProvider, readCodexConfig } from "../agents/providers.ts";

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
export const SETTING_ID_TEST_COMMAND = "runtime.testCommand";
export const SETTING_ID_MERGE_MODE = "runtime.mergeMode";
export const SETTING_ID_PR_BASE_BRANCH = "runtime.prBaseBranch";
export const SETTING_ID_AUTO_REVIEW_APPROVAL = "runtime.autoReviewApproval";
export const SETTING_ID_DOCKER_EXECUTION = "runtime.dockerExecution";
export const SETTING_ID_DOCKER_IMAGE = "runtime.dockerImage";
export const SETTING_ID_MAX_REVIEW_AUTO_RETRIES = "runtime.maxReviewAutoRetries";
export const SETTING_ID_ENABLE_PLAYWRIGHT_REVIEW = "runtime.enablePlaywrightReview";
export const SETTING_ID_AUTO_REPLAN_ON_STALL = "runtime.autoReplanOnStall";
export const SETTING_ID_AUTO_REPLAN_STALL_THRESHOLD = "runtime.autoReplanStallThreshold";
export const SETTING_ID_ADAPTIVE_HARNESS_SELECTION = "runtime.adaptiveHarnessSelection";
export const SETTING_ID_ADAPTIVE_REVIEW_ROUTING = "runtime.adaptiveReviewRouting";
export const SETTING_ID_ADAPTIVE_POLICY_MIN_SAMPLES = "runtime.adaptivePolicyMinSamples";
export const SETTING_ID_SERVICE_ENV = "runtime.serviceEnv";
export const SETTING_ID_MESH_ENABLED = "runtime.meshEnabled";
export const SETTING_ID_MESH_PROXY_PORT = "runtime.meshProxyPort";
export const SETTING_ID_MESH_BUFFER_SIZE = "runtime.meshBufferSize";
export const SETTING_ID_AUTO_APPROVE_TRIVIAL_PLANS = "runtime.autoApproveTrivialPlans";
export const SETTING_ID_AUTO_COMMIT_BEFORE_MERGE = "runtime.autoCommitBeforeMerge";
export const SETTING_ID_AUTO_RESOLVE_CONFLICTS = "runtime.autoResolveConflicts";
export const SETTING_ID_SANDBOX_EXECUTION = "runtime.sandboxExecution";
export const SETTING_ID_REVERSE_PROXY_ENABLED = "runtime.reverseProxyEnabled";
export const SETTING_ID_REVERSE_PROXY_PORT = "runtime.reverseProxyPort";
export const SETTING_ID_PROXY_ROUTES = "runtime.proxyRoutes";
export const SETTING_ID_LOCAL_DOMAIN = "runtime.localDomain";

const LOCAL_DOMAIN_PORT_SUFFIX = /:\d+$/;

function normalizeLocalDomain(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const hostOnly = withoutScheme.split("/")[0]?.split("?")[0] ?? "";
  return hostOnly.replace(LOCAL_DOMAIN_PORT_SUFFIX, "").toLowerCase();
}

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
  SETTING_ID_TEST_COMMAND,
  SETTING_ID_MERGE_MODE,
  SETTING_ID_PR_BASE_BRANCH,
  SETTING_ID_AUTO_REVIEW_APPROVAL,
  SETTING_ID_DOCKER_EXECUTION,
  SETTING_ID_DOCKER_IMAGE,
  SETTING_ID_MAX_REVIEW_AUTO_RETRIES,
  SETTING_ID_ENABLE_PLAYWRIGHT_REVIEW,
  SETTING_ID_AUTO_REPLAN_ON_STALL,
  SETTING_ID_AUTO_REPLAN_STALL_THRESHOLD,
  SETTING_ID_ADAPTIVE_HARNESS_SELECTION,
  SETTING_ID_ADAPTIVE_REVIEW_ROUTING,
  SETTING_ID_ADAPTIVE_POLICY_MIN_SAMPLES,
  SETTING_ID_SERVICE_ENV,
  SETTING_ID_MESH_ENABLED,
  SETTING_ID_MESH_PROXY_PORT,
  SETTING_ID_MESH_BUFFER_SIZE,
  SETTING_ID_AUTO_APPROVE_TRIVIAL_PLANS,
  SETTING_ID_AUTO_COMMIT_BEFORE_MERGE,
  SETTING_ID_AUTO_RESOLVE_CONFLICTS,
  SETTING_ID_SANDBOX_EXECUTION,
  SETTING_ID_REVERSE_PROXY_ENABLED,
  SETTING_ID_REVERSE_PROXY_PORT,
  SETTING_ID_PROXY_ROUTES,
  SETTING_ID_LOCAL_DOMAIN,
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
    { id: SETTING_ID_TEST_COMMAND, scope: "runtime", value: config.testCommand ?? "", source, updatedAt },
    { id: SETTING_ID_MERGE_MODE, scope: "runtime", value: config.mergeMode ?? "local", source, updatedAt },
    { id: SETTING_ID_PR_BASE_BRANCH, scope: "runtime", value: config.prBaseBranch ?? "", source, updatedAt },
    { id: SETTING_ID_AUTO_REVIEW_APPROVAL, scope: "runtime", value: config.autoReviewApproval, source, updatedAt },
    { id: SETTING_ID_DOCKER_EXECUTION, scope: "runtime", value: config.dockerExecution, source, updatedAt },
    { id: SETTING_ID_DOCKER_IMAGE, scope: "runtime", value: config.dockerImage, source, updatedAt },
    { id: SETTING_ID_MAX_REVIEW_AUTO_RETRIES, scope: "runtime", value: config.maxReviewAutoRetries ?? DEFAULT_MAX_REVIEW_AUTO_RETRIES, source, updatedAt },
    { id: SETTING_ID_ENABLE_PLAYWRIGHT_REVIEW, scope: "runtime", value: config.enablePlaywrightReview ?? false, source, updatedAt },
    { id: SETTING_ID_AUTO_REPLAN_ON_STALL, scope: "runtime", value: config.autoReplanOnStall ?? false, source, updatedAt },
    { id: SETTING_ID_AUTO_REPLAN_STALL_THRESHOLD, scope: "runtime", value: config.autoReplanStallThreshold ?? DEFAULT_AUTO_REPLAN_STALL_THRESHOLD, source, updatedAt },
    { id: SETTING_ID_ADAPTIVE_HARNESS_SELECTION, scope: "runtime", value: config.adaptiveHarnessSelection !== false, source, updatedAt },
    { id: SETTING_ID_ADAPTIVE_REVIEW_ROUTING, scope: "runtime", value: config.adaptiveReviewRouting !== false, source, updatedAt },
    { id: SETTING_ID_ADAPTIVE_POLICY_MIN_SAMPLES, scope: "runtime", value: config.adaptivePolicyMinSamples ?? DEFAULT_ADAPTIVE_POLICY_MIN_SAMPLES, source, updatedAt },
    { id: SETTING_ID_SERVICE_ENV, scope: "runtime", value: config.serviceEnv ?? {}, source, updatedAt },
    { id: SETTING_ID_MESH_ENABLED, scope: "runtime", value: config.meshEnabled ?? false, source, updatedAt },
    { id: SETTING_ID_MESH_PROXY_PORT, scope: "runtime", value: config.meshProxyPort ?? 0, source, updatedAt },
    { id: SETTING_ID_MESH_BUFFER_SIZE, scope: "runtime", value: config.meshBufferSize ?? 1000, source, updatedAt },
    { id: SETTING_ID_AUTO_APPROVE_TRIVIAL_PLANS, scope: "runtime", value: config.autoApproveTrivialPlans ?? true, source, updatedAt },
    { id: SETTING_ID_AUTO_COMMIT_BEFORE_MERGE, scope: "runtime", value: config.autoCommitBeforeMerge ?? true, source, updatedAt },
    { id: SETTING_ID_AUTO_RESOLVE_CONFLICTS, scope: "runtime", value: config.autoResolveConflicts ?? false, source, updatedAt },
    { id: SETTING_ID_SANDBOX_EXECUTION, scope: "runtime", value: config.sandboxExecution ?? false, source, updatedAt },
    { id: SETTING_ID_REVERSE_PROXY_ENABLED, scope: "runtime", value: config.reverseProxyEnabled ?? false, source, updatedAt },
    { id: SETTING_ID_REVERSE_PROXY_PORT, scope: "runtime", value: config.reverseProxyPort ?? 4433, source, updatedAt },
    { id: SETTING_ID_PROXY_ROUTES, scope: "runtime", value: config.proxyRoutes ?? [], source, updatedAt },
    { id: SETTING_ID_LOCAL_DOMAIN, scope: "runtime", value: config.localDomain ?? "", source, updatedAt },
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
          nextConfig.workerConcurrency = clamp(parsed, 1, 10);
        }
        break;
      }
      case SETTING_ID_COMMAND_TIMEOUT_MS: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null) {
          nextConfig.commandTimeoutMs = clamp(parsed, 1_000, 3_600_000);
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
      case SETTING_ID_TEST_COMMAND: {
        if (typeof setting.value === "string") {
          nextConfig.testCommand = setting.value.trim() || undefined;
        }
        break;
      }
      case SETTING_ID_MERGE_MODE: {
        if (setting.value === "local" || setting.value === "push-pr") {
          nextConfig.mergeMode = setting.value;
        }
        break;
      }
      case SETTING_ID_PR_BASE_BRANCH: {
        if (typeof setting.value === "string" && setting.value.trim()) {
          nextConfig.prBaseBranch = setting.value.trim();
        }
        break;
      }
      case SETTING_ID_AUTO_REVIEW_APPROVAL: {
        nextConfig.autoReviewApproval = toBooleanValue(setting.value, true);
        break;
      }
      case SETTING_ID_DOCKER_EXECUTION: {
        nextConfig.dockerExecution = toBooleanValue(setting.value, false);
        break;
      }
      case SETTING_ID_DOCKER_IMAGE: {
        if (typeof setting.value === "string" && setting.value.trim()) {
          nextConfig.dockerImage = setting.value.trim();
        }
        break;
      }
      case SETTING_ID_MAX_REVIEW_AUTO_RETRIES: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null && parsed >= 0 && parsed <= 10) {
          nextConfig.maxReviewAutoRetries = parsed;
        }
        break;
      }
      case SETTING_ID_ENABLE_PLAYWRIGHT_REVIEW: {
        nextConfig.enablePlaywrightReview = toBooleanValue(setting.value, false);
        break;
      }
      case SETTING_ID_AUTO_REPLAN_ON_STALL: {
        nextConfig.autoReplanOnStall = toBooleanValue(setting.value, false);
        break;
      }
      case SETTING_ID_AUTO_REPLAN_STALL_THRESHOLD: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null && parsed >= 2 && parsed <= 5) {
          nextConfig.autoReplanStallThreshold = parsed;
        }
        break;
      }
      case SETTING_ID_ADAPTIVE_HARNESS_SELECTION: {
        nextConfig.adaptiveHarnessSelection = toBooleanValue(setting.value, true);
        break;
      }
      case SETTING_ID_ADAPTIVE_REVIEW_ROUTING: {
        nextConfig.adaptiveReviewRouting = toBooleanValue(setting.value, true);
        break;
      }
      case SETTING_ID_ADAPTIVE_POLICY_MIN_SAMPLES: {
        const parsed = parseIntegerSetting(setting.value);
        if (parsed !== null && parsed >= 1 && parsed <= 10) {
          nextConfig.adaptivePolicyMinSamples = parsed;
        }
        break;
      }
      case SETTING_ID_SERVICE_ENV: {
        const parsed = normalizeServiceEnvironment(setting.value);
        if (parsed.errors.length === 0) {
          nextConfig.serviceEnv = parsed.env;
        }
        break;
      }
      case SETTING_ID_MESH_ENABLED: {
        nextConfig.meshEnabled = setting.value === true || setting.value === "true";
        break;
      }
      case SETTING_ID_MESH_PROXY_PORT: {
        const parsed = Number(setting.value);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 65535) {
          nextConfig.meshProxyPort = parsed;
        }
        break;
      }
      case SETTING_ID_MESH_BUFFER_SIZE: {
        const parsed = Number(setting.value);
        if (!Number.isNaN(parsed) && parsed >= 100 && parsed <= 10000) {
          nextConfig.meshBufferSize = parsed;
        }
        break;
      }
      case SETTING_ID_AUTO_APPROVE_TRIVIAL_PLANS: {
        nextConfig.autoApproveTrivialPlans = toBooleanValue(setting.value, true);
        break;
      }
      case SETTING_ID_AUTO_COMMIT_BEFORE_MERGE: {
        nextConfig.autoCommitBeforeMerge = toBooleanValue(setting.value, true);
        break;
      }
      case SETTING_ID_AUTO_RESOLVE_CONFLICTS: {
        nextConfig.autoResolveConflicts = toBooleanValue(setting.value, false);
        break;
      }
      case SETTING_ID_SANDBOX_EXECUTION: {
        nextConfig.sandboxExecution = toBooleanValue(setting.value, false);
        break;
      }
      case SETTING_ID_REVERSE_PROXY_ENABLED: {
        nextConfig.reverseProxyEnabled = toBooleanValue(setting.value, false);
        break;
      }
      case SETTING_ID_REVERSE_PROXY_PORT: {
        const parsed = Number(setting.value);
        if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
          nextConfig.reverseProxyPort = parsed;
        }
        break;
      }
      case SETTING_ID_PROXY_ROUTES: {
        if (Array.isArray(setting.value)) {
          nextConfig.proxyRoutes = setting.value as import("../types.ts").ProxyRoute[];
        }
        break;
      }
      case SETTING_ID_LOCAL_DOMAIN: {
        const d = normalizeLocalDomain(setting.value);
        if (d) nextConfig.localDomain = d;
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
    clamp(Math.round(value), 1, 10),
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
  // model is optional — empty string means "use CLI default"
  return typeof s.provider === "string" && typeof s.effort === "string";
}

/**
 * Build a default workflow config using discovered models.
 * Never hardcodes model IDs — always uses the first model from each provider's discovery.
 * Falls back to provider name as model if discovery returned nothing.
 */
export function buildDefaultWorkflowConfig(
  detectedProviders: DetectedProvider[],
  discoveredModels?: Record<string, DiscoveredModel[]>,
): WorkflowConfig {
  const available = detectedProviders.filter((p) => p.available);
  const hasClaude = available.some((p) => p.name === "claude");
  const hasCodex = available.some((p) => p.name === "codex");

  // Pick the first discovered model per provider (discoverModels promotes the user's configured CLI default to [0])
  const claudeModel = discoveredModels?.claude?.[0]?.id || "";
  const codexModel = discoveredModels?.codex?.[0]?.id || "";

  // Use the effort the user already configured in ~/.codex/config.toml as the execute default
  const codexEffort = (readCodexConfig().reasoningEffort as ReasoningEffort | undefined) || "medium";

  const claudeDefault: PipelineStageConfig = { provider: "claude", model: claudeModel, effort: "medium" };
  const codexDefault: PipelineStageConfig = { provider: "codex", model: codexModel, effort: codexEffort };

  // Default: claude for plan+review (better reasoning), codex for execute (better code)
  if (hasClaude && hasCodex) {
    const planConfig = { ...claudeDefault, effort: "high" as ReasoningEffort };
    return {
      enhance: { ...planConfig },
      chat: { ...planConfig, effort: "medium" as ReasoningEffort },
      plan: planConfig,
      execute: { ...codexDefault },
      review: { ...claudeDefault },
      services: { ...planConfig, effort: "medium" as ReasoningEffort },
    };
  }
  if (hasClaude) {
    const planConfig = { ...claudeDefault, effort: "high" as ReasoningEffort };
    return {
      enhance: { ...planConfig },
      chat: { ...planConfig, effort: "medium" as ReasoningEffort },
      plan: planConfig,
      execute: claudeDefault,
      review: claudeDefault,
      services: { ...planConfig, effort: "medium" as ReasoningEffort },
    };
  }
  if (hasCodex) {
    const planConfig = { ...codexDefault, effort: "high" as ReasoningEffort };
    return {
      enhance: { ...planConfig },
      chat: { ...planConfig, effort: "medium" as ReasoningEffort },
      plan: planConfig,
      execute: codexDefault,
      review: codexDefault,
      services: { ...planConfig, effort: "medium" as ReasoningEffort },
    };
  }
  const planConfig = { ...claudeDefault };
  return {
    enhance: { ...planConfig },
    chat: { ...planConfig, effort: "medium" as ReasoningEffort },
    plan: planConfig,
    execute: codexDefault,
    review: claudeDefault,
    services: { ...planConfig, effort: "medium" as ReasoningEffort },
  };
}

/** Load workflow config from settings */
export function getWorkflowConfig(settings: RuntimeSettingRecord[]): WorkflowConfig | null {
  const setting = settings.find((s) => s.id === SETTING_ID_WORKFLOW_CONFIG);
  if (!setting?.value || typeof setting.value !== "object") return null;
  const wf = setting.value as Record<string, unknown>;
  if (isValidStage(wf.plan) && isValidStage(wf.execute) && isValidStage(wf.review)) {
    const config: WorkflowConfig = {
      plan: wf.plan as PipelineStageConfig,
      execute: wf.execute as PipelineStageConfig,
      review: wf.review as PipelineStageConfig,
    };
    if (isValidStage(wf.enhance)) config.enhance = wf.enhance as PipelineStageConfig;
    if (isValidStage(wf.chat)) config.chat = wf.chat as PipelineStageConfig;
    if (isValidStage(wf.services)) config.services = wf.services as PipelineStageConfig;
    return config;
  }
  return null;
}

/** Persist workflow config */
export async function persistWorkflowConfig(config: WorkflowConfig): Promise<void> {
  await persistSetting(SETTING_ID_WORKFLOW_CONFIG, config, { scope: "runtime", source: "user" });
}
