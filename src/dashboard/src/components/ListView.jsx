import React from "react";
import { IssueCard } from "./IssueCard.jsx";
import { EmptyState } from "./EmptyState.jsx";
import {
  ListChecks, Zap, Clock, RotateCcw, Layers, Timer, Hourglass,
  FileDiff, FileCode, ArrowRight, Coins,
} from "lucide-react";
import { timeAgo, formatDuration } from "../utils.js";

const STATE_BADGE = {
  Planning: "badge-info", Todo: "badge-warning", Queued: "badge-info", Running: "badge-primary", Interrupted: "badge-accent",
  "In Review": "badge-secondary", Blocked: "badge-error", Done: "badge-success", Cancelled: "badge-neutral",
};

const STATE_BG = {
  Planning: "border-l-info", Todo: "border-l-warning", Queued: "border-l-info", Running: "border-l-primary", Interrupted: "border-l-accent",
  "In Review": "border-l-secondary", Blocked: "border-l-error", Done: "border-l-success", Cancelled: "border-l-neutral",
};

function formatTokens(n) {
  if (!n || n === 0) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function Metric({ icon: Icon, label, value, color = "" }) {
  if (!value && value !== 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px]" title={label}>
      <Icon className={`size-2.5 ${color || "opacity-40"}`} />
      <span className="font-mono opacity-70">{value}</span>
    </span>
  );
}

function computeMetrics(issue) {
  const created = issue.createdAt ? new Date(issue.createdAt).getTime() : 0;
  const started = issue.startedAt ? new Date(issue.startedAt).getTime() : 0;
  const completed = issue.completedAt ? new Date(issue.completedAt).getTime() : 0;
  const now = Date.now();

  // Lead Time: creation → completion (or now if not done)
  const leadTimeMs = completed ? completed - created : (started ? now - created : 0);

  // Cycle Time: work started → completion
  const cycleTimeMs = completed && started ? completed - started : (started ? now - started : 0);

  // Wait Time: creation → work started
  const waitTimeMs = started ? started - created : (created ? now - created : 0);

  return { leadTimeMs, cycleTimeMs, waitTimeMs };
}

function GridIssueCard({ issue, onSelect }) {
  const isRunning = issue.state === "Running";
  const tokenDisplay = formatTokens(issue.tokenUsage?.totalTokens);
  const description = issue.description || "";
  const labels = (issue.labels || []).filter((l) => !l.startsWith("capability:") && !l.startsWith("overlay:"));
  const { leadTimeMs, cycleTimeMs, waitTimeMs } = computeMetrics(issue);
  const isDone = issue.state === "Done" || issue.state === "Cancelled";

  return (
    <div
      className={`card bg-base-100 border border-base-300 border-l-[3px] ${STATE_BG[issue.state] || ""} card-interactive cursor-pointer hover:shadow-lg transition-all ${isRunning ? "animate-pulse-border" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(issue)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect?.(issue);
        }
      }}
    >
      <div className="card-body gap-3 p-4 justify-between">
        {/* Header */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-xs opacity-50">{issue.identifier}</span>
              <span className={`badge badge-xs ${STATE_BADGE[issue.state] || "badge-ghost"}`}>{issue.state}</span>
              <span className="text-[10px] opacity-30">P{issue.priority}</span>
            </div>
            <span className="text-xs opacity-40 shrink-0">{timeAgo(issue.updatedAt)}</span>
          </div>

          <h3 className="font-semibold text-sm leading-snug line-clamp-2">{issue.title}</h3>

          {description && (
            <p className="text-xs opacity-50 leading-relaxed line-clamp-2 mt-1">{description}</p>
          )}
        </div>

        {/* Labels */}
        {(labels.length > 0 || issue.capabilityCategory) && (
          <div className="flex flex-wrap gap-1">
            {issue.capabilityCategory && (
              <span className="badge badge-xs badge-outline">
                <Layers className="size-2.5 mr-0.5" />{issue.capabilityCategory}
              </span>
            )}
            {labels.slice(0, 3).map((label) => (
              <span key={label} className="badge badge-xs badge-ghost">{label}</span>
            ))}
            {labels.length > 3 && <span className="badge badge-xs badge-ghost opacity-40">+{labels.length - 3}</span>}
          </div>
        )}

        {/* Metrics row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 border-t border-base-200">
          <Metric icon={Hourglass} label="Wait" value={waitTimeMs > 0 ? formatDuration(waitTimeMs) : null} />
          <Metric icon={Timer} label="Cycle" value={cycleTimeMs > 0 ? formatDuration(cycleTimeMs) : null} color="text-primary" />
          <Metric icon={Clock} label="Lead" value={leadTimeMs > 0 ? formatDuration(leadTimeMs) : null} />
          <Metric icon={Zap} label="Tokens" value={tokenDisplay} color="text-warning" />
          <Metric icon={Coins} label="Cost" value={issue.tokenUsage?.costUsd ? `$${issue.tokenUsage.costUsd.toFixed(2)}` : null} color="text-secondary" />
          <Metric icon={RotateCcw} label="Attempts" value={issue.attempts > 0 ? `${issue.attempts}/${issue.maxAttempts}` : null} />
          <Metric icon={FileCode} label="Files" value={issue.filesChanged || null} color="text-info" />
          {issue.linesAdded ? <span className="text-[10px] font-mono text-success">+{issue.linesAdded}</span> : null}
          {issue.linesRemoved ? <span className="text-[10px] font-mono text-error">-{issue.linesRemoved}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function ListView({ issues, onStateChange, onRetry, onCancel, onSelect, expanded = false }) {
  if (issues.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title="No issues match filters"
        description="Try adjusting your search or filter criteria."
      />
    );
  }

  if (expanded) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 stagger-children">
        {issues.map((issue) => (
          <GridIssueCard key={issue.id} issue={issue} onSelect={onSelect} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2 stagger-children">
      {issues.map((issue) => (
        <IssueCard key={issue.id} issue={issue} onSelect={onSelect} />
      ))}
    </div>
  );
}

export default ListView;
