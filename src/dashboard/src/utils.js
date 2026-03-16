/** Parse JSON safely, returning null on failure. */
export function safeJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/** Split a comma-separated string into trimmed, non-empty tokens. */
export function normalizeCsv(str) {
  return typeof str === "string"
    ? str.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
}

/** Browser timezone name (e.g. "America/Sao_Paulo") */
export const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  timeZone: BROWSER_TZ,
});

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  timeZoneName: "short",
  timeZone: BROWSER_TZ,
});

const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "long" });

/** Format a date value in the browser's local timezone, or "-" if invalid. */
export function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : dateFmt.format(d);
}

/** Format with explicit timezone indicator. */
export function formatDateTz(value) {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "-" : dateTimeFmt.format(d);
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

/** Short relative time for compact display ("2s", "5m", "3h", "2d"). */
export function timeAgoShort(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const ms = Math.abs(Date.now() - d.getTime());
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** Format a duration in ms to human readable ("1.2s", "3m 20s", "2h 15m"). */
export function formatDuration(ms) {
  if (!ms && ms !== 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

export const STATES = ["Todo", "Queued", "Running", "Interrupted", "In Review", "Blocked", "Done", "Cancelled"];
export const ISSUE_STATE_MACHINE = {
  Todo: ["Queued", "Cancelled"],
  Queued: ["Running", "Todo", "Cancelled"],
  Running: ["In Review", "Interrupted", "Blocked", "Cancelled"],
  Interrupted: ["Queued", "Running", "Blocked", "Cancelled"],
  "In Review": ["Running", "Done", "Blocked", "Cancelled"],
  Blocked: ["Queued", "Cancelled"],
  Done: ["Todo", "Cancelled"],
  Cancelled: ["Todo", "Queued"],
};

export function getIssueTransitions(state) {
  if (!Array.isArray(ISSUE_STATE_MACHINE[state])) return STATES;
  const next = ISSUE_STATE_MACHINE[state];
  return [state, ...next.filter((s) => s !== state)];
}
