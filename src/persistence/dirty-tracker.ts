/**
 * Dirty tracking for incremental persistence.
 * Tracks which issue and event IDs have been modified since last persist.
 */

const dirtyIssueIds = new Set<string>();
const dirtyIssuePlanIds = new Set<string>();
const dirtyEventIds = new Set<string>();

export function markIssueDirty(id: string): void {
  dirtyIssueIds.add(id);
}

export function markIssuePlanDirty(id: string): void {
  dirtyIssuePlanIds.add(id);
}

export function markEventDirty(id: string): void {
  dirtyEventIds.add(id);
}

export function hasDirtyState(): boolean {
  return dirtyIssueIds.size > 0 || dirtyEventIds.size > 0;
}

export function getDirtyIssueIds(): Set<string> {
  return dirtyIssueIds;
}

export function getDirtyIssuePlanIds(): Set<string> {
  return dirtyIssuePlanIds;
}

export function getDirtyEventIds(): Set<string> {
  return dirtyEventIds;
}

/** Snapshot current dirty IDs, then delete only those from the live set. */
export function snapshotAndClearDirtyIssueIds(): Set<string> {
  const snapshot = new Set(dirtyIssueIds);
  for (const id of snapshot) dirtyIssueIds.delete(id);
  return snapshot;
}

export function snapshotAndClearDirtyIssuePlanIds(): Set<string> {
  const snapshot = new Set(dirtyIssuePlanIds);
  for (const id of snapshot) dirtyIssuePlanIds.delete(id);
  return snapshot;
}

export function snapshotAndClearDirtyEventIds(): Set<string> {
  const snapshot = new Set(dirtyEventIds);
  for (const id of snapshot) dirtyEventIds.delete(id);
  return snapshot;
}

/** @deprecated Use snapshotAndClearDirtyIssueIds() to avoid race conditions */
export function clearDirtyIssueIds(): void {
  dirtyIssueIds.clear();
}

/** @deprecated Use snapshotAndClearDirtyIssuePlanIds() to avoid race conditions */
export function clearDirtyIssuePlanIds(): void {
  dirtyIssuePlanIds.clear();
}

/** @deprecated Use snapshotAndClearDirtyEventIds() to avoid race conditions */
export function clearDirtyEventIds(): void {
  dirtyEventIds.clear();
}

export function markAllIssuesDirty(ids: string[]): void {
  for (const id of ids) dirtyIssueIds.add(id);
}

export function markAllIssuePlansDirty(ids: string[]): void {
  for (const id of ids) dirtyIssuePlanIds.add(id);
}

export function markAllEventsDirty(ids: string[]): void {
  for (const id of ids) dirtyEventIds.add(id);
}
