import type { IssueEntry } from "../types.ts";
import type { IQueuePort, JobType } from "../ports/index.ts";
import {
  enqueue,
  areQueueWorkersActive,
} from "./plugins/queue-workers.ts";

/**
 * Wraps the unified queue behind the IQueuePort interface.
 */
export function createS3QueueAdapter(): IQueuePort {
  return {
    async enqueue(issue: IssueEntry, job: JobType): Promise<void> {
      return enqueue(issue, job);
    },

    isActive(): boolean {
      return areQueueWorkersActive();
    },
  };
}
