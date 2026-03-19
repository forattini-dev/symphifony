import type { IssueEntry, RuntimeEvent, RuntimeState } from "./types.ts";
import type { PlanningSessionUsage } from "./issue-planner.ts";
import { logger } from "./logger.ts";
import { now } from "./helpers.ts";
import { getEventStateResource } from "./store.ts";
import { persistState } from "./store.ts";
import { enqueueForPlanning, enqueueForExecution, enqueueForReview } from "./queue-workers.ts";

export async function listEvents(
  state: RuntimeState,
  filters: { issueId?: string; kind?: string; since?: string } = {},
): Promise<RuntimeEvent[]> {
  const eventResource = getEventStateResource();
  const { issueId, kind, since } = filters;

  let events: RuntimeEvent[];
  if (eventResource?.list) {
    const partition = issueId && kind ? "byIssueIdAndKind"
      : issueId ? "byIssueId"
      : kind ? "byKind"
      : null;
    const partitionValues = issueId && kind ? { issueId, kind }
      : issueId ? { issueId }
      : kind ? { kind }
      : {};
    events = (await eventResource.list({ partition, partitionValues, limit: 200 }))
      .map((record) => record as RuntimeEvent);
  } else {
    events = state.events.filter((event) => {
      if (issueId && event.issueId !== issueId) return false;
      if (kind && event.kind !== kind) return false;
      return true;
    });
  }

  return typeof since === "string" && since
    ? events.filter((entry) => entry.at > since)
    : events;
}

export function findIssue(state: RuntimeState, issueId: string): IssueEntry | undefined {
  return state.issues.find((issue) => issue.id === issueId || issue.identifier === issueId);
}

export function parseIssue(c: any): string | null {
  const value = c.req?.param ? c.req.param("id") : undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Apply plan token usage to issue tracking fields */
export function applyPlanUsage(issue: IssueEntry, usage: PlanningSessionUsage): void {
  if (usage.totalTokens <= 0) return;
  const prev = issue.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  issue.tokenUsage = {
    inputTokens: prev.inputTokens + usage.inputTokens,
    outputTokens: prev.outputTokens + usage.outputTokens,
    totalTokens: prev.totalTokens + usage.totalTokens,
    model: usage.model || prev.model,
  };
  if (!issue.tokensByPhase) issue.tokensByPhase = {} as any;
  const prevPlanner = issue.tokensByPhase.planner ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  issue.tokensByPhase.planner = {
    inputTokens: prevPlanner.inputTokens + usage.inputTokens,
    outputTokens: prevPlanner.outputTokens + usage.outputTokens,
    totalTokens: prevPlanner.totalTokens + usage.totalTokens,
    model: usage.model || prevPlanner.model,
  };
  if (!issue.tokensByModel) issue.tokensByModel = {};
  const model = usage.model || "unknown";
  const prevModel = issue.tokensByModel[model] ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  issue.tokensByModel[model] = {
    inputTokens: prevModel.inputTokens + usage.inputTokens,
    outputTokens: prevModel.outputTokens + usage.outputTokens,
    totalTokens: prevModel.totalTokens + usage.totalTokens,
    model,
  };
  if (!issue.usage) issue.usage = { tokens: {} };
  issue.usage.tokens[model] = (issue.usage.tokens[model] || 0) + usage.totalTokens;
}

/** Apply plan suggestions to issue (paths, labels, effort) */
export function applyPlanSuggestions(issue: IssueEntry, plan: import("./types.ts").IssuePlan): void {
  if (plan.suggestedPaths?.length && !(issue.paths?.length)) issue.paths = plan.suggestedPaths;
  if (plan.suggestedLabels?.length && !issue.labels?.length) issue.labels = plan.suggestedLabels;
  if (plan.suggestedEffort && !issue.effort) issue.effort = plan.suggestedEffort;
}

export async function mutateIssueState(
  state: RuntimeState,
  c: any,
  updater: (issue: IssueEntry) => Promise<void> | void,
): Promise<any> {
  const issueId = parseIssue(c);
  if (!issueId) {
    return c.json({ ok: false, error: "Issue id is required." }, 400);
  }

  const issue = findIssue(state, issueId);
  if (!issue) {
    return c.json({ ok: false, error: "Issue not found" }, 404);
  }

  try {
    await updater(issue);
    await persistState(state);
    if (issue.state === "Planning") enqueueForPlanning(issue).catch(() => {});
    else if (issue.state === "Queued" || issue.state === "Running") enqueueForExecution(issue).catch(() => {});
    else if (issue.state === "Reviewing") enqueueForReview(issue).catch(() => {});
    return c.json({ ok: true, issue });
  } catch (error) {
    logger.error({ err: error, issueId }, "[API] mutateIssueState failed");
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}
