import React from "react";
import { timeAgo } from "../utils.js";

const STATE_BADGE = {
  Planning: "badge-info",
  Todo: "badge-warning",
  Queued: "badge-info",
  Running: "badge-primary",
  Interrupted: "badge-accent",
  "In Review": "badge-secondary",
  Blocked: "badge-error",
  Done: "badge-success",
  Cancelled: "badge-neutral",
};

const STATE_BORDER_LEFT = {
  Planning: "border-l-info",
  Todo: "border-l-warning",
  Queued: "border-l-info",
  Running: "border-l-primary",
  Interrupted: "border-l-accent",
  "In Review": "border-l-secondary",
  Blocked: "border-l-error",
  Done: "border-l-success",
  Cancelled: "border-l-neutral",
};

export function IssueCard({ issue, onSelect, dragHandlers, isDragging }) {
  const isRunning = issue.state === "Running";

  return (
    <div
      className={`card card-compact bg-base-100 border border-base-300 border-l-[3px] ${STATE_BORDER_LEFT[issue.state] || ""} card-interactive cursor-pointer ${isRunning ? "animate-pulse-border" : ""} ${isDragging ? "kanban-card-source-opacity" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(issue)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect?.(issue);
        }
      }}
      aria-label={`Open issue ${issue.identifier}`}
      {...(dragHandlers || {})}
    >
      <div className="card-body gap-1 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="font-mono text-xs opacity-50">{issue.identifier}</span>
            <h3 className="font-semibold text-sm truncate">{issue.title}</h3>
          </div>
          <span className={`badge badge-xs ${STATE_BADGE[issue.state] || "badge-ghost"} shrink-0`}>
            {issue.state}
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-xs opacity-50">
          <span>P{issue.priority}</span>
          <span>·</span>
          <span>{timeAgo(issue.updatedAt)}</span>
          {issue.capabilityCategory && (
            <>
              <span>·</span>
              <span>{issue.capabilityCategory}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default IssueCard;
