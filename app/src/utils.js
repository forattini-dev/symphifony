/** Parse JSON safely, returning null on failure. */
export function safeJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  timeZone: BROWSER_TZ,
});

const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "long" });

/** Format a date value in the browser's local timezone, or "-" if invalid. */
export function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : dateFmt.format(d);
}

/** Human-readable relative time using Intl.RelativeTimeFormat ("2 seconds ago", "in 3 minutes"). */
export function timeAgo(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const diffMs = d.getTime() - Date.now();
  const absDiff = Math.abs(diffMs);

  if (absDiff < 5_000) return "just now";
  if (absDiff < 60_000) return relFmt.format(Math.round(diffMs / 1000), "second");
  if (absDiff < 3_600_000) return relFmt.format(Math.round(diffMs / 60_000), "minute");
  if (absDiff < 86_400_000) return relFmt.format(Math.round(diffMs / 3_600_000), "hour");
  if (absDiff < 2_592_000_000) return relFmt.format(Math.round(diffMs / 86_400_000), "day");
  return relFmt.format(Math.round(diffMs / 2_592_000_000), "month");
}

/** Format a duration in ms to human readable ("1.2s", "3m 20s", "2h 15m"). */
export function formatDuration(ms) {
  if (!ms && ms !== 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

/**
 * Fill missing days in a daily data array with zero entries.
 * Returns an array of exactly `days` entries ending on today, preserving
 * any existing data and zeroing out days with no records.
 *
 * Each entry in the source array must have a `date` field ("YYYY-MM-DD").
 * Returned entries carry all original fields (totalTokens, events, etc.)
 * or default zeros for missing days.
 */
export function fillDailyGaps(data, days = 14) {
  const byDate = new Map((data || []).filter((d) => d.date).map((d) => [d.date, d]));
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    result.push(byDate.get(date) ?? { date, totalTokens: 0, inputTokens: 0, outputTokens: 0, events: 0 });
  }
  return result;
}

export const STATES = [
  "Planning", "PendingApproval", "Queued", "Running",
  "Reviewing", "PendingDecision", "Blocked", "Approved", "Merged", "Cancelled", "Archived"
];
// Must match backend state machine in persistence/plugins/issue-state-machine.ts
export const ISSUE_STATE_MACHINE = {
  Planning:  ["PendingApproval", "Cancelled"],
  PendingApproval:   ["Queued", "Planning", "Cancelled"],
  Queued:    ["Running"],
  Running:   ["Reviewing", "Queued", "Blocked"],
  Reviewing: ["PendingDecision", "Queued", "Blocked"],
  PendingDecision:  ["Approved", "Queued", "Planning", "Cancelled"],
  Blocked:   ["Queued", "Planning", "Cancelled"],
  Approved:      ["Merged", "Planning"],
  Merged:    ["Archived", "Planning"],
  Cancelled: ["Archived", "Planning"],
  Archived:  [],
};

const MANUAL_TRANSITION_HIDDEN = {
  Queued: new Set(["Running"]),
  Reviewing: new Set(["Running"]),
};

export function getIssueTransitions(state) {
  if (!Array.isArray(ISSUE_STATE_MACHINE[state])) return STATES;
  const next = ISSUE_STATE_MACHINE[state].filter((target) => !(MANUAL_TRANSITION_HIDDEN[state]?.has(target)));
  return [state, ...next.filter((s) => s !== state)];
}
