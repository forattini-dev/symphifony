import type { IssueEntry } from "../types.ts";
import type { IIssueRepository, IEventStore } from "../ports/index.ts";
import { markIssuePlanDirty } from "../persistence/dirty-tracker.ts";
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
  if (issue.state === "Running" || issue.state === "Reviewing" || issue.state === "Queued") {
    throw new Error(`Cannot replan issue in ${issue.state} state — wait for it to finish or cancel it first.`);
  }

  // Archive current plan
  if (issue.plan) {
    if (!Array.isArray(issue.planHistory)) issue.planHistory = [];
    issue.planHistory.push(issue.plan);
    issue.plan = undefined;
    markIssuePlanDirty(issue.id);
  }

  issue.planVersion = (issue.planVersion ?? 0) + 1;
  issue.executeAttempt = 0;
  issue.reviewAttempt = 0;

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
