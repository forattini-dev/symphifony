import type { IssueEntry, JsonRecord, RuntimeState } from "../types.ts";
import type { IIssueRepository, IQueuePort, IEventStore, IPersistencePort } from "../ports/index.ts";
import { createIssueFromPayload } from "../domains/issues.ts";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { ATTACHMENTS_ROOT } from "../concerns/constants.ts";

export type CreateIssueInput = {
  payload: JsonRecord;
  state: RuntimeState;
};

export type CreateIssueResult = {
  issue: IssueEntry;
};

export async function createIssueCommand(
  input: CreateIssueInput,
  deps: {
    issueRepository: IIssueRepository;
    eventStore: IEventStore;
    queuePort: IQueuePort;
    persistencePort: IPersistencePort;
  },
): Promise<CreateIssueResult> {
  const { payload, state } = input;

  const issue = createIssueFromPayload(payload, state.issues, state.config.defaultBranch);

  // Move temp attachment files to permanent issue directory
  const tempImages = Array.isArray(payload.images) ? payload.images as string[] : [];
  if (tempImages.length) {
    const issueAttachDir = join(ATTACHMENTS_ROOT, issue.id);
    mkdirSync(issueAttachDir, { recursive: true });
    const finalPaths: string[] = [];
    for (const tempPath of tempImages) {
      if (typeof tempPath === "string" && existsSync(tempPath)) {
        const dest = join(issueAttachDir, basename(tempPath));
        try { renameSync(tempPath, dest); finalPaths.push(dest); } catch { finalPaths.push(tempPath); }
      }
    }
    if (finalPaths.length) issue.images = finalPaths;
  }

  deps.issueRepository.save(issue);
  deps.issueRepository.markDirty(issue.id);
  deps.eventStore.addEvent(issue.id, "info", `Issue ${issue.identifier} created via API.`);

  if (issue.plan) {
    deps.eventStore.addEvent(issue.id, "info", `Plan: ${issue.plan.steps.length} steps, complexity: ${issue.plan.estimatedComplexity}.`);
  }

  await deps.persistencePort.persistState(state);

  // Enqueue based on initial state
  if (issue.state === "Planning") {
    deps.queuePort.enqueueForPlanning(issue).catch(() => {});
  } else if (issue.state === "Queued" || issue.state === "Running") {
    deps.queuePort.enqueueForExecution(issue).catch(() => {});
  } else if (issue.state === "Reviewing") {
    deps.queuePort.enqueueForReview(issue).catch(() => {});
  }

  return { issue };
}
