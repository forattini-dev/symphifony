import { S3DB_ISSUE_RESOURCE } from "../../concerns/constants.ts";
import type { JsonRecord } from "../../types.ts";
import { loadAgentPipelineSnapshotForIssue, loadAgentSessionSnapshotsForIssue } from "../../agents/agent.ts";
import { getApiRuntimeContextOrThrow } from "../plugins/api-runtime-context.ts";
import { getSessionProvidersForIssue } from "../../agents/providers.ts";
import { addEvent } from "../../domains/issues.ts";
import { now, toStringValue, parseIssueState } from "../../concerns/helpers.ts";
import { getContainer } from "../container.ts";
import { buildContextPack, renderContextPackMarkdown } from "../../agents/context-engine.ts";
import { createIssueCommand } from "../../commands/create-issue.command.ts";
import { cancelIssueCommand } from "../../commands/cancel-issue.command.ts";
import { deleteIssueCommand } from "../../commands/delete-issue.command.ts";
import { mergeWorkspaceCommand } from "../../commands/merge-workspace.command.ts";
import { pushWorkspaceCommand } from "../../commands/push-workspace.command.ts";
import { retryIssueCommand } from "../../commands/retry-issue.command.ts";
import { transitionIssueCommand } from "../../commands/transition-issue.command.ts";
import { approvePlanCommand } from "../../commands/approve-plan.command.ts";
import { executeIssueCommand } from "../../commands/execute-issue.command.ts";
import { replanIssueCommand } from "../../commands/replan-issue.command.ts";
import { findIssue } from "../../routes/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { getWorkflowConfig, loadRuntimeSettings } from "../settings.ts";
import { assignIssueMilestoneForState } from "./issue-milestone.api.ts";
import { markIssueDirty } from "../dirty-tracker.ts";
import { ATTACHMENTS_ROOT, STATE_ROOT, TARGET_ROOT, SOURCE_ROOT } from "../../concerns/constants.ts";
import { cleanWorkspace, createTestWorkspace, removeTestWorkspace } from "../../domains/workspace.ts";
import { getIssueTransitionHistoryForIssue } from "../../domains/issue-state.ts";
import { agentLogPath, getAgentStatus } from "../../domains/agents.ts";
import { isAgentStillRunning } from "../../agents/agent.ts";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { execSync } from "node:child_process";

// Reuse shared parseIssue helper (single source of truth for issue ID parsing)
import { parseIssue as getIssueId } from "../../routes/helpers.ts";

type ApiContext = {
  json: (body: unknown, status?: number) => unknown;
};

type IssueApiDeps = {
  persistState: (state: Awaited<ReturnType<typeof getApiRuntimeContextOrThrow>>["state"]) => Promise<unknown>;
};

async function loadIssueApiDeps(): Promise<IssueApiDeps> {
  const { persistState } = await import("../store.ts");
  return { persistState };
}

function respond(c: unknown, result: { body: unknown; status?: number }, createdStatus?: number) {
  if (result.body instanceof Response) {
    return result.body;
  }
  const context = c as ApiContext;
  return context.json(result.body, result.status ?? createdStatus ?? 200);
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

  let workflowConfig = null;
  try {
    workflowConfig = getWorkflowConfig(await loadRuntimeSettings());
  } catch {
    workflowConfig = null;
  }

  const providers = getSessionProvidersForIssue(context.state, issue, workflowConfig);
  const pipeline = await loadAgentPipelineSnapshotForIssue(issue, providers);
  const sessions = await loadAgentSessionSnapshotsForIssue(issue, providers, pipeline, null);
  return { body: { ok: true, issueId: issue.id, pipeline, sessions } };
}

async function getIssueContext(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) {
    return { status: 400, body: { ok: false, error: "Issue id is required." } };
  }

  const issue = findIssue(context.state, issueId);
  if (!issue) {
    return { status: 404, body: { ok: false, error: "Issue not found" } };
  }

  const roleParam = (c as { req?: { query?: (name: string) => string | undefined } })?.req?.query?.("role");
  const role = roleParam === "planner" || roleParam === "reviewer" || roleParam === "executor"
    ? roleParam
    : issue.state === "Planning"
      ? "planner"
      : issue.state === "Reviewing"
        ? "reviewer"
        : "executor";

  const pack = await buildContextPack({
    role,
    title: issue.title,
    description: issue.description,
    issue,
    workspacePath: issue.workspacePath,
    runtimeState: context.state,
  });
  const markdown = renderContextPackMarkdown(pack);

  return { body: { ok: true, issueId: issue.id, role, pack, markdown } };
}

async function patchIssueState(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const { persistState } = await import("../store.ts");
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
  const { persistState } = await import("../store.ts");
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
  const { persistState } = await import("../store.ts");
  try {
    const payload = await (c as { req: { json: () => Promise<unknown> } }).req.json() as JsonRecord;
    const container = getContainer();
    const { issue } = await createIssueCommand(
      { payload, state: context.state },
      container,
    );
    await persistState(context.state);
    return { body: { ok: true, issue } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function cancelIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const { persistState } = await import("../store.ts");
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
  const { persistState } = await import("../store.ts");
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
  const { persistState } = await import("../store.ts");
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

function getWorkspaceActionErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("requires a git repository")
    || message.includes("requires at least one commit")
    || message.includes("has no git worktree")
    || message.includes("No mergeable workspace found")
    || message.includes("target repository has uncommitted changes")
    || message.includes("current branch is")
  ) {
    return 409;
  }
  return 500;
}

async function approveIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found" } };

  try {
    const container = getContainer();
    await approvePlanCommand({ issue }, container);
    const { persistState } = await import("../store.ts");
    await persistState(context.state);
    return { body: { ok: true, issue } };
  } catch (error) {
    logger.error({ err: error }, `Failed to approve issue ${issueId}`);
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function executeIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found" } };

  try {
    const container = getContainer();
    await executeIssueCommand({ issue }, container);
    const { persistState } = await import("../store.ts");
    await persistState(context.state);
    return { body: { ok: true, issue } };
  } catch (error) {
    logger.error({ err: error }, `Failed to execute issue ${issueId}`);
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function replanIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found" } };

  try {
    const container = getContainer();
    await replanIssueCommand({ issue }, container);
    const { persistState } = await import("../store.ts");
    await persistState(context.state);
    return { body: { ok: true, issue } };
  } catch (error) {
    logger.error({ err: error }, `Failed to replan issue ${issueId}`);
    return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function mergeIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  try {
    const container = getContainer();
    if (context.state.config.mergeMode === "push-pr") {
      const result = await pushWorkspaceCommand({ issue, state: context.state }, container);
      return { body: { ok: true, prUrl: result.prUrl, ghAvailable: result.ghAvailable } };
    }
    const result = await mergeWorkspaceCommand({ issue, state: context.state }, container);
    return { body: { ok: true, ...result } };
  } catch (error) {
    logger.error(`Failed to merge workspace for ${issueId}: ${String(error)}`);
    return { status: getWorkspaceActionErrorStatus(error), body: { ok: false, error: String(error) } };
  }
}

async function mergeIssuePreview(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  try {
    const { dryMerge } = await import("../../domains/workspace.ts");
    const autoCommit = context.state.config.autoCommitBeforeMerge ?? true;
    const result = dryMerge(issue, autoCommit);
    return { body: { ok: true, ...result } };
  } catch (error) {
    logger.error(`Failed to preview merge for ${issueId}: ${String(error)}`);
    return { status: getWorkspaceActionErrorStatus(error), body: { ok: false, error: String(error) } };
  }
}

async function rebaseIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  try {
    const { rebaseWorktree } = await import("../../domains/workspace.ts");
    const result = rebaseWorktree(issue);
    if (result.success) {
      addEvent(context.state, issue.id, "info", `Branch ${issue.branchName} rebased onto ${issue.baseBranch}.`);
    }
    const { persistState } = await import("../store.ts");
    await persistState(context.state);
    return { body: { ok: true, ...result } };
  } catch (error) {
    logger.error(`Failed to rebase for ${issueId}: ${String(error)}`);
    return { status: getWorkspaceActionErrorStatus(error), body: { ok: false, error: String(error) } };
  }
}

async function createIssueTestWorkspace(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };
  if (!["Reviewing", "PendingDecision"].includes(issue.state)) {
    return { status: 409, body: { ok: false, error: `Cannot create a test workspace for issue in state ${issue.state}.` } };
  }

  const testWorkspacePath = createTestWorkspace(issue);
  markIssueDirty(issue.id);
  addEvent(context.state, issue.id, "manual", `Isolated test workspace created at ${testWorkspacePath}.`);
  const { persistState } = await import("../store.ts");
  await persistState(context.state);
  return { body: { ok: true, issue } };
}

async function revertIssueTestWorkspace(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  removeTestWorkspace(issue);
  markIssueDirty(issue.id);
  addEvent(context.state, issue.id, "manual", "Isolated test workspace removed.");
  const { persistState } = await import("../store.ts");
  await persistState(context.state);
  return { body: { ok: true, issue } };
}

async function rollbackIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };
  if (!["Reviewing", "PendingDecision", "Approved"].includes(issue.state)) {
    return { status: 409, body: { ok: false, error: `Cannot rollback issue in state ${issue.state}. Must be in Reviewing, Reviewed, or Done.` } };
  }

  if (issue.workspacePath) {
    try {
      await cleanWorkspace(issue.id, issue, context.state);
      delete issue.workspacePath;
      delete issue.worktreePath;
    } catch (error) {
      logger.warn({ err: error }, `[API] Workspace cleanup failed during rollback for ${issue.id}`);
    }
  }

  const container = getContainer();
  await transitionIssueCommand(
    { issue, target: "Queued", note: "Rolled back by user - worktree removed." },
    container,
  );
  addEvent(context.state, issue.id, "manual", `${issue.identifier} rolled back. Worktree and branch removed.`);
  const { persistState } = await import("../store.ts");
  await persistState(context.state);
  return { body: { ok: true, issue } };
}

async function pushIssue(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };
  if (!["Approved", "PendingDecision"].includes(issue.state)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: `Issue ${issue.identifier} must be in Approved or PendingDecision state to push. Reviewing must complete first. Current state: ${issue.state}.`,
      },
    };
  }

  try {
    const container = getContainer();
    const result = await pushWorkspaceCommand({ issue, state: context.state }, container);
    return { body: { ok: true, prUrl: result.prUrl, ghAvailable: result.ghAvailable } };
  } catch (error) {
    logger.error({ err: error }, `[API] Failed to push branch for ${issueId}`);
    return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function uploadIssueImages(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  try {
    const payload = await (c as { req: { json: () => Promise<{ files?: Array<{ name: string; data: string; type: string }> }> } }).req.json();
    if (!Array.isArray(payload.files) || payload.files.length === 0) {
      return { status: 400, body: { ok: false, error: "No files provided." } };
    }

    const issueAttachDir = join(ATTACHMENTS_ROOT, issue.id);
    mkdirSync(issueAttachDir, { recursive: true });
    const newPaths: string[] = [];
    for (const file of payload.files) {
      if (typeof file.data !== "string" || !file.name) continue;
      const safeExt = extname(file.name).replace(/[^a-z0-9.]/gi, "").slice(0, 10) || ".bin";
      const safeName = `${randomUUID()}${safeExt}`;
      const dest = join(issueAttachDir, safeName);
      writeFileSync(dest, Buffer.from(file.data, "base64"));
      newPaths.push(dest);
    }

    issue.images = [...(issue.images ?? []), ...newPaths];
    issue.updatedAt = now();
    markIssueDirty(issue.id);
    const { persistState } = await import("../store.ts");
    await persistState(context.state);
    return { body: { ok: true, paths: newPaths, issue } };
  } catch (error) {
    logger.error({ err: error }, "[API] Issue image upload failed");
    return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function getIssueImage(c: unknown) {
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const filename = (c as { req?: { param?: (name: string) => string | undefined } })?.req?.param?.("filename") ?? "";
  if (!filename) return { status: 400, body: { ok: false, error: "Filename is required." } };
  const safeName = basename(filename);
  const filePath = join(ATTACHMENTS_ROOT, issueId, safeName);
  if (!existsSync(filePath)) return { status: 404, body: { ok: false, error: "Image not found." } };

  const ext = extname(safeName).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  const mime = mimeMap[ext] ?? "application/octet-stream";
  const data = readFileSync(filePath);
  return { body: new Response(data, { headers: { "Content-Type": mime, "Cache-Control": "private, max-age=86400" } }) };
}

async function getIssueHistory(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  try {
    const query = (c as { req?: { query?: (name: string) => string | undefined } })?.req?.query;
    const limit = parseInt(query?.("limit") ?? "50", 10);
    const offset = parseInt(query?.("offset") ?? "0", 10);
    const transitions = await getIssueTransitionHistoryForIssue(issue.id, { limit, offset });
    return { body: { ok: true, issueId: issue.id, transitions, localHistory: issue.history } };
  } catch (error) {
    return { status: 500, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function writeToIssueAgent(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };
  if (!issue.workspacePath) return { status: 409, body: { ok: false, error: "Issue has no workspace." } };
  if (issue.state !== "Running") return { status: 409, body: { ok: false, error: "Agent is not currently running." } };

  const body = (c as { req: { json: () => Promise<unknown> } }).req.json
    ? await (c as { req: { json: () => Promise<{ text?: string; command?: string }> } }).req.json()
    : {};
  const text = (body as { text?: string; command?: string }).text ?? (body as { text?: string; command?: string }).command;
  if (!text || typeof text !== "string") {
    return { status: 400, body: { ok: false, error: "Body must include { text: string } — the text to send to the agent's PTY stdin." } };
  }

  // Ensure text ends with carriage return so the CLI processes it as a command
  const payload = text.endsWith("\r") || text.endsWith("\n") ? text : `${text}\r`;

  const { writeToDaemon, isDaemonSocketReady } = await import("../../agents/agent.ts");
  if (!isDaemonSocketReady(issue.workspacePath)) {
    return { status: 409, body: { ok: false, error: "Agent is running but not via PTY daemon — write not supported for this session." } };
  }

  await writeToDaemon(issue.workspacePath, payload);
  return { body: { ok: true, sent: payload } };
}

async function getIssueAgentRuntimeStatus(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };
  return { body: { ok: true, ...getAgentStatus(STATE_ROOT, issue.id, issue.identifier) } };
}

async function streamIssueAgentRuntime(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  const getLogFile = (): string | null => {
    if (issue.workspacePath) return agentLogPath(issue.workspacePath);
    return null;
  };

  const enc = new TextEncoder();
  const sseMsg = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`);
  const sseComment = () => enc.encode(": keepalive\n\n");

  let chunkIntervalId: ReturnType<typeof setInterval>;
  let keepaliveId: ReturnType<typeof setInterval>;
  let statusCheckId: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(ctrl) {
      let lastSize = 0;
      const logFile = getLogFile();

      if (logFile && existsSync(logFile)) {
        try {
          const stat = statSync(logFile);
          lastSize = stat.size;
          const readSize = Math.min(lastSize, 16_384);
          const fd = openSync(logFile, "r");
          const buf = Buffer.alloc(readSize);
          readSync(fd, buf, 0, readSize, Math.max(0, lastSize - readSize));
          closeSync(fd);
          ctrl.enqueue(sseMsg({ type: "init", text: buf.toString("utf8"), size: lastSize }));
        } catch {
          ctrl.enqueue(sseMsg({ type: "init", text: "", size: 0 }));
        }
      } else {
        ctrl.enqueue(sseMsg({ type: "init", text: "", size: 0 }));
      }

      chunkIntervalId = setInterval(() => {
        const lf = getLogFile();
        if (!lf || !existsSync(lf)) return;
        try {
          const stat = statSync(lf);
          if (stat.size < lastSize) {
            lastSize = 0;
            const readSize = Math.min(stat.size, 16_384);
            let text = "";
            if (readSize > 0) {
              const fd = openSync(lf, "r");
              const buf = Buffer.alloc(readSize);
              readSync(fd, buf, 0, readSize, 0);
              closeSync(fd);
              text = buf.toString("utf8");
              lastSize = stat.size;
            }
            ctrl.enqueue(sseMsg({ type: "init", text, size: lastSize }));
          } else if (stat.size > lastSize) {
            const readSize = stat.size - lastSize;
            const fd = openSync(lf, "r");
            const buf = Buffer.alloc(readSize);
            readSync(fd, buf, 0, readSize, lastSize);
            closeSync(fd);
            lastSize = stat.size;
            ctrl.enqueue(sseMsg({ type: "chunk", text: buf.toString("utf8"), size: lastSize }));
          }
        } catch {}
      }, 1_000);

      statusCheckId = setInterval(() => {
        const current = context.state.issues.find((entry) => entry.id === issueId);
        if (!current) return;
        const status = getAgentStatus(STATE_ROOT, issueId, current.identifier);
        if (!status.running) {
          try {
            ctrl.enqueue(sseMsg({ type: "status", running: false, state: status.state }));
          } catch {}
        }
      }, 5_000);

      keepaliveId = setInterval(() => {
        try {
          ctrl.enqueue(sseComment());
        } catch {}
      }, 15_000);
    },
    cancel() {
      clearInterval(chunkIntervalId);
      clearInterval(keepaliveId);
      clearInterval(statusCheckId);
    },
  });

  return {
    body: new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }),
  };
}

export async function getIssueLive(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  try {
    const parseStartedAt = (value: unknown): number | null => {
      const valueText = typeof value === "string" ? value.trim() : "";
      if (!valueText) return null;
      const ts = Date.parse(valueText);
      return Number.isFinite(ts) ? ts : null;
    };

    const startedAtText = toStringValue(issue.startedAt, "");
    const updatedAtText = toStringValue(issue.updatedAt, "");
    const startedAtTs = parseStartedAt(startedAtText) ?? parseStartedAt(updatedAtText);
    const elapsed = startedAtTs ? Date.now() - startedAtTs : 0;

    const wp = issue.workspacePath;
    const liveLog = wp ? `${wp}/live-output.log` : null;
    const req = c as { req?: { query: (name: string) => string | undefined } };
    const afterParam = req.req?.query?.("after");
    const after = afterParam !== undefined ? parseInt(afterParam, 10) : null;

    let logTail = "";
    let logSize = 0;
    let text = "";
    let truncated = false;
    let hasIncremental = false;

    if (liveLog && existsSync(liveLog)) {
      try {
        const stat = statSync(liveLog);
        logSize = stat.size;
        const fd = openSync(liveLog, "r");

        if (Number.isInteger(after) && after >= 0) {
          if (logSize < after) {
            truncated = true;
          } else if (logSize > after) {
            const readSize = Math.min(logSize - after, 8192);
            const delta = Buffer.alloc(readSize);
            readSync(fd, delta, 0, readSize, after);
            text = delta.toString("utf8");
            hasIncremental = true;
            closeSync(fd);
          }
        }

        if (!hasIncremental) {
          const readSize = Math.min(logSize, 8192);
          const buf = Buffer.alloc(readSize);
          readSync(fd, buf, 0, readSize, Math.max(0, logSize - readSize));
          logTail = buf.toString("utf8");
          closeSync(fd);
        }
      } catch {}
    }
    const agentStatus = isAgentStillRunning(issue);
    const daemonSocketReady = wp ? existsSync(join(wp, "agent.sock")) : false;
    return {
      body: {
        ok: true,
        issueId: issue.id,
        state: issue.state,
        running: issue.state === "Running" || issue.state === "Reviewing",
        agentAlive: agentStatus.alive,
        agentPid: agentStatus.pid?.pid ?? null,
        daemonSocketReady,
        startedAt: startedAtText || updatedAtText || now(),
        elapsed: Number.isFinite(elapsed) ? elapsed : 0,
        logSize,
        text,
        truncated,
        logTail,
        outputTail: issue.commandOutputTail || "",
      },
    };
  } catch (error) {
    logger.error(`Failed to load live issue state for ${issueId}: ${String(error)}`);
    return { status: 500, body: { ok: false, error: "Failed to load live issue state." } };
  }
}

export async function streamIssueLive(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  const enc = new TextEncoder();
  const sseMsg = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`);
  const sseComment = () => enc.encode(": keepalive\n\n");

  let intervalId: ReturnType<typeof setInterval>;
  let keepaliveId: ReturnType<typeof setInterval>;

  const stream = new ReadableStream({
    start(ctrl) {
      const wp = issue.workspacePath;
      const liveLog = wp ? `${wp}/live-output.log` : null;
      let lastSize = 0;

      if (liveLog && existsSync(liveLog)) {
        try {
          const stat = statSync(liveLog);
          lastSize = stat.size;
          const readSize = Math.min(lastSize, 16_384);
          const fd = openSync(liveLog, "r");
          const buf = Buffer.alloc(readSize);
          readSync(fd, buf, 0, readSize, Math.max(0, lastSize - readSize));
          closeSync(fd);
          ctrl.enqueue(sseMsg({ type: "init", text: buf.toString("utf8"), size: lastSize }));
        } catch {}
      } else {
        ctrl.enqueue(sseMsg({ type: "init", text: "", size: 0 }));
      }

      intervalId = setInterval(() => {
        const currentIssue = findIssue(context.state, issueId);
        if (!currentIssue || (currentIssue.state !== "Running" && currentIssue.state !== "Reviewing" && currentIssue.state !== "Planning")) {
          ctrl.enqueue(sseMsg({ type: "done", state: currentIssue?.state }));
          clearInterval(intervalId);
          clearInterval(keepaliveId);
          try { ctrl.close(); } catch {}
          return;
        }
        const logPath = currentIssue.workspacePath ? `${currentIssue.workspacePath}/live-output.log` : null;
        if (logPath && existsSync(logPath)) {
          try {
            const stat = statSync(logPath);
            if (stat.size > lastSize) {
              const readSize = stat.size - lastSize;
              const fd = openSync(logPath, "r");
              const buf = Buffer.alloc(readSize);
              readSync(fd, buf, 0, readSize, lastSize);
              closeSync(fd);
              lastSize = stat.size;
              ctrl.enqueue(sseMsg({ type: "chunk", text: buf.toString("utf8"), size: lastSize }));
            }
          } catch {}
        }
      }, 1_000);

      keepaliveId = setInterval(() => {
        try { ctrl.enqueue(sseComment()); } catch {}
      }, 15_000);
    },
    cancel() {
      clearInterval(intervalId);
      clearInterval(keepaliveId);
    },
  });

  return {
    body: new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    }),
  };
}

export async function getIssueDiff(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  try {
    const wp = issue.workspacePath;
    if (!wp || !existsSync(wp)) {
      return { body: { ok: true, files: [], diff: "", message: "No workspace found." } };
    }

    let raw = "";
    if (issue.branchName && issue.baseBranch) {
      try {
        raw = execSync(
          `git diff --no-color "${issue.baseBranch}"..."${issue.branchName}"`,
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000, cwd: TARGET_ROOT, stdio: "pipe" },
        );
      } catch (error) {
        const failedDiff = error as { stdout?: string };
        raw = typeof failedDiff.stdout === "string" ? failedDiff.stdout : "";
      }
    } else {
      if (!existsSync(SOURCE_ROOT)) {
        return { body: { ok: true, files: [], diff: "", message: "Source root not found." } };
      }
      try {
        raw = execSync(
          `git diff --no-index --no-color -- "${SOURCE_ROOT}" "${wp}"`,
          { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
        );
      } catch (error) {
        const failedDiff = error as { stdout?: string };
        raw = typeof failedDiff.stdout === "string" ? failedDiff.stdout : "";
      }
    }

    if (!raw.trim()) {
      return { body: { ok: true, files: [], diff: "", message: "No changes" } };
    }

    let cleaned = raw;
    if (!issue.branchName || !issue.baseBranch) {
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const sourcePrefix = SOURCE_ROOT.endsWith("/") ? SOURCE_ROOT : `${SOURCE_ROOT}/`;
      const wpPrefix = wp.endsWith("/") ? wp : `${wp}/`;
      cleaned = raw
        .replace(new RegExp(esc(wpPrefix), "g"), "b/")
        .replace(new RegExp(esc(sourcePrefix), "g"), "a/");
    }

    const internalRe = /^(fifony[-_]|\.fifony-|WORKFLOW\.local)/;
    const chunks = cleaned.split(/(?=^diff --git )/m);
    const filtered = chunks.filter((chunk) => {
      const match = chunk.match(/^diff --git a\/(.+?) b\//);
      if (!match) return false;
      const fileName = match[1].split("/").pop() || "";
      return !internalRe.test(fileName);
    });

    const diff = filtered.join("").trim();
    const files = filtered.map((chunk) => {
      const pathMatch = chunk.match(/^diff --git a\/(.+?) b\//);
      const path = pathMatch?.[1] || "unknown";
      const additions = (chunk.match(/^\+[^+]/gm) || []).length;
      const deletions = (chunk.match(/^-[^-]/gm) || []).length;
      const isNew = chunk.includes("new file mode");
      const isDeleted = chunk.includes("deleted file mode");
      const status = isNew ? "added" : isDeleted ? "removed" : "modified";
      return { path, status, additions, deletions };
    });

    const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0);
    const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
    return { body: { ok: true, files, diff, totalAdditions, totalDeletions } };
  } catch (error) {
    logger.error(`Failed to load issue diff for ${issueId}: ${String(error)}`);
    return { status: 500, body: { ok: false, error: "Failed to load issue diff." } };
  }
}

async function listIssueOutputs(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  const wp = issue.workspacePath;
  if (!wp) return { body: { ok: true, files: [] } };
  const outputsDir = join(wp, "outputs");
  if (!existsSync(outputsDir)) return { body: { ok: true, files: [] } };
  const entries = readdirSync(outputsDir)
    .filter((file) => file.endsWith(".stdout.log"))
    .map((file) => {
      try {
        const stats = statSync(join(outputsDir, file));
        return { name: file, size: stats.size };
      } catch {
        return { name: file, size: 0 };
      }
    });
  return { body: { ok: true, files: entries } };
}

async function getIssueOutput(c: unknown) {
  const context = getApiRuntimeContextOrThrow();
  const issueId = getIssueId(c);
  if (!issueId) return { status: 400, body: { ok: false, error: "Issue id is required." } };
  const issue = findIssue(context.state, issueId);
  if (!issue) return { status: 404, body: { ok: false, error: "Issue not found." } };

  const filename = (c as { req?: { param?: (name: string) => string | undefined } })?.req?.param?.("filename") ?? "";
  if (!filename) return { status: 400, body: { ok: false, error: "Filename is required." } };
  const safeName = basename(filename);
  if (safeName !== filename || !safeName.endsWith(".stdout.log")) {
    return { status: 400, body: { ok: false, error: "Invalid filename." } };
  }
  const wp = issue.workspacePath;
  if (!wp) return { status: 404, body: { ok: false, error: "No workspace found." } };
  const filePath = join(wp, "outputs", safeName);
  if (!existsSync(filePath)) return { status: 404, body: { ok: false, error: "Output file not found." } };
  const content = readFileSync(filePath, "utf8");
  return { body: new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } }) };
}

export async function assignIssueMilestone(c: unknown, deps?: IssueApiDeps) {
  const context = getApiRuntimeContextOrThrow();
  const apiDeps = deps ?? await loadIssueApiDeps();
  return assignIssueMilestoneForState(context.state, c, apiDeps);
}

export default {
  name: S3DB_ISSUE_RESOURCE,
  attributes: {
    id: "string|required",
    identifier: "string|required",
    title: "string|required",
    description: "string|optional",
    state: "string|required",
    milestoneId: "string|optional",
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
    checkpointAttempt: "number|optional",
    contractNegotiationAttempt: "number|optional",
    checkpointStatus: "string|optional",
    checkpointPassedAt: "datetime|optional",
    checkpointReport: "json|optional",
    contractNegotiationStatus: "string|optional",
    contractNegotiationRuns: "json|optional",
    reviewProfile: "json|optional",
    reviewRuns: "json|optional",
    reviewFailureHistory: "json|optional",
    policyDecisions: "json|optional",
    contextReportsByRole: "json|optional",
    memoryFlushAt: "datetime|optional",
    memoryFlushCount: "number|optional",
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
    "GET /:id/context": async (c: unknown) => {
      const result = await getIssueContext(c);
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
    "POST /:id/approve": async (c: unknown) => {
      const result = await approveIssue(c);
      return respond(c, result);
    },
    "POST /:id/execute": async (c: unknown) => {
      const result = await executeIssue(c);
      return respond(c, result);
    },
    "POST /:id/replan": async (c: unknown) => {
      const result = await replanIssue(c);
      return respond(c, result);
    },
    "POST /:id/merge": async (c: unknown) => {
      const result = await mergeIssue(c);
      return respond(c, result);
    },
    "GET /:id/merge-preview": async (c: unknown) => {
      const result = await mergeIssuePreview(c);
      return respond(c, result);
    },
    "POST /:id/rebase": async (c: unknown) => {
      const result = await rebaseIssue(c);
      return respond(c, result);
    },
    "POST /:id/try": async (c: unknown) => {
      const result = await createIssueTestWorkspace(c);
      return respond(c, result);
    },
    "POST /:id/revert-try": async (c: unknown) => {
      const result = await revertIssueTestWorkspace(c);
      return respond(c, result);
    },
    "POST /:id/rollback": async (c: unknown) => {
      const result = await rollbackIssue(c);
      return respond(c, result);
    },
    "POST /:id/push": async (c: unknown) => {
      const result = await pushIssue(c);
      return respond(c, result);
    },
    "POST /:id/delete": async (c: unknown) => {
      const result = await deleteIssue(c);
      return respond(c, result);
    },
    "POST /:id/milestone": async (c: unknown) => {
      const result = await assignIssueMilestone(c);
      return respond(c, result);
    },
    "POST /:id/images": async (c: unknown) => {
      const result = await uploadIssueImages(c);
      return respond(c, result);
    },
    "GET /:id/images/:filename": async (c: unknown) => {
      const result = await getIssueImage(c);
      return respond(c, result);
    },
    "GET /:id/history": async (c: unknown) => {
      const result = await getIssueHistory(c);
      return respond(c, result);
    },
    "GET /:id/live": async (c: unknown) => {
      const result = await getIssueLive(c);
      return respond(c, result);
    },
    "GET /:id/live/stream": async (c: unknown) => {
      const result = await streamIssueLive(c);
      return respond(c, result);
    },
    "GET /:id/diff": async (c: unknown) => {
      const result = await getIssueDiff(c);
      return respond(c, result);
    },
    "GET /:id/outputs": async (c: unknown) => {
      const result = await listIssueOutputs(c);
      return respond(c, result);
    },
    "GET /:id/outputs/:filename": async (c: unknown) => {
      const result = await getIssueOutput(c);
      return respond(c, result);
    },
    "GET /:id/agent/status": async (c: unknown) => {
      const result = await getIssueAgentRuntimeStatus(c);
      return respond(c, result);
    },
    "GET /:id/agent/stream": async (c: unknown) => {
      const result = await streamIssueAgentRuntime(c);
      return respond(c, result);
    },
    "POST /:id/agent/write": async (c: unknown) => {
      const result = await writeToIssueAgent(c);
      return respond(c, result);
    },
  },
};
