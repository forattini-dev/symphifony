import React from "react";
import { timeAgo } from "../utils.js";

const STATE_BADGE = {
  Todo: "badge-warning",
  Queued: "badge-info",
  Running: "badge-primary",
  Interrupted: "badge-accent",
  "In Review": "badge-secondary",
  Blocked: "badge-error",
  Done: "badge-success",
  Cancelled: "badge-neutral",
};

export function IssueCard({ issue, onSelect }) {
  return (
    <div
      className="card card-compact bg-base-100 border border-base-300 transition-shadow hover:shadow-md cursor-pointer"
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
