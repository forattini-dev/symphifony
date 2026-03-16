import React from "react";
import { formatDate } from "../utils.js";
import { EmptyState } from "./EmptyState.jsx";
import { Activity } from "lucide-react";

const EVENT_KINDS = ["all", "info", "state", "progress", "error", "manual", "runner"];

export function EventsView({ events, kind, setKind, issueId, setIssueId, issueOptions }) {
  const rows = Array.isArray(events)
    ? events.filter((entry) => (kind === "all" || entry.kind === kind) && (issueId === "all" || entry.issueId === issueId))
    : [];

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="select select-bordered select-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="Filter by event kind"
        >
          {EVENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === "all" ? "All kinds" : k}
            </option>
          ))}
        </select>

        <select
          className="select select-bordered select-sm"
          value={issueId}
          onChange={(e) => setIssueId(e.target.value)}
          aria-label="Filter by issue"
        >
          <option value="all">All issues</option>
          {issueOptions.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>
      </div>

      {/* Event list */}
      {rows.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No events yet"
          description="Events will appear here as issues are processed."
        />
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 100).map((ev, i) => (
            <div key={`${ev.at}-${i}`} className="bg-base-200 rounded-box px-3 py-2">
              <div className="text-xs opacity-50">
                {ev.at ? formatDate(ev.at) : "-"}
                {" -- "}
                {ev.issueId || "system"}
                {" -- "}
                {ev.kind || "info"}
              </div>
              <div className="text-sm mt-0.5">{ev.message || ""}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default EventsView;
