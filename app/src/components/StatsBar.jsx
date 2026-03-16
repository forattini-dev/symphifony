import React, { useRef, useEffect, useState, useMemo } from "react";
import { Zap, TrendingUp, Coins } from "lucide-react";

function AnimatedCount({ value, className = "" }) {
  const [display, setDisplay] = useState(value);
  const [bumping, setBumping] = useState(false);
  const prevRef = useRef(value);

  useEffect(() => {
    if (prevRef.current !== value) {
      prevRef.current = value;
      setBumping(true);
      setDisplay(value);
      const t = setTimeout(() => setBumping(false), 300);
      return () => clearTimeout(t);
    }
  }, [value]);

  return (
    <span className={`${className} inline-block ${bumping ? "animate-count-bump" : ""}`}>
      {display}
    </span>
  );
}

function formatTokens(n) {
  if (!n || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n) {
  if (!n || n === 0) return "-";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

// Tiny inline sparkline bar chart (no dependency)
function MiniBarChart({ data, height = 32, className = "" }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.total), 1);
  const barWidth = Math.max(2, Math.floor(100 / data.length));

  return (
    <div className={`flex items-end gap-px ${className}`} style={{ height }}>
      {data.map((d, i) => {
        const h = Math.max(1, Math.round((d.total / max) * height));
        return (
          <div
            key={i}
            className="flex flex-col justify-end gap-px rounded-t-sm"
            style={{ width: `${barWidth}%`, height: "100%" }}
            title={`${d.label}: ${formatTokens(d.total)}`}
          >
            {Object.entries(d.byModel).map(([model, tokens]) => {
              const modelH = Math.max(1, Math.round((tokens / max) * height));
              const color = model.includes("claude") ? "bg-primary" : model.includes("gpt") || model.includes("codex") ? "bg-secondary" : "bg-accent";
              return (
                <div key={model} className={`${color} rounded-t-sm w-full opacity-80`} style={{ height: modelH }} />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// Build daily token data from issues
function buildDailyTokens(issues, days = 7) {
  const now = new Date();
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets.push({ key, label: d.toLocaleDateString(undefined, { weekday: "short" }), total: 0, byModel: {} });
  }

  const bucketMap = Object.fromEntries(buckets.map((b) => [b.key, b]));

  for (const issue of issues) {
    if (!issue.usage?.tokens) continue;
    // Attribute tokens to completion date or updated date
    const dateStr = (issue.completedAt || issue.updatedAt || "").slice(0, 10);
    const bucket = bucketMap[dateStr];
    if (!bucket) continue;

    for (const [model, tokens] of Object.entries(issue.usage.tokens)) {
      bucket.byModel[model] = (bucket.byModel[model] || 0) + tokens;
      bucket.total += tokens;
    }
  }

  return buckets;
}

export function StatsBar({ metrics, total, issues = [], compact = false }) {
  // Aggregate token usage across all issues
  const { totalTokens, totalCost, byModel, dailyData } = useMemo(() => {
    let totalTokens = 0;
    let totalCost = 0;
    const byModel = {};

    for (const issue of issues) {
      if (issue.tokenUsage) {
        totalTokens += issue.tokenUsage.totalTokens || 0;
        totalCost += issue.tokenUsage.costUsd || 0;
      }
      if (issue.usage?.tokens) {
        for (const [model, tokens] of Object.entries(issue.usage.tokens)) {
          byModel[model] = (byModel[model] || 0) + tokens;
        }
      }
    }

    const dailyData = buildDailyTokens(issues, 7);
    return { totalTokens, totalCost, byModel, dailyData };
  }, [issues]);

  const modelEntries = Object.entries(byModel).sort((a, b) => b[1] - a[1]);
  const hasTokenData = totalTokens > 0;

  if (compact) {
    return (
      <div className="flex items-stretch gap-3 bg-base-200 rounded-box animate-fade-in overflow-hidden">
        {/* Tokens + Cost */}
        <div className="flex items-center gap-5 px-4 py-2.5">
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wide opacity-40">Tokens</span>
            <span className="text-base font-bold font-mono leading-tight flex items-center gap-1.5">
              <Zap className="size-3.5 text-primary" />
              <AnimatedCount value={formatTokens(totalTokens)} />
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wide opacity-40">Cost</span>
            <span className="text-base font-bold font-mono leading-tight flex items-center gap-1.5">
              <Coins className="size-3.5 text-secondary" />
              <AnimatedCount value={formatCost(totalCost)} />
            </span>
          </div>
        </div>

        {/* Sparkline */}
        <div className="flex flex-col justify-center py-2 px-3 border-l border-base-300 min-w-[180px]">
          <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1">Last 7 days</span>
          {hasTokenData ? (
            <MiniBarChart data={dailyData} height={32} />
          ) : (
            <div className="text-xs opacity-20 h-8 flex items-center">No data yet</div>
          )}
        </div>

        {/* Models breakdown */}
        {modelEntries.length > 0 && (
          <div className="flex flex-col justify-center py-2 px-3 border-l border-base-300">
            <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1">Models</span>
            <div className="flex flex-col gap-0.5">
              {modelEntries.slice(0, 3).map(([model, tokens]) => {
                const color = model.includes("claude") ? "bg-primary" : model.includes("gpt") || model.includes("codex") ? "bg-secondary" : "bg-accent";
                const short = model.split("-").slice(-2).join("-");
                return (
                  <span key={model} className="flex items-center gap-1.5 text-xs">
                    <span className={`inline-block w-2 h-2 rounded-full ${color} shrink-0`} />
                    <span className="opacity-60">{short}</span>
                    <span className="font-mono opacity-80">{formatTokens(tokens)}</span>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {/* Issue count */}
        <div className="flex items-center px-4 ml-auto">
          <span className="text-xs opacity-40">{issues.length} issues</span>
        </div>
      </div>
    );
  }

  return (
    <div className="stats stats-horizontal bg-base-200 rounded-box w-full mb-4 overflow-x-auto animate-fade-in">
      {/* Total tokens */}
      <div className="stat">
        <div className="stat-figure text-primary hidden sm:inline">
          <Zap className="size-7" />
        </div>
        <div className="stat-title">Tokens Used</div>
        <div className="stat-value text-lg">
          <AnimatedCount value={formatTokens(totalTokens)} />
        </div>
        <div className="stat-desc">
          {hasTokenData ? `${issues.length} issues` : "No token data yet"}
        </div>
      </div>

      {/* Cost */}
      <div className="stat">
        <div className="stat-figure text-secondary hidden sm:inline">
          <Coins className="size-7" />
        </div>
        <div className="stat-title">Estimated Cost</div>
        <div className="stat-value text-lg">
          <AnimatedCount value={formatCost(totalCost)} />
        </div>
        <div className="stat-desc">
          {modelEntries.length > 0
            ? modelEntries.map(([m, t]) => `${m.split("-").pop()}: ${formatTokens(t)}`).join(" · ")
            : "Across all models"
          }
        </div>
      </div>

      {/* Sparkline chart */}
      <div className="stat">
        <div className="stat-figure text-accent hidden sm:inline">
          <TrendingUp className="size-7" />
        </div>
        <div className="stat-title">Last 7 days</div>
        <div className="stat-value p-0">
          {hasTokenData ? (
            <MiniBarChart data={dailyData} height={36} />
          ) : (
            <div className="text-sm opacity-30 py-1">—</div>
          )}
        </div>
        <div className="stat-desc">
          {hasTokenData && modelEntries.length > 0 && (
            <span className="flex items-center gap-2 mt-1">
              {modelEntries.slice(0, 3).map(([model]) => {
                const color = model.includes("claude") ? "bg-primary" : model.includes("gpt") || model.includes("codex") ? "bg-secondary" : "bg-accent";
                const short = model.split("-").slice(-2).join("-");
                return (
                  <span key={model} className="flex items-center gap-1 text-[10px]">
                    <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
                    {short}
                  </span>
                );
              })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default StatsBar;
