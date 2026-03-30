import { markIssueDirty, markEventDirty } from "../persistence/dirty-tracker.ts";
import { recordEvent as recordLedgerEvent } from "./tokens.ts";
import type {
  IssueEntry,
  IssueState,
  JsonRecord,
  MilestoneEntry,
  RuntimeConfig,
  RuntimeEvent,
  RuntimeEventType,
  RuntimeState,
} from "../types.ts";
import {
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
import { parseEffortConfig } from "./config.ts";
import { computeMetrics as _computeMetrics } from "./metrics.ts";
import { normalizeMilestone, refreshMilestoneSummaries } from "./milestones.ts";

export { computeMetrics } from "./metrics.ts";
export { deriveConfig, applyWorkflowConfig, validateConfig } from "./config.ts";

export type IssueTransitionExecutor = (
  issue: IssueEntry,
  event: string,
  context?: Record<string, unknown>,
) => Promise<{ previousState: IssueState }>;

let issueTransitionExecutor: IssueTransitionExecutor | null = null;

export function setIssueTransitionExecutor(executor: IssueTransitionExecutor | null): void {
  issueTransitionExecutor = executor;
}

export function getIssueTransitionExecutor(): IssueTransitionExecutor | null {
  return issueTransitionExecutor;
}


export function normalizeIssue(
  raw: JsonRecord,
): IssueEntry | null {
  const id = toStringValue(raw.id, "");
  if (!id) return null;

  const createdAt = toStringValue(raw.createdAt, now());
  const updatedAt = toStringValue(raw.updatedAt, createdAt);
  const milestoneId = toStringValue(raw.milestoneId) || toStringValue(raw["projectId"]) || undefined;
  const issue: IssueEntry = {
    id,
    identifier: toStringValue(raw.identifier, id),
    title: toStringValue(raw.title, `Issue ${id}`),
    description: toStringValue(raw.description, ""),
    state: normalizeState(raw.state, raw.plan && typeof raw.plan === "object" ? "PendingApproval" : "Planning"),
    milestoneId,
    branchName: toStringValue(raw.branchName),
    url: toStringValue(raw.url),
    assigneeId: toStringValue(raw.assigneeId),
    labels: toStringArray(raw.labels),
    paths: toStringArray(raw.paths),
    blockedBy: toStringArray(raw.blockedBy),
    assignedToWorker: toBooleanValue(raw.assignedToWorker, true),
    createdAt,
    updatedAt,
    history: [],
    attempts: toNumberValue(raw.attempts, 0),
    maxAttempts: toNumberValue(raw.maxAttempts, 3),
    nextRetryAt: toStringValue(raw.nextRetryAt),
    planVersion: 0,
    executeAttempt: 0,
    reviewAttempt: 0,
    checkpointAttempt: 0,
    contractNegotiationAttempt: 0,
    planHistory: [],
    contractNegotiationRuns: [],
    reviewRuns: [],
    reviewFailureHistory: [],
    policyDecisions: [],
    contextReportsByRole: {},
    memoryFlushCount: 0,
  };

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
  const initialState = parseIssueState(payload.state) ?? (payload.plan ? "PendingApproval" : "Planning");

  const issue: IssueEntry = {
    id,
    identifier,
    title: toStringValue(payload.title, `Issue ${identifier}`),
    description: toStringValue(payload.description, ""),
    state: initialState,
    milestoneId: toStringValue(payload.milestoneId) || undefined,
    branchName: toStringValue(payload.branchName),
    baseBranch: toStringValue(payload.baseBranch) || defaultBranch,
    url: toStringValue(payload.url),
    assigneeId: toStringValue(payload.assigneeId),
    labels: toStringArray(payload.labels),
    paths,
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
    checkpointAttempt: 0,
    contractNegotiationAttempt: 0,
    planHistory: [],
    contractNegotiationRuns: [],
    reviewRuns: [],
    reviewFailureHistory: [],
    policyDecisions: [],
    contextReportsByRole: {},
    memoryFlushCount: 0,
  };

  // If plan provides suggestions, apply them
  if (issue.plan) {
    if (issue.plan.suggestedPaths?.length && !issue.paths?.length) {
      issue.paths = issue.plan.suggestedPaths;
    }
    if (issue.plan.suggestedEffort && !issue.effort) {
      issue.effort = issue.plan.suggestedEffort;
    }
  }

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
  persistedMilestones: MilestoneEntry[] = [],
): RuntimeState {
  const mergedIssues = (previous?.issues ?? []).reduce<IssueEntry[]>((issues, rawIssue) => {
      if (!rawIssue || typeof rawIssue !== "object") return issues;

      const existing = rawIssue as IssueEntry;
      const existingRecord = rawIssue as JsonRecord;
      issues.push({
        ...existing,
        id: toStringValue(existing.id, ""),
        identifier: toStringValue(existing.identifier, existing.id),
        title: toStringValue(existing.title, `Issue ${toStringValue(existing.identifier, existing.id)}`),
        description: toStringValue(existing.description, ""),
        state: normalizeState(existing.state, existing.plan ? "PendingApproval" : "Planning"),
        milestoneId: toStringValue(existing.milestoneId) || toStringValue(existingRecord["projectId"]) || undefined,
        paths: toStringArray(existing.paths),
        labels: toStringArray(existing.labels),
        blockedBy: toStringArray(existing.blockedBy),
        history: Array.isArray(existing.history) ? existing.history : [],
        attempts: clamp(toNumberValue(existing.attempts, 0), 0, config.maxAttemptsDefault),
        maxAttempts: clamp(toNumberValue(existing.maxAttempts, config.maxAttemptsDefault), 1, config.maxAttemptsDefault),
        nextRetryAt: toStringValue(existing.nextRetryAt),
        updatedAt: toStringValue(existing.updatedAt, now()),
        createdAt: toStringValue(existing.createdAt, now()),
        planVersion: toNumberValue(existing.planVersion, existing.plan ? 1 : 0),
        executeAttempt: toNumberValue(existing.executeAttempt, toNumberValue(existing.attempts, 0)),
        reviewAttempt: toNumberValue(existing.reviewAttempt, toNumberValue(existing.attempts, 0)),
        checkpointAttempt: toNumberValue(existing.checkpointAttempt, 0),
        contractNegotiationAttempt: toNumberValue(existing.contractNegotiationAttempt, 0),
        checkpointStatus: toStringValue(existing.checkpointStatus) as IssueEntry["checkpointStatus"],
        checkpointPassedAt: toStringValue(existing.checkpointPassedAt) || undefined,
        contractNegotiationStatus: toStringValue(existing.contractNegotiationStatus) as IssueEntry["contractNegotiationStatus"],
        planHistory: Array.isArray(existing.planHistory) ? existing.planHistory : [],
        contractNegotiationRuns: Array.isArray(existing.contractNegotiationRuns) ? existing.contractNegotiationRuns : [],
        reviewRuns: Array.isArray(existing.reviewRuns) ? existing.reviewRuns : [],
        reviewFailureHistory: Array.isArray(existing.reviewFailureHistory) ? existing.reviewFailureHistory : [],
        policyDecisions: Array.isArray(existing.policyDecisions) ? existing.policyDecisions : [],
        contextReportsByRole: existing.contextReportsByRole && typeof existing.contextReportsByRole === "object"
          ? existing.contextReportsByRole
          : {},
        memoryFlushAt: toStringValue(existing.memoryFlushAt) || undefined,
        memoryFlushCount: toNumberValue(existing.memoryFlushCount, 0),
      });
      return issues;
    }, [])
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

  const mergedMilestones = (previous?.milestones ?? persistedMilestones)
    .map((milestone) => normalizeMilestone(milestone as unknown as JsonRecord))
    .filter((milestone): milestone is MilestoneEntry => Boolean(milestone));

  const state: RuntimeState = {
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
    milestones: mergedMilestones,
    issues: mergedIssues,
    events: previous?.events ?? [],
    metrics,
    notes: previous?.notes ?? [
      "Local TypeScript runtime bootstrapped.",
      "Codex-only execution path enabled.",
      "No external tracker dependency (filesystem-backed local mode).",
    ],
    variables: previous?.variables ?? [],
  };

  refreshMilestoneSummaries(state);
  return state;
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
  if (!issueTransitionExecutor) {
    const { executeTransition } = await import("../persistence/plugins/fsm-issue.ts");
    await executeTransition(issue, event, { ...context, issue });
    return;
  }

  await issueTransitionExecutor(issue, event, { ...context, issue });
}

export function issueDependenciesResolved(issue: IssueEntry, allIssues: IssueEntry[]): boolean {
  if (issue.blockedBy.length === 0) return true;
  const map = new Map(allIssues.map((entry) => [entry.id, entry]));
  return issue.blockedBy.every((dependencyId) => {
    const dep = map.get(dependencyId);
    return dep?.state === "Approved" || dep?.state === "Merged";
  });
}

export function getNextRetryAt(issue: IssueEntry, baseMs: number): string {
  const nextAttempt = issue.attempts + 1;
  const nextDelay = withRetryBackoff(nextAttempt, baseMs);
  return new Date(Date.now() + nextDelay).toISOString();
}

// ── Fast mode heuristic ──────────────────────────────────────────────────────

const FAST_MODE_ISSUE_TYPES = new Set(["bug", "chore", "docs"]);
const FAST_MODE_DESCRIPTION_MAX_LENGTH = 150;

/**
 * Determine whether the planner should use fast mode for an issue.
 * Fast mode produces a minimal plan (2-4 steps, skips optional fields).
 *
 * Heuristic: issue type is bug/chore/docs, OR description is very short.
 */
export function shouldUseFastMode(issue: Pick<IssueEntry, "issueType" | "description">): boolean {
  if (issue.issueType && FAST_MODE_ISSUE_TYPES.has(issue.issueType)) return true;
  if ((issue.description ?? "").length < FAST_MODE_DESCRIPTION_MAX_LENGTH) return true;
  return false;
}
