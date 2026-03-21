import type { IssueEntry, IssueState } from "../types.ts";
import type { IIssueRepository } from "../ports/index.ts";
import {
  findIssueStateMachineTransitionPath,
  getIssueStateMachinePlugin,
  ISSUE_STATE_MACHINE_ID,
} from "../persistence/plugins/issue-state-machine.ts";
import { transitionIssue } from "../domains/issues.ts";
import { parseIssueState } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";

export type TransitionIssueInput = {
  issue: IssueEntry;
  target: IssueState;
  note: string;
  fallbackToLocal?: boolean;
};

/**
 * THE SINGLE WAY to transition an issue's state from commands/callers.
 * Queries the FSM for the real current state, finds the event path, then sends each event.
 */
export async function transitionIssueCommand(
  input: TransitionIssueInput,
  deps: {
    issueRepository: IIssueRepository;
  },
): Promise<void> {
  const { issue, target, note } = input;

  // Resolve the real FSM state (source of truth) — in-memory may be stale
  let currentState = issue.state;
  try {
    const plugin = getIssueStateMachinePlugin();
    if (plugin?.getState) {
      const fsmState = await plugin.getState(ISSUE_STATE_MACHINE_ID, issue.id);
      const normalized = parseIssueState(fsmState) ?? fsmState;
      if (normalized && normalized !== currentState) {
        logger.debug({ issueId: issue.id, memoryState: currentState, fsmState, normalized }, "[Transition] Syncing stale in-memory state with FSM");
        issue.state = normalized as typeof issue.state;
        currentState = normalized;
      }
    }
  } catch { /* FSM not available — use in-memory */ }

  if (currentState === target) return;

  const path = findIssueStateMachineTransitionPath(null, currentState, target);
  if (!path || path.length === 0) {
    throw new Error(`State machine does not allow transition from '${currentState}' to '${target}' for issue ${issue.id}.`);
  }

  for (const event of path) {
    await transitionIssue(issue, event, { note });
  }
}
