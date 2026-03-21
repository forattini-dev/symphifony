import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { X, Activity, SlidersHorizontal, Zap, ArrowRight, ChevronDown } from "lucide-react";
import { timeAgo, formatDate } from "../utils.js";
import { EmptyState } from "./EmptyState.jsx";
import { useSwipeToDismiss } from "../hooks/useSwipeToDismiss.js";

const EVENT_KINDS = ["all", "info", "state", "progress", "error", "manual", "runner", "merge"];

const KIND_COLORS = {
  error: "badge-error",
  state: "badge-primary",
  progress: "badge-info",
  manual: "badge-warning",
  runner: "badge-accent",
  info: "badge-ghost",
  merge: "badge-success",
};

/** Border color for state-transition events, keyed by the new state name found in the message. */
const STATE_BORDER = {
  Planning: "border-l-info",
  PendingApproval: "border-l-warning",
  Queued: "border-l-info",
  Running: "border-l-primary",
  Reviewing: "border-l-secondary",
  PendingDecision: "border-l-success",
  Blocked: "border-l-error",
  Approved: "border-l-success",
  Cancelled: "border-l-neutral",
};

const TOKEN_RE = /([\d,]+)\s+tokens/gi;
const MAX_RENDERED = 200;
const AUTOSCROLL_THRESHOLD = 100;
const GROUP_GAP_MS = 5_000;

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** Highlight token counts in a message string, returning React nodes. */
function renderMessage(message, isTokenEvent) {
  if (!message) return "";
  if (!isTokenEvent) return message;

  const parts = [];
  let lastIndex = 0;
  let match;
  const re = new RegExp(TOKEN_RE.source, "gi");
  while ((match = re.exec(message)) !== null) {
    if (match.index > lastIndex) {
      parts.push(message.slice(lastIndex, match.index));
    }
    parts.push(
      <strong key={match.index} className="font-semibold">{match[0]}</strong>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < message.length) {
    parts.push(message.slice(lastIndex));
  }
  return parts.length > 0 ? parts : message;
}

/** Detect the target state from a state-event message. */
function detectState(message) {
  if (!message) return null;
  for (const state of Object.keys(STATE_BORDER)) {
    if (message.includes(state)) return state;
  }
  return null;
}

/** Group consecutive events for the same issue within GROUP_GAP_MS. */
function groupEvents(rows) {
  if (rows.length === 0) return [];
  const groups = [];
  let current = null;

  for (const ev of rows) {
    const ts = ev.at ? new Date(ev.at).getTime() : 0;
    if (
      current &&
      current.issueId &&
      current.issueId === ev.issueId &&
      Math.abs(ts - current.lastTs) <= GROUP_GAP_MS
    ) {
      current.events.push(ev);
      current.lastTs = ts;
    } else {
      current = { issueId: ev.issueId || null, events: [ev], lastTs: ts };
      groups.push(current);
    }
  }
  return groups;
}

/* ── Relative timestamp that ticks live ───────────────────────────────── */

function RelativeTime({ value }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);
  return <span title={formatDate(value)}>{timeAgo(value)}</span>;
}

/* ── Single event row ─────────────────────────────────────────────────── */

function EventRow({ ev }) {
  const isTokenEvent = typeof ev.message === "string" && /tokens/i.test(ev.message);
  const isState = ev.kind === "state";
  const targetState = isState ? detectState(ev.message) : null;
  const borderClass = targetState ? STATE_BORDER[targetState] : "";

  return (
    <div
      className={`bg-base-200 rounded-box px-3 py-2 ${isState ? `border-l-[3px] ${borderClass}` : ""}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="opacity-50">
          <RelativeTime value={ev.at} />
        </span>
        <span className={`badge badge-xs ${KIND_COLORS[ev.kind] || "badge-ghost"}`}>
          {ev.kind || "info"}
        </span>
        {isState && <ArrowRight className="size-3 opacity-50" />}
        {isTokenEvent && <Zap className="size-3 text-warning" />}
        {ev.issueId && (
          <span className="opacity-40 font-mono">{ev.issueId}</span>
        )}
      </div>
      <div className="text-sm mt-0.5">{renderMessage(ev.message, isTokenEvent)}</div>
    </div>
  );
}

/* ── Grouped cluster ──────────────────────────────────────────────────── */

function EventGroup({ group }) {
  // Single event — no grouping chrome needed
  if (group.events.length === 1) {
    return <EventRow ev={group.events[0]} />;
  }

  return (
    <details className="rounded-box" open>
      <summary className="flex items-center gap-2 cursor-pointer select-none px-1 py-1 text-xs font-medium opacity-70 hover:opacity-100 list-none [&::-webkit-details-marker]:hidden">
        <ChevronDown className="size-3.5 transition-transform [[open]>&]:rotate-0 [details:not([open])>&]:-rotate-90" />
        <span className="font-mono">{group.issueId || "general"}</span>
        <span className="badge badge-xs badge-neutral">{group.events.length}</span>
      </summary>
      <div className="pl-4 space-y-1.5 mt-1">
        {group.events.map((ev, i) => (
          <EventRow key={`${ev.at}-${i}`} ev={ev} />
        ))}
      </div>
    </details>
  );
}

/* ── Main drawer ──────────────────────────────────────────────────────── */

export function EventsDrawer({ open, onClose, events, kind, setKind, issueId, setIssueId, issueOptions, wsStatus }) {
  const listRef = useRef(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [hasNewEvents, setHasNewEvents] = useState(false);
  const prevCountRef = useRef(0);
  const [expandedEvent, setExpandedEvent] = useState(null);

  const { ref: swipeRef, handlers: swipeHandlers } = useSwipeToDismiss({ onDismiss: onClose, direction: "right" });

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // History integration — back button closes drawer
  useEffect(() => {
    if (!open) return;
    history.pushState({ drawer: "events" }, "");
    const handler = (e) => {
      if (e.state?.drawer !== "events") onClose();
    };
    window.addEventListener("popstate", handler);
    return () => {
      window.removeEventListener("popstate", handler);
    };
  }, [open, onClose]);

  // Filtered rows (capped at MAX_RENDERED)
  const rows = useMemo(() => {
    if (!Array.isArray(events)) return [];
    return events
      .filter((entry) => (kind === "all" || entry.kind === kind) && (issueId === "all" || entry.issueId === issueId))
      .slice(0, MAX_RENDERED);
  }, [events, kind, issueId]);

  // Grouped rows
  const groups = useMemo(() => groupEvents(rows), [rows]);

  // Track scroll position
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < AUTOSCROLL_THRESHOLD;
    setIsNearBottom(near);
    if (near) setHasNewEvents(false);
  }, []);

  // Auto-scroll or show pill when new events arrive
  useEffect(() => {
    if (rows.length > prevCountRef.current && rows.length > 0) {
      if (isNearBottom && listRef.current) {
        requestAnimationFrame(() => {
          listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
        });
      } else if (prevCountRef.current > 0) {
        setHasNewEvents(true);
      }
    }
    prevCountRef.current = rows.length;
  }, [rows.length, isNearBottom]);

  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    setHasNewEvents(false);
  }, []);

  if (!open) return null;

  const hasActiveFilters = kind !== "all" || issueId !== "all";

  return (
    <div
      className="fixed inset-0 z-40 bg-black/35 animate-fade-in"
      onClick={onClose}
    >
      <div
        ref={swipeRef}
        className="fixed top-0 right-0 z-50 h-full w-full md:w-[480px] lg:w-[540px] bg-base-100 shadow-2xl animate-slide-in-right flex flex-col"
        onClick={(e) => e.stopPropagation()}
        {...swipeHandlers}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-base-300 shrink-0">
          <div className="flex items-center gap-2">
            <Activity className="size-5 opacity-60" />
            <h2 className="text-lg font-bold">Events</h2>
            {rows.length > 0 && (
              <span className="badge badge-sm badge-neutral">{rows.length}</span>
            )}
            {wsStatus === "connected" && (
              <span className="inline-flex items-center gap-1 text-[10px] text-success font-medium ml-1">
                <span className="relative flex size-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-50" />
                  <span className="relative inline-flex rounded-full size-2 bg-success" />
                </span>
                LIVE
              </span>
            )}
          </div>
          <button type="button" className="btn btn-sm btn-ghost btn-circle" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        {/* Filters — chips on mobile, selects on desktop */}
        <div className="px-5 py-3 border-b border-base-300 space-y-2 shrink-0">
          <div className="flex items-center gap-2 text-sm font-medium opacity-60">
            <SlidersHorizontal className="size-3.5" />
            Filters
            {hasActiveFilters && (
              <span className="badge badge-xs badge-primary">active</span>
            )}
          </div>

          {/* Mobile: chips */}
          <div className="flex md:hidden overflow-x-auto gap-1.5 pb-1 -webkit-overflow-scrolling-touch">
            {EVENT_KINDS.map((k) => (
              <button
                key={k}
                className={`badge badge-sm whitespace-nowrap cursor-pointer shrink-0 ${kind === k ? (KIND_COLORS[k] || "badge-primary") : "badge-ghost"}`}
                onClick={() => setKind(k)}
              >
                {k === "all" ? "All" : k.charAt(0).toUpperCase() + k.slice(1)}
              </button>
            ))}
          </div>
          <div className="flex md:hidden overflow-x-auto gap-1.5 pb-1 -webkit-overflow-scrolling-touch">
            <button
              className={`badge badge-sm whitespace-nowrap cursor-pointer shrink-0 ${issueId === "all" ? "badge-primary" : "badge-ghost"}`}
              onClick={() => setIssueId("all")}
            >
              All issues
            </button>
            {issueOptions.map((id) => (
              <button
                key={id}
                className={`badge badge-sm font-mono whitespace-nowrap cursor-pointer shrink-0 ${issueId === id ? "badge-primary" : "badge-ghost"}`}
                onClick={() => setIssueId(id)}
              >
                {id}
              </button>
            ))}
          </div>

          {/* Desktop: selects */}
          <div className="hidden md:flex flex-wrap gap-2 items-center">
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
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto px-5 py-3 relative drawer-safe-bottom"
          onScroll={handleScroll}
        >
          {rows.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No events yet"
              description="Events will appear here as issues are processed."
            />
          ) : (
            <div className="space-y-2 stagger-children">
              {groups.map((group, i) => (
                <EventGroup key={`g-${i}-${group.events[0]?.at}`} group={group} />
              ))}
            </div>
          )}
        </div>

        {/* New events pill — positioned above mobile dock */}
        {hasNewEvents && (
          <div className="absolute left-1/2 -translate-x-1/2 z-10" style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 5rem)" }}>
            <button
              type="button"
              className="btn btn-xs btn-primary rounded-full shadow-lg animate-fade-in-up gap-1"
              onClick={scrollToBottom}
            >
              <ChevronDown className="size-3" />
              New events
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default EventsDrawer;
