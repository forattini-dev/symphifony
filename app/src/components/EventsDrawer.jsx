import React, { useEffect } from "react";
import { X, Activity, SlidersHorizontal } from "lucide-react";
import { formatDate } from "../utils.js";
import { EmptyState } from "./EmptyState.jsx";

const EVENT_KINDS = ["all", "info", "state", "progress", "error", "manual", "runner"];

const KIND_COLORS = {
  error: "badge-error",
  state: "badge-primary",
  progress: "badge-info",
  manual: "badge-warning",
  runner: "badge-accent",
  info: "badge-ghost",
};

export function EventsDrawer({ open, onClose, events, kind, setKind, issueId, setIssueId, issueOptions }) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const rows = Array.isArray(events)
    ? events.filter((entry) => (kind === "all" || entry.kind === kind) && (issueId === "all" || entry.issueId === issueId))
    : [];

  const hasActiveFilters = kind !== "all" || issueId !== "all";

  return (
    <div
      className="fixed inset-0 z-40 bg-black/35 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="fixed top-0 right-0 z-50 h-full w-full md:w-[480px] lg:w-[540px] bg-base-100 shadow-2xl animate-slide-in-right flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-base-300 shrink-0">
          <div className="flex items-center gap-2">
            <Activity className="size-5 opacity-60" />
            <h2 className="text-lg font-bold">Events</h2>
            {rows.length > 0 && (
              <span className="badge badge-sm badge-neutral">{rows.length}</span>
            )}
          </div>
          <button type="button" className="btn btn-sm btn-ghost btn-circle" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        {/* Filters */}
        <div className="px-5 py-3 border-b border-base-300 space-y-2 shrink-0">
          <div className="flex items-center gap-2 text-sm font-medium opacity-60">
            <SlidersHorizontal className="size-3.5" />
            Filters
            {hasActiveFilters && (
              <span className="badge badge-xs badge-primary">active</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <select
              className="select select-bordered select-sm flex-1 min-w-[140px]"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-label="Filter by event kind"
            >
              {EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === "all" ? "All kinds" : k.charAt(0).toUpperCase() + k.slice(1)}
                </option>
              ))}
            </select>

            <select
              className="select select-bordered select-sm flex-1 min-w-[140px]"
              value={issueId}
              onChange={(e) => setIssueId(e.target.value)}
              aria-label="Filter by issue"
            >
              <option value="all">All issues</option>
              {issueOptions.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>

            {hasActiveFilters && (
              <button
                className="btn btn-xs btn-ghost opacity-60"
                onClick={() => { setKind("all"); setIssueId("all"); }}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Event list */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {rows.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No events yet"
              description="Events will appear here as issues are processed."
            />
          ) : (
            <div className="space-y-2 stagger-children">
              {rows.slice(0, 100).map((ev, i) => (
                <div key={`${ev.at}-${i}`} className="bg-base-200 rounded-box px-3 py-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="opacity-50">{ev.at ? formatDate(ev.at) : "-"}</span>
                    <span className={`badge badge-xs ${KIND_COLORS[ev.kind] || "badge-ghost"}`}>
                      {ev.kind || "info"}
                    </span>
                    {ev.issueId && (
                      <span className="opacity-40 font-mono">{ev.issueId}</span>
                    )}
                  </div>
                  <div className="text-sm mt-0.5">{ev.message || ""}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default EventsDrawer;
