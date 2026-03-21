import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Cpu, Circle, Clock, Terminal, CheckCircle2, XCircle, AlertTriangle, Eye, ListOrdered, Zap, Gauge, Users, Loader, ChevronDown, ChevronUp, GitMerge } from "lucide-react";
import { timeAgo, formatDuration } from "../utils.js";
import { api } from "../api.js";
import { useWorkflowConfig } from "../hooks/useWorkflowConfig.js";

const STATE_BADGE = {
  Queued: "badge-info", Running: "badge-primary", Reviewing: "badge-secondary",
  PendingDecision: "badge-success", Blocked: "badge-error", Approved: "badge-success", Merged: "badge-success", Cancelled: "badge-neutral",
  Planning: "badge-info",
};

const STATE_ICON = {
  Queued: ListOrdered, Running: Circle, Reviewing: Eye,
  PendingDecision: Eye, Blocked: AlertTriangle, Approved: CheckCircle2, Merged: GitMerge, Cancelled: XCircle,
};

function formatTokens(n) {
  if (!n || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatModelName(slug) {
  if (!slug) return null;
  const m = slug.match(/claude-(\w+)-(\d+)-(\d+)/);
  if (m) return `${m[1].charAt(0).toUpperCase() + m[1].slice(1)} ${m[2]}.${m[3]}`;
  return slug.length <= 16 ? slug : slug.slice(0, 16);
}

// ── Slot live output ────────────────────────────────────────────────────────

function SlotLiveInfo({ issueId, issueState }) {
  const [live, setLive] = useState(null);
  const [expanded, setExpanded] = useState(true);
  const logRef = useRef(null);

  const fetchLive = useCallback(async () => {
    try {
      const res = await api.get(`/live/${encodeURIComponent(issueId)}`);
      setLive(res);
    } catch { /* ignore */ }
  }, [issueId]);

  useEffect(() => {
    fetchLive();
    const interval = setInterval(fetchLive, 2000);
    return () => clearInterval(interval);
  }, [fetchLive]);

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [live?.logTail]);

  const elapsed = live && Number.isFinite(Number(live.elapsed))
    ? Number(live.elapsed)
    : live?.startedAt ? Math.max(Date.now() - new Date(live.startedAt).getTime(), 0) : 0;
  const logKb = live?.logSize ? (live.logSize / 1024).toFixed(1) : "0";

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-3 text-xs opacity-60">
        {live && (
          <>
            <span className="flex items-center gap-1"><Clock className="size-3" />{formatDuration(elapsed)}</span>
            <span>Log: {logKb} KB</span>
            {live.agentPid && <span>PID {live.agentPid}</span>}
            {live.agentAlive === false && live.agentPid && <span className="text-error">dead</span>}
          </>
        )}
        <button
          className="ml-auto flex items-center gap-0.5 opacity-50 hover:opacity-100 transition-opacity"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Collapse output" : "Expand output"}
        >
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          <span className="text-[10px]">{expanded ? "hide" : "output"}</span>
        </button>
      </div>
      {expanded && (
        <pre
          ref={logRef}
          className="text-[11px] bg-base-300 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto font-mono opacity-80 leading-relaxed break-all w-full max-w-full"
        >
          {live?.logTail || <span className="opacity-30">Waiting for output…</span>}
        </pre>
      )}
    </div>
  );
}

// ── Active agent slot ───────────────────────────────────────────────────────

function AgentSlot({ index, issue, total, workflow }) {
  if (!issue) {
    return (
      <div className="slot-idle rounded-box p-6 flex items-center justify-center opacity-30 transition-opacity duration-300 hover:opacity-40 border-2 border-dashed border-base-300">
        <div className="flex items-center gap-2 text-sm">
          <Circle className="size-5 animate-pulse-soft" />
          Slot {index + 1} -- idle
        </div>
      </div>
    );
  }

  const isRunning = issue.state === "Running";
  const isPlanning = issue.state === "Planning";
  const borderClass = issue.state === "Reviewing" || issue.state === "PendingDecision"
    ? "border-secondary bg-secondary/5"
    : isPlanning
    ? "border-info bg-info/5"
    : "border-primary bg-primary/5";

  // Resolve stage config for current phase
  const stageKey = isPlanning ? "plan" : (issue.state === "Reviewing" || issue.state === "PendingDecision") ? "review" : "execute";
  const stageConfig = workflow?.[stageKey];

  // Actual model from tokensByPhase (falls back to configured)
  const phaseKey = isPlanning ? "planner" : (issue.state === "Reviewing" || issue.state === "PendingDecision") ? "reviewer" : "executor";
  const actualModel = issue.tokensByPhase?.[phaseKey]?.model;
  const displayModel = formatModelName(actualModel || stageConfig?.model);
  const displayProvider = stageConfig?.provider;
  const displayEffort = issue.effort?.[phaseKey] || issue.effort?.default || stageConfig?.effort;

  return (
    <div className={`border-2 rounded-box p-5 space-y-2 animate-fade-in-scale overflow-hidden min-w-0 ${borderClass} ${isRunning ? "slot-active" : ""}`}>
      <div className="flex items-center justify-between min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {isPlanning
            ? <Loader className="size-4 animate-spin text-info shrink-0" />
            : <span className="loading loading-spinner loading-sm text-primary shrink-0" />
          }
          <span className="font-mono text-base font-bold truncate">{issue.identifier}</span>
          <span className={`badge badge-sm ${STATE_BADGE[issue.state] || "badge-ghost"} shrink-0`}>{issue.state}</span>
        </div>
        <span className="text-xs font-mono opacity-50 shrink-0 bg-base-200 px-2 py-0.5 rounded">Slot {index + 1}/{total}</span>
      </div>

      <div className="text-sm font-medium">{issue.title}</div>

      <div className="flex flex-wrap gap-2 text-xs opacity-60">
        {issue.capabilityCategory && <span className="badge badge-xs badge-ghost">{issue.capabilityCategory}</span>}
        <span>Attempt {(issue.attempts || 0) + 1}/{issue.maxAttempts}</span>
        {issue.startedAt && <span>started {timeAgo(issue.startedAt)}</span>}
      </div>

      {(displayProvider || displayModel || displayEffort) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {displayProvider && (
            <span className="badge badge-xs badge-ghost font-mono gap-1">
              <Terminal className="size-2.5" />{displayProvider}
            </span>
          )}
          {displayModel && <span className="badge badge-xs badge-ghost font-mono">{displayModel}</span>}
          {displayEffort && <span className="badge badge-xs badge-outline">{displayEffort}</span>}
        </div>
      )}

      <SlotLiveInfo issueId={issue.id} issueState={issue.state} />
    </div>
  );
}

// ── Queue item ──────────────────────────────────────────────────────────────

function QueueItem({ issue }) {
  const Icon = STATE_ICON[issue.state] || Circle;
  return (
    <div className="flex items-center gap-2 text-xs py-1.5 px-3 rounded-lg bg-base-200">
      <Icon className="size-3 opacity-40 shrink-0" />
      <span className="font-mono opacity-60 shrink-0">{issue.identifier}</span>
      <span className="truncate flex-1">{issue.title}</span>
      <span className={`badge badge-xs ${STATE_BADGE[issue.state] || "badge-ghost"}`}>{issue.state}</span>
      {issue.state === "Blocked" && issue.nextRetryAt && (
        <span className="opacity-40 shrink-0">retry {timeAgo(issue.nextRetryAt)}</span>
      )}
    </div>
  );
}

// ── Recently completed ──────────────────────────────────────────────────────

function CompletedItem({ issue }) {
  const Icon = issue.state === "Merged" ? GitMerge : issue.state === "Approved" ? CheckCircle2 : XCircle;
  const color = (issue.state === "Approved" || issue.state === "Merged") ? "text-success" : "text-neutral";
  return (
    <div className="flex items-center gap-2 text-xs py-1.5 px-3 rounded-lg bg-base-200">
      <Icon className={`size-3 shrink-0 ${color}`} />
      <span className="font-mono opacity-60 shrink-0">{issue.identifier}</span>
      <span className="truncate flex-1 opacity-70">{issue.title}</span>
      {issue.durationMs && <span className="opacity-40 shrink-0">{formatDuration(issue.durationMs)}</span>}
      {issue.completedAt && <span className="opacity-40 shrink-0">{timeAgo(issue.completedAt)}</span>}
    </div>
  );
}

// ── Summary cockpit bar ─────────────────────────────────────────────────────

function CockpitSummary({ running, queued, concurrency, totalTokensToday }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">
      <div className="bg-base-200 rounded-box p-3 flex items-center gap-3">
        <div className="bg-primary/10 rounded-btn p-2">
          <Users className="size-5 text-primary" />
        </div>
        <div>
          <div className="text-2xl font-bold font-mono">{running.length}<span className="text-sm opacity-50">/{concurrency}</span></div>
          <div className="text-xs opacity-50">Active agents</div>
        </div>
      </div>
      <div className="bg-base-200 rounded-box p-3 flex items-center gap-3">
        <div className="bg-info/10 rounded-btn p-2">
          <ListOrdered className="size-5 text-info" />
        </div>
        <div>
          <div className="text-2xl font-bold font-mono">{queued.length}</div>
          <div className="text-xs opacity-50">Queued</div>
        </div>
      </div>
      <div className="bg-base-200 rounded-box p-3 flex items-center gap-3">
        <div className="bg-accent/10 rounded-btn p-2">
          <Zap className="size-5 text-accent" />
        </div>
        <div>
          <div className="text-2xl font-bold font-mono">{formatTokens(totalTokensToday)}</div>
          <div className="text-xs opacity-50">Tokens today</div>
        </div>
      </div>
      <div className="bg-base-200 rounded-box p-3 flex items-center gap-3">
        <div className="bg-secondary/10 rounded-btn p-2">
          <Gauge className="size-5 text-secondary" />
        </div>
        <div>
          <div className="text-2xl font-bold font-mono">{concurrency}</div>
          <div className="text-xs opacity-50">Max parallelism</div>
        </div>
      </div>
    </div>
  );
}

// ── Main view ───────────────────────────────────────────────────────────────

export function RuntimeView({ state, providers, parallelism, onRefresh, issues: allIssues = [] }) {
  const stateIssues = Array.isArray(state.issues) ? state.issues : [];
  const concurrency = Number(state.config?.workerConcurrency) || 3;
  const { data: workflowData } = useWorkflowConfig();
  const workflow = workflowData?.workflow || null;

  const activePlanning = stateIssues.filter((i) => i.state === "Planning" && i.planningStatus === "planning");
  const running = [
    ...stateIssues.filter((i) => i.state === "Running" || i.state === "Reviewing"),
    ...activePlanning,
  ];
  const queued = stateIssues.filter((i) =>
    i.state === "PendingApproval" || i.state === "Queued"
    || (i.state === "Blocked" && i.nextRetryAt)
    || (i.state === "Planning" && i.planningStatus !== "planning"),
  );
  const completed = stateIssues
    .filter((i) => i.state === "Approved" || i.state === "Merged" || i.state === "Cancelled")
    .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""))
    .slice(0, 10);

  // Calculate tokens used today
  const totalTokensToday = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    let sum = 0;
    for (const issue of allIssues) {
      if (!issue.tokenUsage?.totalTokens) continue;
      const d = (issue.completedAt || issue.updatedAt || "").slice(0, 10);
      if (d === today) sum += issue.tokenUsage.totalTokens;
    }
    return sum;
  }, [allIssues]);

  // Build slot array
  const slots = [];
  for (let i = 0; i < concurrency; i++) {
    slots.push(running[i] || null);
  }

  return (
    <div className="space-y-5 min-w-0 overflow-hidden flex-1">
      {/* Cockpit summary */}
      <CockpitSummary running={running} queued={queued} concurrency={concurrency} totalTokensToday={totalTokensToday} />

      {/* Active agents */}
      <div className="space-y-3 min-w-0">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-1.5">
            <Cpu className="size-4 opacity-50" />
            Active Agents
          </h3>
          <span className="text-xs opacity-50">{running.length}/{concurrency} slots</span>
        </div>
        <div className="grid gap-3 min-w-0" style={{ gridTemplateColumns: `repeat(${Math.min(concurrency, 3)}, 1fr)` }}>
          {slots.map((issue, i) => (
            <AgentSlot key={i} index={i} issue={issue} total={concurrency} workflow={workflow} />
          ))}
        </div>
      </div>

      {/* Queue */}
      {queued.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm opacity-70 flex items-center gap-1.5">
            <ListOrdered className="size-4 opacity-50" />
            Queue
            <span className="badge badge-xs badge-ghost">{queued.length}</span>
          </h3>
          <div className="space-y-1 stagger-children">
            {queued.slice(0, 12).map((issue) => (
              <QueueItem key={issue.id} issue={issue} />
            ))}
            {queued.length > 12 && <div className="text-xs opacity-40 pl-3">+{queued.length - 12} more</div>}
          </div>
        </div>
      )}

      {/* Recently completed */}
      {completed.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm opacity-70 flex items-center gap-1.5">
            <CheckCircle2 className="size-4 opacity-50" />
            Recently Completed
            <span className="badge badge-xs badge-ghost">{completed.length}</span>
          </h3>
          <div className="space-y-1 stagger-children">
            {completed.map((issue) => (
              <CompletedItem key={issue.id} issue={issue} />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {running.length === 0 && queued.length === 0 && completed.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 animate-fade-in-up">
          <div className="bg-primary/10 rounded-full p-5 mb-4">
            <Cpu className="size-10 text-primary opacity-60" />
          </div>
          <h3 className="text-base font-semibold mb-1">No agents running</h3>
          <p className="text-sm opacity-50 text-center max-w-xs">
            Approve a plan on an issue to start an agent, or create a new issue from the Kanban board.
          </p>
        </div>
      )}
    </div>
  );
}

export default RuntimeView;
