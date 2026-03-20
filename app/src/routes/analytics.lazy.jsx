import { createLazyFileRoute } from "@tanstack/react-router";
import { useTokenAnalytics, useCodeChurnAnalytics, useKpiAnalytics } from "../hooks.js";
import { fillDailyGaps } from "../utils.js";
import { Zap, TrendingUp, Layers, Cpu, Clock, Activity, GitMerge, Timer, GitPullRequestArrow } from "lucide-react";
import { useRef, useEffect, useState } from "react";

// ── Format helpers ───────────────────────────────────────────────────────

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

// ── Animated counter ─────────────────────────────────────────────────────

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

// ── Phase breakdown bar ──────────────────────────────────────────────────

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
      <div className="flex items-center gap-3 flex-wrap text-xs">
        {PHASES.map((p) => {
          const tokens = byPhase[p.key]?.totalTokens || 0;
          const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
          if (tokens === 0) return null;
          return (
            <span key={p.key} className="flex items-center gap-1">
              <span className={`inline-block size-2 rounded-full ${p.color} shrink-0`} />
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

// ── Single-metric daily bar chart ────────────────────────────────────────

function DailyBarChart({ data, valueKey, barClass, label, height = 64, showXAxis = false, hoveredIdx, onHover, formatTooltip }) {
  if (!data || data.length === 0) return null;

  const today = new Date().toISOString().slice(0, 10);
  const max = Math.max(...data.map((d) => d[valueKey] || 0), 1);
  const labelEvery = data.length <= 7 ? 1 : data.length <= 14 ? 2 : data.length <= 21 ? 3 : 5;

  const hovered = hoveredIdx != null ? data[hoveredIdx] : null;
  const tooltipAlign = hoveredIdx == null ? "center"
    : hoveredIdx < data.length / 3 ? "left"
    : hoveredIdx > (data.length * 2) / 3 ? "right"
    : "center";

  return (
    <div className="relative">
      {/* Label */}
      <div className="flex items-center gap-1.5 text-xs opacity-50 mb-2">
        <span className={`inline-block w-2.5 h-2.5 rounded-sm ${barClass}`} />
        {label}
      </div>

      {/* Tooltip */}
      {hovered && (
        <div
          className="absolute top-5 z-10 pointer-events-none"
          style={{
            left: tooltipAlign !== "right" ? `${((hoveredIdx + 0.5) / data.length) * 100}%` : undefined,
            right: tooltipAlign === "right" ? `${((data.length - 1 - hoveredIdx) / data.length) * 100}%` : undefined,
            transform: tooltipAlign === "center" ? "translateX(-50%) translateY(-100%)"
              : tooltipAlign === "left" ? "translateY(-100%)"
              : "translateY(-100%)",
          }}
        >
          <div className="bg-base-300 border border-base-content/10 rounded-lg px-2.5 py-1.5 shadow-lg text-left whitespace-nowrap">
            <div className="text-[10px] font-semibold opacity-60 mb-0.5">
              {hovered.date === today ? "Today" : new Date(hovered.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </div>
            <span className="flex items-center gap-1.5 text-xs">
              <span className={`inline-block w-2 h-2 rounded-sm ${barClass} shrink-0`} />
              <span className="font-mono font-semibold">{formatTooltip ? formatTooltip(hovered[valueKey] || 0) : (hovered[valueKey] || 0).toLocaleString()}</span>
            </span>
          </div>
        </div>
      )}

      {/* Bars */}
      <div className="flex gap-px" style={{ height }}>
        {data.map((d, i) => {
          const val = d[valueKey] || 0;
          const barH = val > 0 ? Math.max(3, Math.round((val / max) * height)) : 0;
          const isToday = d.date === today;
          const isHovered = hoveredIdx === i;
          return (
            <div
              key={d.date}
              className="flex-1 relative cursor-default"
              onMouseEnter={() => onHover?.(i)}
              onMouseLeave={() => onHover?.(null)}
            >
              {barH > 0 && (
                <div
                  className={`absolute bottom-0 left-0 right-0 rounded-t-[2px] ${barClass} transition-opacity duration-100 ${
                    isHovered ? "opacity-80" : isToday ? "opacity-90" : "opacity-35"
                  }`}
                  style={{ height: barH }}
                />
              )}
              {isHovered && <div className="absolute inset-0 bg-base-content/5 rounded-sm" />}
            </div>
          );
        })}
      </div>

      {/* X-axis labels (only on bottom chart) */}
      {showXAxis && (
        <div className="flex gap-px mt-1.5">
          {data.map((d, i) => {
            const isToday = d.date === today;
            const isHovered = hoveredIdx === i;
            const showLabel = isToday || i === 0 || i % labelEvery === 0;
            const shortLabel = d.date
              ? new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { month: "numeric", day: "numeric" })
              : "";
            return (
              <div key={d.date} className="flex-1 overflow-hidden">
                {showLabel && (
                  <span className={`block text-center text-[9px] truncate transition-opacity duration-100 ${
                    isHovered ? "opacity-80" : isToday ? "opacity-60 font-semibold" : "opacity-30"
                  }`}>
                    {isToday ? "today" : shortLabel}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActivityChart({ daily }) {
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const data = daily || [];

  return (
    <div className="space-y-4">
      <DailyBarChart
        data={data}
        valueKey="totalTokens"
        barClass="bg-primary"
        label="Tokens / day"
        height={64}
        showXAxis={false}
        hoveredIdx={hoveredIdx}
        onHover={setHoveredIdx}
        formatTooltip={(v) => v.toLocaleString()}
      />
      <DailyBarChart
        data={data}
        valueKey="events"
        barClass="bg-secondary"
        label="Events / day"
        height={36}
        showXAxis
        hoveredIdx={hoveredIdx}
        onHover={setHoveredIdx}
      />
    </div>
  );
}

// ── Model breakdown ──────────────────────────────────────────────────────

function ModelBreakdown({ byModel }) {
  if (!byModel) return null;

  const entries = Object.entries(byModel)
    .map(([model, data]) => ({
      model,
      inputTokens: data?.inputTokens || 0,
      outputTokens: data?.outputTokens || 0,
      totalTokens: data?.totalTokens || 0,
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Top issues table ─────────────────────────────────────────────────────

function TopIssuesTable({ topIssues }) {
  if (!topIssues || topIssues.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th className="w-20">Issue</th>
            <th>Title</th>
            <th className="text-right">Tokens</th>
            <th className="hidden sm:table-cell">Phase Split</th>
          </tr>
        </thead>
        <tbody>
          {topIssues.slice(0, 10).map((issue) => {
            const byPhase = issue.byPhase;
            const total = issue.totalTokens || 0;

            return (
              <tr key={issue.id || issue.identifier}>
                <td className="font-mono text-xs font-semibold text-primary">{issue.identifier}</td>
                <td className="max-w-[200px] truncate text-sm" title={issue.title}>{issue.title || "-"}</td>
                <td className="text-right font-mono text-xs font-semibold">{formatTokens(total)}</td>
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

// ── Code Churn Chart ─────────────────────────────────────────────────────

function CodeChurnChart({ daily }) {
  const daily_ = daily || [];

  const [hoveredIdx, setHoveredIdx] = useState(null);
  const today = new Date().toISOString().slice(0, 10);

  const maxAdded = Math.max(...daily_.map((d) => d.linesAdded || 0), 1);
  const maxRemoved = Math.max(...daily_.map((d) => d.linesRemoved || 0), 1);

  const ADD_H = 64;
  const DEL_H = 24;

  const labelEvery = daily_.length <= 7 ? 1 : daily_.length <= 14 ? 2 : daily_.length <= 21 ? 3 : 5;
  const hovered = hoveredIdx != null ? daily_[hoveredIdx] : null;
  const tooltipAlign = hoveredIdx == null ? "center"
    : hoveredIdx < daily_.length / 3 ? "left"
    : hoveredIdx > (daily_.length * 2) / 3 ? "right"
    : "center";

  return (
    <div>
      <div className="flex items-center gap-5 mb-3">
        <span className="flex items-center gap-1.5 text-xs opacity-50">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-success" />
          Lines added / day
        </span>
        <span className="flex items-center gap-1.5 text-xs opacity-50">
          <span className="inline-block w-2.5 h-2.5 rounded-sm bg-error" />
          Lines removed / day
        </span>
      </div>

      <div className="relative">
        {hovered && (
          <div
            className="absolute -top-1 z-10 pointer-events-none"
            style={{
              left: tooltipAlign !== "right" ? `${((hoveredIdx + 0.5) / daily_.length) * 100}%` : undefined,
              right: tooltipAlign === "right" ? `${((daily_.length - 1 - hoveredIdx) / daily_.length) * 100}%` : undefined,
              transform: tooltipAlign === "center" ? "translateX(-50%) translateY(-100%)"
                : tooltipAlign === "left" ? "translateY(-100%)"
                : "translateY(-100%)",
            }}
          >
            <div className="bg-base-300 border border-base-content/10 rounded-lg px-2.5 py-1.5 shadow-lg text-left whitespace-nowrap">
              <div className="text-[10px] font-semibold opacity-60 mb-1">
                {hovered.date === today ? "Today" : new Date(hovered.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-xs">
                  <span className="inline-block w-2 h-2 rounded-sm bg-success shrink-0" />
                  <span className="font-mono font-semibold">+{(hovered.linesAdded || 0).toLocaleString()}</span>
                  <span className="opacity-50">added</span>
                </span>
                <span className="flex items-center gap-1.5 text-xs">
                  <span className="inline-block w-2 h-2 rounded-sm bg-error shrink-0" />
                  <span className="font-mono font-semibold">-{(hovered.linesRemoved || 0).toLocaleString()}</span>
                  <span className="opacity-50">removed</span>
                </span>
                {(hovered.filesChanged || 0) > 0 && (
                  <span className="flex items-center gap-1.5 text-xs">
                    <span className="opacity-50">{hovered.filesChanged} file{hovered.filesChanged !== 1 ? "s" : ""}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex gap-px">
          {daily_.map((d, i) => {
            const addVal = d.linesAdded || 0;
            const delVal = d.linesRemoved || 0;
            const addH = addVal > 0 ? Math.max(3, Math.round((addVal / maxAdded) * ADD_H)) : 0;
            const delH = delVal > 0 ? Math.max(3, Math.round((delVal / maxRemoved) * DEL_H)) : 0;
            const isToday = d.date === today;
            const isHovered = hoveredIdx === i;

            return (
              <div
                key={d.date}
                className="flex-1 flex flex-col cursor-default"
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                <div className="relative" style={{ height: ADD_H }}>
                  {addH > 0 && (
                    <div
                      className={`absolute bottom-0 left-0 right-0 rounded-t-[2px] bg-success transition-opacity duration-100 ${
                        isHovered ? "opacity-80" : isToday ? "opacity-90" : "opacity-35"
                      }`}
                      style={{ height: addH }}
                    />
                  )}
                  {isHovered && <div className="absolute inset-0 bg-base-content/5 rounded-sm" />}
                </div>

                <div className={`h-px transition-colors duration-100 ${isHovered ? "bg-base-content/20" : "bg-base-300"}`} />

                <div className="relative" style={{ height: DEL_H }}>
                  {delH > 0 && (
                    <div
                      className={`absolute bottom-0 left-0 right-0 rounded-t-[2px] bg-error transition-opacity duration-100 ${
                        isHovered ? "opacity-80" : isToday ? "opacity-90" : "opacity-35"
                      }`}
                      style={{ height: delH }}
                    />
                  )}
                  {isHovered && <div className="absolute inset-0 bg-base-content/5 rounded-sm" />}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex gap-px mt-1.5">
          {daily_.map((d, i) => {
            const isToday = d.date === today;
            const isHovered = hoveredIdx === i;
            const showLabel = isToday || i === 0 || i % labelEvery === 0;
            const shortLabel = d.date
              ? new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { month: "numeric", day: "numeric" })
              : "";
            return (
              <div key={d.date} className="flex-1 overflow-hidden">
                {showLabel && (
                  <span className={`block text-center text-[9px] truncate transition-opacity duration-100 ${
                    isHovered ? "opacity-80" : isToday ? "opacity-60 font-semibold" : "opacity-30"
                  }`}>
                    {isToday ? "today" : shortLabel}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────────

// ── KPI helpers ──────────────────────────────────────────────────────────

function fmtDays(n) {
  if (n == null || !Number.isFinite(n)) return "–";
  if (n < 1 / 24) return `${Math.round(n * 24 * 60)}m`;
  if (n < 1) return `${(n * 24).toFixed(1)}h`;
  return `${n.toFixed(1)}d`;
}

function fmtLines(n) {
  if (n == null || !Number.isFinite(n)) return "–";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return Math.round(n).toString();
}

function KpiCard({ icon: Icon, iconClass, title, avg, median, n, formatValue, unit }) {
  return (
    <div className="stat bg-base-200 rounded-box">
      <div className={`stat-figure ${iconClass}`}>
        <Icon className="size-6" />
      </div>
      <div className="stat-title">{title}</div>
      <div className={`stat-value text-2xl ${iconClass}`}>
        {formatValue(avg)}
        {unit && <span className="text-base font-normal opacity-50 ml-1">{unit}</span>}
      </div>
      <div className="stat-desc">
        {median != null ? `median ${formatValue(median)}` : "–"}
        {n != null && <span className="opacity-40"> · n={n}</span>}
      </div>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 pb-4 pt-3">
      <div className="max-w-6xl w-full mx-auto space-y-6">
        <div className="skeleton-line h-8 w-48" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
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

// ── Empty state ──────────────────────────────────────────────────────────

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

// ── Page component ───────────────────────────────────────────────────────

export const Route = createLazyFileRoute("/analytics")({
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const { data: analytics, isLoading: analyticsLoading } = useTokenAnalytics();
  const { data: linesData } = useCodeChurnAnalytics();
  const { data: kpiData } = useKpiAnalytics();

  if (analyticsLoading && !analytics) return <AnalyticsSkeleton />;

  const overall = analytics?.overall;
  const totalTokens = overall?.totalTokens || 0;
  const byPhase = analytics?.byPhase || null;
  const byModel = analytics?.byModel || {};
  const daily = fillDailyGaps(analytics?.daily, 32);
  const topIssues = analytics?.topIssues || [];

  // Today vs this week
  const today = new Date().toISOString().slice(0, 10);
  const todayEntry = daily.find((d) => d.date === today);
  const tokensToday = todayEntry?.totalTokens || 0;
  const tokensThisWeek = daily.reduce((sum, d) => sum + (d.totalTokens || 0), 0);

  // Events aggregates (from EC-backed daily.events)
  const totalEvents = daily.reduce((sum, d) => sum + (d.events || 0), 0);
  const eventsToday = todayEntry?.events || 0;

  // Code churn — fill daily gaps manually since fillDailyGaps uses token defaults
  const linesDaily = (() => {
    const byDate = new Map((linesData?.lines || []).filter((d) => d.date).map((d) => [d.date, d]));
    const result = [];
    for (let i = 31; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      result.push(byDate.get(date) ?? { date, linesAdded: 0, linesRemoved: 0, filesChanged: 0 });
    }
    return result;
  })();
  const totalLinesAdded = linesDaily.reduce((s, d) => s + (d.linesAdded || 0), 0);
  const totalLinesRemoved = linesDaily.reduce((s, d) => s + (d.linesRemoved || 0), 0);

  const kpis = kpiData?.ok ? kpiData : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 pb-4 pt-3 overflow-y-auto">
      <div className="max-w-6xl w-full mx-auto space-y-6 stagger-children">

        {/* Section 1: Overview stats */}
        <section>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-7 gap-4">
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

            {/* Tokens today */}
            <div className="stat bg-base-200 rounded-box">
              <div className="stat-figure text-accent">
                <Clock className="size-6" />
              </div>
              <div className="stat-title">Tokens Today</div>
              <div className="stat-value text-2xl">
                <AnimatedCount value={tokensToday} />
              </div>
              <div className="stat-desc">
                30d: {formatTokens(tokensThisWeek)}
              </div>
            </div>

            {/* Total events */}
            <div className="stat bg-base-200 rounded-box">
              <div className="stat-figure text-secondary">
                <Activity className="size-6" />
              </div>
              <div className="stat-title">Total Events</div>
              <div className="stat-value text-2xl">
                <AnimatedCount value={totalEvents} format={(n) => String(n || 0)} />
              </div>
              <div className="stat-desc">Today: {eventsToday}</div>
            </div>

            {/* Phase breakdown summary */}
            <div className="stat bg-base-200 rounded-box xl:col-span-2 overflow-hidden">
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

            {/* Lines added */}
            <div className="stat bg-base-200 rounded-box">
              <div className="stat-figure text-success">
                <GitMerge className="size-6" />
              </div>
              <div className="stat-title">Lines Added</div>
              <div className="stat-value text-2xl text-success">
                <AnimatedCount value={totalLinesAdded} format={(n) => n >= 1000 ? `${(n/1000).toFixed(1)}K` : String(n || 0)} />
              </div>
              <div className="stat-desc">30d total</div>
            </div>

            {/* Lines removed */}
            <div className="stat bg-base-200 rounded-box">
              <div className="stat-figure text-error">
                <GitMerge className="size-6" />
              </div>
              <div className="stat-title">Lines Removed</div>
              <div className="stat-value text-2xl text-error">
                <AnimatedCount value={totalLinesRemoved} format={(n) => n >= 1000 ? `${(n/1000).toFixed(1)}K` : String(n || 0)} />
              </div>
              <div className="stat-desc">30d total</div>
            </div>
          </div>
        </section>

        {/* Section 2: Daily Activity Chart */}
        <section className="bg-base-200 rounded-box p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <TrendingUp className="size-4 text-primary" />
              Daily Activity
            </h2>
          </div>
          <ActivityChart daily={daily} />
          <div className="border-t border-base-300 my-5" />
          <CodeChurnChart daily={linesDaily} />
        </section>

        {/* Section 4: Engineering KPIs */}
        <section className="bg-base-200 rounded-box p-5">
          <h2 className="text-sm font-semibold flex items-center gap-2 mb-4">
            <Timer className="size-4 text-warning" />
            Engineering KPIs
            {kpis?.sampleSize > 0 && (
              <span className="text-xs font-normal opacity-40 ml-1">based on {kpis.sampleSize} completed issue{kpis.sampleSize !== 1 ? "s" : ""}</span>
            )}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <KpiCard
              icon={Clock}
              iconClass="text-primary"
              title="Issue Cycle Time"
              avg={kpis?.issueCycleTimeDays?.avg ?? null}
              median={kpis?.issueCycleTimeDays?.median ?? null}
              n={kpis?.issueCycleTimeDays?.n ?? null}
              formatValue={fmtDays}
            />
            <KpiCard
              icon={GitPullRequestArrow}
              iconClass="text-secondary"
              title="PR Cycle Time"
              avg={kpis?.prCycleTimeDays?.avg ?? null}
              median={kpis?.prCycleTimeDays?.median ?? null}
              n={kpis?.prCycleTimeDays?.n ?? null}
              formatValue={fmtDays}
            />
            <KpiCard
              icon={Timer}
              iconClass="text-warning"
              title="Review Turnaround"
              avg={kpis?.reviewTurnaroundDays?.avg ?? null}
              median={kpis?.reviewTurnaroundDays?.median ?? null}
              n={kpis?.reviewTurnaroundDays?.n ?? null}
              formatValue={fmtDays}
            />
            <KpiCard
              icon={GitMerge}
              iconClass="text-info"
              title="PR Size"
              avg={kpis?.prSizeLines?.avg ?? null}
              median={kpis?.prSizeLines?.median ?? null}
              n={kpis?.prSizeLines?.n ?? null}
              formatValue={fmtLines}
              unit="lines"
            />
          </div>
        </section>

        {/* Section 6: Top Issues */}
        {topIssues.length > 0 && (
          <section className="bg-base-200 rounded-box p-5">
            <h2 className="text-sm font-semibold flex items-center gap-2 mb-4">
              <Zap className="size-4 text-accent" />
              Top Issues by Token Usage
            </h2>
            <TopIssuesTable topIssues={topIssues} />
          </section>
        )}

        {/* Section 7: Model Breakdown */}
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
