import { S3DB_ISSUE_RESOURCE } from "../../concerns/constants.ts";
import type { JsonRecord, RuntimeState } from "../../types.ts";
import { TERMINAL_STATES } from "../../concerns/constants.ts";
import { loadAgentPipelineSnapshotForIssue, loadAgentSessionSnapshotsForIssue } from "../../agents/agent.ts";
import { getApiRuntimeContextOrThrow } from "../plugins/api-runtime-context.ts";
import { persistState } from "../store.ts";
import { getEffectiveAgentProviders } from "../../agents/providers.ts";
import { addEvent } from "../../domains/issues.ts";
import { now, toStringValue, parseIssueState } from "../../concerns/helpers.ts";
import { getContainer } from "../container.ts";
import { createIssueCommand } from "../../commands/create-issue.command.ts";
import { cancelIssueCommand } from "../../commands/cancel-issue.command.ts";
import { mergeWorkspaceCommand } from "../../commands/merge-workspace.command.ts";
import { pushWorkspaceCommand } from "../../commands/push-workspace.command.ts";
import { transitionIssueCommand } from "../../commands/transition-issue.command.ts";
import { findIssue } from "../../routes/helpers.ts";
import { logger } from "../../concerns/logger.ts";

function getIssueId(c: unknown): string | null {
  if (!c || typeof c !== "object" || !("req" in c) || !c.req || typeof (c as { req: unknown }).req !== "object") {
    return null;
  }
  const req = (c as { req: { param: (name: string) => unknown } }).req;
  const value = req.param("id");
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function getIssuePipeline(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  const providers = getEffectiveAgentProviders(context.state, issue, null);
  const pipeline = await loadAgentPipelineSnapshotForIssue(issue, providers);
  return { body: { ok: true, issueId: issue.id, pipeline } };
}

async function getIssueSessions(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  const providers = getEffectiveAgentProviders(context.state, issue, null);
  const pipeline = await loadAgentPipelineSnapshotForIssue(issue, providers);
  const sessions = await loadAgentSessionSnapshotsForIssue(issue, providers, pipeline, null);
  return { body: { ok: true, issueId: issue.id, pipeline, sessions } };
}

async function patchIssueState(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  try {
    const payload = await (c as { req: { json: () => Promise<Record<string, unknown>> } }).req.json();
    const nextState = parseIssueState(payload.state);
    if (!nextState) {
      throw new Error(`Unsupported state: ${String(payload.state)}`);
    }
    const container = getContainer();
    const reason = payload.reason ? toStringValue(payload.reason) : undefined;
    logger.info({ issueId, identifier: issue.identifier, targetState: nextState }, "[API] POST /api/issues/:id/state");
    // FSM is the single source of truth — it handles guards, enqueue, and field assignments
    await transitionIssueCommand({
      issue,
      target: nextState,
      note: reason || `Manual state update: ${nextState}`,
    }, container);
    await persistState(context.state);
    return { body: { ok: true, issue } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function retryIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  // Extract optional rework feedback from request body
  let feedback: string | undefined;
  try {
    const body = await (c as { req: { json: () => Promise<Record<string, unknown>> } }).req.json();
    if (body?.feedback) feedback = toStringValue(body.feedback);
  } catch { /* no body or invalid JSON — fine */ }

  const container = getContainer();
  logger.info({ issueId, state: issue.state, lastFailedPhase: issue.lastFailedPhase, attempts: issue.attempts }, "[API] Retry — dispatching");

  // Intent → FSM target mapping. No business logic here — FSM entry actions handle everything.
  const note = feedback
    ? `Rework requested for ${issue.identifier}: ${feedback.slice(0, 200)}`
    : `Manual retry for ${issue.identifier}.`;

  if (TERMINAL_STATES.has(issue.state)) {
    // REOPEN → Planning. If plan exists, fast-track through PendingApproval → Queued.
    await transitionIssueCommand({ issue, target: "Planning", note }, container);
    if (issue.plan?.steps?.length) {
      await transitionIssueCommand({ issue, target: "PendingApproval", note: "Existing plan found." }, container);
      await transitionIssueCommand({ issue, target: "Queued", note: "Auto-queued after plan approval." }, container);
    }
  } else if (issue.state === "Blocked" && issue.lastFailedPhase === "review") {
    // Execution was fine, only review failed — go directly to Reviewing (REVIEW event)
    issue.lastError = undefined;
    issue.lastFailedPhase = undefined;
    await transitionIssueCommand({ issue, target: "Reviewing", note }, container);
  } else if (issue.state === "Blocked") {
    // UNBLOCK → Queued. FSM onEnterQueued handles attempts++ and archival.
    await transitionIssueCommand({ issue, target: "Queued", note }, container);
  } else if (issue.state === "Approved") {
    // REOPEN → Planning for rework
    await transitionIssueCommand({ issue, target: "Planning", note }, container);
    if (issue.plan?.steps?.length) {
      await transitionIssueCommand({ issue, target: "PendingApproval", note: "Existing plan found." }, container);
      await transitionIssueCommand({ issue, target: "Queued", note: "Auto-queued for rework." }, container);
    }
  } else if (issue.state === "Reviewing" || issue.state === "PendingDecision") {
    // REQUEUE → Queued. FSM onEnterQueued handles feedback archival via event="REQUEUE".
    const reworkNote = feedback || issue.lastError || "Manual rework request.";
    await transitionIssueCommand({ issue, target: "Queued", note: reworkNote }, container);
  } else if (issue.state === "PendingApproval") {
    // QUEUE → Queued
    await transitionIssueCommand({ issue, target: "Queued", note }, container);
  } else {
    issue.lastError = undefined;
    issue.nextRetryAt = undefined;
    issue.updatedAt = now();
  }

  addEvent(context.state, issue.id, "manual", `Manual retry requested for ${issue.id}.`);
  await persistState(context.state);
  return { body: { ok: true, issue } };
}

async function createIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  try {
    const payload = await (c as { req: { json: () => Promise<unknown> } }).req.json() as JsonRecord;
    const container = getContainer();
    const { issue } = await createIssueCommand(
      { payload, state: context.state },
      container,
    );
    return { body: { ok: true, issue } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function cancelIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  await cancelIssueCommand(
    { issue },
    { ...getContainer(), state: context.state },
  );
  addEvent(context.state, issue.id, "manual", `Manual cancel requested for ${issue.id}.`);
  await persistState(context.state);
  return { body: { ok: true, issue } };
}

async function approveAndMerge(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  if (issue.state !== "PendingDecision" && issue.state !== "Reviewing" && issue.state !== "Approved") {
    return { status: 400, body: { ok: false, error: `Cannot approve-and-merge from state ${issue.state}. Expected PendingDecision, Reviewing, or Approved.` } };
  }

  try {
    const container = getContainer();
    const mergeMode = context.state.config.mergeMode;
    logger.info({ issueId, state: issue.state, testApplied: issue.testApplied, mergeMode }, "[API] POST /api/issues/:id/approve-and-merge");

    if (mergeMode === "push-pr") {
      // Push-PR mode: approve, then push to remote + create PR
      if (issue.state !== "Approved") {
        await transitionIssueCommand(
          { issue, target: "Approved", note: "Approved for push-pr." },
          container,
        );
      }
      await pushWorkspaceCommand({ issue }, { ...container, state: context.state });
    } else {
      // Local merge mode: approve + merge (squash or git merge --no-ff)
      await mergeWorkspaceCommand(
        { issue, squashAlreadyApplied: issue.testApplied ?? false },
        { ...container, state: context.state },
      );
    }

    addEvent(context.state, issue.id, "manual", `Approved and ${mergeMode === "push-pr" ? "pushed PR for" : "merged"} ${issue.identifier}.`);
    await persistState(context.state);
    return { body: { ok: true, issue } };
  } catch (error) {
    return { status: 409, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

export default {
  name: S3DB_ISSUE_RESOURCE,
  attributes: {
    id: "string|required",
    identifier: "string|required",
    title: "string|required",
    description: "string|optional",
    state: "string|required",
    branchName: "string|optional",
    url: "string|optional",
    assigneeId: "string|optional",
    labels: "json|required",
    paths: "json|optional",
    blockedBy: "json|required",
    assignedToWorker: "boolean|required",
    createdAt: "datetime|required",
    updatedAt: "datetime|required",
    history: "json|required",
    startedAt: "datetime|optional",
    completedAt: "datetime|optional",
    attempts: "number|required",
    maxAttempts: "number|required",
    nextRetryAt: "datetime|optional",
    workspacePath: "string|optional",
    worktreePath: "string|optional",
    baseBranch: "string|optional",
    headCommitAtStart: "string|optional",
    mergedAt: "datetime|optional",
    mergeResult: "json|optional",
    mergedReason: "string|optional",
    cancelledReason: "string|optional",
    reviewingAt: "datetime|optional",
    workspacePreparedAt: "datetime|optional",
    lastError: "string|optional",
    durationMs: "number|optional",
    commandExitCode: "number|optional",
    commandOutputTail: "string|optional",
    terminalWeek: "string|optional",
    usage: "json|optional",
    testApplied: "boolean|optional",
    tokenUsage: "json|optional",
    tokensByPhase: "json|optional",
    tokensByModel: "json|optional",
    plan: "json|optional",
    planHistory: "json|optional",
    planVersion: "number|optional",
    planningStatus: "string|optional",
    planningStartedAt: "datetime|optional",
    planningError: "string|optional",
    executeAttempt: "number|optional",
    reviewAttempt: "number|optional",
    issueType: "string|optional",
    eventsCount: "number|optional",
    images: "json|optional",
    linesAdded: "number|optional",
    linesRemoved: "number|optional",
    filesChanged: "number|optional",
    effort: "json|optional",
  },
  partitions: {
    byState: { fields: { state: "string" } },
    byTerminalWeek: { fields: { terminalWeek: "string" } },
  },
  asyncPartitions: true,
  behavior: "body-overflow",
  paranoid: false,
  timestamps: true,
  api: {
    auth: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    description: "Issue registry for orchestration runtime",
    "POST /create": async (c: unknown) => {
      const result = await createIssue(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return c.json(result.body, 201);
    },
    "POST /": async (c: unknown) => {
      const result = await createIssue(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return c.json(result.body, 201);
    },
    "GET /:id/pipeline": async (c: unknown) => {
      const result = await getIssuePipeline(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
    "GET /:id/sessions": async (c: unknown) => {
      const result = await getIssueSessions(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
    "POST /:id/state": async (c: unknown) => {
      const result = await patchIssueState(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
    "POST /:id/retry": async (c: unknown) => {
      const result = await retryIssue(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
    "POST /:id/cancel": async (c: unknown) => {
      const result = await cancelIssue(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
    "POST /:id/approve-and-merge": async (c: unknown) => {
      const result = await approveAndMerge(c);
      if (result.status) {
        return c.json(result.body, result.status);
      }
      return result.body;
    },
  },
};
