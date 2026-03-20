import { env } from "node:process";
import type { RuntimeConfig, ReasoningEffort, EffortConfig } from "../types.ts";
import {
  clamp,
  toStringValue,
  parseEnvNumber,
  parseIntArg,
  parsePositiveIntEnv,
  fail,
} from "../concerns/helpers.ts";
import { normalizeAgentProvider } from "../agents/providers.ts";

const VALID_EFFORTS = new Set(["low", "medium", "high", "extra-high"]);

function parseEffortValue(value: unknown): ReasoningEffort | undefined {
  const str = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_EFFORTS.has(str) ? (str as ReasoningEffort) : undefined;
}

export function parseEffortConfig(value: unknown): EffortConfig | undefined {
  if (!value || typeof value !== "object") {
    // Simple string → default effort for all roles
    const simple = parseEffortValue(value);
    return simple ? { default: simple } : undefined;
  }
  const obj = value as Record<string, unknown>;
  const config: EffortConfig = {};
  const d = parseEffortValue(obj.default);
  const p = parseEffortValue(obj.planner);
  const e = parseEffortValue(obj.executor);
  const r = parseEffortValue(obj.reviewer);
  if (d) config.default = d;
  if (p) config.planner = p;
  if (e) config.executor = e;
  if (r) config.reviewer = r;
  return Object.keys(config).length > 0 ? config : undefined;
}

export function deriveConfig(args: string[]): RuntimeConfig {
  const parsedConcurrency = parsePositiveIntEnv("FIFONY_WORKER_CONCURRENCY", 3);
  let pollIntervalMs = parseEnvNumber("FIFONY_POLL_INTERVAL_MS", 1200);
  let workerConcurrency = parsedConcurrency;
  let maxAttemptsDefault = parseEnvNumber("FIFONY_MAX_ATTEMPTS", 3);
  let commandTimeoutMs = parseEnvNumber("FIFONY_AGENT_TIMEOUT_MS", 1_800_000);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--poll") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) fail(`Invalid value for --poll: ${value}`);
      pollIntervalMs = parseIntArg(value, pollIntervalMs);
    }
    if (arg === "--concurrency") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) fail(`Invalid value for --concurrency: ${value}`);
      workerConcurrency = parseIntArg(value, workerConcurrency);
    }
    if (arg === "--attempts") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) fail(`Invalid value for --attempts: ${value}`);
      maxAttemptsDefault = parseIntArg(value, maxAttemptsDefault);
    }
    if (arg === "--timeout") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) fail(`Invalid value for --timeout: ${value}`);
      commandTimeoutMs = parseIntArg(value, commandTimeoutMs);
    }
  }

  return {
    pollIntervalMs: clamp(pollIntervalMs, 200, 10_000),
    workerConcurrency: clamp(workerConcurrency, 1, 10),
    commandTimeoutMs: clamp(commandTimeoutMs, 1_000, 3_600_000),
    maxAttemptsDefault: clamp(maxAttemptsDefault, 1, 10),
    maxTurns: clamp(parseEnvNumber("FIFONY_AGENT_MAX_TURNS", 4), 1, 16),
    retryDelayMs: parseEnvNumber("FIFONY_RETRY_DELAY_MS", 3_000),
    staleInProgressTimeoutMs: parseEnvNumber("FIFONY_STALE_IN_PROGRESS_MS", 2_400_000),
    logLinesTail: parseEnvNumber("FIFONY_LOG_TAIL_CHARS", 12_000),
    maxPreviousOutputChars: parseEnvNumber("FIFONY_PREVIOUS_OUTPUT_CHARS", 20_000),
    agentProvider: normalizeAgentProvider(env.FIFONY_AGENT_PROVIDER ?? "codex"),
    agentCommand: toStringValue(env.FIFONY_AGENT_COMMAND, ""),
    defaultEffort: {
      default: parseEffortValue(env.FIFONY_REASONING_EFFORT),
      planner: parseEffortValue(env.FIFONY_PLANNER_EFFORT),
      executor: parseEffortValue(env.FIFONY_EXECUTOR_EFFORT),
      reviewer: parseEffortValue(env.FIFONY_REVIEWER_EFFORT),
    },
    maxConcurrentByState: {},
    runMode: "filesystem",
    afterCreateHook: env.FIFONY_AFTER_CREATE_HOOK ?? "",
    beforeRunHook: env.FIFONY_BEFORE_RUN_HOOK ?? "",
    afterRunHook: env.FIFONY_AFTER_RUN_HOOK ?? "",
    beforeRemoveHook: env.FIFONY_BEFORE_REMOVE_HOOK ?? "",
  };
}

export function applyWorkflowConfig(
  config: RuntimeConfig,
  port: number | undefined,
): RuntimeConfig {
  return {
    ...config,
    dashboardPort: port ? String(port) : config.dashboardPort,
  };
}

export function validateConfig(config: RuntimeConfig): string[] {
  const errors: string[] = [];
  if (config.pollIntervalMs < 200) errors.push(`pollIntervalMs too low: ${config.pollIntervalMs} (min 200)`);
  if (config.workerConcurrency < 1 || config.workerConcurrency > 10) errors.push(`workerConcurrency out of range: ${config.workerConcurrency} (1-10)`);
  if (config.maxAttemptsDefault < 1 || config.maxAttemptsDefault > 10) errors.push(`maxAttemptsDefault out of range: ${config.maxAttemptsDefault} (1-10)`);
  if (config.maxTurns < 1 || config.maxTurns > 16) errors.push(`maxTurns out of range: ${config.maxTurns} (1-16)`);
  if (config.commandTimeoutMs < 1000) errors.push(`commandTimeoutMs too low: ${config.commandTimeoutMs} (min 1000)`);
  if (config.retryDelayMs < 0) errors.push(`retryDelayMs negative: ${config.retryDelayMs}`);
  for (const [stateKey, limit] of Object.entries(config.maxConcurrentByState)) {
    if (limit < 1) errors.push(`maxConcurrentByState[${stateKey}] must be >= 1, got ${limit}`);
  }
  return errors;
}
