import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Server, Play, Square, Terminal, Circle, Loader2,
  AlertTriangle, ChevronRight, Folder, Hash, Scan, Wrench, CheckCircle2,
} from "lucide-react";
import { api } from "../api.js";
import { useDashboard } from "../context/DashboardContext";
import { CreateIssueDrawer } from "../components/CreateIssueForm.jsx";
import { useServices, useServiceLog } from "../hooks/useServices.js";
import { formatDuration } from "../utils.js";
import {
  DrawerBackdrop,
  DrawerPanel,
  DrawerSection,
  DrawerFieldLabel,
  DrawerCloseButton,
} from "../components/DrawerPrimitives.jsx";

export const Route = createFileRoute("/services")({
  component: ServicesPage,
});

// ── Uptime counter ─────────────────────────────────────────────────────────────

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
  return <>{formatDuration(elapsed)}</>;
}

// ── ANSI → HTML ────────────────────────────────────────────────────────────────

const ANSI_FG = ["#3d3d3d","#c0392b","#27ae60","#d4a017","#2980b9","#8e44ad","#16a085","#bdc3c7"];
const ANSI_FG_BRIGHT = ["#666","#e74c3c","#2ecc71","#f1c40f","#3498db","#9b59b6","#1abc9c","#ecf0f1"];
const ANSI_BG = ["#1a1a1a","#6b0000","#004d1a","#4d3800","#00234d","#3a0066","#004d40","#4a4a4a"];
const ANSI_BG_BRIGHT = ["#333","#c0392b","#27ae60","#b8860b","#1a5276","#6c3483","#0e6655","#7f8c8d"];

function ansiToHtml(text) {
  const ESC = /\x1b\[([0-9;]*)m/g;
  let fg = null, bg = null, bold = false, dim = false, italic = false;
  let out = "";
  let last = 0;

  const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const flush = (raw) => {
    if (!raw) return;
    const safe = escapeHtml(raw);
    const styles = [];
    if (fg) styles.push(`color:${fg}`);
    if (bg) styles.push(`background:${bg}`);
    if (bold) styles.push("font-weight:700");
    if (dim) styles.push("opacity:0.5");
    if (italic) styles.push("font-style:italic");
    out += styles.length ? `<span style="${styles.join(";")}">${safe}</span>` : safe;
  };

  for (const m of text.matchAll(ESC)) {
    flush(text.slice(last, m.index));
    last = m.index + m[0].length;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    let i = 0;
    while (i < codes.length) {
      const c = codes[i++];
      if (c === 0) { fg = bg = null; bold = dim = italic = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 3) italic = true;
      else if (c === 22) { bold = false; dim = false; }
      else if (c === 23) italic = false;
      else if (c >= 30 && c <= 37) fg = ANSI_FG[c - 30];
      else if (c === 38) {
        if (codes[i] === 5 && i + 1 < codes.length) { i += 2; }
        else if (codes[i] === 2 && i + 3 < codes.length) { fg = `rgb(${codes[i+1]},${codes[i+2]},${codes[i+3]})`; i += 4; }
      }
      else if (c === 39) fg = null;
      else if (c >= 40 && c <= 47) bg = ANSI_BG[c - 40];
      else if (c === 49) bg = null;
      else if (c >= 90 && c <= 97) fg = ANSI_FG_BRIGHT[c - 90];
      else if (c >= 100 && c <= 107) bg = ANSI_BG_BRIGHT[c - 100];
    }
  }
  flush(text.slice(last));
  return out;
}

// ── State metadata ─────────────────────────────────────────────────────────────

function stateInfo(state) {
  const map = {
    running:  { dot: "text-success fill-success", strip: "bg-success", badge: "badge-success",          label: "Running",  spinning: false },
    starting: { dot: "text-warning fill-warning", strip: "bg-warning", badge: "badge-warning",          label: "Starting", spinning: true  },
    stopping: { dot: "text-warning fill-warning", strip: "bg-warning/60", badge: "badge-warning",       label: "Stopping", spinning: true  },
    crashed:  { dot: "text-error fill-error",     strip: "bg-error",   badge: "badge-error",            label: "Crashed",  spinning: false },
    stopped:  { dot: "opacity-20",                strip: "bg-base-300", badge: "badge-ghost opacity-50", label: "Stopped",  spinning: false },
  };
  return map[state] ?? map.stopped;
}

// ── Log viewer ─────────────────────────────────────────────────────────────────

function LogViewer({ id, running, state }) {
  const { log, connected, error } = useServiceLog(id, true);
  const logRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const html = useMemo(() => (log ? ansiToHtml(log) : ""), [log]);
  const hasLog = Boolean(log && log.trim());

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [html, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollTop + clientHeight >= scrollHeight - 40);
  }, []);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-4 py-2 bg-base-200/40 border-t border-b border-base-200 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="size-3.5 opacity-30" />
          <span className="text-[10px] font-medium opacity-40 uppercase tracking-widest">Output</span>
        </div>
        <div className="flex items-center gap-2">
          {connected
            ? <span className="flex items-center gap-1.5 text-xs text-success"><Circle className="size-2 fill-success" />live</span>
            : error
              ? <span className="text-xs text-error/70">error</span>
            : hasLog && state === "crashed"
              ? <span className="flex items-center gap-1.5 text-xs text-error/70"><Circle className="size-2 fill-current" />crash log</span>
            : hasLog
              ? <span className="text-xs opacity-45">saved log</span>
            : running
              ? <span className="flex items-center gap-1.5 text-xs opacity-35"><Loader2 className="size-2.5 animate-spin" />connecting</span>
              : <span className="text-xs opacity-25">idle</span>
          }
          {!autoScroll && (
            <button
              className="btn btn-xs btn-ghost opacity-40 hover:opacity-80"
              onClick={() => { setAutoScroll(true); logRef.current?.scrollTo(0, logRef.current.scrollHeight); }}
            >
              ↓ end
            </button>
          )}
        </div>
      </div>
      <pre
        ref={logRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed bg-base-100 min-h-0"
        dangerouslySetInnerHTML={{
          __html: html || (error
            ? `<span style="color:color-mix(in srgb, currentColor 60%, transparent)">${String(error).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>`
            : '<span style="opacity:0.2">No output yet. Start the service to see logs here.</span>'),
        }}
      />
    </div>
  );
}

// ── ServiceDrawerBody ──────────────────────────────────────────────────────────
// Pure content — works both as an inline desktop pane and inside a mobile overlay.

function ServiceDrawerBody({ service, onClose, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState(null); // null | { found, healthcheck } | "error"
  const [fixing, setFixing] = useState(false);
  const [fixDrawer, setFixDrawer] = useState({ open: false, defaultValues: null });
  const { createIssue, showToast } = useDashboard();

  const state = service.state ?? (service.running ? "running" : "stopped");
  const info = stateInfo(state);
  const canStart = state === "stopped" || state === "crashed";
  const canStop  = state === "running" || state === "starting";

  const handleStart = useCallback(async () => {
    setBusy(true);
    try { await api.post(`/services/${service.id}/start`, {}); await onRefresh(); }
    finally { setBusy(false); }
  }, [service.id, onRefresh]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try { await api.post(`/services/${service.id}/stop`, {}); await onRefresh(); }
    finally { setBusy(false); }
  }, [service.id, onRefresh]);

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    setDetectResult(null);
    try {
      const res = await api.post(`/services/${service.id}/detect-healthcheck`, {});
      setDetectResult(res.found ? { found: true, healthcheck: res.healthcheck } : { found: false });
      if (res.found) await onRefresh();
    } catch (err) {
      setDetectResult("error");
      showToast(err.message ?? "Detection failed", "error");
    } finally {
      setDetecting(false);
    }
  }, [service.id, onRefresh, showToast]);

  const handleFix = useCallback(async () => {
    setFixing(true);
    try {
      const res = await api.post(`/services/${service.id}/fix`, {});
      setFixDrawer({ open: true, defaultValues: { title: res.title, description: res.description, issueType: res.issueType } });
    } catch (err) {
      showToast(err.message ?? "Analysis failed", "error");
    } finally {
      setFixing(false);
    }
  }, [service.id, showToast]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Status strip */}
      <div className={`h-0.5 w-full shrink-0 ${info.strip} opacity-80`} />

      {/* Header */}
      <DrawerSection className="pt-4 pb-3">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <Circle className={`size-2 shrink-0 ${info.dot}`} />
              <span className={`text-xs font-medium ${state === "running" ? "text-success" : state === "crashed" ? "text-error" : state === "starting" || state === "stopping" ? "text-warning" : "opacity-40"}`}>
                {info.spinning
                  ? <span className="flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" />{info.label}</span>
                  : info.label
                }
              </span>
              {service.pid && state === "running" && (
                <span className="text-xs opacity-25 font-mono tabular-nums">pid {service.pid}</span>
              )}
            </div>
            <h2 className="text-lg font-bold leading-snug truncate">{service.name}</h2>
          </div>
          <DrawerCloseButton onClick={onClose} label="Close service panel" />
        </div>
      </DrawerSection>

      {/* Controls */}
      <DrawerSection>
        <div className="flex items-center gap-3">
          {canStop ? (
            <button className="btn btn-sm btn-error gap-1.5" onClick={handleStop} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
              Stop
            </button>
          ) : (
            <button className="btn btn-sm btn-success gap-1.5" onClick={handleStart} disabled={busy || state === "stopping"}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              Start
            </button>
          )}
          {service.running && service.startedAt && (
            <span className="text-xs opacity-40 tabular-nums">
              up <UptimeCounter startedAt={service.startedAt} running={service.running} />
            </span>
          )}
          {state === "crashed" && service.crashCount > 0 && (
            <span className="flex items-center gap-1.5 text-xs text-error/60">
              <AlertTriangle className="size-3" />
              {service.crashCount} crash{service.crashCount !== 1 ? "es" : ""}
            </span>
          )}
        </div>
      </DrawerSection>

      {/* Info */}
      <DrawerSection className="space-y-2.5">
        <div>
          <DrawerFieldLabel>Command</DrawerFieldLabel>
          <code className="block text-xs font-mono bg-base-200 px-3 py-2 rounded-lg break-all leading-relaxed opacity-80">
            {service.command}
          </code>
        </div>
        <div className="flex gap-4 flex-wrap">
          {service.cwd && (
            <div className="min-w-0">
              <DrawerFieldLabel>Dir</DrawerFieldLabel>
              <div className="flex items-center gap-1.5 text-xs font-mono opacity-50">
                <Folder className="size-3 shrink-0" />
                <span className="truncate max-w-[180px]">{service.cwd}</span>
              </div>
            </div>
          )}
          {service.port && (
            <div>
              <DrawerFieldLabel>Port</DrawerFieldLabel>
              <div className="flex items-center gap-1 text-xs font-mono opacity-50">
                <Hash className="size-3" />
                <span>{service.port}</span>
              </div>
            </div>
          )}
          {service.logSize != null && service.logSize > 0 && (
            <div>
              <DrawerFieldLabel>Log</DrawerFieldLabel>
              <div className="text-xs font-mono opacity-40">{(service.logSize / 1024).toFixed(1)} KB</div>
            </div>
          )}
        </div>
      </DrawerSection>

      {/* AI actions */}
      {(state === "running" || state === "crashed") && (
        <DrawerSection>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn btn-xs btn-ghost gap-1.5 opacity-60 hover:opacity-100"
              onClick={handleDetect}
              disabled={detecting || fixing}
              title="Detect host/port from log using AI"
            >
              {detecting ? <Loader2 className="size-3.5 animate-spin" /> : <Scan className="size-3.5" />}
              Detect Config
            </button>
            <button
              className="btn btn-xs btn-ghost gap-1.5 opacity-60 hover:opacity-100"
              onClick={handleFix}
              disabled={fixing || detecting}
              title="Analyze log and create a fix issue"
            >
              {fixing ? <Loader2 className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}
              Fix
            </button>
            {detectResult && detectResult !== "error" && (
              detectResult.found ? (
                <span className="flex items-center gap-1.5 text-xs text-success">
                  <CheckCircle2 className="size-3.5" />
                  {detectResult.healthcheck?.endpoint ?? `port ${detectResult.healthcheck?.port}`}
                </span>
              ) : (
                <span className="text-xs opacity-40">Could not detect config</span>
              )
            )}
          </div>
        </DrawerSection>
      )}

      {/* Log viewer */}
      <LogViewer id={service.id} running={service.running} state={state} />

      {/* Fix: Create issue drawer */}
      <CreateIssueDrawer
        open={fixDrawer.open}
        onClose={() => setFixDrawer({ open: false, defaultValues: null })}
        onSubmit={async (data) => { await createIssue(data); setFixDrawer({ open: false, defaultValues: null }); }}
        defaultValues={fixDrawer.defaultValues}
        onToast={showToast}
      />
    </div>
  );
}

// ── ServiceDrawer (mobile overlay) ────────────────────────────────────────────

function ServiceDrawer({ service, onClose, onRefresh }) {
  const [closing, setClosing] = useState(false);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setClosing(false); onClose(); }, 250);
  }, [onClose]);

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose]);

  return (
    <>
      <DrawerBackdrop
        onClick={handleClose}
        className={closing ? "animate-fade-out" : "animate-fade-in"}
      />
      <DrawerPanel
        closing={closing}
        width="w-full sm:w-[500px] lg:w-[40vw] lg:min-w-[520px] xl:min-w-[600px]"
        onClick={(e) => e.stopPropagation()}
      >
        <ServiceDrawerBody service={service} onClose={handleClose} onRefresh={onRefresh} />
      </DrawerPanel>
    </>
  );
}

// ── ServiceRow ─────────────────────────────────────────────────────────────────

function ServiceRow({ service, selected, onSelect }) {
  const state = service.state ?? (service.running ? "running" : "stopped");
  const info = stateInfo(state);

  return (
    <button
      type="button"
      onClick={() => onSelect(service.id)}
      className={`group w-full text-left flex items-center gap-3 px-4 py-3.5 border-b border-base-200/80 last:border-b-0 transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30
        ${selected ? "bg-base-200" : "hover:bg-base-200/50"}`}
    >
      {/* State indicator */}
      <Circle className={`size-2 shrink-0 ${info.dot} ${info.spinning ? "animate-pulse" : ""}`} />

      {/* Name + command */}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm leading-none mb-1 truncate">{service.name}</div>
        <div className="font-mono text-[11px] opacity-30 truncate">{service.command}</div>
      </div>

      {/* Uptime — visible on wider columns */}
      {service.running && service.startedAt && (
        <span className="hidden xl:block text-xs tabular-nums opacity-30 shrink-0">
          <UptimeCounter startedAt={service.startedAt} running />
        </span>
      )}

      {/* Badge */}
      <span className={`badge badge-xs shrink-0 ${info.badge}`}>{info.label}</span>

      {/* Chevron */}
      <ChevronRight className={`size-3 shrink-0 transition-opacity duration-150 ${selected ? "opacity-40" : "opacity-0 group-hover:opacity-20"}`} />
    </button>
  );
}

// ── SkeletonRow ────────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-4 py-3.5 border-b border-base-200/80 animate-pulse">
      <div className="size-2 rounded-full bg-base-300 shrink-0" />
      <div className="flex-1 space-y-1.5 min-w-0">
        <div className="h-3 w-24 rounded bg-base-300" />
        <div className="h-2 w-40 rounded bg-base-300" />
      </div>
      <div className="h-4 w-14 rounded-full bg-base-300 shrink-0" />
    </div>
  );
}

// ── ServicesPage ───────────────────────────────────────────────────────────────

function ServicesPage() {
  const { liveMode } = useDashboard();
  const { services, loading, refresh } = useServices({ pollInterval: liveMode ? false : 3_000 });
  const [selectedId, setSelectedId] = useState(null);

  const selectedService = services.find((s) => s.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId && !loading && !selectedService) setSelectedId(null);
  }, [selectedId, selectedService, loading]);

  const handleSelect = useCallback((id) => {
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const handleClose = useCallback(() => setSelectedId(null), []);

  const handleStartAll = useCallback(async () => {
    await Promise.all(services.filter((s) => !s.running).map((s) => api.post(`/services/${s.id}/start`, {})));
    await refresh();
  }, [services, refresh]);

  const handleStopAll = useCallback(async () => {
    await Promise.all(services.filter((s) => s.running).map((s) => api.post(`/services/${s.id}/stop`, {})));
    await refresh();
  }, [services, refresh]);

  const anyRunning   = services.some((s) => s.running);
  const allRunning   = services.length > 0 && services.every((s) => s.running);
  const runningCount = services.filter((s) => s.running).length;

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* ── Left: service list ──────────────────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-base-200 shrink-0">
          <div className="flex items-center gap-2">
            <Server className="size-3.5 opacity-35" />
            <span className="text-xs font-semibold opacity-55 uppercase tracking-widest">Services</span>
            {!loading && services.length > 0 && (
              <span className="text-[11px] opacity-30 tabular-nums">{runningCount}/{services.length}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {services.length > 0 && !allRunning && (
              <button className="btn btn-xs btn-ghost opacity-50 hover:opacity-90" onClick={handleStartAll}>
                Start all
              </button>
            )}
            {anyRunning && (
              <button className="btn btn-xs btn-ghost text-error opacity-50 hover:opacity-90" onClick={handleStopAll}>
                Stop all
              </button>
            )}
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        )}

        {/* Empty */}
        {!loading && services.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 py-12">
            <Server className="size-8 opacity-10" />
            <div className="text-center">
              <p className="text-sm font-medium opacity-60">No services configured</p>
              <p className="text-xs opacity-35 mt-1">
                Add services in Settings → Services to manage them here.
              </p>
            </div>
          </div>
        )}

        {/* Rows */}
        {services.map((service) => (
          <ServiceRow
            key={service.id}
            service={service}
            selected={service.id === selectedId}
            onSelect={handleSelect}
          />
        ))}
      </div>

      {/* ── Overlay drawer ─────────────────────────────────────────────────── */}
      {selectedService && (
        <ServiceDrawer
          key={selectedService.id}
          service={selectedService}
          onClose={handleClose}
          onRefresh={refresh}
        />
      )}
    </div>
  );
}
