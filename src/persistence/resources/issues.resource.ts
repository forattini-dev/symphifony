import { S3DB_ISSUE_RESOURCE } from "../../concerns/constants.ts";
import type { JsonRecord, RuntimeState } from "../../types.ts";
import { loadAgentPipelineSnapshotForIssue, loadAgentSessionSnapshotsForIssue } from "../../agents/agent.ts";
import { getApiRuntimeContextOrThrow } from "../plugins/api-runtime-context.ts";
import { persistState } from "../store.ts";
import { getEffectiveAgentProviders } from "../../agents/providers.ts";
import { addEvent } from "../../domains/issues.ts";
import { toStringValue, parseIssueState } from "../../concerns/helpers.ts";
import { getContainer } from "../container.ts";
import { createIssueCommand } from "../../commands/create-issue.command.ts";
import { cancelIssueCommand } from "../../commands/cancel-issue.command.ts";
import { deleteIssueCommand } from "../../commands/delete-issue.command.ts";
import { mergeWorkspaceCommand } from "../../commands/merge-workspace.command.ts";
import { pushWorkspaceCommand } from "../../commands/push-workspace.command.ts";
import { retryIssueCommand } from "../../commands/retry-issue.command.ts";
import { transitionIssueCommand } from "../../commands/transition-issue.command.ts";
import { findIssue } from "../../routes/helpers.ts";
import { logger } from "../../concerns/logger.ts";

// Reuse shared parseIssue helper (single source of truth for issue ID parsing)
import { parseIssue as getIssueId } from "../../routes/helpers.ts";

type ApiContext = {
  json: (body: unknown, status?: number) => unknown;
};

function respond(c: unknown, result: { body: unknown; status?: number }, createdStatus?: number) {
  const context = c as ApiContext;
  if (result.status) {
    return context.json(result.body, result.status);
  }
  if (createdStatus) {
    return context.json(result.body, createdStatus);
  }
  return result.body;
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
  await retryIssueCommand({ issue, feedback }, container);
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

async function deleteIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  // Prevent deletion of actively running issues — cancel first
  if (issue.state === "Running" || issue.state === "Reviewing") {
    return { status: 409, body: { ok: false, error: `Cannot delete issue in state ${issue.state}. Cancel it first.` } };
  }

  try {
    await deleteIssueCommand({ issue, state: context.state });
    await persistState(context.state);
    return { body: { ok: true, id: issueId } };
  } catch (error) {
    return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
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

  if (issue.state !== "PendingDecision" && issue.state !== "Approved") {
    return { status: 400, body: { ok: false, error: `Cannot approve-and-merge from state ${issue.state}. Expected PendingDecision or Approved. Reviewing must complete first.` } };
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
      await pushWorkspaceCommand({ issue, state: context.state }, container);
    } else {
      // Local merge mode: approve + merge (squash or git merge --no-ff)
      await mergeWorkspaceCommand(
        { issue, state: context.state },
        container,
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
    history: "json|optional",
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
    testWorkspacePath: "string|optional",
    tokenUsage: "json|optional",
    tokensByPhase: "json|optional",
    tokensByModel: "json|optional",
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
      return respond(c, result, 201);
    },
    "POST /": async (c: unknown) => {
      const result = await createIssue(c);
      return respond(c, result, 201);
    },
    "GET /:id/sessions": async (c: unknown) => {
      const result = await getIssueSessions(c);
      return respond(c, result);
    },
    "POST /:id/state": async (c: unknown) => {
      const result = await patchIssueState(c);
      return respond(c, result);
    },
    "POST /:id/retry": async (c: unknown) => {
      const result = await retryIssue(c);
      return respond(c, result);
    },
    "POST /:id/cancel": async (c: unknown) => {
      const result = await cancelIssue(c);
      return respond(c, result);
    },
    "POST /:id/approve-and-merge": async (c: unknown) => {
      const result = await approveAndMerge(c);
      return respond(c, result);
    },
    "POST /:id/delete": async (c: unknown) => {
      const result = await deleteIssue(c);
      return respond(c, result);
    },
  },
};
