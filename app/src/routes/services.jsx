import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Server, Play, Square, Terminal, Circle, Loader2, X,
  AlertTriangle, ChevronRight, Folder, Scan, Wrench, CheckCircle2,
} from "lucide-react";
import { api } from "../api.js";
import { useDashboard } from "../context/DashboardContext";
import { CreateIssueDrawer } from "../components/CreateIssueForm.jsx";
import { useServices, onServiceLog, dispatchServiceLog } from "../hooks/useServices.js";
import { subscribeServiceLog, unsubscribeServiceLog } from "../hooks.js";
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

const REFRESH_PRESETS = [
  { label: "WS",  value: 0 },       // WebSocket push — no polling
  { label: "5s",  value: 5_000 },
  { label: "10s", value: 10_000 },
  { label: "30s", value: 30_000 },
  { label: "1m",  value: 60_000 },
  { label: "5m",  value: 300_000 },
];

function LogViewer({ id, running, state }) {
  const [log, setLog] = useState("");
  const [logSize, setLogSize] = useState(0);
  const [status, setStatus] = useState("idle"); // idle | loading | live | error
  const [error, setError] = useState(null);
  const [pollInterval, setPollInterval] = useState(0); // 0 = WS-only, no HTTP poll
  const logRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const html = useMemo(() => (log ? ansiToHtml(log) : ""), [log]);
  const hasLog = Boolean(log && log.trim());
  const lastSizeRef = useRef(0);

  // Initial full fetch
  const fetchFull = useCallback(async () => {
    if (!id) return;
    setStatus("loading");
    setError(null);
    try {
      const res = await api.get(`/services/${encodeURIComponent(id)}/log`);
      setLog(res.logTail ?? "");
      lastSizeRef.current = res.logSize ?? 0;
      setLogSize(res.logSize ?? 0);
      setStatus("live");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load logs.");
      setStatus("error");
    }
  }, [id]);

  // Incremental fetch — only new bytes since last known position
  const fetchIncremental = useCallback(async () => {
    if (!id) return;
    try {
      const res = await api.get(`/services/${encodeURIComponent(id)}/log?after=${lastSizeRef.current}`);
      if (res.text) {
        setLog((prev) => prev + res.text);
        lastSizeRef.current = res.logSize ?? lastSizeRef.current;
        setLogSize(res.logSize ?? lastSizeRef.current);
      } else if ((res.logSize ?? lastSizeRef.current) < lastSizeRef.current) {
        fetchFull(); // Log truncated — service restarted
      }
    } catch {
      /* non-critical — will retry on next interval */
    }
  }, [id, fetchFull]);

  // Mount: fetch full log + subscribe to WS log room
  useEffect(() => {
    setLog("");
    lastSizeRef.current = 0;
    setLogSize(0);
    setStatus("idle");
    if (!id) return;

    fetchFull();
    subscribeServiceLog(id);

    const unsub = onServiceLog(id, (chunk) => {
      setLog((prev) => prev + chunk);
      lastSizeRef.current += new TextEncoder().encode(chunk).length;
      setStatus("live");
    });

    return () => {
      unsubscribeServiceLog(id);
      unsub();
    };
  }, [id, fetchFull]);

  // Polling at selected interval (fallback / user preference)
  useEffect(() => {
    if (!pollInterval || !id) return;
    const timer = setInterval(fetchIncremental, pollInterval);
    return () => clearInterval(timer);
  }, [pollInterval, id, fetchIncremental]);

  // Auto-scroll
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

  const statusBadge = status === "loading"
    ? <span className="flex items-center gap-1.5 text-xs opacity-40"><Loader2 className="size-2.5 animate-spin" />loading</span>
    : status === "error"
      ? <span className="text-xs text-error/70">error</span>
    : hasLog && state === "crashed"
      ? <span className="flex items-center gap-1.5 text-xs text-error/70"><Circle className="size-2 fill-current" />crash log</span>
    : status === "live"
      ? <span className="flex items-center gap-1.5 text-xs text-success"><Circle className="size-2 fill-success" />{pollInterval === 0 ? "ws" : "live"}</span>
    : hasLog
      ? <span className="text-xs opacity-45">saved log</span>
    : <span className="text-xs opacity-25">no output</span>;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-4 py-2 bg-base-200/40 border-t border-b border-base-200 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="size-3.5 opacity-30" />
          <span className="text-[10px] font-medium opacity-40 uppercase tracking-widest">Output</span>
        </div>
        <div className="flex items-center gap-2">
          {statusBadge}
          {/* Refresh interval selector */}
          <div className="flex items-center gap-0.5 border border-base-300 rounded overflow-hidden ml-1">
            {REFRESH_PRESETS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPollInterval(p.value)}
                className={`px-1.5 py-0.5 text-[10px] font-mono transition-colors ${
                  pollInterval === p.value
                    ? "bg-primary text-primary-content"
                    : "hover:bg-base-300 opacity-50 hover:opacity-100"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <button
            className="btn btn-xs btn-ghost opacity-40 hover:opacity-80 px-1.5"
            onClick={fetchFull}
            title="Reload full log"
          >
            ↺
          </button>
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
  const [fixDiagnosis, setFixDiagnosis] = useState(null); // null | { healthy: true } | { healthy: false, title, description, issueType } | { error: string }
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

  const handleAnalyze = useCallback(async () => {
    setFixing(true);
    setFixDiagnosis(null);
    try {
      const res = await api.post(`/services/${service.id}/fix`, {});
      if (!res.hasProblem) {
        setFixDiagnosis({ healthy: true });
      } else {
        setFixDiagnosis({ healthy: false, title: res.title, description: res.description, issueType: res.issueType });
      }
    } catch (err) {
      setFixDiagnosis({ error: err.message ?? "Analysis failed" });
    } finally {
      setFixing(false);
    }
  }, [service.id]);

  const stateColor = state === "running" ? "text-success" : state === "crashed" ? "text-error" : state === "starting" || state === "stopping" ? "text-warning" : "opacity-35";

  // Diagnosis panel visibility + severity
  const hasDiagnosisPanel = Boolean(fixDiagnosis && !fixDiagnosis.healthy);
  const diagnosisCritical = Boolean(hasDiagnosisPanel && (fixDiagnosis?.error || state === "crashed"));

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Thin accent strip */}
      <div className={`h-px w-full shrink-0 ${info.strip} opacity-60`} />

      {/* ── Row 1: title + state + action + close ───────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        <Circle className={`size-1.5 shrink-0 ${info.dot} ${info.spinning ? "animate-pulse" : ""}`} />
        <span className="font-semibold text-sm truncate flex-1 leading-none">{service.name}</span>
        {service.pid && state === "running" && (
          <span className="text-[11px] font-mono opacity-25 tabular-nums shrink-0">pid {service.pid}</span>
        )}
        <span className={`text-[11px] font-medium shrink-0 ${stateColor}`}>
          {info.spinning
            ? <span className="flex items-center gap-1"><Loader2 className="size-3 animate-spin" />{info.label}</span>
            : info.label}
        </span>
        {canStop ? (
          <button className="btn btn-xs btn-error h-6 min-h-0 gap-1 px-2 shrink-0" onClick={handleStop} disabled={busy}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Square className="size-3" />}
            Stop
          </button>
        ) : (
          <button className="btn btn-xs btn-success h-6 min-h-0 gap-1 px-2 shrink-0" onClick={handleStart} disabled={busy || state === "stopping"}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
            Start
          </button>
        )}
        <button onClick={onClose} className="btn btn-ghost btn-xs btn-circle h-6 min-h-0 w-6 opacity-40 hover:opacity-80 shrink-0">
          <X className="size-3.5" />
        </button>
      </div>

      {/* ── Row 2: command + meta ────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-base-200/60 shrink-0 min-w-0">
        <code className="text-[11px] font-mono opacity-50 truncate flex-1 leading-none">{service.command}</code>
        {service.cwd && (
          <span className="flex items-center gap-1 text-[11px] font-mono opacity-30 shrink-0">
            <Folder className="size-3" />{service.cwd}
          </span>
        )}
        {service.logSize != null && service.logSize > 0 && (
          <span className="text-[11px] font-mono opacity-25 shrink-0 tabular-nums">{(service.logSize / 1024).toFixed(1)}KB</span>
        )}
        {service.running && service.startedAt && (
          <span className="text-[11px] opacity-30 shrink-0 tabular-nums">
            <UptimeCounter startedAt={service.startedAt} running={service.running} />
          </span>
        )}
        {state === "crashed" && service.crashCount > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-error/50 shrink-0">
            <AlertTriangle className="size-3" />{service.crashCount}
          </span>
        )}
      </div>

      {/* ── Row 3: AI toolbar ───────────────────────────────────────────────── */}
      {(state === "running" || state === "crashed") && (
        <div className="flex items-center gap-0.5 px-2 py-1 border-t border-base-200/60 bg-base-200/20 shrink-0">
          <button
            className="btn btn-xs btn-ghost h-6 min-h-0 gap-1 px-2 text-[11px] opacity-50 hover:opacity-90"
            onClick={handleDetect}
            disabled={detecting || fixing}
          >
            {detecting ? <Loader2 className="size-3 animate-spin" /> : <Scan className="size-3" />}
            {detecting ? "Scanning…" : "Detect"}
          </button>
          {detectResult && detectResult !== "error" && (
            detectResult.found ? (
              <span className="flex items-center gap-1 text-[11px] text-success">
                <CheckCircle2 className="size-3" />
                {detectResult.healthcheck?.endpoint ?? `port ${detectResult.healthcheck?.port}`}
              </span>
            ) : (
              <span className="text-[11px] opacity-30">no config detected</span>
            )
          )}
          <div className="flex-1" />
          <div className="w-px h-3 bg-base-content/10 mx-0.5 shrink-0" />
          <button
            className="btn btn-xs btn-ghost h-6 min-h-0 gap-1 px-2 text-[11px] opacity-50 hover:opacity-90"
            onClick={handleAnalyze}
            disabled={fixing || detecting}
          >
            {fixing ? <Loader2 className="size-3 animate-spin" /> : <Wrench className="size-3" />}
            {fixing ? "Analyzing…" : "Analyze"}
          </button>
          {fixDiagnosis?.healthy && (
            <span className="flex items-center gap-1 text-[11px] text-success/70">
              <CheckCircle2 className="size-3 shrink-0" />Clean
            </span>
          )}
        </div>
      )}

      {/* ── Diagnosis panel — slides in when Analyze finds a problem ────────── */}
      <div
        className="grid shrink-0"
        style={{
          gridTemplateRows: hasDiagnosisPanel ? "1fr" : "0fr",
          transition: "grid-template-rows 220ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <div className="overflow-hidden">
          <div className={`flex items-start gap-2.5 px-3 py-2.5 border-b ${diagnosisCritical ? "bg-error/5 border-error/20" : "bg-warning/5 border-warning/20"}`}>
            <AlertTriangle className={`size-3.5 shrink-0 mt-0.5 ${diagnosisCritical ? "text-error" : "text-warning"}`} />
            <div className="flex-1 min-w-0">
              {fixDiagnosis?.error ? (
                <p className="text-xs leading-relaxed opacity-70">{fixDiagnosis.error}</p>
              ) : (
                <>
                  <p className="text-sm font-medium leading-snug">{fixDiagnosis?.title}</p>
                  {fixDiagnosis?.description && (
                    <p className="text-xs opacity-50 mt-0.5 line-clamp-2 leading-relaxed">{fixDiagnosis.description}</p>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {!fixDiagnosis?.error && fixDiagnosis?.title && (
                <button
                  className={`btn btn-xs h-6 min-h-0 gap-1 px-2.5 ${diagnosisCritical ? "btn-error" : "btn-warning"}`}
                  onClick={() => setFixDrawer({ open: true, defaultValues: { title: fixDiagnosis.title, description: fixDiagnosis.description, issueType: fixDiagnosis.issueType } })}
                >
                  Create Issue
                  <ChevronRight className="size-3" />
                </button>
              )}
              <button
                className="btn btn-ghost btn-xs btn-circle h-5 min-h-0 w-5 opacity-30 hover:opacity-70"
                onClick={() => setFixDiagnosis(null)}
              >
                <X className="size-3" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Log viewer */}
      <LogViewer id={service.id} running={service.running} state={state} />

      {/* Fix: Create issue drawer */}
      <CreateIssueDrawer
        open={fixDrawer.open}
        onClose={() => setFixDrawer({ open: false, defaultValues: null })}
        onSubmit={async (data) => { await createIssue.mutateAsync(data); setFixDrawer({ open: false, defaultValues: null }); }}
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

// ── Helpers ─────────────────────────────────────────────────────────────────────

function formatLogSize(bytes) {
  if (bytes == null || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── ServiceCard ─────────────────────────────────────────────────────────────────

function ServiceCard({ service, selected, onSelect }) {
  const [busy, setBusy] = useState(false);
  const state = service.state ?? (service.running ? "running" : "stopped");
  const info = stateInfo(state);
  const canStart = state === "stopped" || state === "crashed";
  const canStop = state === "running" || state === "starting";

  const handleAction = useCallback(async (e, action) => {
    e.stopPropagation();
    setBusy(true);
    try { await api.post(`/services/${service.id}/${action}`, {}); }
    finally { setBusy(false); }
  }, [service.id]);

  const logSizeStr = formatLogSize(service.logSize);

  return (
    <button
      type="button"
      onClick={() => onSelect(service.id)}
      className={`group relative text-left rounded-md border border-base-content/[0.08] bg-base-200/40 transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30
        ${selected ? "ring-1 ring-primary/30 bg-base-200/70" : "hover:bg-base-200/60"}${state === "crashed" ? " border-error/20" : ""}`}
    >
      <div className="px-3.5 py-3">
        {/* Row 1: dot + name + action */}
        <div className="flex items-center gap-2">
          <Circle className={`size-1.5 shrink-0 ${info.dot}${info.spinning ? " animate-pulse" : ""}`} />
          <span className="font-medium text-sm leading-none truncate flex-1 min-w-0">{service.name}</span>
          {canStart && (
            <span role="button" tabIndex={-1}
              className="btn btn-xs btn-ghost h-5 min-h-0 gap-1 px-1.5 text-success/70 hover:text-success hover:bg-success/10"
              onClick={(e) => handleAction(e, "start")}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
              Start
            </span>
          )}
          {canStop && (
            <span role="button" tabIndex={-1}
              className="btn btn-xs btn-ghost h-5 min-h-0 px-1 opacity-0 group-hover:opacity-100 text-error/50 hover:text-error hover:bg-error/10 transition-opacity"
              onClick={(e) => handleAction(e, "stop")}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Square className="size-2.5" />}
            </span>
          )}
        </div>

        {/* Row 2: command */}
        <div className="font-mono text-[11px] opacity-35 truncate mt-1.5 leading-none">{service.command}</div>

        {/* Row 3: stats — only for active services */}
        {(state === "running" || state === "starting" || state === "crashed") && (
        <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[11px] tabular-nums opacity-40 mt-2 leading-tight">
          {service.running && service.startedAt && (
            <span className="flex items-center gap-1">
              <span className="opacity-60">up</span>
              <UptimeCounter startedAt={service.startedAt} running />
            </span>
          )}
          {service.pid && state === "running" && (
            <span><span className="opacity-60">pid</span> {service.pid}</span>
          )}
          {service.port && (
            <span><span className="opacity-60">:</span>{service.port}</span>
          )}
          {logSizeStr && (
            <span><span className="opacity-60">log</span> {logSizeStr}</span>
          )}
          {service.crashCount > 0 && (
            <span className="text-error/70 flex items-center gap-0.5">
              <AlertTriangle className="size-2.5" />{service.crashCount}
            </span>
          )}
          {service.autoStart && (
            <span className="opacity-40">auto</span>
          )}
        </div>
        )}
      </div>

    </button>
  );
}

// ── SkeletonCard ────────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-md bg-base-200/50 animate-pulse">
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="h-3.5 w-24 rounded bg-base-300 flex-1 max-w-[8rem]" />
          <div className="h-4 w-12 rounded-full bg-base-300 shrink-0" />
        </div>
        <div className="h-2.5 w-36 rounded bg-base-300 mb-2" />
        <div className="flex items-center gap-3">
          <div className="h-2.5 w-12 rounded bg-base-300" />
          <div className="h-2.5 w-10 rounded bg-base-300" />
          <div className="h-2.5 w-14 rounded bg-base-300" />
        </div>
      </div>
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

  const isActive = (s) => s.running || s.state === "starting" || s.state === "crashed";
  const activeServices = services.filter(isActive);
  const idleServices = services.filter((s) => !isActive(s));

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-base-200 shrink-0">
        <div className="flex items-center gap-2.5">
          <Server className="size-3.5 opacity-35" />
          <span className="text-xs font-semibold opacity-55 uppercase tracking-widest">Services</span>
          {!loading && services.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] opacity-30 tabular-nums">{runningCount}/{services.length}</span>
              <div className="w-16 h-1 rounded-full bg-base-300 overflow-hidden">
                <div
                  className="h-full bg-success/60 rounded-full transition-all duration-300"
                  style={{ width: `${(runningCount / services.length) * 100}%` }}
                />
              </div>
            </div>
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

      {/* Grid content area */}
      <div className="flex-1 overflow-y-auto p-3">
        {/* Loading */}
        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {/* Empty */}
        {!loading && services.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-16">
            <Server className="size-8 opacity-10" />
            <div className="text-center">
              <p className="text-sm font-medium opacity-60">No services configured</p>
              <p className="text-xs opacity-35 mt-1">
                Add services in Settings to manage them here.
              </p>
            </div>
          </div>
        )}

        {/* Cards grouped by state */}
        {!loading && services.length > 0 && (
          <div className="space-y-6">
            {activeServices.length > 0 && (
              <section>
                <div className="flex items-center gap-2.5 mb-2.5">
                  <span className="text-[11px] font-medium opacity-30 uppercase tracking-wider">Active</span>
                  <div className="flex-1 h-px bg-base-content/5" />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5 items-start">
                  {activeServices.map((service) => (
                    <ServiceCard key={service.id} service={service} selected={service.id === selectedId} onSelect={handleSelect} />
                  ))}
                </div>
              </section>
            )}
            {idleServices.length > 0 && (
              <section>
                <div className="flex items-center gap-2.5 mb-2.5">
                  <span className="text-[11px] font-medium opacity-30 uppercase tracking-wider">Stopped</span>
                  <div className="flex-1 h-px bg-base-content/5" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2 items-start">
                  {idleServices.map((service) => (
                    <ServiceCard key={service.id} service={service} selected={service.id === selectedId} onSelect={handleSelect} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {/* Overlay drawer */}
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
