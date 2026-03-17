import { env } from "node:process";
import * as tokenLedger from "./token-ledger.ts";
import { markIssueDirty, markEventDirty } from "./dirty-tracker.ts";
import { invalidateMetrics } from "./metrics-cache.ts";
import type {
  EffortConfig,
  IssueEntry,
  IssueState,
  JsonRecord,
  ReasoningEffort,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeEventType,
  RuntimeMetrics,
  RuntimeState,
  WorkflowDefinition,
} from "./types.ts";
import {
  ISSUE_STATE_MACHINE_ID,
  findIssueStateMachineTransitionPath,
  getIssueStateMachineDefinition,
  getIssueStateMachineInitialState,
  getIssueStateMachinePlugin,
  type IssueStateMachinePluginLike,
} from "./issue-state-machine.ts";
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
  isoWeek,
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
import { resolveTaskCapabilities } from "../routing/capability-resolver.ts";

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

const VALID_EFFORTS = new Set(["low", "medium", "high", "extra-high"]);

function parseEffortValue(value: unknown): ReasoningEffort | undefined {
  const str = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_EFFORTS.has(str) ? (str as ReasoningEffort) : undefined;
}

function parseEffortConfig(value: unknown): EffortConfig | undefined {
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

export function nextLocalIssueId(issues: IssueEntry[]): string {
  const maxId = issues.reduce((current, issue) => {
    // Support both old LOCAL-N and new #N formats
    const match = issue.identifier.match(/^(?:LOCAL-|#)(\d+)$/);
    if (!match) return current;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? Math.max(current, parsed) : current;
  }, 0);

  return `#${maxId + 1}`;
}

export function createIssueFromPayload(
  payload: JsonRecord,
  issues: IssueEntry[],
  workflowDefinition: WorkflowDefinition | null,
): IssueEntry {
  const identifier = toStringValue(payload.identifier, nextLocalIssueId(issues));
  const id = toStringValue(payload.id, identifier.replace(/^#/, "issue-"));
  logger.info({ id, identifier, title: toStringValue(payload.title, "").slice(0, 80) }, "[Issues] Creating new issue");
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
    state: payload.plan ? "Todo" : "Planning",
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
    terminalWeek: "",
    effort: parseEffortConfig(payload.effort),
    plan: payload.plan && typeof payload.plan === "object" ? payload.plan as IssueEntry["plan"] : undefined,
  };

  // If plan provides suggestions, apply them
  if (issue.plan) {
    if (issue.plan.suggestedPaths?.length && !issue.paths?.length) {
      issue.paths = issue.plan.suggestedPaths;
    }
    if (issue.plan.suggestedLabels?.length && !issue.labels?.length) {
      issue.labels = issue.plan.suggestedLabels;
    }
    if (issue.plan.suggestedEffort && !issue.effort) {
      issue.effort = issue.plan.suggestedEffort;
    }
  }

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
  const parsedConcurrency = parsePositiveIntEnv("FIFONY_WORKER_CONCURRENCY", 2);
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
    workerConcurrency: clamp(workerConcurrency, 1, 16),
    commandTimeoutMs: clamp(commandTimeoutMs, 1_000, 3_600_000),
    maxAttemptsDefault: clamp(maxAttemptsDefault, 1, 10),
    maxTurns: clamp(parseEnvNumber("FIFONY_AGENT_MAX_TURNS", 4), 1, 16),
    retryDelayMs: parseEnvNumber("FIFONY_RETRY_DELAY_MS", 3_000),
    staleInProgressTimeoutMs: parseEnvNumber("FIFONY_STALE_IN_PROGRESS_MS", 2_400_000),
    logLinesTail: parseEnvNumber("FIFONY_LOG_TAIL_CHARS", 12_000),
    agentProvider: normalizeAgentProvider(env.FIFONY_AGENT_PROVIDER ?? "codex"),
    agentCommand: toStringValue(env.FIFONY_AGENT_COMMAND, ""),
    defaultEffort: {
      default: (env.FIFONY_REASONING_EFFORT as any) || undefined,
      planner: (env.FIFONY_PLANNER_EFFORT as any) || undefined,
      executor: (env.FIFONY_EXECUTOR_EFFORT as any) || undefined,
      reviewer: (env.FIFONY_REVIEWER_EFFORT as any) || undefined,
    },
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

/**
 * Apply workflow definition config to runtime config.
 * WORKFLOW.md is deprecated — this is now a passthrough that only applies the port.
 */
export function applyWorkflowConfig(
  config: RuntimeConfig,
  _definition: WorkflowDefinition,
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

export function buildRuntimeState(
  previous: RuntimeState | null,
  config: RuntimeConfig,
  definition: WorkflowDefinition,
): RuntimeState {
  const mergedIssues = (previous?.issues ?? [])
    .map((rawIssue) => {
      if (!rawIssue || typeof rawIssue !== "object") return null;

      const existing = rawIssue as IssueEntry & { blocked_by?: unknown };
      return {
        ...existing,
        id: toStringValue(existing.id, ""),
        identifier: toStringValue(existing.identifier, existing.id),
        title: toStringValue(existing.title, `Issue ${toStringValue(existing.identifier, existing.id)}`),
        description: toStringValue(existing.description, ""),
        state: normalizeState(existing.state),
        paths: toStringArray(existing.paths),
        inferredPaths: toStringArray(existing.inferredPaths),
        labels: toStringArray(existing.labels),
        capabilityOverlays: toStringArray(existing.capabilityOverlays),
        capabilityRationale: toStringArray(existing.capabilityRationale),
        blockedBy: toStringArray(existing.blockedBy).length > 0
          ? toStringArray(existing.blockedBy)
          : toStringArray(existing.blocked_by),
        history: Array.isArray(existing.history) ? existing.history : [],
        attempts: clamp(toNumberValue(existing.attempts, 0), 0, config.maxAttemptsDefault),
        maxAttempts: clamp(toNumberValue(existing.maxAttempts, config.maxAttemptsDefault), 1, config.maxAttemptsDefault),
        nextRetryAt: toStringValue(existing.nextRetryAt),
        updatedAt: toStringValue(existing.updatedAt, now()),
        createdAt: toStringValue(existing.createdAt, now()),
      };
    })
    .filter((issue): issue is IssueEntry => issue !== null)
    .filter((issue) => issue.id);

  // Backfill terminalWeek for existing terminal issues that don't have it
  for (const issue of mergedIssues) {
    if (TERMINAL_STATES.has(issue.state) && !issue.terminalWeek) {
      issue.terminalWeek = isoWeek(issue.completedAt || issue.updatedAt);
    } else if (!TERMINAL_STATES.has(issue.state)) {
      issue.terminalWeek = "";
    }
  }

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
  let planning = 0;
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
      case "Planning":
        planning += 1;
        break;
      case "Todo":
        queued += 1;
        break;
      case "Queued":
      case "Running":
      case "Interrupted":
      case "In Review":
        inProgress += 1;
        break;
      case "Blocked":
        blocked += 1;
        break;
      case "Done":
        done += 1;
        break;
      case "Cancelled":
        cancelled += 1;
        break;
    }
  }

  if (completionTimes.length === 0) {
    return {
      total: issues.length,
      planning,
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
    planning,
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
  markEventDirty(event.id);

  // Track event in hourly counter for sparklines
  try { tokenLedger.recordEvent(); } catch { /* non-critical */ }

  logger.info({ issueId, kind }, message);
}

export function transition(issue: IssueEntry, target: IssueState, note: string): void {
  const previous = issue.state;
  logger.debug({ issueId: issue.id, identifier: issue.identifier, from: previous, to: target, note }, "[State] Issue transition");
  issue.state = target;
  issue.updatedAt = now();
  markIssueDirty(issue.id);
  invalidateMetrics();
  issue.history.push(`[${issue.updatedAt}] ${note}`);

  if (previous === "Blocked" && target === "Todo") {
    issue.lastError = undefined;
    issue.nextRetryAt = undefined;
  }

  if (TERMINAL_STATES.has(target)) {
    issue.completedAt = now();
    issue.nextRetryAt = undefined;
    issue.terminalWeek = isoWeek();
  }

  // Clear terminalWeek when leaving terminal state
  if (TERMINAL_STATES.has(previous) && !TERMINAL_STATES.has(target)) {
    issue.terminalWeek = "";
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

async function syncIssueWithStateMachineIfNeeded(issue: IssueEntry): Promise<void> {
  const plugin = getIssueStateMachinePlugin();
  if (!plugin || !plugin.getState || !plugin.send || !plugin.initializeEntity) {
    return;
  }

  let machineDefinition: unknown;
  try {
    machineDefinition = plugin.getMachineDefinition
      ? plugin.getMachineDefinition(ISSUE_STATE_MACHINE_ID)
      : getIssueStateMachineDefinition();
  } catch {
    machineDefinition = getIssueStateMachineDefinition();
  }
  const targetState = normalizeState(issue.state);
  let machineState = await plugin.getState(ISSUE_STATE_MACHINE_ID, issue.id).catch(() => null);

  if (!machineState) {
    await plugin.initializeEntity(ISSUE_STATE_MACHINE_ID, issue.id, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      state: targetState,
    });
    machineState = await plugin.getState(ISSUE_STATE_MACHINE_ID, issue.id).catch(() => {
      return getIssueStateMachineInitialState(machineDefinition);
    });
  }

  if (machineState === targetState) {
    return;
  }

  const path = findIssueStateMachineTransitionPath(machineDefinition, machineState, targetState);
  if (!path) {
    throw new Error(`State machine cannot synchronize issue ${issue.id} from '${machineState}' to '${targetState}'.`);
  }

  for (const event of path) {
    await plugin.send(ISSUE_STATE_MACHINE_ID, issue.id, event, {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      transition: "sync",
      targetState,
    });
  }
}

export async function syncIssueStateMachineState(issue: IssueEntry): Promise<void> {
  await syncIssueWithStateMachineIfNeeded(issue);
}

export async function syncIssueStateMachineStates(issues: IssueEntry[]): Promise<void> {
  for (const issue of issues) {
    try {
      await syncIssueWithStateMachineIfNeeded(issue);
    } catch (error) {
      logger.warn(`State machine sync failed for issue ${issue.id}: ${String(error)}`);
    }
  }
}

async function runStateMachineTransition(issue: IssueEntry, targetState: IssueState, note: string): Promise<void> {
  const plugin = getIssueStateMachinePlugin() as IssueStateMachinePluginLike | null;
  if (!plugin?.send || !plugin.getState) {
    transition(issue, targetState, note);
    return;
  }

  let machineDefinition: unknown;
  try {
    machineDefinition = plugin.getMachineDefinition
      ? plugin.getMachineDefinition(ISSUE_STATE_MACHINE_ID)
      : getIssueStateMachineDefinition();
  } catch {
    machineDefinition = getIssueStateMachineDefinition();
  }
  const currentRuntimeState = normalizeState(issue.state);
  const target = normalizeState(targetState);

  await syncIssueWithStateMachineIfNeeded(issue);
  const machineState = await plugin.getState(ISSUE_STATE_MACHINE_ID, issue.id).catch(() => currentRuntimeState);

  if (machineState !== currentRuntimeState) {
    throw new Error(`State machine desync while transitioning issue ${issue.id}: expected ${currentRuntimeState}, machine has ${machineState}.`);
  }

  if (currentRuntimeState !== target) {
    const path = findIssueStateMachineTransitionPath(machineDefinition, currentRuntimeState, target);
    if (!path) {
      throw new Error(`State machine does not allow transition from '${currentRuntimeState}' to '${target}' for issue ${issue.id}.`);
    }

    for (const event of path) {
      await plugin.send(ISSUE_STATE_MACHINE_ID, issue.id, event, {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        fromState: issue.state,
        toState: target,
        note,
      });
    }
  }

  transition(issue, target, note);
}

export async function transitionIssueState(
  issue: IssueEntry,
  target: IssueState,
  note: string,
  options?: { fallbackToLocal?: boolean },
): Promise<void> {
  try {
    await runStateMachineTransition(issue, target, note);
    return;
  } catch (error) {
    if (options?.fallbackToLocal || !getIssueStateMachinePlugin()) {
      logger.warn(`State machine transition failed for issue ${issue.id}, falling back to local transition: ${String(error)}`);
      transition(issue, target, note);
      return;
    }
    throw error;
  }
}

export async function handleStatePatch(state: RuntimeState, issue: IssueEntry, payload: JsonRecord): Promise<void> {
  const nextState = normalizeState(payload.state);
  const allowed = new Set([...ALLOWED_STATES]);

  if (!allowed.has(nextState)) {
    throw new Error(`Unsupported state: ${String(payload.state)}`);
  }

  await transitionIssueState(issue, nextState, `Manual state update: ${nextState}`);
  if (nextState === "Todo") {
    issue.nextRetryAt = undefined;
    issue.lastError = undefined;
  }
  if (nextState === "Cancelled") {
    issue.lastError = toStringValue(payload.reason);
  }

  addEvent(state, issue.id, "manual", `Manual state transition to ${nextState}`);
}
