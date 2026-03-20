import type { IssueEntry } from "../types.ts";
import type { IIssueRepository, IEventStore } from "../ports/index.ts";
import { transitionIssueCommand } from "./transition-issue.command.ts";

export type ApprovePlanInput = {
  issue: IssueEntry;
};

export async function approvePlanCommand(
  input: ApprovePlanInput,
  deps: {
    issueRepository: IIssueRepository;
    eventStore: IEventStore;
  },
): Promise<void> {
  const { issue } = input;

  if (issue.state !== "Planning") {
    throw new Error(`Cannot approve issue in state ${issue.state}. Must be in Planning.`);
  }

  await transitionIssueCommand(
    { issue, target: "Planned", note: `Plan approved for ${issue.identifier}. Ready for execution.` },
    deps,
  );
  // Event emitted by FSM onEnterPlanned

  // Explicitly queue for execution (no auto-queue hack in FSM)
  await transitionIssueCommand(
    { issue, target: "Queued", note: `${issue.identifier} queued for execution after plan approval.` },
    deps,
  );
}
