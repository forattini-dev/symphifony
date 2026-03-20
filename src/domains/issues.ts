import { markIssueDirty, markEventDirty } from "../persistence/dirty-tracker.ts";
import { recordEvent as recordLedgerEvent } from "./tokens.ts";
import type {
  IssueEntry,
  IssueState,
  JsonRecord,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeEventType,
  RuntimeState,
} from "../types.ts";
import {
  findIssueStateMachineTransitionPath,
  executeTransition,
} from "../persistence/plugins/issue-state-machine.ts";
import {
  ALLOWED_STATES,
  PERSIST_EVENTS_MAX,
  TERMINAL_STATES,
  TARGET_ROOT,
} from "../concerns/constants.ts";
import type { ProjectMetadata } from "./project.ts";
import { resolveProjectMetadata } from "./project.ts";
import {
  now,
  isoWeek,
  toStringValue,
  toNumberValue,
  toBooleanValue,
  toStringArray,
  clamp,
  normalizeState,
  parseIssueState,
  withRetryBackoff,
} from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import {
  getCapabilityRoutingOptions,
  applyCapabilityMetadata,
} from "../agents/providers.ts";
import { resolveTaskCapabilities } from "../routing/capability-resolver.ts";
import { parseEffortConfig } from "./config.ts";
import { computeMetrics as _computeMetrics } from "./metrics.ts";

export { computeMetrics, computeCapabilityCounts } from "./metrics.ts";
export { deriveConfig, applyWorkflowConfig, validateConfig } from "./config.ts";

export function normalizeIssue(
  raw: JsonRecord,
): IssueEntry | null {
  const id = toStringValue(raw.id, "");
  if (!id) return null;

  const createdAt = toStringValue(raw.created_at, now());
  const updatedAt = toStringValue(raw.updated_at, createdAt);
  const issue: IssueEntry = {
    id,
    identifier: toStringValue(raw.identifier, id),
    title: toStringValue(raw.title, `Issue ${id}`),
    description: toStringValue(raw.description, ""),
    priority: toNumberValue(raw.priority, 1),
    state: normalizeState(raw.state, raw.plan && typeof raw.plan === "object" ? "Planned" : "Planning"),
    branchName: toStringValue(raw.branchName) || toStringValue(raw.branch_name),
    url: toStringValue(raw.url),
    assigneeId: toStringValue(raw.assignee_id),
    labels: toStringArray(raw.labels),
    paths: toStringArray(raw.paths),
    inferredPaths: toStringArray(raw.inferredPaths),
    capabilityCategory: toStringValue(raw.capabilityCategory),
    capabilityOverlays: toStringArray(raw.capabilityOverlays),
    capabilityRationale: toStringArray(raw.capabilityRationale),
    blockedBy: toStringArray(raw.blockedBy),
    assignedToWorker: toBooleanValue(raw.assigned_to_worker, true),
    createdAt,
    updatedAt,
    history: [],
    attempts: toNumberValue(raw.attempts, 0),
    maxAttempts: toNumberValue(raw.max_attempts, 3),
    nextRetryAt: toStringValue(raw.next_retry_at),
    planVersion: 0,
    executeAttempt: 0,
    reviewAttempt: 0,
    planHistory: [],
  };

  if (!issue.capabilityCategory) {
    applyCapabilityMetadata(issue, resolveTaskCapabilities({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      labels: issue.labels,
      paths: issue.paths,
    }, getCapabilityRoutingOptions()));
  }

  return issue;
}

export function nextLocalIssueId(issues: IssueEntry[]): string {
  const maxId = issues.reduce((current, issue) => {
    const match = issue.identifier.match(/^#(\d+)$/);
    if (!match) return current;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? Math.max(current, parsed) : current;
  }, 0);

  return `#${maxId + 1}`;
}

export function createIssueFromPayload(
  payload: JsonRecord,
  issues: IssueEntry[],
  defaultBranch?: string,
): IssueEntry {
  const identifier = toStringValue(payload.identifier, nextLocalIssueId(issues));
  const id = toStringValue(payload.id, identifier.replace(/^#/, "issue-"));
  logger.info({ id, identifier, title: toStringValue(payload.title, "").slice(0, 80) }, "[Issues] Creating new issue");
  const createdAt = now();
  const blockedBy = toStringArray(payload.blockedBy);
  const paths = toStringArray(payload.paths);
  const images = toStringArray(payload.images);
  const initialState = parseIssueState(payload.state) ?? (payload.plan ? "Planned" : "Planning");

  const issue: IssueEntry = {
    id,
    identifier,
    title: toStringValue(payload.title, `Issue ${identifier}`),
    description: toStringValue(payload.description, ""),
    priority: clamp(toNumberValue(payload.priority, 1), 1, 10),
    state: initialState,
    branchName: toStringValue(payload.branchName),
    baseBranch: toStringValue(payload.baseBranch) || defaultBranch,
    url: toStringValue(payload.url),
    assigneeId: toStringValue(payload.assigneeId),
    labels: toStringArray(payload.labels),
    paths,
    inferredPaths: [],
    capabilityCategory: "",
    capabilityOverlays: [],
    capabilityRationale: [],
    blockedBy,
    assignedToWorker: true,
    createdAt,
    updatedAt: createdAt,
    history: [`[${createdAt}] Issue created via API.`],
    attempts: 0,
    maxAttempts: clamp(toNumberValue(payload.maxAttempts, 3), 1, 10),
    terminalWeek: "",
    images: images.length ? images : undefined,
    issueType: toStringValue(payload.issueType) || undefined,
    effort: parseEffortConfig(payload.effort),
    plan: payload.plan && typeof payload.plan === "object" ? payload.plan as IssueEntry["plan"] : undefined,
    planVersion: payload.plan ? 1 : 0,
    executeAttempt: 0,
    reviewAttempt: 0,
    planHistory: [],
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
  }, getCapabilityRoutingOptions()));

  return issue;
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
  projectMetadata: ProjectMetadata = resolveProjectMetadata([], TARGET_ROOT),
): RuntimeState {
  const mergedIssues = (previous?.issues ?? [])
    .map((rawIssue) => {
      if (!rawIssue || typeof rawIssue !== "object") return null;

      const existing = rawIssue as IssueEntry;
      return {
        ...existing,
        id: toStringValue(existing.id, ""),
        identifier: toStringValue(existing.identifier, existing.id),
        title: toStringValue(existing.title, `Issue ${toStringValue(existing.identifier, existing.id)}`),
        description: toStringValue(existing.description, ""),
        state: normalizeState(existing.state, existing.plan ? "Planned" : "Planning"),
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
        planVersion: toNumberValue(existing.planVersion, existing.plan ? 1 : 0),
        executeAttempt: toNumberValue(existing.executeAttempt, toNumberValue(existing.attempts, 0)),
        reviewAttempt: toNumberValue(existing.reviewAttempt, toNumberValue(existing.attempts, 0)),
        planHistory: Array.isArray(existing.planHistory) ? existing.planHistory : [],
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

  const metrics = _computeMetrics(mergedIssues);

  return {
    startedAt: previous?.startedAt ?? now(),
    updatedAt: now(),
    trackerKind: "filesystem",
    sourceRepoUrl: TARGET_ROOT,
    sourceRef: "workspace",
    projectName: projectMetadata.projectName,
    detectedProjectName: projectMetadata.detectedProjectName,
    projectNameSource: projectMetadata.projectNameSource,
    queueTitle: projectMetadata.queueTitle,
    config: {
      ...config,
      dashboardPort: previous?.config.dashboardPort,
    },
    issues: mergedIssues,
    events: previous?.events ?? [],
    metrics,
    notes: previous?.notes ?? [
      "Local TypeScript runtime bootstrapped.",
      "Codex-only execution path enabled.",
      "No external tracker dependency (filesystem-backed local mode).",
    ],
  };
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

  // Track event in daily ledger for analytics sparkline
  try { recordLedgerEvent(); } catch { /* non-critical */ }

  // Increment per-issue event counter (tracked by EventualConsistency plugin for daily analytics)
  if (issueId) {
    const issue = state.issues.find((i) => i.id === issueId);
    if (issue) {
      issue.eventsCount = (issue.eventsCount || 0) + 1;
      markIssueDirty(issue.id);
    }
  }

  logger.info({ issueId, kind }, message);
}

/**
 * Transition an issue via the unified FSM. This is the single public API.
 * The plugin handles guards, entry actions, dirty tracking, events, and enqueue.
 */
export async function transitionIssue(
  issue: IssueEntry,
  event: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  logger.debug({ issueId: issue.id, identifier: issue.identifier, from: issue.state, event, context }, "[State] Issue transition");
  await executeTransition(issue, event, { ...context, issue });
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

export async function handleStatePatch(state: RuntimeState, issue: IssueEntry, payload: JsonRecord): Promise<void> {
  const nextState = parseIssueState(payload.state);
  if (!nextState || !ALLOWED_STATES.includes(nextState)) {
    throw new Error(`Unsupported state: ${String(payload.state)}`);
  }

  // Find the FSM event path from current state to target
  const path = findIssueStateMachineTransitionPath(null, issue.state, nextState);
  if (!path || path.length === 0) {
    throw new Error(`No valid transition from '${issue.state}' to '${nextState}' for issue ${issue.id}.`);
  }

  // Execute each event in the path
  for (const event of path) {
    await transitionIssue(issue, event, { note: `Manual state update: ${nextState}`, reason: toStringValue(payload.reason) });
  }

  if (nextState === "Planned") {
    issue.nextRetryAt = undefined;
    issue.lastError = undefined;
  }
  if (nextState === "Cancelled") {
    issue.lastError = toStringValue(payload.reason);
  }

  addEvent(state, issue.id, "manual", `Manual state transition to ${nextState}`);
}
