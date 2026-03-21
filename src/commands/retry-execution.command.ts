import type { IssueEntry } from "../types.ts";
import type { IIssueRepository, IEventStore } from "../ports/index.ts";
import { transitionIssueCommand } from "./transition-issue.command.ts";

export type RetryExecutionInput = {
  issue: IssueEntry;
  note?: string;
};

/**
 * Retry execution from Blocked state.
 *
 * Semantics: the *same plan* is re-executed with a fresh attempt.
 * - Increments `attempts` (global retry budget)
 * - Does NOT touch `planVersion`, `executeAttempt`, or `reviewAttempt`
 *   (those are incremented at execution/review time by the runner)
 * - Clears transient error state
 * - Transitions Blocked → Queued (FSM onEnterQueued archives the failure
 *   into `previousAttemptSummaries` and enqueues for execution)
 *
 * For re-planning, use `replanIssueCommand` instead.
 * For reviewer-requested rework, use `requestReworkCommand` instead.
 */
export async function retryExecutionCommand(
  input: RetryExecutionInput,
  deps: {
    issueRepository: IIssueRepository;
    eventStore: IEventStore;
  },
): Promise<void> {
  const { issue, note } = input;

  if (issue.state !== "Blocked") {
    throw new Error(
      `retryExecutionCommand requires Blocked state, got ${issue.state}. ` +
      `Use replanIssueCommand for re-planning or the generic /retry endpoint for other states.`,
    );
  }

  await transitionIssueCommand(
    { issue, target: "Queued", note: note ?? `Retry execution for ${issue.identifier} (attempt ${issue.attempts + 1}).` },
    deps,
  );
  // FSM onEnterQueued handles: archive previousAttemptSummaries, clear lastError/nextRetryAt, enqueue

  deps.eventStore.addEvent(
    issue.id,
    "manual",
    `Execution retry requested for ${issue.identifier} — re-queued from Blocked.`,
  );
}
