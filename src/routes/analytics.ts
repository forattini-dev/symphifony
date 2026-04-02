import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAnalytics as getTokenAnalytics, getHourlySnapshot } from "../domains/tokens.ts";
import { computeQualityGateMetrics } from "../domains/metrics.ts";
import { getEcDailyEvents, getEcDailyLines } from "../persistence/store.ts";
import { logger } from "../concerns/logger.ts";
import { getApiRuntimeContextOrThrow } from "../persistence/plugins/api-runtime-context.ts";
import type { IssueEntry } from "../types.ts";
import type { DailyBucket } from "../domains/tokens.ts";
import type { RouteRegistrar } from "./http.ts";
import { traceDir } from "../domains/trace-bundle.ts";

type StageRailSummary = {
  harnessModes: Array<{ name: string; count: number }>;
  checkpointPolicies: Array<{ name: string; count: number }>;
  avgContextResets: number;
  contextResetCountSum: number;
  issuesWithContextResets: number;
  issuesNearRetryBudget: number;
  issuesWithPolicyChanges: number;
  issuesWithCheckpointFailures: number;
  issuesWithContractBlockers: number;
};

type StageBucket = {
  role: string;
  totalTokens: number;
  avgTokensPerIssue: number;
  issueCount: number;
  successfulIssues: number;
  successRate: number;
  outcomes: {
    Approved: number;
    Merged: number;
    Blocked: number;
    Cancelled: number;
    rework: number;
  };
  costUsdSum: number;
  avgCostUsd: number;
  byProviderModel: Array<{
    provider: string;
    model: string;
    totalTokens: number;
    avgTokensPerIssue: number;
    issueCount: number;
    costUsdSum: number;
    avgCostUsd: number;
  }>;
  topIssues: Array<{
    id: string;
    identifier: string;
    title: string;
    totalTokens: number;
    costUsd?: number;
    outcome: string;
    harnessMode: string;
    checkpointPolicy: string;
    contextResetCount: number;
    retryBudgetRemaining: number;
    retryBudgetMax: number;
    policyDecisionCount: number;
    railsPath?: string;
    similarTracesPath?: string;
  }>;
  rails: StageRailSummary;
};

function parseDateBound(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function issueAnalyticsTimestamp(issue: IssueEntry): number {
  const candidates = [
    issue.completedAt,
    issue.updatedAt,
    issue.reviewingAt,
    issue.startedAt,
    issue.createdAt,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function issueOutcome(issue: IssueEntry): "Approved" | "Merged" | "Blocked" | "Cancelled" | "rework" {
  if ((issue.previousAttemptSummaries ?? []).some((summary) => summary.phase === "review")) {
    return "rework";
  }
  if (issue.state === "Merged") return "Merged";
  if (issue.state === "Approved") return "Approved";
  if (issue.state === "Cancelled") return "Cancelled";
  return "Blocked";
}

function inferProviderFromModel(model: string | undefined): string {
  const normalized = (model ?? "unknown").toLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("gemini")) return "gemini";
  if (normalized.includes("gpt") || normalized.includes("o1") || normalized.includes("o3")) return "openai";
  if (normalized.includes("codex")) return "codex";
  return "unknown";
}

function createStageBucket(role: string): StageBucket {
  return {
    role,
    totalTokens: 0,
    avgTokensPerIssue: 0,
    issueCount: 0,
    successfulIssues: 0,
    successRate: 0,
    outcomes: {
      Approved: 0,
      Merged: 0,
      Blocked: 0,
      Cancelled: 0,
      rework: 0,
    },
    costUsdSum: 0,
    avgCostUsd: 0,
    byProviderModel: [],
    topIssues: [],
    rails: {
      harnessModes: [],
      checkpointPolicies: [],
      avgContextResets: 0,
      contextResetCountSum: 0,
      issuesWithContextResets: 0,
      issuesNearRetryBudget: 0,
      issuesWithPolicyChanges: 0,
      issuesWithCheckpointFailures: 0,
      issuesWithContractBlockers: 0,
    },
  };
}

function resolveCurrentTraceArtifactPath(issue: IssueEntry, fileName: string): string | undefined {
  if (!issue.workspacePath) return undefined;
  const planVersion = issue.planVersion ?? 1;
  const executeAttempt = issue.executeAttempt ?? 1;
  const absolutePath = join(traceDir(issue.workspacePath, planVersion, executeAttempt), fileName);
  if (!existsSync(absolutePath)) return undefined;
  return `traces/v${planVersion}a${executeAttempt}/${fileName}`;
}

function resolveRailsArtifactPath(issue: IssueEntry): string | undefined {
  return resolveCurrentTraceArtifactPath(issue, "rails.json");
}

function resolveSimilarTracesArtifactPath(issue: IssueEntry): string | undefined {
  return resolveCurrentTraceArtifactPath(issue, "similar-traces.json");
}

export function registerAnalyticsRoutes(app: RouteRegistrar): void {
  app.get("/api/analytics/tokens", async (c) => {
    const [tokenData, ecEvents] = await Promise.all([
      Promise.resolve(getTokenAnalytics()),
      getEcDailyEvents(),
    ]);
    // Merge EC daily event counts into the daily token array
    if (ecEvents.length > 0) {
      const eventsByDate = new Map(ecEvents.map((e) => [e.date, e.events]));
      const dateSet = new Set(tokenData.daily.map((d: { date: string }) => d.date));
      const merged: DailyBucket[] = tokenData.daily.map((d: DailyBucket) => ({
        ...d,
        events: (eventsByDate.get(d.date) || 0) + (d.events || 0),
      }));
      for (const e of ecEvents) {
        if (!dateSet.has(e.date)) {
          merged.push({ date: e.date, inputTokens: 0, outputTokens: 0, totalTokens: 0, events: e.events });
        }
      }
      merged.sort((a, b) => a.date.localeCompare(b.date));
      return c.json({ ok: true, ...tokenData, daily: merged });
    }
    return c.json({ ok: true, ...tokenData });
  });

  app.get("/api/analytics/tokens/weekly", async (c) => {
    // Weekly is part of the daily data in the ledger — filter client-side
    return c.json({ ok: true, ...getTokenAnalytics() });
  });

  app.get("/api/analytics/hourly", async (c) => {
    const hours = Math.min(parseInt(c.req.query("hours") || "24", 10) || 24, 48);
    return c.json({ ok: true, ...getHourlySnapshot(hours) });
  });

  app.get("/api/analytics/lines", async (c) => {
    try {
      const days = Math.min(parseInt(c.req.query("days") || "90", 10) || 90, 180);
      const lines = await getEcDailyLines(days);
      return c.json({ ok: true, lines });
    } catch (error) {
      logger.error({ err: error }, "Failed to collect lines analytics");
      return c.json({ ok: true, lines: [] });
    }
  });

  app.get("/api/analytics/kpis", (c) => {
    try {
      const context = getApiRuntimeContextOrThrow();
      const doneIssues = context.state.issues.filter(
        (i) => (i.state === "Approved" || i.state === "Merged") && i.completedAt,
      );

      const msToDay = (ms: number) => ms / (1000 * 60 * 60 * 24);
      const avg = (arr: number[]) =>
        arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
      const median = (arr: number[]) => {
        if (!arr.length) return null;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      };

      // Code review turnaround: reviewingAt → completedAt
      const reviewMs = doneIssues
        .filter((i) => i.reviewingAt && i.completedAt)
        .map((i) => Date.parse(i.completedAt!) - Date.parse(i.reviewingAt!))
        .filter((ms) => ms > 0);

      // PR cycle time: startedAt → completedAt
      const cycleMs = doneIssues
        .filter((i) => i.startedAt && i.completedAt)
        .map((i) => Date.parse(i.completedAt!) - Date.parse(i.startedAt!))
        .filter((ms) => ms > 0);

      // PR size: linesAdded + linesRemoved (only issues with diff data)
      const prSizes = doneIssues
        .filter((i) => typeof i.linesAdded === "number" || typeof i.linesRemoved === "number")
        .map((i) => (i.linesAdded || 0) + (i.linesRemoved || 0));

      // Issue cycle time: createdAt → completedAt
      const issueCycleMs = doneIssues
        .filter((i) => i.createdAt && i.completedAt)
        .map((i) => Date.parse(i.completedAt!) - Date.parse(i.createdAt))
        .filter((ms) => ms > 0);

      return c.json({
        ok: true,
        sampleSize: doneIssues.length,
        reviewTurnaroundDays: reviewMs.length
          ? { avg: msToDay(avg(reviewMs)!), median: msToDay(median(reviewMs)!), n: reviewMs.length }
          : null,
        prCycleTimeDays: cycleMs.length
          ? { avg: msToDay(avg(cycleMs)!), median: msToDay(median(cycleMs)!), n: cycleMs.length }
          : null,
        prSizeLines: prSizes.length
          ? { avg: avg(prSizes)!, median: median(prSizes)!, n: prSizes.length }
          : null,
        issueCycleTimeDays: issueCycleMs.length
          ? { avg: msToDay(avg(issueCycleMs)!), median: msToDay(median(issueCycleMs)!), n: issueCycleMs.length }
          : null,
        qualityGate: computeQualityGateMetrics(context.state.issues),
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to compute KPI analytics");
      return c.json({ ok: false, error: String(error) }, 500);
    }
  });

  app.get("/api/analytics/stage-quality", (c) => {
    try {
      const context = getApiRuntimeContextOrThrow();
      const from = parseDateBound(c.req.query("from"), Number.NEGATIVE_INFINITY);
      const to = parseDateBound(c.req.query("to"), Number.POSITIVE_INFINITY);
      const issues = context.state.issues.filter((issue) => {
        if (!issue.tokensByPhase) return false;
        const timestamp = issueAnalyticsTimestamp(issue);
        return timestamp >= from && timestamp <= to;
      });

      const buckets = new Map<string, StageBucket>();
      const grouped = new Map<string, Map<string, {
        provider: string;
        model: string;
        totalTokens: number;
        issueCount: number;
        costUsdSum: number;
      }>>();
      const railGroups = new Map<string, {
        harnessModes: Map<string, number>;
        checkpointPolicies: Map<string, number>;
      }>();

      for (const issue of issues) {
        const outcome = issueOutcome(issue);
        for (const [role, usage] of Object.entries(issue.tokensByPhase ?? {})) {
          if (!usage || usage.totalTokens <= 0) continue;
          const bucket = buckets.get(role) ?? createStageBucket(role);
          buckets.set(role, bucket);

          bucket.totalTokens += usage.totalTokens;
          bucket.issueCount += 1;
          if (outcome === "Approved" || outcome === "Merged") {
            bucket.successfulIssues += 1;
          }
          bucket.outcomes[outcome] += 1;
          if (typeof usage.costUsd === "number") {
            bucket.costUsdSum += usage.costUsd;
          }
          bucket.topIssues.push({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            totalTokens: usage.totalTokens,
            costUsd: usage.costUsd,
            outcome,
            harnessMode: issue.plan?.harnessMode ?? "standard",
            checkpointPolicy: issue.plan?.executionContract?.checkpointPolicy ?? "final_only",
            contextResetCount: issue.contextResetCount ?? 0,
            retryBudgetRemaining: Math.max(0, (issue.maxAttempts ?? 0) - (issue.attempts ?? 0)),
            retryBudgetMax: issue.maxAttempts ?? 0,
            policyDecisionCount: issue.policyDecisions?.length ?? 0,
            railsPath: resolveRailsArtifactPath(issue),
            similarTracesPath: resolveSimilarTracesArtifactPath(issue),
          });

          bucket.rails.contextResetCountSum += issue.contextResetCount ?? 0;
          if ((issue.contextResetCount ?? 0) > 0) {
            bucket.rails.issuesWithContextResets += 1;
          }
          if ((issue.policyDecisions?.length ?? 0) > 0) {
            bucket.rails.issuesWithPolicyChanges += 1;
          }
          if ((issue.maxAttempts ?? 0) > 0 && Math.max(0, (issue.maxAttempts ?? 0) - (issue.attempts ?? 0)) <= 1) {
            bucket.rails.issuesNearRetryBudget += 1;
          }
          if (issue.checkpointStatus === "failed") {
            bucket.rails.issuesWithCheckpointFailures += 1;
          }
          if (issue.contractNegotiationStatus && issue.contractNegotiationStatus !== "approved") {
            bucket.rails.issuesWithContractBlockers += 1;
          }

          const stageRails = railGroups.get(role) ?? {
            harnessModes: new Map<string, number>(),
            checkpointPolicies: new Map<string, number>(),
          };
          railGroups.set(role, stageRails);
          const harnessMode = issue.plan?.harnessMode ?? "standard";
          const checkpointPolicy = issue.plan?.executionContract?.checkpointPolicy ?? "final_only";
          stageRails.harnessModes.set(harnessMode, (stageRails.harnessModes.get(harnessMode) ?? 0) + 1);
          stageRails.checkpointPolicies.set(checkpointPolicy, (stageRails.checkpointPolicies.get(checkpointPolicy) ?? 0) + 1);

          const provider = inferProviderFromModel(usage.model);
          const model = usage.model ?? "unknown";
          const roleGroups = grouped.get(role) ?? new Map<string, {
            provider: string;
            model: string;
            totalTokens: number;
            issueCount: number;
            costUsdSum: number;
          }>();
          grouped.set(role, roleGroups);
          const groupKey = `${provider}:${model}`;
          const group = roleGroups.get(groupKey) ?? {
            provider,
            model,
            totalTokens: 0,
            issueCount: 0,
            costUsdSum: 0,
          };
          group.totalTokens += usage.totalTokens;
          group.issueCount += 1;
          group.costUsdSum += usage.costUsd ?? 0;
          roleGroups.set(groupKey, group);
        }
      }

      const roles = [...buckets.values()]
        .map((bucket) => {
          bucket.avgTokensPerIssue = bucket.issueCount > 0 ? bucket.totalTokens / bucket.issueCount : 0;
          bucket.avgCostUsd = bucket.issueCount > 0 ? bucket.costUsdSum / bucket.issueCount : 0;
          bucket.successRate = bucket.issueCount > 0 ? bucket.successfulIssues / bucket.issueCount : 0;
          bucket.rails.avgContextResets = bucket.issueCount > 0 ? bucket.rails.contextResetCountSum / bucket.issueCount : 0;
          bucket.rails.harnessModes = [...(railGroups.get(bucket.role)?.harnessModes.entries() ?? [])]
            .sort((left, right) => right[1] - left[1])
            .map(([name, count]) => ({ name, count }));
          bucket.rails.checkpointPolicies = [...(railGroups.get(bucket.role)?.checkpointPolicies.entries() ?? [])]
            .sort((left, right) => right[1] - left[1])
            .map(([name, count]) => ({ name, count }));
          bucket.topIssues = bucket.topIssues
            .sort((left, right) => right.totalTokens - left.totalTokens)
            .slice(0, 5);
          bucket.byProviderModel = [...(grouped.get(bucket.role)?.values() ?? [])]
            .sort((left, right) => right.totalTokens - left.totalTokens)
            .map((group) => ({
              provider: group.provider,
              model: group.model,
              totalTokens: group.totalTokens,
              avgTokensPerIssue: group.issueCount > 0 ? group.totalTokens / group.issueCount : 0,
              issueCount: group.issueCount,
              costUsdSum: group.costUsdSum,
              avgCostUsd: group.issueCount > 0 ? group.costUsdSum / group.issueCount : 0,
            }));
          return bucket;
        })
        .sort((left, right) => right.totalTokens - left.totalTokens);

      return c.json({
        ok: true,
        from: Number.isFinite(from) ? new Date(from).toISOString() : null,
        to: Number.isFinite(to) ? new Date(to).toISOString() : null,
        issueCount: issues.length,
        roles,
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to compute stage quality analytics");
      return c.json({ ok: false, error: String(error) }, 500);
    }
  });

  app.get("/api/analytics/stage-quality/trace-detail", (c) => {
    try {
      const context = getApiRuntimeContextOrThrow();
      const issueId = (c.req.query("issueId") || "").trim();
      const kind = (c.req.query("kind") || "rails").trim();
      if (!issueId) {
        return c.json({ ok: false, error: "Missing issueId" }, 400);
      }
      if (kind !== "rails" && kind !== "similar") {
        return c.json({ ok: false, error: "Invalid kind" }, 400);
      }

      const issue = context.state.issues.find((entry) => entry.id === issueId);
      if (!issue?.workspacePath) {
        return c.json({ ok: false, error: "Issue workspace not found" }, 404);
      }

      const planVersion = issue.planVersion ?? 1;
      const executeAttempt = issue.executeAttempt ?? 1;
      const fileName = kind === "rails" ? "rails.json" : "similar-traces.json";
      const relativePath = `traces/v${planVersion}a${executeAttempt}/${fileName}`;
      const absolutePath = join(traceDir(issue.workspacePath, planVersion, executeAttempt), fileName);
      if (!existsSync(absolutePath)) {
        return c.json({ ok: false, error: "Artifact not found", path: relativePath }, 404);
      }

      const data = JSON.parse(readFileSync(absolutePath, "utf8"));
      return c.json({
        ok: true,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        kind,
        path: relativePath,
        data,
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to load stage quality trace detail");
      return c.json({ ok: false, error: String(error) }, 500);
    }
  });
}
