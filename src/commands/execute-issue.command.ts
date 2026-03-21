import type { IssueEntry } from "../types.ts";
import type { IIssueRepository, IEventStore } from "../ports/index.ts";
import { transitionIssueCommand } from "./transition-issue.command.ts";

export type ExecuteIssueInput = {
  issue: IssueEntry;
};

export async function executeIssueCommand(
  input: ExecuteIssueInput,
  deps: {
    issueRepository: IIssueRepository;
    eventStore: IEventStore;
  },
): Promise<void> {
  const { issue } = input;

  if (issue.state !== "PendingApproval") {
    throw new Error(`Cannot execute issue in state ${issue.state}. Must be in PendingApproval.`);
  }

  await transitionIssueCommand(
    { issue, target: "Queued", note: `Execution requested for ${issue.identifier}.` },
    deps,
  );

  deps.eventStore.addEvent(issue.id, "state", `Execute requested — ${issue.identifier} moved to Queued.`);
}
