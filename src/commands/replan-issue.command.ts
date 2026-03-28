import type { IssueEntry } from "../types.ts";
import type { IIssueRepository, IEventStore } from "../ports/index.ts";
import { TERMINAL_STATES } from "../concerns/constants.ts";
import { transitionIssueCommand } from "./transition-issue.command.ts";

export type ReplanIssueInput = {
  issue: IssueEntry;
};

export async function replanIssueCommand(
  input: ReplanIssueInput,
  deps: {
    issueRepository: IIssueRepository;
    eventStore: IEventStore;
  },
): Promise<void> {
  const { issue } = input;

  if (issue.planningStatus === "planning") {
    throw new Error("Cannot replan while planning is in progress.");
  }
  if (TERMINAL_STATES.has(issue.state)) {
    throw new Error(`Cannot replan issue in terminal state ${issue.state}.`);
  }
  if (issue.state === "Queued") {
    throw new Error(`Cannot replan issue in ${issue.state} state — move it out of the execution queue first.`);
  }

  // Previous plans stay in issue_plans resource (1:N model — they become history automatically).
  // Just clear the in-memory plan so the planner generates a new one.
  issue.plan = undefined;

  issue.planVersion = (issue.planVersion ?? 0) + 1;
  issue.executeAttempt = 0;
  issue.reviewAttempt = 0;
  issue.attempts = 0; // fresh budget for the new plan

  // Transition to Planning — FSM onEnterPlanning action handles enqueue
  await transitionIssueCommand(
    { issue, target: "Planning", note: "Replan requested." },
    deps,
  );

  issue.planningStatus = "idle";
  issue.planningError = undefined;
  issue.planningStartedAt = undefined;

  deps.eventStore.addEvent(issue.id, "manual", `Replan requested for ${issue.identifier} — now at plan v${issue.planVersion}.`);
}
