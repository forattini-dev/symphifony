import type { RuntimeEvent, RuntimeEventType, RuntimeState } from "../types.ts";
import type { IEventStore } from "../ports/index.ts";
import { addEvent } from "../domains/issues.ts";
import { listEvents } from "../routes/helpers.ts";

/**
 * Wraps existing addEvent and listEvents functions.
 */
export function createS3dbEventStore(state: RuntimeState): IEventStore {
  return {
    addEvent(issueId: string | undefined, kind: RuntimeEventType, message: string): void {
      addEvent(state, issueId, kind, message);
    },

    async listEvents(filters?: { issueId?: string; kind?: string; since?: string }): Promise<RuntimeEvent[]> {
      return listEvents(state, filters);
    },
  };
}
