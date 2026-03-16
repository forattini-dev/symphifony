/**
 * In-memory token usage ledger.
 *
 * Updated O(1) per turn via `record()`.
 * Queried O(1) for all analytics views — no disk I/O, no scans.
 *
 * Hydrated once at startup from existing issue data,
 * then kept in sync incrementally as turns complete.
 */

import type { AgentProviderRole, AgentTokenUsage, IssueEntry } from "./types.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type TokenBucket = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type DailyBucket = TokenBucket & {
  date: string; // "2026-03-16"
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
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
  const model = usage.model || "unknown";

  // Overall
  addTo(overall, usage);

  // Daily overall
  addTo(getOrCreate(daily, date), usage);

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

    // Note: daily breakdown cannot be reconstructed from issue data alone
    // (we don't store per-day history on the issue). This is fine — daily
    // data accumulates correctly from record() calls going forward.
    // Historical daily data lives in the EC plugin as a secondary source.
  }
}

/**
 * Get full analytics snapshot. O(1) — reads from pre-computed maps.
 */
export function getAnalytics(topN = 20): TokenAnalytics {
  // Daily overall
  const dailyArray: DailyBucket[] = [];
  for (const [date, bucket] of daily) {
    dailyArray.push({ ...bucket, date });
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
