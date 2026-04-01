import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { X, FileText, Clock, GitBranch } from "lucide-react";
import { api } from "../api.js";
import { formatDuration, timeAgo } from "../utils.js";
import { useDashboard } from "../context/DashboardContext.jsx";
import { useIssueLog } from "../hooks/useIssueLog.js";

const ROLE_BADGE = {
  planner: "badge-info",
  executor: "badge-primary",
  reviewer: "badge-secondary",
};

const ACTIVE_STATES = new Set(["Planning", "Queued", "Running", "Reviewing"]);

function formatTime(isoStr) {
  if (!isoStr) return "--:--:--";
  const d = new Date(isoStr);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatTokens(n) {
  if (!n || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function TurnLogLine({ turn }) {
  const roleClass = ROLE_BADGE[turn.role] || "badge-ghost";
  const tokens = turn.tokenUsage?.totalTokens;
  const toolCount = turn.toolsUsed?.length || 0;
  const cmdCount = turn.commandsRun?.length || 0;
  const contextCount = turn.contextPack?.hits?.length || 0;
  const contextPreview = (turn.contextPack?.hits || [])
    .slice(0, 2)
    .map((hit) => hit.path || hit.sourceId || hit.kind)
    .filter(Boolean)
    .join(" • ");

  return (
    <div className="py-1 group">
      <div className="flex items-start gap-2.5">
        <span className="opacity-25 shrink-0 tabular-nums text-[11px]">[{formatTime(turn.startedAt)}]</span>
        <span className={`badge badge-xs ${roleClass} shrink-0 mt-0.5`}>{turn.role || "agent"}</span>
        <span className="flex-1 opacity-80 leading-relaxed">
          {turn.directiveSummary || `Turn ${turn.turn}`}
        </span>
        <div className="flex items-center gap-2 opacity-25 shrink-0 text-[11px]">
          {tokens > 0 && <span>{formatTokens(tokens)}tk</span>}
          {contextCount > 0 && <span>{contextCount}ctx</span>}
          {toolCount > 0 && <span>{toolCount}t</span>}
          {cmdCount > 0 && <span>{cmdCount}c</span>}
        </div>
      </div>
      {contextPreview && (
        <div className="ml-[86px] mt-1 text-[11px] opacity-35">
          context: {contextPreview}
        </div>
      )}
      {turn.traceSteps?.length > 0 && (
        <div className="ml-[86px] mt-1 text-[11px] opacity-25">
          trace: {turn.traceSteps.map((step) => step.label).slice(0, 3).join(" • ")}
        </div>
      )}
    </div>
  );
}

export function AgentSessionLogModal({ issue, onClose }) {
  const [sessions, setSessions] = useState([]);
  const [lastFetched, setLastFetched] = useState(null);
  const logRef = useRef(null);
  const prevTurnsCount = useRef(0);
  const prevLiveLog = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  const isActive = ACTIVE_STATES.has(issue?.state);
  const { liveMode } = useDashboard();
  const { log: liveLog } = useIssueLog(issue?.id, isActive, liveMode);

  const fetchSessions = useCallback(async () => {
    if (!issue?.id) return;
    try {
      const res = await api.get(`/agent_sessions?issueId=${encodeURIComponent(issue.id)}`);
      const list = Array.isArray(res) ? res : [];
      setSessions(list);
      setLastFetched(new Date());
    } catch { /* ignore */ }
  }, [issue?.id]);

  useEffect(() => {
    fetchSessions();
    if (!isActive) return;
    const id = setInterval(fetchSessions, 5000);
    return () => clearInterval(id);
  }, [fetchSessions, isActive]);

  // Live elapsed counter
  useEffect(() => {
    if (!issue?.startedAt) return;
    const calc = () => setElapsed(Math.max(0, Date.now() - new Date(issue.startedAt).getTime()));
    calc();
    const id = setInterval(calc, 1000);
    return () => clearInterval(id);
  }, [issue?.startedAt]);

  // Flatten + sort turns across all sessions
  const allTurns = useMemo(() => {
    return sessions
      .flatMap((s) =>
        (s.session?.turns || []).map((t) => ({
          ...t,
          provider: s.provider,
          _role: t.role || s.role,
        }))
      )
      .sort((a, b) => a.turn - b.turn);
  }, [sessions]);

  // Auto-scroll on new turns or new log content
  useEffect(() => {
    const newTurns = allTurns.length > prevTurnsCount.current;
    const newLog = liveLog !== prevLiveLog.current;
    if ((newTurns || newLog) && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
    prevTurnsCount.current = allTurns.length;
    prevLiveLog.current = liveLog;
  }, [allTurns, liveLog]);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!issue) return null;

  const totalTokens = allTurns.reduce((sum, t) => sum + (t.tokenUsage?.totalTokens || 0), 0);
  const attempt = issue.attempts ?? 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl bg-base-200 rounded-box shadow-2xl flex flex-col max-h-[85vh] animate-fade-in-scale"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-base-300 shrink-0">
          <span className="badge badge-sm font-mono font-bold shrink-0">{issue.identifier}</span>
          <h2 className="font-semibold flex-1 truncate text-sm">{issue.title}</h2>
          <button className="btn btn-ghost btn-sm btn-square shrink-0" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-3 px-5 py-2 text-xs opacity-40 font-mono border-b border-base-300 shrink-0 flex-wrap">
          <span>attempt {attempt + 1}</span>
          <span>·</span>
          <span>{allTurns.length} turns</span>
          <span>·</span>
          <span>{formatTokens(totalTokens)} tokens</span>
          {issue.startedAt && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1">
                <Clock className="size-3" />
                {formatDuration(elapsed)}
              </span>
            </>
          )}
          {issue.branch && (
            <>
              <span>·</span>
              <span className="flex items-center gap-1">
                <GitBranch className="size-3" />
                {issue.branch}
              </span>
            </>
          )}
          {issue.workspace && (
            <>
              <span>·</span>
              <span className="truncate max-w-[160px]" title={issue.workspace}>
                {issue.workspace.split("/").slice(-2).join("/")}
              </span>
            </>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {isActive && (
              <span className="size-1.5 rounded-full bg-success animate-pulse inline-block" />
            )}
            {isActive ? "Live" : "Completed"}
          </span>
        </div>

        {/* Log body */}
        <div
          ref={logRef}
          className="flex-1 overflow-y-auto px-5 py-3 font-mono text-xs leading-relaxed min-h-0"
        >
          {allTurns.length === 0 && !liveTail?.logTail ? (
            <div className="flex flex-col items-center justify-center py-16 opacity-25">
              <FileText className="size-10 mb-3" />
              <span>No turns recorded yet…</span>
            </div>
          ) : (
            <div className="divide-y divide-base-300/50">
              {allTurns.map((turn, i) => (
                <TurnLogLine key={i} turn={{ ...turn, role: turn._role }} />
              ))}
            </div>
          )}

          {/* Live log — WS-streamed, only shown when active and has output */}
          {isActive && liveLog && (
            <div className="mt-3">
              <div className="flex items-center gap-1.5 mb-2 opacity-30">
                <span className="size-1.5 rounded-full bg-success animate-pulse inline-block" />
                <span className="text-[9px] uppercase tracking-widest font-bold">Live output</span>
              </div>
              <pre className="text-[11px] bg-base-300 rounded-box p-3 whitespace-pre-wrap opacity-70 leading-relaxed break-all">
                {liveLog}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-2 border-t border-base-300 shrink-0 text-xs opacity-30 font-mono">
          <span>Read-only</span>
          {lastFetched && <span>updated {timeAgo(lastFetched)}</span>}
        </div>
      </div>
    </div>
  );
}

export default AgentSessionLogModal;
