import { createFileRoute } from "@tanstack/react-router";
import { useTokenAnalytics, useHourlyAnalytics } from "../hooks.js";
import { Zap, TrendingUp, Layers, Activity, Cpu, Clock, DollarSign } from "lucide-react";
import { useRef, useEffect, useState } from "react";

// ── Cost estimation ──────────────────────────────────────────────────────────

const MODEL_PRICING = {
  "claude-opus-4-6": { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  "claude-sonnet-4-6": { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  "claude-haiku-4-5": { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  "codex": { input: 2.5 / 1_000_000, output: 10 / 1_000_000 },
};

function estimateCost(inputTokens, outputTokens, model) {
  // Try exact match first, then partial match
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    const key = Object.keys(MODEL_PRICING).find((k) => model?.includes(k) || k.includes(model));
    pricing = key ? MODEL_PRICING[key] : { input: 3 / 1_000_000, output: 15 / 1_000_000 };
  }
  return (inputTokens || 0) * pricing.input + (outputTokens || 0) * pricing.output;
}

function estimateTotalCost(byModel) {
  if (!byModel) return 0;
  return Object.entries(byModel).reduce((sum, [model, data]) => {
    return sum + estimateCost(data?.inputTokens || 0, data?.outputTokens || 0, model);
  }, 0);
}

function formatCost(usd) {
  if (!usd || usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// ── Format helpers ───────────────────────────────────────────────────────────

function formatTokens(n) {
  if (!n || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTokensFull(n) {
  if (!n || n === 0) return "0";
  return n.toLocaleString();
}

// ── Animated counter ─────────────────────────────────────────────────────────

function AnimatedCount({ value, format = formatTokens, className = "" }) {
  const [display, setDisplay] = useState(() => format(value));
  const prevRef = useRef(value);
  const rafRef = useRef(null);

  useEffect(() => {
    const from = prevRef.current || 0;
    const to = value || 0;
    prevRef.current = to;

    if (from === to) {
      setDisplay(format(to));
      return;
    }

    const duration = 600;
    const start = performance.now();

    const tick = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = from + (to - from) * eased;
      setDisplay(format(Math.round(current)));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafRef.current);
  }, [value, format]);

  return (
    <span className={`${className} inline-block tabular-nums`}>
      {display}
    </span>
  );
}

// ── Phase breakdown bar ──────────────────────────────────────────────────────

const PHASES = [
  { key: "planner", label: "Plan", color: "bg-info", textColor: "text-info" },
  { key: "executor", label: "Execute", color: "bg-primary", textColor: "text-primary" },
  { key: "reviewer", label: "Review", color: "bg-secondary", textColor: "text-secondary" },
];

function PhaseBreakdownLarge({ byPhase }) {
  if (!byPhase) return null;

  const total = PHASES.reduce((sum, p) => sum + (byPhase[p.key]?.totalTokens || 0), 0);
  if (total === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-4 rounded-full overflow-hidden bg-base-300 w-full">
        {PHASES.map((p) => {
          const tokens = byPhase[p.key]?.totalTokens || 0;
          const pct = (tokens / total) * 100;
          if (pct === 0) return null;
          return (
            <div
              key={p.key}
              className={`${p.color} opacity-80 transition-all duration-500`}
              style={{ width: `${pct}%` }}
              title={`${p.label}: ${formatTokensFull(tokens)} (${Math.round(pct)}%)`}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-4 flex-wrap">
        {PHASES.map((p) => {
          const tokens = byPhase[p.key]?.totalTokens || 0;
          const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
          if (tokens === 0) return null;
          return (
            <span key={p.key} className="flex items-center gap-1.5 text-sm">
              <span className={`inline-block w-3 h-3 rounded-full ${p.color} shrink-0`} />
              <span className="opacity-60">{p.label}</span>
              <span className="font-mono font-semibold">{formatTokens(tokens)}</span>
              <span className="opacity-40">({pct}%)</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Daily bar chart (large) ──────────────────────────────────────────────────

function DailyBarChart({ data, height = 160, byModel }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.totalTokens || 0), 1);

  return (
    <div className="flex items-end gap-2 w-full" style={{ height }}>
      {data.map((d, i) => {
        const tokens = d.totalTokens || 0;
        const h = Math.max(2, Math.round((tokens / max) * height));
        const dayLabel = d.date
          ? new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
          : `Day ${i + 1}`;
        const shortDay = d.date
          ? new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" })
          : `${i + 1}`;

        return (
          <div key={d.date || i} className="flex-1 flex flex-col items-center gap-1.5 group">
            <span className="text-[10px] font-mono opacity-0 group-hover:opacity-70 transition-opacity">
              {formatTokens(tokens)}
            </span>
            <div
              className="w-full bg-primary rounded-t-md opacity-70 hover:opacity-100 transition-all duration-300 cursor-default"
              style={{ height: h }}
              title={`${dayLabel}: ${formatTokensFull(tokens)} tokens`}
            />
            <span className="text-[10px] opacity-50">{shortDay}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Hourly sparkline (large) ─────────────────────────────────────────────────

function LargeSparkline({ data, valueKey = "totalTokens", height = 60, color = "stroke-primary", label }) {
  if (!data || data.length === 0) return null;
  const values = data.map((d) => d[valueKey] || d.count || 0);
  const max = Math.max(...values, 1);
  const w = 200;
  const points = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * w;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(" ");

  const total = values.reduce((a, b) => a + b, 0);
  const avg = values.length > 0 ? Math.round(total / values.length) : 0;
  const peak = Math.max(...values);

  return (
    <div className="flex flex-col gap-2 flex-1 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium opacity-60">{label}</span>
        <span className="flex items-center gap-3 text-[10px] opacity-50">
          <span>avg: <span className="font-mono">{formatTokens(avg)}/h</span></span>
          <span>peak: <span className="font-mono">{formatTokens(peak)}/h</span></span>
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none">
        <polyline
          points={`0,${height} ${points} ${w},${height}`}
          fill="currentColor"
          className={color.replace("stroke-", "text-")}
          opacity="0.08"
        />
        <polyline
          points={points}
          fill="none"
          className={color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

// ── Model breakdown ──────────────────────────────────────────────────────────

function ModelBreakdown({ byModel }) {
  if (!byModel) return null;

  const entries = Object.entries(byModel)
    .map(([model, data]) => ({
      model,
      inputTokens: data?.inputTokens || 0,
      outputTokens: data?.outputTokens || 0,
      totalTokens: data?.totalTokens || 0,
      cost: estimateCost(data?.inputTokens || 0, data?.outputTokens || 0, model),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  if (entries.length === 0) return null;

  const grandTotal = entries.reduce((sum, e) => sum + e.totalTokens, 0);

  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th>Model</th>
            <th className="text-right">Input</th>
            <th className="text-right">Output</th>
            <th className="text-right">Total</th>
            <th className="text-right">Share</th>
            <th className="text-right">Est. Cost</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const pct = grandTotal > 0 ? Math.round((e.totalTokens / grandTotal) * 100) : 0;
            const colorClass = e.model.includes("claude") ? "bg-primary" : e.model.includes("codex") ? "bg-secondary" : "bg-accent";
            return (
              <tr key={e.model}>
                <td className="flex items-center gap-2">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${colorClass} shrink-0`} />
                  <span className="font-mono text-xs">{e.model}</span>
                </td>
                <td className="text-right font-mono text-xs">{formatTokens(e.inputTokens)}</td>
                <td className="text-right font-mono text-xs">{formatTokens(e.outputTokens)}</td>
                <td className="text-right font-mono text-xs font-semibold">{formatTokens(e.totalTokens)}</td>
                <td className="text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <div className="w-12 h-1.5 bg-base-300 rounded-full overflow-hidden">
                      <div className={`h-full ${colorClass} rounded-full`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs opacity-60 w-8 text-right">{pct}%</span>
                  </div>
                </td>
                <td className="text-right font-mono text-xs">{formatCost(e.cost)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Top issues table ─────────────────────────────────────────────────────────

function TopIssuesTable({ topIssues, byModel }) {
  if (!topIssues || topIssues.length === 0) return null;

  // Use a default pricing estimate if we don't have per-issue model info
  const defaultPricing = { input: 3 / 1_000_000, output: 15 / 1_000_000 };

  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th className="w-20">Issue</th>
            <th>Title</th>
            <th className="text-right">Tokens</th>
            <th className="text-right">Est. Cost</th>
            <th className="hidden sm:table-cell">Phase Split</th>
          </tr>
        </thead>
        <tbody>
          {topIssues.slice(0, 10).map((issue) => {
            const inputTokens = issue.inputTokens || Math.round((issue.totalTokens || 0) * 0.6);
            const outputTokens = issue.outputTokens || (issue.totalTokens || 0) - inputTokens;
            const cost = inputTokens * defaultPricing.input + outputTokens * defaultPricing.output;
            const byPhase = issue.byPhase;
            const total = issue.totalTokens || 0;

            return (
              <tr key={issue.id || issue.identifier}>
                <td className="font-mono text-xs font-semibold text-primary">{issue.identifier}</td>
                <td className="max-w-[200px] truncate text-sm" title={issue.title}>{issue.title || "-"}</td>
                <td className="text-right font-mono text-xs font-semibold">{formatTokens(total)}</td>
                <td className="text-right font-mono text-xs opacity-70">{formatCost(cost)}</td>
                <td className="hidden sm:table-cell">
                  {byPhase ? (
                    <div className="flex h-1.5 rounded-full overflow-hidden bg-base-300 w-24">
                      {PHASES.map((p) => {
                        const tokens = byPhase[p.key]?.totalTokens || 0;
                        const pct = total > 0 ? (tokens / total) * 100 : 0;
                        if (pct === 0) return null;
                        return (
                          <div
                            key={p.key}
                            className={`${p.color} opacity-80`}
                            style={{ width: `${pct}%` }}
                            title={`${p.label}: ${formatTokens(tokens)}`}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <span className="opacity-30 text-xs">-</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

function AnalyticsSkeleton() {
  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 pb-4 pt-3">
      <div className="max-w-6xl w-full mx-auto space-y-6">
        <div className="skeleton-line h-8 w-48" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="skeleton-card h-28" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
        <div className="skeleton-card h-52" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="skeleton-card h-32" />
          <div className="skeleton-card h-32" />
        </div>
        <div className="skeleton-card h-64" />
      </div>
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyAnalytics() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 pb-20 animate-fade-in">
      <TrendingUp className="size-16 opacity-15" />
      <h2 className="text-lg font-semibold opacity-60">No analytics data yet</h2>
      <p className="text-sm opacity-40 text-center max-w-md">
        Token usage and pipeline metrics will appear here once issues start processing.
      </p>
    </div>
  );
}

// ── Page component ───────────────────────────────────────────────────────────

export const Route = createFileRoute("/analytics")({
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const { data: analytics, isLoading: analyticsLoading } = useTokenAnalytics();
  const { data: hourlyData, isLoading: hourlyLoading } = useHourlyAnalytics(24);

  if (analyticsLoading && !analytics) return <AnalyticsSkeleton />;

  const overall = analytics?.overall;
  const totalTokens = overall?.totalTokens || 0;
  const byPhase = analytics?.byPhase || null;
  const byModel = analytics?.byModel || {};
  const daily = analytics?.daily || [];
  const topIssues = analytics?.topIssues || [];

  const tokensPerHour = hourlyData?.tokensPerHour || [];
  const eventsPerHour = hourlyData?.eventsPerHour || [];

  const totalCost = estimateTotalCost(byModel);

  // Today vs this week
  const today = new Date().toISOString().slice(0, 10);
  const todayEntry = daily.find((d) => d.date === today);
  const tokensToday = todayEntry?.totalTokens || 0;
  const tokensThisWeek = daily.reduce((sum, d) => sum + (d.totalTokens || 0), 0);

  if (totalTokens === 0 && daily.length === 0 && topIssues.length === 0) {
    return <EmptyAnalytics />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 pb-4 pt-3 overflow-y-auto">
      <div className="max-w-6xl w-full mx-auto space-y-6 stagger-children">

        {/* Section 1: Token Overview */}
        <section>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total tokens */}
            <div className="stat bg-base-200 rounded-box">
              <div className="stat-figure text-primary">
                <Zap className="size-6" />
              </div>
              <div className="stat-title">Total Tokens</div>
              <div className="stat-value text-2xl">
                <AnimatedCount value={totalTokens} />
              </div>
              <div className="stat-desc font-mono">{formatTokensFull(totalTokens)}</div>
            </div>

            {/* Estimated cost */}
            <div className="stat bg-base-200 rounded-box">
              <div className="stat-figure text-secondary">
                <DollarSign className="size-6" />
              </div>
              <div className="stat-title">Estimated Cost</div>
              <div className="stat-value text-2xl">
                <AnimatedCount value={Math.round(totalCost * 100)} format={(v) => formatCost(v / 100)} />
              </div>
              <div className="stat-desc">Based on model pricing</div>
            </div>

            {/* Today */}
            <div className="stat bg-base-200 rounded-box">
              <div className="stat-figure text-accent">
                <Clock className="size-6" />
              </div>
              <div className="stat-title">Today</div>
              <div className="stat-value text-2xl">
                <AnimatedCount value={tokensToday} />
              </div>
              <div className="stat-desc">
                This week: {formatTokens(tokensThisWeek)}
              </div>
            </div>

            {/* Phase breakdown summary */}
            <div className="stat bg-base-200 rounded-box">
              <div className="stat-figure text-info">
                <Layers className="size-6" />
              </div>
              <div className="stat-title">Phase Split</div>
              <div className="stat-value text-2xl p-0">
                {byPhase ? (
                  <PhaseBreakdownLarge byPhase={byPhase} />
                ) : (
                  <span className="opacity-30">-</span>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Section 2: Daily Token Chart */}
        {daily.length > 0 && (
          <section className="bg-base-200 rounded-box p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="size-4 text-primary" />
                Daily Token Usage
              </h2>
              <span className="text-xs opacity-40">Last {daily.length} days</span>
            </div>
            <DailyBarChart data={daily} height={160} byModel={byModel} />
          </section>
        )}

        {/* Section 3: Hourly Activity */}
        {(tokensPerHour.length > 0 || eventsPerHour.length > 0) && (
          <section className="bg-base-200 rounded-box p-5">
            <h2 className="text-sm font-semibold flex items-center gap-2 mb-4">
              <Activity className="size-4 text-secondary" />
              Hourly Activity (last 24h)
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {tokensPerHour.length > 0 && (
                <LargeSparkline
                  data={tokensPerHour}
                  valueKey="totalTokens"
                  height={60}
                  color="stroke-primary"
                  label="Tokens / hour"
                />
              )}
              {eventsPerHour.length > 0 && (
                <LargeSparkline
                  data={eventsPerHour}
                  valueKey="count"
                  height={60}
                  color="stroke-secondary"
                  label="Events / hour"
                />
              )}
            </div>
          </section>
        )}

        {/* Section 4: Top Issues */}
        {topIssues.length > 0 && (
          <section className="bg-base-200 rounded-box p-5">
            <h2 className="text-sm font-semibold flex items-center gap-2 mb-4">
              <Zap className="size-4 text-accent" />
              Top Issues by Token Usage
            </h2>
            <TopIssuesTable topIssues={topIssues} byModel={byModel} />
          </section>
        )}

        {/* Section 5: Model Breakdown */}
        {Object.keys(byModel).length > 0 && (
          <section className="bg-base-200 rounded-box p-5">
            <h2 className="text-sm font-semibold flex items-center gap-2 mb-4">
              <Cpu className="size-4 text-info" />
              Model Breakdown
            </h2>
            <ModelBreakdown byModel={byModel} />
          </section>
        )}

      </div>
    </div>
  );
}
