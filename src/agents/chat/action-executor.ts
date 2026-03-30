import { readFileSync } from "node:fs";
import { resolve, normalize } from "node:path";
import type { ChatAction, RuntimeState, JsonRecord } from "../../types.ts";
import { TARGET_ROOT } from "../../concerns/constants.ts";
import { logger } from "../../concerns/logger.ts";
import { getContainer } from "../../persistence/container.ts";
import { listServiceStatuses, readServiceLogTail, startManagedService, stopManagedService } from "../../domains/services.ts";
import { persistState } from "../../persistence/store.ts";

type ActionResult = { ok: boolean; result: unknown; error?: string };

export async function executeChatAction(
  action: ChatAction,
  state: RuntimeState,
): Promise<ActionResult> {
  try {
    switch (action.type) {
      case "list-issues":
        return {
          ok: true,
          result: state.issues.map((i) => ({
            id: i.id,
            identifier: i.identifier,
            title: i.title,
            state: i.state,
          })),
        };

      case "list-services": {
        const fifonyDir = resolve(TARGET_ROOT, ".fifony");
        const statuses = listServiceStatuses(state.config.services ?? [], fifonyDir);
        return {
          ok: true,
          result: statuses.map((s) => ({
            id: s.id,
            name: s.name,
            state: s.state,
            port: s.port,
            running: s.running,
          })),
        };
      }

      case "read-file": {
        const rawPath = String(action.payload.path ?? "");
        const absPath = normalize(resolve(TARGET_ROOT, rawPath));
        if (!absPath.startsWith(TARGET_ROOT)) {
          return { ok: false, result: null, error: "Path is outside the project root." };
        }
        const content = readFileSync(absPath, "utf8");
        // Truncate large files
        return { ok: true, result: content.length > 8000 ? content.slice(0, 8000) + "\n...(truncated)" : content };
      }

      case "read-service-log": {
        const id = String(action.payload.id ?? "");
        if (!id) return { ok: false, result: null, error: "Service id is required." };
        const fifonyDir = resolve(TARGET_ROOT, ".fifony");
        const bytes = typeof action.payload.bytes === "number" ? action.payload.bytes : 8192;
        const log = readServiceLogTail(id, fifonyDir, bytes);
        return { ok: true, result: log || "(no log output)" };
      }

      case "start-service": {
        const id = String(action.payload.id ?? "");
        if (!id) return { ok: false, result: null, error: "Service id is required." };
        await startManagedService(id);
        return { ok: true, result: `Service ${id} start requested.` };
      }

      case "stop-service": {
        const id = String(action.payload.id ?? "");
        if (!id) return { ok: false, result: null, error: "Service id is required." };
        await stopManagedService(id);
        return { ok: true, result: `Service ${id} stop requested.` };
      }

      case "restart-service": {
        const id = String(action.payload.id ?? "");
        if (!id) return { ok: false, result: null, error: "Service id is required." };
        await stopManagedService(id);
        // Small delay before restart
        await new Promise((r) => setTimeout(r, 500));
        await startManagedService(id);
        return { ok: true, result: `Service ${id} restart requested.` };
      }

      case "create-issue": {
        const { createIssueCommand } = await import("../../commands/create-issue.command.ts");
        const container = getContainer();
        const payload: JsonRecord = {
          title: String(action.payload.title ?? ""),
          description: String(action.payload.description ?? ""),
        };
        if (!payload.title) return { ok: false, result: null, error: "Title is required." };
        const { issue } = await createIssueCommand({ payload, state }, container);
        await persistState(state);
        return { ok: true, result: { id: issue.id, identifier: issue.identifier, title: issue.title, state: issue.state } };
      }

      case "retry-issue": {
        const { retryIssueCommand } = await import("../../commands/retry-issue.command.ts");
        const container = getContainer();
        const issue = findIssue(state, String(action.payload.issueId ?? ""));
        if (!issue) return { ok: false, result: null, error: "Issue not found." };
        const feedback = action.payload.feedback ? String(action.payload.feedback) : undefined;
        await retryIssueCommand({ issue, feedback }, container);
        await persistState(state);
        return { ok: true, result: `Retry requested for ${issue.identifier}.` };
      }

      case "replan-issue": {
        const { replanIssueCommand } = await import("../../commands/replan-issue.command.ts");
        const container = getContainer();
        const issue = findIssue(state, String(action.payload.issueId ?? ""));
        if (!issue) return { ok: false, result: null, error: "Issue not found." };
        await replanIssueCommand({ issue }, container);
        await persistState(state);
        return { ok: true, result: `Replan requested for ${issue.identifier}.` };
      }

      case "approve-issue": {
        const { approvePlanCommand } = await import("../../commands/approve-plan.command.ts");
        const container = getContainer();
        const issue = findIssue(state, String(action.payload.issueId ?? ""));
        if (!issue) return { ok: false, result: null, error: "Issue not found." };
        await approvePlanCommand({ issue }, container);
        await persistState(state);
        return { ok: true, result: `Plan approved for ${issue.identifier}.` };
      }

      case "merge-issue": {
        const { mergeWorkspaceCommand } = await import("../../commands/merge-workspace.command.ts");
        const container = getContainer();
        const issue = findIssue(state, String(action.payload.issueId ?? ""));
        if (!issue) return { ok: false, result: null, error: "Issue not found." };
        const result = await mergeWorkspaceCommand({ issue, state }, container);
        await persistState(state);
        return { ok: true, result: { merged: true, conflicts: result.conflicts.length } };
      }

      default:
        return { ok: false, result: null, error: `Unknown action type: ${(action as { type: string }).type}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, action: action.type }, "[Chat] Action execution failed");
    return { ok: false, result: null, error: msg };
  }
}

function findIssue(state: RuntimeState, issueId: string) {
  return state.issues.find((i) => i.id === issueId || i.identifier === issueId);
}
