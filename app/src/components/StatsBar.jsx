import React, { useRef, useEffect, useState } from "react";
import { Zap, TrendingUp, Activity, ChevronDown, GitBranch, GitMerge } from "lucide-react";
import { useTokenAnalytics, useCodeChurnAnalytics } from "../hooks.js";
import { fillDailyGaps } from "../utils.js";

function formatTokens(n) {
  if (!n || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function AnimatedCount({ value, format = formatTokens, className = "" }) {
  const [display, setDisplay] = useState(() => format(value));
  const prevRef = useRef(value);
  const rafRef = useRef(null);

  useEffect(() => {
    const from = prevRef.current || 0;
    const to = value || 0;
    prevRef.current = to;
    if (from === to) { setDisplay(format(to)); return; }
    const duration = 600;
    const start = performance.now();
    const tick = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(format(Math.round(from + (to - from) * eased)));
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, format]);

  return <span className={`${className} inline-block tabular-nums`}>{display}</span>;
}

/**
 * Daily column sparkline — bar chart with one column per day.
 * valueKey: which field to read from each day entry (default: "totalTokens")
 * colorClass: Tailwind text color for the bars
 */
function DailyColumnSparkline({ data, height = 28, cols = 14, valueKey = "totalTokens", colorClass = "text-primary", showValue = false, className = "" }) {
  if (!data || data.length === 0) return null;
  const days = data.slice(-cols);
  const today = new Date().toISOString().slice(0, 10);
  const max = Math.max(...days.map((d) => d[valueKey] || 0), 1);
  const n = days.length;
  const gap = 1.5;
  const colW = Math.max(2, (100 - gap * (n - 1)) / n);

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <svg viewBox={`0 0 100 ${height}`} className="flex-1" style={{ height }} preserveAspectRatio="none">
        {days.map((d, i) => {
          const val = d[valueKey] || 0;
          const h = Math.max(1.5, (val / max) * (height - 1));
          const x = i * (colW + gap);
          const isToday = d.date === today;
          const label = d.date
            ? new Date(d.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
            : `Day ${i + 1}`;
          return (
            <rect key={d.date || i} x={x} y={height - h} width={colW} height={h} rx="0.5"
              fill="currentColor" className={colorClass}
              opacity={isToday ? 0.85 : val > 0 ? 0.4 : 0.12}>
              <title>{`${label}: ${val > 999 ? formatTokens(val) : val}`}</title>
            </rect>
          );
        })}
      </svg>
      {showValue && (
        <span className="text-[9px] font-mono opacity-50 shrink-0">
          {formatTokens(days[days.length - 1]?.[valueKey] || 0)}/d
        </span>
      )}
    </div>
  );
}

/**
 * Stacked bar sparkline — each column shows linesAdded (green, top) stacked over linesRemoved (red, bottom)
 */
function StackedChurnSparkline({ data, height = 28, cols = 14, className = "" }) {
  if (!data || data.length === 0) return null;
  const days = data.slice(-cols);
  const today = new Date().toISOString().slice(0, 10);
  const max = Math.max(...days.map((d) => (d.linesAdded || 0) + (d.linesRemoved || 0)), 1);
  const n = days.length;
  const gap = 1.5;
  const colW = Math.max(2, (100 - gap * (n - 1)) / n);

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <svg viewBox={`0 0 100 ${height}`} className="flex-1" style={{ height }} preserveAspectRatio="none">
        {days.map((d, i) => {
          const added = d.linesAdded || 0;
          const removed = d.linesRemoved || 0;
          const total = added + removed;
          const totalH = Math.max(total > 0 ? 1.5 : 0, (total / max) * (height - 1));
          const addH = total > 0 ? (added / total) * totalH : 0;
          const delH = totalH - addH;
          const x = i * (colW + gap);
          const isToday = d.date === today;
          const opacity = isToday ? 0.85 : total > 0 ? 0.5 : 0.12;
          const label = d.date
            ? new Date(d.date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
            : `Day ${i + 1}`;
          return (
            <g key={d.date || i}>
              {delH > 0 && (
                <rect x={x} y={height - delH} width={colW} height={delH} rx="0.5"
                  className="fill-error" opacity={opacity}>
                  <title>{`${label}: +${added} / -${removed}`}</title>
                </rect>
              )}
              {addH > 0 && (
                <rect x={x} y={height - totalH} width={colW} height={addH} rx="0.5"
                  className="fill-success" opacity={opacity}>
                  <title>{`${label}: +${added} / -${removed}`}</title>
                </rect>
              )}
            </g>
          );
        })}
      </svg>
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

/** Mobile-only collapsed stats — tap to expand */
function MobileStatsBar({ monthlyTokens, monthlyEvents, dailyData, hasDailyData, hasEventData, linesDaily, hasChurnData }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-base-200 rounded-box animate-fade-in overflow-hidden">
      <button
        className="flex items-center justify-between w-full px-4 py-2.5 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <span className="text-base font-bold font-mono leading-tight flex items-center gap-1.5">
            <Zap className="size-3.5 text-primary" />
            <AnimatedCount value={monthlyTokens} />
            <span className="text-[10px] uppercase tracking-wide opacity-40 font-normal ml-1">this month</span>
          </span>
          {monthlyEvents > 0 && (
            <span className="flex items-center gap-1 text-xs opacity-50">
              <Activity className="size-3" />
              {monthlyEvents}
            </span>
          )}
        </div>
        <ChevronDown className={`size-4 opacity-40 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3 animate-fade-in border-t border-base-300 pt-3">
          {hasDailyData && (
            <div>
              <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 flex items-center gap-1">
                <TrendingUp className="size-2.5" /> Tokens / day
              </span>
              <DailyColumnSparkline data={dailyData} height={32} cols={14} valueKey="totalTokens" colorClass="text-primary" className="w-full" />
            </div>
          )}
          {hasEventData && (
            <div>
              <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 flex items-center gap-1">
                <Activity className="size-2.5" /> Events / day
              </span>
              <DailyColumnSparkline data={dailyData} height={24} cols={14} valueKey="events" colorClass="text-secondary" className="w-full" />
            </div>
          )}
          <div>
            <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 flex items-center gap-1">
              <GitMerge className="size-2.5" /> Lines / day
            </span>
            <StackedChurnSparkline data={linesDaily} height={24} cols={14} className="w-full" />
          </div>
        </div>
      )}
    </div>
  );
}

export function StatsBar({ issues = [], defaultBranch }) {
  const { data: analytics } = useTokenAnalytics();
  const { data: linesData } = useCodeChurnAnalytics({ pollInterval: 60000 });
  const isMobile = useIsMobile();

  const dailyData = fillDailyGaps(analytics?.daily, 14);

  // Monthly aggregates (current calendar month)
  const currentMonth = new Date().toISOString().slice(0, 7); // "2026-03"
  const monthlyTokens = dailyData
    .filter((d) => d.date?.startsWith(currentMonth))
    .reduce((sum, d) => sum + (d.totalTokens || 0), 0);
  const monthlyEvents = dailyData
    .filter((d) => d.date?.startsWith(currentMonth))
    .reduce((sum, d) => sum + (d.events || 0), 0);

  // Lines churn (14-day gap fill)
  const linesDaily = (() => {
    const byDate = new Map((linesData?.lines || []).filter((d) => d.date).map((d) => [d.date, d]));
    const result = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().slice(0, 10);
      result.push(byDate.get(date) ?? { date, linesAdded: 0, linesRemoved: 0, filesChanged: 0 });
    }
    return result;
  })();

  const hasDailyData = dailyData.some((d) => (d.totalTokens || 0) > 0);
  const hasEventData = dailyData.some((d) => (d.events || 0) > 0);
  const hasChurnData = linesDaily.some((d) => (d.linesAdded || 0) > 0 || (d.linesRemoved || 0) > 0);
  const hasAnyData = monthlyTokens > 0 || hasDailyData || hasEventData;

  const hadDataRef = useRef(hasAnyData);
  const [showFadeIn, setShowFadeIn] = useState(false);
  useEffect(() => {
    if (!hadDataRef.current && hasAnyData) {
      hadDataRef.current = true;
      setShowFadeIn(true);
    }
  }, [hasAnyData]);

  if (!hasAnyData) return null;

  if (isMobile) {
    return (
      <MobileStatsBar
        monthlyTokens={monthlyTokens}
        monthlyEvents={monthlyEvents}
        dailyData={dailyData}
        hasDailyData={hasDailyData}
        hasEventData={hasEventData}
        linesDaily={linesDaily}
        hasChurnData={hasChurnData}
      />
    );
  }

  return (
    <div className={`flex items-stretch gap-0 bg-base-200 rounded-box overflow-hidden ${showFadeIn ? "animate-fade-in-up" : "animate-fade-in"}`}>

      {/* Monthly tokens */}
      <div className="flex flex-col justify-center px-4 py-2.5">
        <span className="text-[10px] uppercase tracking-wide opacity-40">Tokens / month</span>
        <span className="text-base font-bold font-mono leading-tight flex items-center gap-1.5 mt-0.5">
          <Zap className="size-3.5 text-primary shrink-0" />
          <AnimatedCount value={monthlyTokens} />
        </span>
      </div>

      {/* Tokens sparkline */}
      {hasDailyData && (
        <div className="flex flex-col justify-center py-2 px-3 border-l border-base-300 min-w-[120px]">
          <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 flex items-center gap-1">
            <TrendingUp className="size-2.5" /> Tokens / day
          </span>
          <DailyColumnSparkline data={dailyData} height={28} cols={14} valueKey="totalTokens" colorClass="text-primary" />
        </div>
      )}

      {/* Events sparkline */}
      {hasEventData && (
        <div className="flex flex-col justify-center py-2 px-3 border-l border-base-300 min-w-[120px]">
          <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 flex items-center gap-1">
            <Activity className="size-2.5" /> Events / day
          </span>
          <DailyColumnSparkline data={dailyData} height={28} cols={14} valueKey="events" colorClass="text-secondary" />
        </div>
      )}

      {/* Code churn sparkline */}
      <div className="flex flex-col justify-center py-2 px-3 border-l border-base-300 min-w-[120px]">
        <span className="text-[10px] uppercase tracking-wide opacity-40 mb-1 flex items-center gap-1">
          <GitMerge className="size-2.5" /> Lines / day
        </span>
        <StackedChurnSparkline data={linesDaily} height={28} cols={14} />
      </div>

      {/* Default branch */}
      {defaultBranch && (
        <div className="flex flex-col justify-center px-3 border-l border-base-300">
          <span className="text-[10px] uppercase tracking-wide opacity-40">Branch</span>
          <span className="text-xs font-mono font-medium flex items-center gap-1 mt-0.5">
            <GitBranch className="size-3 text-primary shrink-0" />
            {defaultBranch}
          </span>
        </div>
      )}

    </div>
  );
}

export default StatsBar;
