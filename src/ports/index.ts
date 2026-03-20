import type { IssueEntry, RuntimeEvent, RuntimeEventType, RuntimeState } from "../types.ts";

export type IIssueRepository = {
  findById(id: string): IssueEntry | undefined;
  findAll(): IssueEntry[];
  save(issue: IssueEntry): void;
  markDirty(issueId: string): void;
};

export type IEventStore = {
  addEvent(issueId: string | undefined, kind: RuntimeEventType, message: string): void;
  listEvents(filters?: { issueId?: string; kind?: string; since?: string }): Promise<RuntimeEvent[]>;
};

export type IQueuePort = {
  enqueueForPlanning(issue: IssueEntry): Promise<void>;
  enqueueForExecution(issue: IssueEntry): Promise<void>;
  enqueueForReview(issue: IssueEntry): Promise<void>;
  isActive(): boolean;
};

export type IPersistencePort = {
  persistState(state: RuntimeState): Promise<void>;
  loadState(): Promise<RuntimeState | null>;
};
