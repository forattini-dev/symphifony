import type { IssueEntry } from "../types.ts";
import type { IIssueRepository, IEventStore } from "../ports/index.ts";
import { transitionIssueCommand } from "./transition-issue.command.ts";

export type RequestReworkInput = {
  issue: IssueEntry;
  /** Raw reviewer output — archived as lastError so onEnterQueued can analyze it */
  reviewerFeedback: string;
  note?: string;
};

/**
 * Reviewer-requested rework: send the issue back for re-execution.
 *
 * Semantics: the reviewer found issues with the current execution and
 * wants the agent to try again, informed by the review feedback.
 * - Sets `lastFailedPhase = "review"` so AttemptSummary is tagged correctly
 * - Captures reviewer feedback as `lastError` for failure-analyzer to parse
 * - Increments `attempts` (global retry budget)
 * - Transitions Reviewing/PendingDecision → Queued via PendingDecision intermediate
 *   (FSM onEnterQueued archives the failure into `previousAttemptSummaries`)
 *
 * For retrying from Blocked state, use `retryExecutionCommand` instead.
 * For re-planning, use `replanIssueCommand` instead.
 */
export async function requestReworkCommand(
  input: RequestReworkInput,
  deps: {
    issueRepository: IIssueRepository;
    eventStore: IEventStore;
  },
): Promise<void> {
  const { issue, reviewerFeedback, note } = input;

  if (issue.state !== "Reviewing" && issue.state !== "PendingDecision") {
    throw new Error(
      `requestReworkCommand requires Reviewing or PendingDecision state, got ${issue.state}.`,
    );
  }

  // Tag the failure for structured archival
  issue.lastError = reviewerFeedback;
  issue.lastFailedPhase = "review";
  issue.attempts += 1;

  // Reviewing → PendingDecision (intermediate) → Queued
  if (issue.state === "Reviewing") {
    await transitionIssueCommand(
      { issue, target: "PendingDecision", note: `Reviewer completed for ${issue.identifier}.` },
      deps,
    );
  }

  await transitionIssueCommand(
    { issue, target: "Queued", note: note ?? `Reviewer requested rework for ${issue.identifier}.` },
    deps,
  );
  // FSM onEnterQueued handles: archive previousAttemptSummaries with phase="review", clear lastError/nextRetryAt, enqueue

  deps.eventStore.addEvent(
    issue.id,
    "runner",
    `Issue ${issue.identifier} sent back for rework by reviewer.`,
  );
}
