/**
 * In-memory token usage ledger.
 *
 * Updated O(1) per turn via `record()`.
 * Queried O(1) for all analytics views — no disk I/O, no scans.
 *
 * Hydrated once at startup from existing issue data,
 * then kept in sync incrementally as turns complete.
 *
 * Event counts (events/day) are tracked via the EventualConsistencyPlugin
 * using the `eventsCount` field on IssueEntry — not here.
 */

import type { AgentProviderRole, AgentTokenUsage, IssueEntry } from "../types.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type TokenBucket = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type DailyBucket = TokenBucket & {
  date: string; // "2026-03-16"
  events?: number;
};

export type HourlyBucket = TokenBucket & {
  hour: string; // "2026-03-16T14" (ISO date + hour)
};

export type HourlySnapshot = {
  tokensPerHour: HourlyBucket[];
};

export type TokenAnalytics = {
  overall: TokenBucket;
  byPhase: Record<string, TokenBucket>;
  byModel: Record<string, TokenBucket>;
  daily: DailyBucket[];
  dailyByPhase: Record<string, DailyBucket[]>;
  dailyByModel: Record<string, DailyBucket[]>;
  topIssues: Array<{ id: string; identifier: string; title: string; totalTokens: number }>;
};

// ── Internal state ───────────────────────────────────────────────────────────

const EMPTY: TokenBucket = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Overall aggregate */
let overall: TokenBucket = { ...EMPTY };

/** Per-phase aggregate */
const byPhase = new Map<string, TokenBucket>();

/** Per-model aggregate */
const byModel = new Map<string, TokenBucket>();

/** Daily overall: date → bucket */
const daily = new Map<string, TokenBucket>();

/** Daily per-phase: "phase:date" → bucket */
const dailyByPhase = new Map<string, TokenBucket>();

/** Daily per-model: "model:date" → bucket */
const dailyByModel = new Map<string, TokenBucket>();

/** Per-issue totals (for top-N) */
const byIssue = new Map<string, { identifier: string; title: string; totalTokens: number }>();

/** Daily event counts: date → count */
const dailyEvents = new Map<string, number>();

/** Hourly token buckets: "2026-03-16T14" → bucket */
const hourly = new Map<string, TokenBucket>();

const HOURLY_RETENTION = 48; // keep last 48 hours

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentHour(): string {
  return new Date().toISOString().slice(0, 13); // "2026-03-16T14"
}

function pruneOldHours(): void {
  if (hourly.size <= HOURLY_RETENTION) return;
  const cutoff = new Date(Date.now() - HOURLY_RETENTION * 3600_000).toISOString().slice(0, 13);
  for (const key of hourly.keys()) {
    if (key < cutoff) hourly.delete(key);
  }
}

function addTo(target: TokenBucket, usage: AgentTokenUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
}

function getOrCreate(map: Map<string, TokenBucket>, key: string): TokenBucket {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { ...EMPTY };
    map.set(key, bucket);
  }
  return bucket;
}

function mapToDailyArray(map: Map<string, TokenBucket>, prefix: string): DailyBucket[] {
  const result: DailyBucket[] = [];
  for (const [key, bucket] of map) {
    if (!key.startsWith(prefix)) continue;
    const date = key.slice(prefix.length);
    result.push({ ...bucket, date });
  }
  result.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a token usage event. Called once per turn completion.
 * O(1) — just increments counters.
 */
export function record(
  issue: IssueEntry,
  usage: AgentTokenUsage,
  role?: AgentProviderRole,
): void {
  if (!usage || usage.totalTokens === 0) return;

  const date = todayDate();
  const hour = currentHour();
  const model = usage.model || "unknown";

  // Overall
  addTo(overall, usage);

  // Daily overall
  addTo(getOrCreate(daily, date), usage);

  // Hourly overall
  addTo(getOrCreate(hourly, hour), usage);
  pruneOldHours();

  // By phase
  if (role) {
    addTo(getOrCreate(byPhase, role), usage);
    addTo(getOrCreate(dailyByPhase, `${role}:${date}`), usage);
  }

  // By model
  addTo(getOrCreate(byModel, model), usage);
  addTo(getOrCreate(dailyByModel, `${model}:${date}`), usage);

  // By issue
  const prev = byIssue.get(issue.id);
  if (prev) {
    prev.totalTokens += usage.totalTokens;
    prev.title = issue.title; // keep fresh
  } else {
    byIssue.set(issue.id, {
      identifier: issue.identifier,
      title: issue.title,
      totalTokens: usage.totalTokens,
    });
  }
}

/**
 * Record a single event occurrence for daily analytics.
 * Called from addEvent() in issues.ts.
 */
export function recordEvent(): void {
  const date = todayDate();
  dailyEvents.set(date, (dailyEvents.get(date) || 0) + 1);
}

/**
 * Get hourly snapshot for sparkline display.
 * Returns last N hours of token usage.
 */
export function getHourlySnapshot(hours = 24): HourlySnapshot {
  const now = Date.now();
  const tokensPerHour: HourlyBucket[] = [];

  for (let i = hours - 1; i >= 0; i--) {
    const h = new Date(now - i * 3600_000).toISOString().slice(0, 13);
    const tokenBucket = hourly.get(h);
    tokensPerHour.push({
      hour: h,
      inputTokens: tokenBucket?.inputTokens || 0,
      outputTokens: tokenBucket?.outputTokens || 0,
      totalTokens: tokenBucket?.totalTokens || 0,
    });
  }

  return { tokensPerHour };
}

/**
 * Hydrate the ledger from existing issues at startup.
 * Called once. O(n) over issues — amortized at boot, never at query time.
 */
export function hydrate(issues: IssueEntry[]): void {
  // Reset
  overall = { ...EMPTY };
  byPhase.clear();
  byModel.clear();
  daily.clear();
  dailyByPhase.clear();
  dailyByModel.clear();
  byIssue.clear();
  dailyEvents.clear();

  for (const issue of issues) {
    // Per-issue totals
    if (issue.tokenUsage && issue.tokenUsage.totalTokens > 0) {
      byIssue.set(issue.id, {
        identifier: issue.identifier,
        title: issue.title,
        totalTokens: issue.tokenUsage.totalTokens,
      });
      addTo(overall, issue.tokenUsage);
    }

    // Per-phase
    if (issue.tokensByPhase) {
      for (const [phase, pu] of Object.entries(issue.tokensByPhase)) {
        if (pu.totalTokens > 0) addTo(getOrCreate(byPhase, phase), pu);
      }
    }

    // Per-model
    if (issue.tokensByModel) {
      for (const [model, mu] of Object.entries(issue.tokensByModel)) {
        if (mu.totalTokens > 0) addTo(getOrCreate(byModel, model), mu);
      }
    }

    // Reconstruct daily token buckets from completedAt date
    const date = issue.completedAt?.slice(0, 10);
    if (date && issue.tokenUsage && issue.tokenUsage.totalTokens > 0) {
      addTo(getOrCreate(daily, date), issue.tokenUsage);
    }
    if (date && issue.tokensByPhase) {
      for (const [phase, pu] of Object.entries(issue.tokensByPhase)) {
        if (pu.totalTokens > 0) addTo(getOrCreate(dailyByPhase, `${phase}:${date}`), pu);
      }
    }
    if (date && issue.tokensByModel) {
      for (const [model, mu] of Object.entries(issue.tokensByModel)) {
        if (mu.totalTokens > 0) addTo(getOrCreate(dailyByModel, `${model}:${date}`), mu);
      }
    }
  }
}

/**
 * Get full analytics snapshot. O(1) — reads from pre-computed maps.
 * Note: daily[].events is populated by the API layer from EventualConsistency.
 */
export function getAnalytics(topN = 20): TokenAnalytics {
  // Daily overall (merge token buckets with event counts)
  const allDates = new Set([...daily.keys(), ...dailyEvents.keys()]);
  const dailyArray: DailyBucket[] = [];
  for (const date of allDates) {
    const bucket = daily.get(date) ?? { ...EMPTY };
    const events = dailyEvents.get(date) || 0;
    dailyArray.push({ ...bucket, date, ...(events > 0 ? { events } : {}) });
  }
  dailyArray.sort((a, b) => a.date.localeCompare(b.date));

  // Daily by phase
  const dailyByPhaseResult: Record<string, DailyBucket[]> = {};
  for (const phase of byPhase.keys()) {
    dailyByPhaseResult[phase] = mapToDailyArray(dailyByPhase, `${phase}:`);
  }

  // Daily by model
  const dailyByModelResult: Record<string, DailyBucket[]> = {};
  for (const model of byModel.keys()) {
    dailyByModelResult[model] = mapToDailyArray(dailyByModel, `${model}:`);
  }

  // Top issues
  const topIssues = [...byIssue.entries()]
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, topN);

  // Phase/model aggregates
  const byPhaseResult: Record<string, TokenBucket> = {};
  for (const [k, v] of byPhase) byPhaseResult[k] = { ...v };

  const byModelResult: Record<string, TokenBucket> = {};
  for (const [k, v] of byModel) byModelResult[k] = { ...v };

  return {
    overall: { ...overall },
    byPhase: byPhaseResult,
    byModel: byModelResult,
    daily: dailyArray,
    dailyByPhase: dailyByPhaseResult,
    dailyByModel: dailyByModelResult,
    topIssues,
  };
}
