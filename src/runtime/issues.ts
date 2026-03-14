import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { env } from "node:process";
import type {
  IssueEntry,
  IssueState,
  JsonRecord,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeEventType,
  RuntimeMetrics,
  RuntimeState,
  WorkflowDefinition,
} from "./types.ts";
import {
  ALLOWED_STATES,
  PERSIST_EVENTS_MAX,
  TERMINAL_STATES,
  STATE_ROOT,
  TARGET_ROOT,
  WORKFLOW_RENDERED,
} from "./constants.ts";
import {
  now,
  toStringValue,
  toNumberValue,
  toBooleanValue,
  toStringArray,
  clamp,
  normalizeState,
  parseEnvNumber,
  parseIntArg,
  parsePositiveIntEnv,
  withRetryBackoff,
  getNestedRecord,
  getNestedString,
  getNestedNumber,
  fail,
} from "./helpers.ts";
import { logger } from "./logger.ts";
import {
  normalizeAgentProvider,
  resolveAgentCommand,
  getCapabilityRoutingOptions,
  applyCapabilityMetadata,
} from "./providers.ts";
import { resolveTaskCapabilities, type CapabilityResolverOptions } from "../routing/capability-resolver.ts";

export function normalizeIssue(
  raw: JsonRecord,
  workflowDefinition: WorkflowDefinition | null,
): IssueEntry | null {
  const id = toStringValue(raw.id, "") || toStringValue(raw.identifier, "");
  if (!id) return null;

  const createdAt = toStringValue(raw.created_at, now());
  const updatedAt = toStringValue(raw.updated_at, createdAt);
  const paths = toStringArray(raw.paths);
  const legacyFiles = toStringArray(raw.files);

  const issue: IssueEntry = {
    id,
    identifier: toStringValue(raw.identifier, id),
    title: toStringValue(raw.title, `Issue ${id}`),
    description: toStringValue(raw.description, ""),
    priority: toNumberValue(raw.priority, 1),
    state: normalizeState(raw.state),
    branchName: toStringValue(raw.branch_name) || toStringValue(raw.branchName),
    url: toStringValue(raw.url),
    assigneeId: toStringValue(raw.assignee_id),
    labels: toStringArray(raw.labels),
    paths: paths.length > 0 ? paths : legacyFiles,
    inferredPaths: toStringArray(raw.inferredPaths),
    capabilityCategory: toStringValue(raw.capabilityCategory),
    capabilityOverlays: toStringArray(raw.capabilityOverlays),
    capabilityRationale: toStringArray(raw.capabilityRationale),
    blockedBy: toStringArray(raw.blocked_by),
    assignedToWorker: toBooleanValue(raw.assigned_to_worker, true),
    createdAt,
    updatedAt,
    history: [],
    attempts: toNumberValue(raw.attempts, 0),
    maxAttempts: toNumberValue(raw.max_attempts, 3),
    nextRetryAt: toStringValue(raw.next_retry_at),
  };

  if (!issue.capabilityCategory) {
    applyCapabilityMetadata(issue, resolveTaskCapabilities({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      labels: issue.labels,
      paths: issue.paths,
    }, getCapabilityRoutingOptions(workflowDefinition)));
  }

  return issue;
}

export function loadSeedIssues(
  path: string,
  workflowDefinition: WorkflowDefinition | null,
): IssueEntry[] {
  const sourcePath = env.SYMPHIFO_ISSUES_JSON ?? path;

  if (sourcePath !== path && sourcePath) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${sourcePath}\n`, "utf8");
  }

  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Invalid local issues JSON: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    fail("Local issues payload must be an array.");
  }

  return parsed
    .filter((candidate): candidate is JsonRecord => typeof candidate === "object" && candidate !== null)
    .map((candidate) => normalizeIssue(candidate, workflowDefinition))
    .filter((issue): issue is IssueEntry => issue !== null);
}

export function nextLocalIssueId(issues: IssueEntry[]): string {
  const maxId = issues.reduce((current, issue) => {
    const match = issue.identifier.match(/^LOCAL-(\d+)$/);
    if (!match) return current;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? Math.max(current, parsed) : current;
  }, 0);

  return `LOCAL-${maxId + 1}`;
}

export function createIssueFromPayload(
  payload: JsonRecord,
  issues: IssueEntry[],
  workflowDefinition: WorkflowDefinition | null,
): IssueEntry {
  const identifier = toStringValue(payload.identifier, nextLocalIssueId(issues));
  const id = toStringValue(payload.id, identifier);
  const createdAt = now();
  const blockedBy = toStringArray(payload.blockedBy);
  const legacyBlockedBy = toStringArray(payload.blocked_by);
  const paths = toStringArray(payload.paths);
  const legacyFiles = toStringArray(payload.files);

  const issue: IssueEntry = {
    id,
    identifier,
    title: toStringValue(payload.title, `Issue ${identifier}`),
    description: toStringValue(payload.description, ""),
    priority: clamp(toNumberValue(payload.priority, 1), 1, 10),
    state: "Todo",
    branchName: toStringValue(payload.branchName) || toStringValue(payload.branch_name),
    url: toStringValue(payload.url),
    assigneeId: toStringValue(payload.assigneeId) || toStringValue(payload.assignee_id),
    labels: toStringArray(payload.labels),
    paths: paths.length > 0 ? paths : legacyFiles,
    inferredPaths: [],
    capabilityCategory: "",
    capabilityOverlays: [],
    capabilityRationale: [],
    blockedBy: blockedBy.length > 0 ? blockedBy : legacyBlockedBy,
    assignedToWorker: true,
    createdAt,
    updatedAt: createdAt,
    history: [`[${createdAt}] Issue created via API.`],
    attempts: 0,
    maxAttempts: clamp(toNumberValue(payload.maxAttempts ?? payload.max_attempts, 3), 1, 10),
  };

  applyCapabilityMetadata(issue, resolveTaskCapabilities({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    labels: issue.labels,
    paths: issue.paths,
  }, getCapabilityRoutingOptions(workflowDefinition)));

  return issue;
}

export function deriveConfig(args: string[]): RuntimeConfig {
  const parsedConcurrency = parsePositiveIntEnv("SYMPHIFO_WORKER_CONCURRENCY", 2);
  let pollIntervalMs = parseEnvNumber("SYMPHIFO_POLL_INTERVAL_MS", 1200);
  let workerConcurrency = parsedConcurrency;
  let maxAttemptsDefault = parseEnvNumber("SYMPHIFO_MAX_ATTEMPTS", 3);
  let commandTimeoutMs = parseEnvNumber("SYMPHIFO_AGENT_TIMEOUT_MS", 120000);

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
  }

  return {
    pollIntervalMs: clamp(pollIntervalMs, 200, 10_000),
    workerConcurrency: clamp(workerConcurrency, 1, 16),
    commandTimeoutMs: clamp(commandTimeoutMs, 1_000, 600_000),
    maxAttemptsDefault: clamp(maxAttemptsDefault, 1, 10),
    maxTurns: clamp(parseEnvNumber("SYMPHIFO_AGENT_MAX_TURNS", 4), 1, 16),
    retryDelayMs: parseEnvNumber("SYMPHIFO_RETRY_DELAY_MS", 3_000),
    staleInProgressTimeoutMs: parseEnvNumber("SYMPHIFO_STALE_IN_PROGRESS_MS", 20_000),
    logLinesTail: parseEnvNumber("SYMPHIFO_LOG_TAIL_CHARS", 12_000),
    agentProvider: normalizeAgentProvider(env.SYMPHIFO_AGENT_PROVIDER ?? "codex"),
    agentCommand: toStringValue(env.SYMPHIFO_AGENT_COMMAND, ""),
    maxConcurrentByState: {},
    runMode: "filesystem",
  };
}

function parseMaxConcurrentByState(agentConfig: JsonRecord): Record<string, number> {
  const raw = agentConfig?.max_concurrent_agents_by_state;
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const num = typeof value === "number" ? value : Number.parseInt(String(value), 10);
    if (Number.isFinite(num) && num > 0) {
      result[key.toLowerCase()] = num;
    }
  }
  return result;
}

export function applyWorkflowConfig(
  config: RuntimeConfig,
  definition: WorkflowDefinition,
  port: number | undefined,
): RuntimeConfig {
  const pollConfig = getNestedRecord(definition.config, "poll");
  const agentConfig = getNestedRecord(definition.config, "agent");
  const codexConfig = getNestedRecord(definition.config, "codex");
  const claudeConfig = getNestedRecord(definition.config, "claude");
  const serverConfig = getNestedRecord(definition.config, "server");
  const agentProvider = normalizeAgentProvider(
    getNestedString(agentConfig, "provider", definition.agentProvider || config.agentProvider),
  );
  const codexCommand = getNestedString(codexConfig, "command");
  const claudeCommand = getNestedString(claudeConfig, "command");

  return {
    ...config,
    pollIntervalMs: clamp(getNestedNumber(pollConfig, "interval_ms", config.pollIntervalMs), 200, 10_000),
    workerConcurrency: clamp(
      getNestedNumber(agentConfig, "max_concurrent_agents", config.workerConcurrency),
      1, 16,
    ),
    maxAttemptsDefault: clamp(getNestedNumber(agentConfig, "max_attempts", config.maxAttemptsDefault), 1, 10),
    maxTurns: clamp(getNestedNumber(agentConfig, "max_turns", config.maxTurns), 1, 16),
    commandTimeoutMs: clamp(
      getNestedNumber(codexConfig, "timeout_ms", config.commandTimeoutMs),
      1_000, 600_000,
    ),
    maxConcurrentByState: parseMaxConcurrentByState(agentConfig),
    agentProvider,
    agentCommand: resolveAgentCommand(agentProvider, config.agentCommand, codexCommand, claudeCommand),
    dashboardPort: String(
      port ?? (getNestedNumber(serverConfig, "port", Number.parseInt(config.dashboardPort ?? "0", 10) || 0) || 0),
    ),
    runMode: "filesystem",
  };
}

export function validateConfig(config: RuntimeConfig): string[] {
  const errors: string[] = [];
  if (config.pollIntervalMs < 200) errors.push(`pollIntervalMs too low: ${config.pollIntervalMs} (min 200)`);
  if (config.workerConcurrency < 1 || config.workerConcurrency > 16) errors.push(`workerConcurrency out of range: ${config.workerConcurrency} (1-16)`);
  if (config.maxAttemptsDefault < 1 || config.maxAttemptsDefault > 10) errors.push(`maxAttemptsDefault out of range: ${config.maxAttemptsDefault} (1-10)`);
  if (config.maxTurns < 1 || config.maxTurns > 16) errors.push(`maxTurns out of range: ${config.maxTurns} (1-16)`);
  if (config.commandTimeoutMs < 1000) errors.push(`commandTimeoutMs too low: ${config.commandTimeoutMs} (min 1000)`);
  if (config.retryDelayMs < 0) errors.push(`retryDelayMs negative: ${config.retryDelayMs}`);
  for (const [stateKey, limit] of Object.entries(config.maxConcurrentByState)) {
    if (limit < 1) errors.push(`maxConcurrentByState[${stateKey}] must be >= 1, got ${limit}`);
  }
  return errors;
}

export function dedupHistoryEntries(issues: IssueEntry[]): void {
  for (const issue of issues) {
    const seen = new Set<string>();
    issue.history = issue.history.filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

export function mergeStateWithSeed(
  seedIssues: IssueEntry[],
  previous: RuntimeState | null,
  config: RuntimeConfig,
  definition: WorkflowDefinition,
): RuntimeState {
  const previousMap = new Map((previous?.issues ?? []).map((issue) => [issue.id, issue]));

  const mergedIssues = seedIssues.map((seed) => {
    const saved = previousMap.get(seed.id);
    if (!saved) return seed;

    return {
      ...seed,
      state: normalizeState(saved.state),
      history: saved.history,
      attempts: clamp(saved.attempts, 0, config.maxAttemptsDefault),
      maxAttempts: clamp(saved.maxAttempts, 1, config.maxAttemptsDefault),
      nextRetryAt: toStringValue(saved.nextRetryAt),
      startedAt: saved.startedAt,
      completedAt: saved.completedAt,
      updatedAt: saved.updatedAt,
      workspacePath: saved.workspacePath,
      workspacePreparedAt: saved.workspacePreparedAt,
      lastError: saved.lastError,
      durationMs: typeof saved.durationMs === "number" ? saved.durationMs : undefined,
      commandExitCode: typeof saved.commandExitCode === "number" ? saved.commandExitCode : saved.commandExitCode,
      commandOutputTail: toStringValue(saved.commandOutputTail),
    };
  });

  dedupHistoryEntries(mergedIssues);

  const metrics = computeMetrics(mergedIssues);

  return {
    startedAt: previous?.startedAt ?? now(),
    updatedAt: now(),
    trackerKind: "filesystem",
    sourceRepoUrl: TARGET_ROOT,
    sourceRef: "workspace",
    workflowPath: WORKFLOW_RENDERED,
    config: {
      ...config,
      dashboardPort: previous?.config.dashboardPort,
    },
    issues: mergedIssues,
    events: previous?.events ?? [],
    metrics,
    notes: previous?.notes ?? [
      "Local TypeScript runtime bootstrapped.",
      `Workflow loaded from ${definition.workflowPath}.`,
      "Codex-only execution path enabled.",
      "No external tracker dependency (filesystem-backed local mode).",
    ],
  };
}

export function computeMetrics(issues: IssueEntry[]): RuntimeMetrics {
  let queued = 0;
  let inProgress = 0;
  let blocked = 0;
  let done = 0;
  let cancelled = 0;
  const completionTimes: number[] = [];

  for (const issue of issues) {
    const duration = issue.durationMs;
    if (issue.state === "Done") {
      const candidate = typeof duration === "number" && Number.isFinite(duration)
        ? duration
        : Number.isFinite(Date.parse(issue.startedAt ?? "")) && Number.isFinite(Date.parse(issue.completedAt ?? ""))
          ? Date.parse(issue.completedAt) - Date.parse(issue.startedAt)
          : NaN;
      if (Number.isFinite(candidate) && candidate >= 0) {
        completionTimes.push(candidate);
      }
    }

    switch (issue.state) {
      case "Todo":
      case "Blocked":
        queued += 1;
        break;
      case "In Progress":
      case "In Review":
        inProgress += 1;
        break;
      case "Done":
        done += 1;
        break;
      case "Cancelled":
        cancelled += 1;
        break;
    }
    if (issue.state === "Blocked") blocked += 1;
  }

  if (completionTimes.length === 0) {
    return {
      total: issues.length,
      queued,
      inProgress,
      blocked,
      done,
      cancelled,
      activeWorkers: 0,
    };
  }

  const sortedCompletionTimes = completionTimes.slice().sort((a, b) => a - b);
  const totalCompletionMs = sortedCompletionTimes.reduce((acc, value) => acc + value, 0);
  const mid = Math.floor(sortedCompletionTimes.length / 2);
  const medianCompletionMs = sortedCompletionTimes.length % 2 === 1
    ? sortedCompletionTimes[mid]
    : Math.round((sortedCompletionTimes[mid - 1] + sortedCompletionTimes[mid]) / 2);

  return {
    total: issues.length,
    queued,
    inProgress,
    blocked,
    done,
    cancelled,
    activeWorkers: 0,
    avgCompletionMs: Math.round(totalCompletionMs / completionTimes.length),
    medianCompletionMs,
    fastestCompletionMs: sortedCompletionTimes[0]!,
    slowestCompletionMs: sortedCompletionTimes[sortedCompletionTimes.length - 1]!,
  };
}

export function computeCapabilityCounts(issues: IssueEntry[]): Record<string, number> {
  return issues.reduce<Record<string, number>>((accumulator, issue) => {
    const key = issue.capabilityCategory?.trim() || "default";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

export function addEvent(
  state: RuntimeState,
  issueId: string | undefined,
  kind: RuntimeEventType,
  message: string,
): void {
  const event: RuntimeEvent = {
    id: `${Date.now()}-${state.events.length + 1}`,
    issueId,
    kind,
    message,
    at: now(),
  };

  state.events = [event, ...state.events].slice(0, PERSIST_EVENTS_MAX);
  logger.info({ issueId, kind }, message);
}

export function transition(issue: IssueEntry, target: IssueState, note: string): void {
  const previous = issue.state;
  issue.state = target;
  issue.updatedAt = now();
  issue.history.push(`[${issue.updatedAt}] ${note}`);

  if (previous === "Blocked" && target === "Todo") {
    issue.lastError = undefined;
    issue.nextRetryAt = undefined;
  }

  if (TERMINAL_STATES.has(target)) {
    issue.completedAt = now();
    issue.nextRetryAt = undefined;
  }

  if (target === "Todo") {
    issue.attempts = Math.max(0, issue.attempts - 1);
  }

  if (target === "Done") {
    issue.lastError = undefined;
  }
}

export function issueDependenciesResolved(issue: IssueEntry, allIssues: IssueEntry[]): boolean {
  if (issue.blockedBy.length === 0) return true;
  const map = new Map(allIssues.map((entry) => [entry.id, entry]));
  return issue.blockedBy.every((dependencyId) => {
    const dep = map.get(dependencyId);
    return dep?.state === "Done";
  });
}

export function getNextRetryAt(issue: IssueEntry, baseMs: number): string {
  const nextAttempt = issue.attempts + 1;
  const nextDelay = withRetryBackoff(nextAttempt, baseMs);
  return new Date(Date.now() + nextDelay).toISOString();
}

export function handleStatePatch(state: RuntimeState, issue: IssueEntry, payload: JsonRecord): void {
  const nextState = normalizeState(payload.state);
  const allowed = new Set([...ALLOWED_STATES]);

  if (!allowed.has(nextState)) {
    throw new Error(`Unsupported state: ${String(payload.state)}`);
  }

  transition(issue, nextState, `Manual state update: ${nextState}`);
  if (nextState === "Todo") {
    issue.nextRetryAt = undefined;
    issue.lastError = undefined;
  }
  if (nextState === "Cancelled") {
    issue.lastError = toStringValue(payload.reason);
  }

  addEvent(state, issue.id, "manual", `Manual state transition to ${nextState}`);
}
