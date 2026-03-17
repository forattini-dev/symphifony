import React, { useRef, useEffect, useState } from "react";
import { Zap, TrendingUp, Layers, Activity, ChevronDown } from "lucide-react";
import { useTokenAnalytics, useHourlyAnalytics } from "../hooks.js";

/** Format a full model slug into a readable short name */
function formatModelName(slug) {
  if (!slug || typeof slug !== "string") return slug || "unknown";
  // claude-sonnet-4-6 → Sonnet 4.6
  // claude-opus-4-6 → Opus 4.6
  // claude-haiku-4-5-20251001 → Haiku 4.5
  const claudeMatch = slug.match(/claude-(\w+)-(\d+)-(\d+)/);
  if (claudeMatch) {
    const family = claudeMatch[1].charAt(0).toUpperCase() + claudeMatch[1].slice(1);
    return `${family} ${claudeMatch[2]}.${claudeMatch[3]}`;
  }
  // codex, gpt-*, o3, o4-mini, etc — return as-is
  return slug;
}

/**
 * Smooth count-up animation using requestAnimationFrame.
 * Receives a raw number, formats at each frame with K/M suffix, animates over 600ms.
 */
function AnimatedCount({ value, className = "" }) {
  const [display, setDisplay] = useState(() => formatTokens(value));
  const prevRef = useRef(value);
  const rafRef = useRef(null);

  useEffect(() => {
    const from = prevRef.current || 0;
    const to = value || 0;
    prevRef.current = to;

    if (from === to) {
      setDisplay(formatTokens(to));
      return;
    }

    const duration = 600;
    const start = performance.now();

    const tick = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = from + (to - from) * eased;
      setDisplay(formatTokens(Math.round(current)));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafRef.current);
  }, [value]);

  return (
    <span className={`${className} inline-block tabular-nums`}>
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

/** Stacked pill group showing planner / executor / reviewer token split. */
function PhaseBreakdown({ byPhase, compact = false }) {
  if (!byPhase) return null;

  const phases = [
    { key: "planner", label: "Plan", color: "bg-info", textColor: "text-info" },
    { key: "executor", label: "Exec", color: "bg-primary", textColor: "text-primary" },
    { key: "reviewer", label: "Review", color: "bg-secondary", textColor: "text-secondary" },
  ];

  const total = phases.reduce((sum, p) => sum + (byPhase[p.key]?.totalTokens || 0), 0);
  if (total === 0) return null;

  return (
    <div className={compact ? "flex flex-col gap-1" : "flex flex-col gap-1.5"}>
      {/* Stacked bar */}
      <div className="flex h-2 rounded-full overflow-hidden bg-base-300 w-full min-w-[100px]">
        {phases.map((p) => {
          const tokens = byPhase[p.key]?.totalTokens || 0;
          const pct = (tokens / total) * 100;
          if (pct === 0) return null;
          return (
            <div
              key={p.key}
              className={`${p.color} opacity-80 transition-all duration-500`}
              style={{ width: `${pct}%` }}
              title={`${p.label}: ${formatTokens(tokens)} (${Math.round(pct)}%)`}
            />
          );
        })}
      </div>
      {/* Labels */}
      <div className="flex items-center gap-2 flex-wrap">
        {phases.map((p) => {
          const tokens = byPhase[p.key]?.totalTokens || 0;
          if (tokens === 0) return null;
          return (
            <span key={p.key} className="flex items-center gap-1 text-[10px]">
              <span className={`inline-block w-2 h-2 rounded-full ${p.color} shrink-0`} />
              <span className="opacity-60">{p.label}</span>
              <span className="font-mono opacity-80">{formatTokens(tokens)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Tiny inline sparkline bar chart using server-provided daily data. */
function MiniBarChart({ data, height = 32, className = "" }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.totalTokens || 0), 1);
  const barWidth = Math.max(2, Math.floor(100 / data.length));

  return (
    <div className={`flex items-end gap-px ${className}`} style={{ height }}>
      {data.map((d, i) => {
        const h = Math.max(1, Math.round(((d.totalTokens || 0) / max) * height));
        const label = d.date
          ? new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" })
          : `Day ${i + 1}`;
        return (
          <div
            key={d.date || i}
            className="bg-primary rounded-t-sm opacity-70 transition-all duration-500"
            style={{ width: `${barWidth}%`, height: h }}
            title={`${label}: ${formatTokens(d.totalTokens || 0)}`}
          />
        );
      })}
    </div>
  );
}

/** Sparkline for hourly data — thin line chart. */
function HourlySparkline({ data, valueKey = "totalTokens", height = 28, color = "stroke-primary", className = "" }) {
  if (!data || data.length === 0) return null;
  const values = data.map((d) => d[valueKey] || d.count || 0);
  const max = Math.max(...values, 1);
  const w = 100;
  const points = values.map((v, i) => {
    const x = (i / Math.max(values.length - 1, 1)) * w;
    const y = height - (v / max) * (height - 2) - 1;
    return `${x},${y}`;
  }).join(" ");

  const lastVal = values[values.length - 1] || 0;
  const prevVal = values[values.length - 2] || 0;
  const trend = lastVal > prevVal ? "up" : lastVal < prevVal ? "down" : "flat";

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <svg viewBox={`0 0 ${w} ${height}`} className="flex-1" style={{ height }} preserveAspectRatio="none">
        <polyline
          points={points}
          fill="none"
          className={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* Fill area under the line */}
        <polyline
          points={`0,${height} ${points} ${w},${height}`}
          fill="currentColor"
          className={color.replace("stroke-", "text-")}
          opacity="0.08"
        />
      </svg>
      <span className={`text-[9px] font-mono opacity-50 shrink-0 ${trend === "up" ? "text-success" : trend === "down" ? "text-error" : ""}`}>
        {formatTokens(lastVal)}/h
      </span>
    </div>
  );
}

/** Mobile-only collapsed stats — tap to expand */
function MobileStatsBar({ totalTokens, byPhase, tokensPerHour, eventsPerHour, hasHourlyData, modelEntries, issues }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-base-200 rounded-box animate-fade-in overflow-hidden">
      <button
        className="flex items-center justify-between w-full px-4 py-2.5 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-base font-bold font-mono leading-tight flex items-center gap-1.5">
          <Zap className="size-3.5 text-primary" />
          <AnimatedCount value={totalTokens} />
          <span className="text-[10px] uppercase tracking-wide opacity-40 font-normal ml-1">tokens</span>
        </span>
        <ChevronDown className={`size-4 opacity-40 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3 animate-fade-in border-t border-base-300 pt-3">
          {/* Phase breakdown */}
          {byPhase && (
            <div>
              <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 block">Phases</span>
              <PhaseBreakdown byPhase={byPhase} compact />
            </div>
          )}

          {/* Sparklines full-width */}
          {hasHourlyData && tokensPerHour.length > 0 && (
            <div>
              <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 flex items-center gap-1">
                <Zap className="size-2.5" /> Tokens/h
              </span>
              <HourlySparkline data={tokensPerHour} valueKey="totalTokens" height={32} color="stroke-primary" className="w-full" />
            </div>
          )}

          {hasHourlyData && eventsPerHour.length > 0 && (
            <div>
              <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 flex items-center gap-1">
                <Activity className="size-2.5" /> Events/h
              </span>
              <HourlySparkline data={eventsPerHour} valueKey="count" height={32} color="stroke-secondary" className="w-full" />
            </div>
          )}

          {/* Models */}
          {modelEntries.length > 0 && (
            <div>
              <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 block">Models</span>
              <div className="flex flex-col gap-0.5">
                {modelEntries.slice(0, 3).map(([model, tokens]) => {
                  const color = model.includes("claude") ? "bg-primary" : model.includes("gpt") || model.includes("codex") ? "bg-secondary" : "bg-accent";
                  const short = formatModelName(model);
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

          {issues.length > 0 && (
            <div className="text-xs opacity-40">{issues.length} issues</div>
          )}
        </div>
      )}
    </div>
  );
}

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e) => setMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return mobile;
}

export function StatsBar({ metrics, total, issues = [], compact = false }) {
  const { data: analytics } = useTokenAnalytics();
  const { data: hourlyData } = useHourlyAnalytics(24);
  const isMobile = useIsMobile();

  const totalTokens = analytics?.overall?.totalTokens || 0;
  const byPhase = analytics?.byPhase || null;
  const dailyData = analytics?.daily || [];
  const byModel = analytics?.byModel || {};
  const hasTokenData = totalTokens > 0;

  const tokensPerHour = hourlyData?.tokensPerHour || [];
  const eventsPerHour = hourlyData?.eventsPerHour || [];
  const hasHourlyData = tokensPerHour.some((h) => h.totalTokens > 0) || eventsPerHour.some((h) => h.count > 0);

  const modelEntries = Object.entries(byModel)
    .map(([model, data]) => [model, data?.totalTokens || 0])
    .sort((a, b) => b[1] - a[1]);

  // Track whether we've ever had data — once true, stays true for fade-in
  const hadDataRef = useRef(totalTokens > 0);
  const [showFadeIn, setShowFadeIn] = useState(false);

  useEffect(() => {
    if (!hadDataRef.current && totalTokens > 0) {
      hadDataRef.current = true;
      setShowFadeIn(true);
    }
  }, [totalTokens]);

  // Hide entire StatsBar when total tokens is 0
  if (totalTokens === 0 && !hasHourlyData) {
    return null;
  }

  // Mobile: single metric + expandable
  if (isMobile) {
    return (
      <MobileStatsBar
        totalTokens={totalTokens}
        byPhase={byPhase}
        tokensPerHour={tokensPerHour}
        eventsPerHour={eventsPerHour}
        hasHourlyData={hasHourlyData}
        modelEntries={modelEntries}
        issues={issues}
      />
    );
  }

  if (compact) {
    return (
      <div className={`flex items-stretch gap-3 bg-base-200 rounded-box overflow-hidden ${showFadeIn ? "animate-fade-in-up" : "animate-fade-in"}`}>
        {/* Tokens */}
        <div className="flex items-center gap-5 px-4 py-2.5">
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wide opacity-40">Tokens</span>
            <span className="text-base font-bold font-mono leading-tight flex items-center gap-1.5">
              <Zap className="size-3.5 text-primary" />
              <AnimatedCount value={totalTokens} />
            </span>
          </div>
        </div>

        {/* Phase breakdown */}
        {byPhase && (
          <div className="flex flex-col justify-center py-2 px-3 border-l border-base-300 min-w-[140px]">
            <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1">Phases</span>
            <PhaseBreakdown byPhase={byPhase} compact />
          </div>
        )}

        {/* Hourly tokens sparkline — hide when all zero */}
        {hasHourlyData && tokensPerHour.some((h) => h.totalTokens > 0) && (
          <div className="flex flex-col justify-center py-2 px-3 border-l border-base-300 min-w-[140px]">
            <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 flex items-center gap-1">
              <Zap className="size-2.5" /> Tokens/h
            </span>
            <HourlySparkline data={tokensPerHour} valueKey="totalTokens" height={28} color="stroke-primary" />
          </div>
        )}

        {/* Hourly events sparkline — hide when all zero */}
        {hasHourlyData && eventsPerHour.some((h) => h.count > 0) && (
          <div className="flex flex-col justify-center py-2 px-3 border-l border-base-300 min-w-[140px]">
            <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 flex items-center gap-1">
              <Activity className="size-2.5" /> Events/h
            </span>
            <HourlySparkline data={eventsPerHour} valueKey="count" height={28} color="stroke-secondary" />
          </div>
        )}

        {/* Models breakdown */}
        {modelEntries.length > 0 && (
          <div className="flex flex-col justify-center py-2 px-3 border-l border-base-300">
            <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1">Models</span>
            <div className="flex flex-col gap-0.5">
              {modelEntries.slice(0, 3).map(([model, tokens]) => {
                const color = model.includes("claude") ? "bg-primary" : model.includes("gpt") || model.includes("codex") ? "bg-secondary" : "bg-accent";
                const short = formatModelName(model);
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
        {issues.length > 0 && (
          <div className="flex items-center px-4 ml-auto">
            <span className="text-xs opacity-40">{issues.length} issues</span>
          </div>
        )}
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
          <AnimatedCount value={totalTokens} />
        </div>
        <div className="stat-desc">
          {hasTokenData ? `${issues.length} issues` : "No token data yet"}
        </div>
      </div>

      {/* Phase breakdown */}
      <div className="stat">
        <div className="stat-figure text-info hidden sm:inline">
          <Layers className="size-7" />
        </div>
        <div className="stat-title">Phase Split</div>
        <div className="stat-value p-0">
          {byPhase ? (
            <PhaseBreakdown byPhase={byPhase} />
          ) : (
            <div className="text-sm opacity-30 py-1">--</div>
          )}
        </div>
        <div className="stat-desc">
          {modelEntries.length > 0
            ? modelEntries.map(([m, t]) => `${m.split("-").pop()}: ${formatTokens(t)}`).join(" \u00b7 ")
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
          {hasTokenData && dailyData.length > 0 ? (
            <MiniBarChart data={dailyData} height={36} />
          ) : (
            <div className="text-sm opacity-30 py-1">--</div>
          )}
        </div>
        <div className="stat-desc">
          {hasTokenData && modelEntries.length > 0 && (
            <span className="flex items-center gap-2 mt-1">
              {modelEntries.slice(0, 3).map(([model]) => {
                const color = model.includes("claude") ? "bg-primary" : model.includes("gpt") || model.includes("codex") ? "bg-secondary" : "bg-accent";
                const short = formatModelName(model);
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
