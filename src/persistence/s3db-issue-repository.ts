import type { IssueEntry } from "../types.ts";
import type { RuntimeState } from "../types.ts";
import type { IIssueRepository } from "../ports/index.ts";
import { markIssueDirty } from "./dirty-tracker.ts";

/**
 * Wraps in-memory RuntimeState.issues array + s3db dirty tracking.
 */
export function createS3dbIssueRepository(state: RuntimeState): IIssueRepository {
  return {
    findById(id: string): IssueEntry | undefined {
      return state.issues.find((i) => i.id === id || i.identifier === id);
    },

    findAll(): IssueEntry[] {
      return state.issues;
    },

    save(issue: IssueEntry): void {
      const idx = state.issues.findIndex((i) => i.id === issue.id);
      if (idx >= 0) {
        state.issues[idx] = issue;
      } else {
        state.issues.push(issue);
      }
      markIssueDirty(issue.id);
    },

    markDirty(issueId: string): void {
      markIssueDirty(issueId);
    },
  };
}
