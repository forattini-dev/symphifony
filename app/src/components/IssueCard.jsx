import React, { useState, useEffect, useRef } from "react";
import {
  Zap, Activity, GitMerge, CheckSquare, Clock,
  Loader, Play, Eye, AlertTriangle, Lightbulb, Pause, ListOrdered,
  GitPullRequestArrow, XCircle,
} from "lucide-react";
import { timeAgo } from "../utils.js";
import { useElapsedTime } from "../hooks/useElapsedTime.js";

// ── Issue type badge ─────────────────────────────────────────────────────────

const ISSUE_TYPE_BADGE = {
  bug:      "badge-error",
  feature:  "badge-primary",
  refactor: "badge-warning",
  docs:     "badge-info",
  chore:    "badge-secondary",
};

// ── State maps ────────────────────────────────────────────────────────────────

const STATE_BORDER_LEFT = {
  Planning:   "border-l-info",
  PendingApproval:    "border-l-warning",
  Queued:     "border-l-info",
  Running:    "border-l-primary",
  Reviewing:  "border-l-secondary",
  PendingDecision:   "border-l-success/60",
  Blocked:    "border-l-error",
  Approved:       "border-l-success",
  Merged:     "border-l-success",
  Cancelled:  "border-l-neutral",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTokens(count) {
  if (!count || count === 0) return null;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000)     return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function parseIssueNumber(identifier) {
  if (!identifier) return null;
  const m = identifier.match(/\d+$/);
  return m ? m[0] : null;
}

function formatModelName(slug) {
  if (!slug) return null;
  const m = slug.match(/claude-(\w+)-(\d+)-(\d+)/);
  if (m) return `${m[1].charAt(0).toUpperCase() + m[1].slice(1)} ${m[2]}.${m[3]}`;
  return slug.length <= 14 ? slug : slug.slice(0, 14);
}

/**
 * Returns per-stage model/effort info for the stages that have actually run.
 * If all stages share the same model, collapses to a single entry (no label).
 * Shape: [{ label: "plan"|"exec"|"rev"|null, model: "Sonnet 4.6", effort: "medium"|null }]
 */
function deriveStageInfo(tokensByPhase, effort) {
  const ROLES = [
    { key: "planner",  short: "plan" },
    { key: "executor", short: "exec" },
    { key: "reviewer", short: "rev"  },
  ];

  const stages = ROLES
    .filter((r) => (tokensByPhase?.[r.key]?.totalTokens || 0) > 0)
    .map((r) => ({
      label:  r.short,
      model:  formatModelName(tokensByPhase[r.key]?.model || null),
      effort: effort?.[r.key] || effort?.default || null,
    }))
    .filter((s) => s.model);

  if (stages.length === 0) return [];

  // Collapse to single unlabelled entry when all stages share same model+effort
  const allSame = stages.every(
    (s) => s.model === stages[0].model && s.effort === stages[0].effort,
  );
  if (allSame) return [{ label: null, model: stages[0].model, effort: stages[0].effort }];

  return stages;
}

function derivePhase(tokensByPhase) { // used in deriveActivity
  if (!tokensByPhase) return null;
  if (tokensByPhase.reviewer?.totalTokens > 0) return "reviewing";
  if (tokensByPhase.executor?.totalTokens > 0)  return "executing";
  if (tokensByPhase.planner?.totalTokens > 0)   return "planning";
  return null;
}

function formatStallMs(ms) {
  if (ms <= 0) return "<1m";
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d${h % 24}h`;
  if (h > 0) return `${h}h${m % 60}m`;
  return `${m}m`;
}

function getStallTimestamp(issue) {
  if (issue.state === "Reviewing") return issue.updatedAt;
  if (issue.state === "PendingDecision")  return issue.completedAt || issue.updatedAt;
  if (issue.state === "Blocked")   return issue.updatedAt;
  return null;
}

// ── Sub-status derivation (granular machine state) ────────────────────────────
// Returns { label, Icon, spin, pulse, color } for the card's activity line.
// Returns null when the state is passive (no active signal to surface).

function deriveActivity(issue) {
  const { state, planningStatus, assignedToWorker, startedAt, tokenUsage, tokensByPhase } = issue;

  switch (state) {
    case "Planning": {
      if (planningStatus === "planning")
        return { label: "Writing plan…",   Icon: Loader,    spin: true,  pulse: false, color: "text-info" };
      if (issue.plan)
        return { label: "Plan ready",      Icon: Lightbulb, spin: false, pulse: false, color: "text-info/60" };
      if (issue.planningError)
        return { label: "Plan failed",     Icon: AlertTriangle, spin: false, pulse: false, color: "text-error" };
      return { label: "Aguardando…",       Icon: Clock,     spin: false, pulse: true,  color: "text-info/50" };
    }

    case "PendingApproval":
      return null; // passive wait

    case "Queued": {
      if (assignedToWorker)
        return { label: "Starting…", Icon: Play, spin: false, pulse: true, color: "text-primary/80" };
      return { label: "In queue", Icon: ListOrdered, spin: false, pulse: false, color: "text-base-content/40" };
    }

    case "Running": {
      const phase = derivePhase(tokensByPhase);
      const hasTokens = tokenUsage?.totalTokens > 0;
      if (!hasTokens && !startedAt)
        return { label: "Spawning…",       Icon: Loader, spin: true,  pulse: false, color: "text-primary" };
      if (!hasTokens)
        return { label: "Starting…",       Icon: Loader, spin: true,  pulse: false, color: "text-primary" };
      if (phase === "reviewing")
        return { label: "Reviewing…",      Icon: Eye,    spin: false, pulse: true,  color: "text-secondary" };
      if (phase === "planning")
        return { label: "Planning…",       Icon: Lightbulb, spin: false, pulse: true, color: "text-info" };
      return   { label: "Working…",        Icon: Play,   spin: false, pulse: true,  color: "text-primary" };
    }

    // Stalling states — handled separately via StallLine
    case "Reviewing":
    case "PendingDecision":
    case "Blocked":
      return "stall";

    default:
      return null;
  }
}

// ── Live stall counter ────────────────────────────────────────────────────────

function useStallMs(timestamp) {
  const [ms, setMs] = useState(() =>
    timestamp ? Math.max(0, Date.now() - new Date(timestamp).getTime()) : 0,
  );
  useEffect(() => {
    if (!timestamp) return;
    const start = new Date(timestamp).getTime();
    const update = () => setMs(Math.max(0, Date.now() - start));
    update();
    const delay = () => (Date.now() - start < 3_600_000 ? 30_000 : 120_000);
    let id = setInterval(() => { update(); clearInterval(id); id = setInterval(update, delay()); }, delay());
    return () => clearInterval(id);
  }, [timestamp]);
  return ms;
}

// ── Activity line (Row 1) ─────────────────────────────────────────────────────
// The single most contextual piece of information — what is happening right now.

function ActivityLine({ issue }) {
  const activity = deriveActivity(issue);
  const stallTs   = getStallTimestamp(issue);
  const stallMs   = useStallMs(activity === "stall" ? stallTs : null);
  const elapsed   = useElapsedTime(
    activity && activity !== "stall" && issue.state === "Running" ? issue.startedAt : null,
  );

  if (!activity) return null;

  // Stalling states: show clock + duration + short label
  if (activity === "stall") {
    if (!stallTs) return null;
    const stallColor =
      issue.state === "Blocked"   ? "text-error/70" :
      issue.state === "PendingDecision"  ? "text-success/70" :
      "text-secondary/70"; // Reviewing
    const stallLabel =
      issue.state === "Blocked"   ? "blocked" :
      issue.state === "PendingDecision"  ? "review complete" :
      "reviewing";

    return (
      <div className={`flex items-center gap-1 text-[11px] font-medium ${stallColor}`}>
        <Clock size={10} className="shrink-0" />
        <span className="tabular-nums font-mono">{formatStallMs(stallMs)}</span>
        <span className="opacity-60 font-normal">· {stallLabel}</span>
      </div>
    );
  }

  // Active state
  const { label, Icon, spin, pulse, color } = activity;
  return (
    <div className={`flex items-center gap-1 text-[11px] ${color}`}>
      {Icon && (
        <Icon
          size={10}
          className={[spin ? "animate-spin" : "", pulse ? "status-indicator-pulse" : ""].filter(Boolean).join(" ")}
        />
      )}
      <span className="font-medium truncate">{label}</span>
      {elapsed && (
        <span className="font-mono opacity-50 tabular-nums shrink-0 ml-0.5">{elapsed}</span>
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

export function IssueCard({
  issue, onSelect, dragHandlers, isDragging,
  isSelected, onToggleSelect, hasSelection,
}) {
  const isRunning    = issue.state === "Running";
  const isPlanning   = issue.state === "Planning";
  const isDone       = issue.state === "Approved" || issue.state === "Merged";
  const isMergedState = issue.state === "Merged";
  const isCancelled  = issue.state === "Cancelled";
  const isBlocked    = issue.state === "Blocked";
  const isPlanBusy   = issue.planningStatus === "planning";
  const isMerged     = !!issue.mergedAt;
  const hasMergeConflict = issue.mergeResult?.conflicts > 0;
  const canMerge     = !isMerged && !isMergedState && !hasMergeConflict && !!issue.branchName
                       && issue.state === "Approved";

  // Token bump animation
  const prevTokensRef = useRef(issue.tokenUsage?.totalTokens);
  const [tokenBump, setTokenBump]       = useState(false);
  const [completionFlash, setCompletionFlash] = useState(false);
  const prevStateRef = useRef(issue.state);

  useEffect(() => {
    const cur = issue.tokenUsage?.totalTokens;
    if (cur != null && cur !== prevTokensRef.current) {
      setTokenBump(true);
      const t = setTimeout(() => setTokenBump(false), 300);
      prevTokensRef.current = cur;
      return () => clearTimeout(t);
    }
  }, [issue.tokenUsage?.totalTokens]);

  useEffect(() => {
    if ((prevStateRef.current !== "Merged" && issue.state === "Merged") || (prevStateRef.current !== "Approved" && issue.state === "Approved")) {
      setCompletionFlash(true);
      const t = setTimeout(() => setCompletionFlash(false), 800);
      prevStateRef.current = issue.state;
      return () => clearTimeout(t);
    }
    prevStateRef.current = issue.state;
  }, [issue.state]);

  // Derived data
  const issueNumber     = parseIssueNumber(issue.identifier);
  const totalTokens     = issue.tokenUsage?.totalTokens || 0;
  const formattedTokens = formatTokens(totalTokens);
  const eventCount      = issue.history?.length || 0;
  const stageInfo       = deriveStageInfo(issue.tokensByPhase, issue.effort);

  const handleClick = (e) => {
    if (e.shiftKey)   { e.preventDefault(); onToggleSelect?.(issue.id); return; }
    if (hasSelection) { e.preventDefault(); onToggleSelect?.(issue.id); return; }
    onSelect?.(issue);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (e.shiftKey || hasSelection) onToggleSelect?.(issue.id);
      else onSelect?.(issue);
    }
  };

  return (
    <div
      data-issue-id={issue.id}
      className={[
        "card card-compact bg-base-100 border border-l-[3px] relative",
        isSelected
          ? "border-primary ring-2 ring-primary/30 border-base-300"
          : "border-base-300",
        STATE_BORDER_LEFT[issue.state] || "",
        isPlanning ? "animate-pulse-soft-border" : "",
        isRunning  ? "animate-pulse-border" : "",
        isDone      ? "opacity-70" : "",
        isCancelled ? "opacity-45" : "",
        isBlocked   ? "issue-card-blocked" : "",
        (!isDone && !isCancelled) ? "card-interactive" : "",
        "cursor-pointer",
        isDragging ? "kanban-card-source-opacity" : "",
        completionFlash ? "issue-card-done-flash" : "",
      ].filter(Boolean).join(" ")}
      style={{ overflow: "hidden" }}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={`${isSelected ? "Deselect" : "Open"} issue ${issue.identifier}`}
      aria-selected={isSelected}
      {...(dragHandlers || {})}
    >

      {/* Ghost number — personality watermark, bottom-right, never interactive */}
      {issueNumber && (
        <div
          aria-hidden="true"
          className="absolute right-0 bottom-0 select-none pointer-events-none font-black leading-none"
          style={{
            fontSize: issueNumber.length <= 2 ? "5rem"
                    : issueNumber.length <= 4 ? "3.75rem"
                    : "2.75rem",
            opacity: isCancelled ? 0.12 : isDone ? 0.09 : 0.055,
            lineHeight: 0.82,
            paddingRight: "2px",
          }}
        >
          {issueNumber}
        </div>
      )}

      {/* Selection checkbox */}
      {(isSelected || hasSelection) && (
        <div className="absolute top-1.5 left-1.5 z-10">
          <div className={`size-5 rounded flex items-center justify-center transition-all ${
            isSelected
              ? "bg-primary text-primary-content"
              : "bg-base-300/60 border border-base-content/20"
          }`}>
            {isSelected && <CheckSquare size={14} />}
          </div>
        </div>
      )}

      <div className="card-body gap-1 p-3 relative">

        {/* Row 1 — activity line: what's happening right now (or stall timer) */}
        <div className={hasSelection ? "pl-5" : ""}>
          <ActivityLine issue={issue} />
        </div>

        {/* Row 2 — title: the primary content */}
        <h3 className={[
          "font-semibold text-sm leading-snug",
          isCancelled ? "line-through opacity-40" : "",
        ].filter(Boolean).join(" ")}>
          {issue.title}
        </h3>

        {/* Row 3 — per-stage model/effort (only when known, collapses if all same) */}
        {stageInfo.length > 0 && (
          <div className="flex items-center gap-2 text-[10px] opacity-35 truncate">
            {stageInfo.map((s) => (
              <span key={s.label ?? "single"} className="inline-flex items-center gap-0.5 shrink-0">
                {s.label && (
                  <span className="opacity-50 uppercase tracking-wide" style={{ fontSize: "8px" }}>
                    {s.label}
                  </span>
                )}
                <span>{s.model}</span>
                {s.effort && <span className="opacity-60">·{s.effort}</span>}
              </span>
            ))}
          </div>
        )}

        {/* Row 4 — metrics footer: left-aligned (never overlaps ghost number) */}
        <div className="flex items-center gap-2 text-[10px] opacity-40 mt-0.5">
          {issue.issueType && ISSUE_TYPE_BADGE[issue.issueType] && (
            <span className={`badge badge-xs ${ISSUE_TYPE_BADGE[issue.issueType]} badge-soft shrink-0`}>
              {issue.issueType}
            </span>
          )}
          {issue.planVersion > 1 && (
            <span className="badge badge-xs badge-info badge-soft shrink-0 font-mono">
              v{issue.planVersion}
            </span>
          )}
          {formattedTokens && (
            <span className={`inline-flex items-center gap-0.5 ${tokenBump ? "animate-count-bump" : ""}`}>
              <Zap size={9} />
              {formattedTokens}
            </span>
          )}
          {eventCount > 0 && (
            <span className="inline-flex items-center gap-0.5">
              <Activity size={9} />
              {eventCount}
            </span>
          )}
          {/* createdAt — always shown */}
          <span className="shrink-0">{timeAgo(issue.createdAt)}</span>
          {hasMergeConflict && (
            <span className="inline-flex items-center gap-0.5 text-error font-semibold ml-auto shrink-0 opacity-100">
              <XCircle size={10} />
              merge failed
            </span>
          )}
          {canMerge && (
            <span className="inline-flex items-center gap-0.5 text-warning font-semibold ml-auto shrink-0 opacity-100 animate-pulse">
              <GitPullRequestArrow size={10} />
              ready to merge
            </span>
          )}
          {isMerged && (
            <span className="inline-flex items-center gap-0.5 text-success font-semibold ml-auto shrink-0 opacity-100">
              <GitMerge size={10} />
              merged
            </span>
          )}
        </div>

      </div>

      {/* Running heartbeat bar */}
      {isRunning && <div className="issue-heartbeat-bar animate-pulse-soft" />}

      {/* Planning progress bar */}
      {isPlanBusy && (
        <div className="h-[3px] rounded-b-[var(--rounded-box,1rem)] bg-info animate-pulse-soft" />
      )}
      {/* Pending scheduler slot — subtle dashed indicator */}
      {isPlanning && !isPlanBusy && !issue.plan && !issue.planningError && (
        <div className="h-[2px] rounded-b-[var(--rounded-box,1rem)] bg-info/20 animate-pulse" />
      )}
      {/* Merge status bars */}
      {hasMergeConflict && (
        <div className="h-[3px] rounded-b-[var(--rounded-box,1rem)] bg-error animate-pulse" />
      )}
      {canMerge && (
        <div className="h-[3px] rounded-b-[var(--rounded-box,1rem)] bg-warning animate-pulse-soft" />
      )}
      {isMerged && (
        <div className="h-[3px] rounded-b-[var(--rounded-box,1rem)] bg-success" />
      )}
    </div>
  );
}

export default IssueCard;
