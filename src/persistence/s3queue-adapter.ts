import type { IssueEntry } from "../types.ts";
import type { IQueuePort } from "../ports/index.ts";
import {
  enqueueForPlanning,
  enqueueForExecution,
  enqueueForReview,
  areQueueWorkersActive,
} from "./plugins/queue-workers.ts";

/**
 * Wraps existing queue-workers.ts functions behind the IQueuePort interface.
 */
export function createS3QueueAdapter(): IQueuePort {
  return {
    async enqueueForPlanning(issue: IssueEntry): Promise<void> {
      return enqueueForPlanning(issue);
    },

    async enqueueForExecution(issue: IssueEntry): Promise<void> {
      return enqueueForExecution(issue);
    },

    async enqueueForReview(issue: IssueEntry): Promise<void> {
      return enqueueForReview(issue);
    },

    isActive(): boolean {
      return areQueueWorkersActive();
    },
  };
}
