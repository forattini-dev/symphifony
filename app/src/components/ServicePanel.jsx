import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  Terminal,
  Play,
  Square,
  ChevronDown,
  ChevronUp,
  Circle,
  Loader2,
  Server,
} from "lucide-react";
import { api } from "../api.js";
import { useServices, useServiceLog } from "../hooks/useServices.js";
import { formatDuration } from "../utils.js";
import { useDashboard } from "../context/DashboardContext.jsx";

// ── Uptime counter ────────────────────────────────────────────────────────────

function UptimeCounter({ startedAt, running }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running || !startedAt) { setElapsed(0); return; }
    const tick = () => setElapsed(Date.now() - Date.parse(startedAt));
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [running, startedAt]);

  if (!running || !startedAt) return null;
  return <span className="text-xs opacity-50 tabular-nums">{formatDuration(elapsed)}</span>;
}

// ── Log viewer ────────────────────────────────────────────────────────────────

function LogViewer({ id, visible, state }) {
  const { log, connected, error } = useServiceLog(id, visible);
  const logRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const hasLog = Boolean(log && log.trim());

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollTop + clientHeight >= scrollHeight - 40);
  }, []);

  return (
    <div className="mt-2 rounded-lg border border-base-300 bg-base-100 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-base-300 bg-base-200/50">
        <div className="flex items-center gap-2">
          <Terminal className="size-3 opacity-40" />
          <span className="text-xs opacity-50">Output</span>
        </div>
        <div className="flex items-center gap-1.5">
          {connected
            ? <span className="flex items-center gap-1 text-xs text-success"><Circle className="size-2 fill-success" /> live</span>
            : error
              ? <span className="text-xs text-error/70">error</span>
            : hasLog && state === "crashed"
              ? <span className="text-xs text-error/70">crash log</span>
              : hasLog
                ? <span className="text-xs opacity-45">saved log</span>
                : <span className="text-xs opacity-40">idle</span>
          }
        </div>
      </div>
      <pre
        ref={logRef}
        onScroll={handleScroll}
        className="text-xs font-mono p-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed"
      >
        {log || (error ? <span className="text-error/70">{error}</span> : <span className="opacity-30">No output yet.</span>)}
      </pre>
    </div>
  );
}

// ── Single service card ───────────────────────────────────────────────────────

function ServiceCard({ service, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const handleStart = useCallback(async () => {
    setBusy(true);
    try {
      await api.post(`/services/${service.id}/start`, {});
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }, [service.id, onRefresh]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await api.post(`/services/${service.id}/stop`, {});
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }, [service.id, onRefresh]);

  const state = service.state ?? (service.running ? "running" : "stopped");
  const dotColor = {
    running:  "text-success",
    starting: "text-warning",
    stopping: "text-warning",
    crashed:  "text-error",
    stopped:  "text-base-content/30",
  }[state] ?? "text-base-content/30";

  const stateLabel = {
    running:  <span className="text-xs text-success font-medium">Running</span>,
    starting: <span className="text-xs text-warning font-medium flex items-center gap-1"><Loader2 className="size-2.5 animate-spin" />Starting</span>,
    stopping: <span className="text-xs text-warning opacity-70 flex items-center gap-1"><Loader2 className="size-2.5 animate-spin" />Stopping</span>,
    crashed:  <span className="text-xs text-error font-medium">Crashed</span>,
    stopped:  <span className="text-xs opacity-40">Stopped</span>,
  }[state] ?? <span className="text-xs opacity-40">Stopped</span>;

  const canStop = state === "running" || state === "starting";

  return (
    <div className="rounded-xl border border-base-300 bg-base-100 p-4 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Circle className={`size-2.5 shrink-0 fill-current ${dotColor}`} />

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-semibold truncate">{service.name}</span>
            <span className="text-xs opacity-40 font-mono truncate">{service.command}</span>
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            {stateLabel}
            {service.pid && <span className="text-xs opacity-30 tabular-nums">PID {service.pid}</span>}
            <UptimeCounter startedAt={service.startedAt} running={service.running} />
            {state === "crashed" && (service.crashCount ?? 0) > 0 && (
              <span className="text-xs text-error/60">{service.crashCount}x</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            className="btn btn-xs btn-ghost opacity-60 hover:opacity-100"
            onClick={() => setShowLog((v) => !v)}
            title="Toggle log"
          >
            {showLog ? <ChevronUp className="size-3.5" /> : <Terminal className="size-3.5" />}
          </button>

          {canStop ? (
            <button
              className="btn btn-xs btn-ghost text-error hover:bg-error/10"
              onClick={handleStop}
              disabled={busy}
              title="Stop"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
            </button>
          ) : (
            <button
              className="btn btn-xs btn-ghost text-success hover:bg-success/10"
              onClick={handleStart}
              disabled={busy || state === "stopping"}
              title="Start"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            </button>
          )}
        </div>
      </div>

      {showLog && <LogViewer id={service.id} visible={showLog} state={state} />}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function ServicePanel() {
  const { liveMode } = useDashboard();
  const { services, loading, refresh } = useServices({ liveMode, pollInterval: liveMode ? false : 30_000 });
  const refreshServices = useCallback(() => {
    if (liveMode) return Promise.resolve();
    return refresh();
  }, [liveMode, refresh]);

  const handleStartAll = useCallback(async () => {
    await Promise.all(
      services.filter((service) => !service.running).map((service) => api.post(`/services/${service.id}/start`, {})),
    );
    await refreshServices();
  }, [services, refreshServices]);

  const handleStopAll = useCallback(async () => {
    await Promise.all(
      services.filter((service) => service.running).map((service) => api.post(`/services/${service.id}/stop`, {})),
    );
    await refreshServices();
  }, [services, refreshServices]);

  if (loading && services.length === 0) {
    return null;
  }

  if (services.length === 0) {
    return null;
  }

  const anyRunning = services.some((service) => service.running);
  const allRunning = services.every((service) => service.running);

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Server className="size-3.5 opacity-40" />
          <span className="text-xs font-semibold uppercase tracking-widest opacity-50">Services</span>
        </div>
        {services.length > 1 && (
          <div className="flex gap-1.5">
            {!allRunning && (
              <button className="btn btn-xs btn-ghost opacity-60 hover:opacity-100" onClick={handleStartAll}>
                Start all
              </button>
            )}
            {anyRunning && (
              <button className="btn btn-xs btn-ghost text-error opacity-60 hover:opacity-100" onClick={handleStopAll}>
                Stop all
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {services.map((service) => (
          <ServiceCard key={service.id} service={service} onRefresh={refreshServices} />
        ))}
      </div>
    </div>
  );
}
