import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ArrowRight, Zap, SlidersHorizontal, ChevronDown } from "lucide-react";
import { timeAgo, formatDate } from "../../../utils.js";

// ── Constants ────────────────────────────────────────────────────────────────

const EVENT_KINDS = ["all", "info", "state", "progress", "error", "manual", "runner"];

const KIND_COLORS = {
  error: "badge-error", state: "badge-primary", progress: "badge-info",
  manual: "badge-warning", runner: "badge-accent", info: "badge-ghost",
};

const STATE_BORDER_EV = {
  Planning: "border-l-info", PendingApproval: "border-l-warning", Queued: "border-l-info",
  Running: "border-l-primary", Reviewing: "border-l-secondary", PendingDecision: "border-l-success",
  Blocked: "border-l-error", Approved: "border-l-success", Cancelled: "border-l-neutral",
};

const TOKEN_RE = /([\d,]+)\s+tokens/gi;
const AUTOSCROLL_THRESHOLD = 100;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function renderEventMessage(message, isTokenEvent) {
  if (!message) return "";
  if (!isTokenEvent) return message;
  const parts = [];
  let lastIndex = 0;
  let match;
  const re = new RegExp(TOKEN_RE.source, "gi");
  while ((match = re.exec(message)) !== null) {
    if (match.index > lastIndex) parts.push(message.slice(lastIndex, match.index));
    parts.push(<strong key={match.index} className="font-semibold">{match[0]}</strong>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < message.length) parts.push(message.slice(lastIndex));
  return parts.length > 0 ? parts : message;
}

export function detectEventState(message) {
  if (!message) return null;
  for (const state of Object.keys(STATE_BORDER_EV)) {
    if (message.includes(state)) return state;
  }
  return null;
}

// ── RelativeTime ──────────────────────────────────────────────────────────────

export function RelativeTime({ value }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);
  return <span title={formatDate(value)}>{timeAgo(value)}</span>;
}

// ── EventRow ──────────────────────────────────────────────────────────────────

export function EventRow({ ev }) {
  const isTokenEvent = typeof ev.message === "string" && /tokens/i.test(ev.message);
  const isState = ev.kind === "state";
  const targetState = isState ? detectEventState(ev.message) : null;
  const borderClass = targetState ? STATE_BORDER_EV[targetState] : "";

  return (
    <div className={`bg-base-200 rounded-box px-3 py-2 ${isState ? `border-l-[3px] ${borderClass}` : ""}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className="opacity-50"><RelativeTime value={ev.at} /></span>
        <span className={`badge badge-xs ${KIND_COLORS[ev.kind] || "badge-ghost"}`}>{ev.kind || "info"}</span>
        {isState && <ArrowRight className="size-3 opacity-50" />}
        {isTokenEvent && <Zap className="size-3 text-warning" />}
      </div>
      <div className="text-sm mt-0.5">{renderEventMessage(ev.message, isTokenEvent)}</div>
    </div>
  );
}

// ── EventsTab ─────────────────────────────────────────────────────────────────

export function EventsTab({ issueId, events }) {
  const [kindFilter, setKindFilter] = useState("all");
  const listRef = useRef(null);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [hasNewEvents, setHasNewEvents] = useState(false);
  const prevCountRef = useRef(0);

  const rows = useMemo(() => {
    if (!Array.isArray(events)) return [];
    return events
      .filter((ev) => ev.issueId === issueId && (kindFilter === "all" || ev.kind === kindFilter))
      .slice(0, 200);
  }, [events, issueId, kindFilter]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < AUTOSCROLL_THRESHOLD;
    setIsNearBottom(near);
    if (near) setHasNewEvents(false);
  }, []);

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

  return (
    <div className="flex flex-col h-full -mx-6 -my-4">
      {/* Filter bar */}
      <div className="px-5 py-2.5 border-b border-base-300 flex items-center gap-2 shrink-0">
        <SlidersHorizontal className="size-3.5 opacity-50" />
        <select
          className="select select-bordered select-xs"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          aria-label="Filter by event kind"
        >
          {EVENT_KINDS.map((k) => (
            <option key={k} value={k}>{k === "all" ? "All kinds" : k.charAt(0).toUpperCase() + k.slice(1)}</option>
          ))}
        </select>
        {rows.length > 0 && <span className="badge badge-xs badge-neutral ml-auto">{rows.length}</span>}
      </div>

      {/* Event list */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-5 py-3 relative" onScroll={handleScroll}>
        {rows.length === 0 ? (
          <div className="text-sm opacity-40 text-center py-8">No events for this issue yet.</div>
        ) : (
          <div className="space-y-2">
            {rows.map((ev, i) => <EventRow key={`${ev.at}-${i}`} ev={ev} />)}
          </div>
        )}
      </div>

      {/* New events pill */}
      {hasNewEvents && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10">
          <button
            type="button"
            className="btn btn-xs btn-primary rounded-full shadow-lg animate-fade-in-up gap-1"
            onClick={scrollToBottom}
          >
            <ChevronDown className="size-3" /> New events
          </button>
        </div>
      )}
    </div>
  );
}
