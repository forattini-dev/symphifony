import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, Cpu, Circle, PlayCircle, Eye, AlertTriangle, Clock, Terminal } from "lucide-react";
import { formatDate, timeAgo } from "../utils.js";
import { api } from "../api.js";

const STATE_ICON = {
  "In Progress": PlayCircle,
  "In Review": Eye,
};

const STATE_COLOR = {
  "In Progress": "text-primary",
  "In Review": "text-secondary",
};

function SlotLiveInfo({ issueId }) {
  const [live, setLive] = useState(null);

  const fetchLive = useCallback(async () => {
    try {
      const res = await api.get(`/issues/${encodeURIComponent(issueId)}/live`);
      setLive(res);
    } catch { /* ignore */ }
  }, [issueId]);

  useEffect(() => {
    fetchLive();
    const interval = setInterval(fetchLive, 4000);
    return () => clearInterval(interval);
  }, [fetchLive]);

  if (!live) return null;

  const elapsed = live.elapsed || 0;
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const logKb = live.logSize ? (live.logSize / 1024).toFixed(1) : "0";

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-3 text-xs opacity-60">
        <span className="flex items-center gap-1"><Clock className="size-3" />{mins}m {secs}s</span>
        <span>Log: {logKb} KB</span>
      </div>
      {live.logTail && (
        <pre className="text-[10px] bg-base-300 rounded-box p-2 overflow-x-auto whitespace-pre-wrap max-h-24 overflow-y-auto font-mono opacity-70 leading-relaxed">
          {live.logTail.slice(-800)}
        </pre>
      )}
    </div>
  );
}

function WorkerSlot({ index, issue }) {
  if (!issue) {
    return (
      <div className="border border-base-300 border-dashed rounded-box p-4 flex items-center justify-center opacity-30">
        <div className="flex items-center gap-2 text-sm">
          <Circle className="size-4" />
          Slot {index + 1} — idle
        </div>
      </div>
    );
  }

  const Icon = STATE_ICON[issue.state] || PlayCircle;
  const color = STATE_COLOR[issue.state] || "text-primary";

  return (
    <div className={`border rounded-box p-4 space-y-2 ${issue.state === "In Review" ? "border-secondary/40 bg-secondary/5" : "border-primary/40 bg-primary/5"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="loading loading-spinner loading-xs text-primary" />
          <span className="font-mono text-sm font-semibold">{issue.identifier}</span>
          <span className={`badge badge-xs ${color.replace("text-", "badge-")}`}>{issue.state}</span>
        </div>
        <span className="text-xs opacity-40">Slot {index + 1}</span>
      </div>

      <div className="text-sm truncate">{issue.title}</div>

      <div className="flex flex-wrap gap-2 text-xs opacity-50">
        {issue.capabilityCategory && <span className="badge badge-xs badge-ghost">{issue.capabilityCategory}</span>}
        <span>P{issue.priority}</span>
        <span>Attempt {(issue.attempts || 0) + 1}/{issue.maxAttempts}</span>
        {issue.startedAt && <span>started {timeAgo(issue.startedAt)}</span>}
      </div>

      <SlotLiveInfo issueId={issue.id} />
    </div>
  );
}

function WorkerSlots({ issues, concurrency }) {
  const executing = issues.filter((i) => i.state === "In Progress" || i.state === "In Review");
  const slots = [];
  for (let i = 0; i < concurrency; i++) {
    slots.push(executing[i] || null);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm flex items-center gap-1.5">
          <Cpu className="size-4 opacity-50" />
          Worker Slots
        </h3>
        <span className="text-xs opacity-50">{executing.length}/{concurrency} active</span>
      </div>
      <div className="grid gap-3">
        {slots.map((issue, i) => (
          <WorkerSlot key={i} index={i} issue={issue} />
        ))}
      </div>
    </div>
  );
}

function QueuePreview({ issues }) {
  const queued = issues.filter((i) => i.state === "Todo" || (i.state === "Blocked" && i.nextRetryAt));
  if (queued.length === 0) return null;

  return (
    <div className="space-y-2">
      <h3 className="font-semibold text-sm opacity-70">Queue ({queued.length})</h3>
      <div className="space-y-1">
        {queued.slice(0, 8).map((issue) => (
          <div key={issue.id} className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-base-200">
            <span className="font-mono opacity-60">{issue.identifier}</span>
            <span className="truncate flex-1 opacity-70">{issue.title}</span>
            <span className="badge badge-xs badge-ghost">{issue.state}</span>
            {issue.state === "Blocked" && issue.nextRetryAt && (
              <span className="opacity-40">retry {timeAgo(issue.nextRetryAt)}</span>
            )}
          </div>
        ))}
        {queued.length > 8 && <div className="text-xs opacity-40 pl-2">+{queued.length - 8} more</div>}
      </div>
    </div>
  );
}

export function RuntimeView({ state, providers, parallelism, onRefresh, concurrency, setConcurrency, saveConcurrency }) {
  const issues = Array.isArray(state.issues) ? state.issues : [];
  const numConcurrency = Number(concurrency) || 2;

  return (
    <div className="space-y-5">
      {/* Worker Slots */}
      <WorkerSlots issues={issues} concurrency={numConcurrency} />

      {/* Queue */}
      <QueuePreview issues={issues} />

      {/* Runtime config */}
      <div className="card bg-base-200">
        <div className="card-body gap-3">
          <h3 className="card-title text-sm">Configuration</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <div><span className="opacity-50">Source</span><div className="truncate">{state.sourceRepoUrl || "local"}</div></div>
            <div><span className="opacity-50">Tracker</span><div>{state.trackerKind || "filesystem"}</div></div>
            <div><span className="opacity-50">Provider</span><div>{state.config?.agentProvider || "auto"}</div></div>
            <div><span className="opacity-50">Started</span><div>{formatDate(state.startedAt)}</div></div>
            <div><span className="opacity-50">Timeout</span><div>{state.config?.commandTimeoutMs ? `${Math.round(state.config.commandTimeoutMs / 60000)}m` : "-"}</div></div>
            <div><span className="opacity-50">Max turns</span><div>{state.config?.maxTurns || "-"}</div></div>
          </div>

          <div className="flex items-center gap-2 mt-1">
            <label className="text-xs font-medium" htmlFor="concurrency-input">Concurrency:</label>
            <input
              id="concurrency-input"
              className="input input-bordered input-sm w-20"
              type="number"
              min={1}
              max={16}
              value={concurrency}
              onChange={(e) => setConcurrency(e.target.value)}
            />
            <button className="btn btn-sm btn-primary" onClick={saveConcurrency}>Set</button>
            <button className="btn btn-sm btn-soft gap-1 ml-auto" onClick={onRefresh}>
              <RefreshCw className="size-3.5" /> Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Providers */}
        <div className="card bg-base-200">
          <div className="card-body">
            <h3 className="card-title text-sm">Providers</h3>
            <div className="flex flex-wrap gap-2">
              {providers?.providers?.length ? (
                providers.providers.map((p) => (
                  <span key={p.name} className={`badge badge-sm ${p.available ? "badge-success" : "badge-warning"}`}>
                    {p.name} {p.path ? `(${p.path})` : ""}
                  </span>
                ))
              ) : (
                <span className="text-sm opacity-50">None</span>
              )}
            </div>
          </div>
        </div>

        {/* Parallelism */}
        <div className="card bg-base-200">
          <div className="card-body">
            <h3 className="card-title text-sm">Parallelism Analysis</h3>
            <p className="text-sm">
              {typeof parallelism?.maxSafeParallelism === "number"
                ? `Max safe: ${parallelism.maxSafeParallelism}`
                : "No data"}
            </p>
            {parallelism?.reason && (
              <p className="text-xs opacity-60">{parallelism.reason}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default RuntimeView;
