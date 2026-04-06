import { createLazyFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Server, Play, Square, Terminal, Circle, Loader2, X,
  AlertTriangle, ChevronRight, Folder, Scan, Wrench, CheckCircle2,
  Network, Trash2, Zap, RotateCcw, ShieldCheck,
  Globe, ExternalLink, Copy, Check,
} from "lucide-react";
import {
  ReactFlow,
  Background,
  MiniMap,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  getBezierPath,
  BaseEdge,
  EdgeLabelRenderer,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "../api.js";
import { useDashboard } from "../context/DashboardContext";
import { CreateIssueDrawer } from "../components/CreateIssueForm.jsx";
import { useServices, onServiceLog, dispatchServiceLog } from "../hooks/useServices.js";
import { useServiceLogSparkline } from "../hooks/useServiceLogSparkline.js";
import { useMesh } from "../hooks/useMesh.js";
import { subscribeServiceLog, unsubscribeServiceLog } from "../hooks.js";
import { formatDuration } from "../utils.js";
import {
  DrawerBackdrop,
  DrawerPanel,
  DrawerSection,
  DrawerFieldLabel,
  DrawerCloseButton,
} from "../components/DrawerPrimitives.jsx";

export const Route = createLazyFileRoute("/services")({
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
  { label: "Auto", value: 0 },      // WS push + auto fallback poll if stale
  { label: "5s",   value: 5_000 },
  { label: "10s",  value: 10_000 },
  { label: "30s",  value: 30_000 },
  { label: "1m",   value: 60_000 },
];

const AUTO_FALLBACK_POLL_MS = 1_000;

function LogViewer({ id, running, state }) {
  const { liveMode } = useDashboard();
  const [log, setLog] = useState("");
  const [logSize, setLogSize] = useState(0);
  const [status, setStatus] = useState("idle"); // idle | loading | live | error
  const [error, setError] = useState(null);
  const [pollInterval, setPollInterval] = useState(0); // 0 = auto (WS + fallback), >0 = forced poll
  const [showPollControls, setShowPollControls] = useState(false);
  const [copied, setCopied] = useState(false);
  const logRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const html = useMemo(() => (log ? ansiToHtml(log) : ""), [log]);
  const hasLog = Boolean(log && log.trim());
  const lastSizeRef = useRef(0);
  const previousLiveModeRef = useRef(liveMode);

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
      setStatus(res.logTail ? "live" : "idle");
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
        lastChunkAtRef.current = Date.now();
        setStatus("live");
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

  // Auto fallback: only poll when the runtime websocket is disconnected.
  // While WS is healthy, logs should be near-real-time via pushed chunks only.
  useEffect(() => {
    if (!running || !id || pollInterval > 0 || liveMode) return;
    setStatus((prev) => (prev === "error" || prev === "loading" ? prev : "live"));
    const timer = setInterval(fetchIncremental, AUTO_FALLBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [running, id, pollInterval, liveMode, fetchIncremental]);

  // When WS comes back, catch up on any bytes emitted during the disconnect gap.
  useEffect(() => {
    const wasLive = previousLiveModeRef.current;
    previousLiveModeRef.current = liveMode;
    if (!id || wasLive || !liveMode) return;
    fetchIncremental();
    if (running) setStatus("live");
  }, [liveMode, id, running, fetchIncremental]);

  // Explicit polling when user selects an interval
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

  const transportLabel = pollInterval > 0
    ? `poll ${pollInterval / 1000}s`
    : liveMode
      ? "ws"
      : `fallback ${AUTO_FALLBACK_POLL_MS / 1000}s`;

  const statusBadge = status === "loading"
    ? <span className="flex items-center gap-1.5 text-xs opacity-40"><Loader2 className="size-2.5 animate-spin" />loading</span>
    : status === "error"
      ? <span className="text-xs text-error/70">error</span>
    : hasLog && state === "crashed"
      ? <span className="flex items-center gap-1.5 text-xs text-error/70"><Circle className="size-2 fill-current" />crash log</span>
    : status === "live"
      ? <span className="flex items-center gap-1.5 text-xs text-success"><Circle className="size-2 fill-success" />{transportLabel}</span>
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
          {/* Poll controls — hidden by default, revealed via gear button */}
          {showPollControls && (
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
          )}
          <button
            className="btn btn-xs btn-ghost opacity-35 hover:opacity-70 px-1"
            onClick={() => setShowPollControls((v) => !v)}
            title="Poll interval"
          >
            ⚙
          </button>
          {hasLog && (
            <button
              className="btn btn-xs btn-ghost opacity-40 hover:opacity-80 px-1.5"
              title="Copy log"
              onClick={() => {
                navigator.clipboard.writeText(log).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
            </button>
          )}
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

// ── History log viewer (read-only, no WS) ─────────────────────────────────────

function HistoryLogViewer({ id, generation }) {
  const [log, setLog] = useState("");
  const [logSize, setLogSize] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState("idle");
  const [copied, setCopied] = useState(false);
  const logRef = useRef(null);
  const html = useMemo(() => (log ? ansiToHtml(log) : ""), [log]);

  useEffect(() => {
    setLog("");
    setLogSize(0);
    setStatus("loading");
    api.get(`/services/${encodeURIComponent(id)}/log/history/${generation}`)
      .then((res) => {
        setLog(res.logTail ?? "");
        setLogSize(res.logSize ?? 0);
        setTruncated(res.truncated ?? false);
        setStatus(res.logTail ? "loaded" : "empty");
      })
      .catch(() => setStatus("error"));
  }, [id, generation]);

  const label = generation === 1 ? "Previous session" : "Oldest session";
  const sizeStr = logSize > 0 ? `${(logSize / 1024).toFixed(1)}KB` : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-4 py-2 bg-base-200/40 border-t border-b border-base-200 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="size-3.5 opacity-30" />
          <span className="text-[10px] font-medium opacity-40 uppercase tracking-widest">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          {status === "loading" && <span className="flex items-center gap-1.5 text-xs opacity-40"><Loader2 className="size-2.5 animate-spin" />loading</span>}
          {status === "loaded" && sizeStr && <span className="text-xs opacity-40">{sizeStr}{truncated ? " (truncated)" : ""}</span>}
          {status === "error" && <span className="text-xs text-error/70">error</span>}
          {status === "empty" && <span className="text-xs opacity-25">empty</span>}
          {log && (
            <button
              className="btn btn-xs btn-ghost opacity-40 hover:opacity-80 px-1.5"
              title="Copy log"
              onClick={() => {
                navigator.clipboard.writeText(log).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
            </button>
          )}
        </div>
      </div>
      <pre
        ref={logRef}
        className="flex-1 overflow-y-auto p-4 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed bg-base-100 min-h-0"
        dangerouslySetInnerHTML={{
          __html: html || (status === "error"
            ? '<span style="opacity:0.3">Failed to load log.</span>'
            : '<span style="opacity:0.2">No output in this session.</span>'),
        }}
      />
    </div>
  );
}

// ── DrawerSparkline ────────────────────────────────────────────────────────────

function DrawerSparkline({ id, running }) {
  const { buckets, peak } = useServiceLogSparkline(id, running);
  const BAR_W = 4;
  const GAP = 1;
  const H = 20;
  const BARS = 30;

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 border-t border-base-200/60 bg-base-200/20 shrink-0">
      <svg width={BARS * (BAR_W + GAP) - GAP} height={H} className="overflow-visible shrink-0">
        {buckets.map((v, i) => {
          const barH = v === 0 ? 1 : Math.max(2, Math.round((v / peak) * (H - 1)));
          const x = i * (BAR_W + GAP);
          const y = H - barH;
          const isRecent = i >= BARS - 3;
          return (
            <rect key={i} x={x} y={y} width={BAR_W} height={barH} rx={0.5}
              className={v === 0 ? "fill-base-content/10" : isRecent ? "fill-success/75" : "fill-success/45"}
            />
          );
        })}
      </svg>
      <span className="text-[10px] opacity-30 shrink-0">5 min</span>
      <span className="flex-1" />
      <span className="text-[10px] opacity-25 tabular-nums">log activity</span>
    </div>
  );
}

// ── ServiceDrawerBody ──────────────────────────────────────────────────────────
// Pure content — works both as an inline desktop pane and inside a mobile overlay.

function ServiceDrawerBody({ service, onClose, onRefresh, graph, proxyRoutes, localDomain, proxyPort }) {
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectResult, setDetectResult] = useState(null); // null | { found, healthcheck } | "error"
  const [fixing, setFixing] = useState(false);
  const [fixDrawer, setFixDrawer] = useState({ open: false, defaultValues: null });
  const [fixDiagnosis, setFixDiagnosis] = useState(null); // null | { healthy: true } | { healthy: false, title, description, issueType } | { error: string }
  const [logGenerations, setLogGenerations] = useState([0]);
  const [activeLogTab, setActiveLogTab] = useState(0);
  const { createIssue, showToast } = useDashboard();

  // Fetch available log generations
  const refreshGenerations = useCallback(() => {
    api.get(`/services/${encodeURIComponent(service.id)}/log/generations`)
      .then((res) => setLogGenerations(res.generations?.length ? res.generations : [0]))
      .catch(() => setLogGenerations([0]));
  }, [service.id]);

  useEffect(() => {
    refreshGenerations();
    setActiveLogTab(0);
  }, [service.id, refreshGenerations]);

  const state = service.state ?? (service.running ? "running" : "stopped");
  const info = stateInfo(state);
  const canStart = state === "stopped" || state === "crashed";
  const canStop  = state === "running" || state === "starting";
  const serviceRoutes = useMemo(
    () => getServiceRouteEntries(service.id, proxyRoutes, localDomain, proxyPort),
    [service.id, proxyRoutes, localDomain, proxyPort],
  );
  const serviceNodeMetrics = useMemo(
    () => graph?.nodes?.find((node) => node.id === service.id) ?? null,
    [graph, service.id],
  );
  const serviceNodeProtocols = useMemo(
    () => topNodeProtocols(serviceNodeMetrics?.protocols, 3),
    [serviceNodeMetrics],
  );

  const handleStart = useCallback(async () => {
    setBusy(true);
    try { await api.post(`/services/${service.id}/start`, {}); await onRefresh(); setActiveLogTab(0); setTimeout(refreshGenerations, 500); }
    finally { setBusy(false); }
  }, [service.id, onRefresh, refreshGenerations]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try { await api.post(`/services/${service.id}/stop`, {}); await onRefresh(); }
    finally { setBusy(false); }
  }, [service.id, onRefresh]);

  const handleRestart = useCallback(async () => {
    setBusy(true);
    try { await api.post(`/services/${service.id}/restart`, {}); await onRefresh(); setActiveLogTab(0); setTimeout(refreshGenerations, 500); }
    finally { setBusy(false); }
  }, [service.id, onRefresh, refreshGenerations]);

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

      {/* ── Row 1: state dot + name + state label + uptime + port + restart + stop/start + close ── */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0">
        {info.spinning
          ? <Loader2 className={`size-3 shrink-0 animate-spin ${stateColor}`} />
          : <Circle className={`size-1.5 shrink-0 ${info.dot}`} />
        }
        <span className="font-semibold text-sm truncate leading-none">{service.name}</span>
        <span className={`text-xs font-medium shrink-0 ${stateColor}`}>{info.label}</span>
        {service.running && service.startedAt && (
          <span className="text-xs opacity-55 tabular-nums shrink-0">
            <UptimeCounter startedAt={service.startedAt} running={service.running} />
          </span>
        )}
        {service.port && (
          <span className="text-xs font-mono opacity-50 shrink-0">:{service.port}</span>
        )}
        {service.pid && state === "running" && (
          <span className="text-[11px] font-mono opacity-45 tabular-nums shrink-0">pid {service.pid}</span>
        )}
        <span className="flex-1" />
        {canStop && (
          <button
            className="btn btn-xs btn-ghost gap-1 h-6 min-h-0 px-1.5 opacity-60 hover:opacity-90 shrink-0"
            onClick={handleRestart}
            disabled={busy}
            title="Restart"
          >
            <RotateCcw className="size-3" />
          </button>
        )}
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

      {/* ── Row 2: command + meta + AI action buttons ────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-base-200/60 shrink-0 min-w-0">
        <code className="font-mono text-[11px] opacity-65 truncate flex-1 leading-none">{service.command}</code>
        {service.cwd && (
          <span className="flex items-center gap-1 text-[11px] font-mono opacity-45 shrink-0">
            <Folder className="size-3" />{service.cwd}
          </span>
        )}
        {state === "crashed" && service.crashCount > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-error/50 shrink-0">
            <AlertTriangle className="size-3" />{service.crashCount}
          </span>
        )}
        {service.logSize != null && service.logSize > 0 && (
          <span className="text-[11px] font-mono opacity-45 shrink-0 tabular-nums">{(service.logSize / 1024).toFixed(1)}KB</span>
        )}
        {(state === "running" || state === "crashed") && (
          <>
            <div className="w-px h-3 bg-base-content/10 shrink-0" />
            <button
              className="btn btn-xs btn-ghost h-6 min-h-0 gap-1 px-2 text-[11px] opacity-70 hover:opacity-100 shrink-0"
              onClick={handleDetect}
              disabled={detecting || fixing}
            >
              {detecting ? <Loader2 className="size-3 animate-spin" /> : <Scan className="size-3" />}
              {detecting ? "Scanning…" : "Detect"}
            </button>
            {detectResult && detectResult !== "error" && (
              detectResult.found ? (
                <span className="flex items-center gap-1 text-[11px] text-success shrink-0">
                  <CheckCircle2 className="size-3" />
                  {detectResult.healthcheck?.endpoint ?? `port ${detectResult.healthcheck?.port}`}
                </span>
              ) : (
                <span className="text-[11px] opacity-30 shrink-0">no config detected</span>
              )
            )}
            <button
              className="btn btn-xs btn-ghost h-6 min-h-0 gap-1 px-2 text-[11px] opacity-70 hover:opacity-100 shrink-0"
              onClick={handleAnalyze}
              disabled={fixing || detecting}
            >
              {fixing ? <Loader2 className="size-3 animate-spin" /> : <Wrench className="size-3" />}
              {fixing ? "Analyzing…" : "Analyze"}
            </button>
            {fixDiagnosis?.healthy && (
              <span className="flex items-center gap-1 text-[11px] text-success/70 shrink-0">
                <CheckCircle2 className="size-3 shrink-0" />Clean
              </span>
            )}
          </>
        )}
      </div>

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

      {/* Proxy routes */}
      {serviceRoutes.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 border-t border-base-200/60 shrink-0">
          <Globe className="size-3 opacity-20 shrink-0" />
          {serviceRoutes.map((route) =>
            route.url ? (
              <a
                key={route.id}
                href={route.url}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] font-mono text-primary/60 hover:text-primary transition-colors truncate"
              >
                {route.url}
              </a>
            ) : (
              <span key={route.id} className="text-[11px] font-mono opacity-35 truncate">{route.label}</span>
            )
          )}
        </div>
      )}

      {serviceNodeMetrics && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 border-t border-base-200/60 shrink-0 text-[10px] font-mono">
          <span className="opacity-30">mesh</span>
          <span className="opacity-50">{serviceNodeMetrics.requestsIn ?? 0} in</span>
          <span className="opacity-50">{serviceNodeMetrics.requestsOut ?? 0} out</span>
          {((serviceNodeMetrics.bytesIn ?? 0) > 0 || (serviceNodeMetrics.bytesOut ?? 0) > 0) && (
            <span className="opacity-45">{formatBytes(serviceNodeMetrics.bytesIn)} in / {formatBytes(serviceNodeMetrics.bytesOut)} out</span>
          )}
          {(serviceNodeMetrics.errorsIn ?? 0) > 0 && (
            <span className="text-error/80">{serviceNodeMetrics.errorsIn} err in</span>
          )}
          {(serviceNodeMetrics.errorsOut ?? 0) > 0 && (
            <span className="text-error/80">{serviceNodeMetrics.errorsOut} err out</span>
          )}
          {(serviceNodeMetrics.activeFlows ?? 0) > 0 && (
            <span className="opacity-50">{serviceNodeMetrics.activeFlows} active</span>
          )}
          {serviceNodeMetrics.lastSeenAt && (
            <span className="opacity-35">{formatRelativeSeenAt(serviceNodeMetrics.lastSeenAt)}</span>
          )}
          {serviceNodeProtocols.length > 0 && (
            <span className="opacity-35">{serviceNodeProtocols.join(" · ")}</span>
          )}
        </div>
      )}

      {/* Log volume sparkline — running services only */}
      {service.running && <DrawerSparkline id={service.id} running={service.running} />}

      {/* Log generation tabs — only visible when history exists */}
      {logGenerations.length > 1 && (
        <div className="flex items-center gap-0 px-3 border-t border-base-200/60 shrink-0 bg-base-200/20">
          {logGenerations.map((gen) => {
            const label = gen === 0 ? "Current" : gen === 1 ? "Previous" : "Oldest";
            const isActive = activeLogTab === gen;
            return (
              <button
                key={gen}
                onClick={() => setActiveLogTab(gen)}
                className={`px-3 py-1.5 text-[11px] font-medium border-b-2 transition-colors ${
                  isActive
                    ? "border-primary text-primary"
                    : "border-transparent opacity-50 hover:opacity-80"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      {activeLogTab === 0 ? (
        <LogViewer id={service.id} running={service.running} state={state} />
      ) : (
        <HistoryLogViewer id={service.id} generation={activeLogTab} />
      )}

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

function ServiceDrawer({ service, onClose, onRefresh, graph, proxyRoutes, localDomain, proxyPort }) {
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
        <ServiceDrawerBody
          service={service}
          onClose={handleClose}
          onRefresh={onRefresh}
          graph={graph}
          proxyRoutes={proxyRoutes}
          localDomain={localDomain}
          proxyPort={proxyPort}
        />
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

// ── Route URL helpers ────────────────────────────────────────────────────────────

function firstHost(host) {
  if (!host) return undefined;
  return Array.isArray(host) ? host[0] : host;
}

function buildRouteUrl(route, localDomain, proxyPort = 4433) {
  const host = firstHost(route.host) ?? localDomain;
  if (!host) return route.target ?? null;
  const path = route.pathPrefix ?? "";
  const normalizedPort = Number(proxyPort ?? 4433);
  const origin = normalizedPort === 443
    ? `https://${host}`
    : `https://${host}:${normalizedPort}`;
  return `${origin}${path}`;
}

function routeDisplayLabel(route) {
  if (route.host) {
    const label = Array.isArray(route.host) ? route.host.join(", ") : route.host;
    return label + (route.pathPrefix ?? "");
  }
  if (route.pathPrefix) return route.pathPrefix;
  return route.target ?? route.id;
}

function getServiceRouteEntries(serviceId, proxyRoutes, localDomain, proxyPort = 4433) {
  if (!serviceId) return [];
  return (proxyRoutes ?? [])
    .filter((route) => route.serviceId === serviceId)
    .map((route) => ({
      id: route.id,
      label: routeDisplayLabel(route),
      url: buildRouteUrl(route, localDomain, proxyPort),
      host: firstHost(route.host) ?? localDomain ?? "",
      pathPrefix: route.pathPrefix ?? "",
    }));
}

// ── LogSparkline ─────────────────────────────────────────────────────────────────
// Bar chart sparkline: 30 × 10s buckets = 5min sliding window.
// Bar dimensions: 3px wide, 1px gap → 119px total, 16px tall.

const SPARK_BARS = 30;
const SPARK_BAR_W = 3;
const SPARK_GAP = 1;
const SPARK_W = SPARK_BARS * (SPARK_BAR_W + SPARK_GAP) - SPARK_GAP; // 119
const SPARK_H = 16;

function LogSparkline({ id, running }) {
  const { buckets, peak } = useServiceLogSparkline(id, running);

  return (
    <svg width={SPARK_W} height={SPARK_H} className="overflow-visible">
      {buckets.map((v, i) => {
        const barH = v === 0 ? 1 : Math.max(2, Math.round((v / peak) * (SPARK_H - 1)));
        const x = i * (SPARK_BAR_W + SPARK_GAP);
        const y = SPARK_H - barH;
        const isRecent = i >= SPARK_BARS - 3;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={SPARK_BAR_W}
            height={barH}
            rx={0.5}
            className={v === 0
              ? "fill-base-content/10"
              : isRecent
                ? "fill-success/80"
                : "fill-success/50"
            }
          />
        );
      })}
    </svg>
  );
}

// ── ServiceCard ─────────────────────────────────────────────────────────────────

function ServiceCard({ service, selected, onSelect, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const state = service.state ?? (service.running ? "running" : "stopped");
  const info = stateInfo(state);
  const canStart = state === "stopped" || state === "crashed";
  const canStop = state === "running" || state === "starting";
  // Health data comes from the backend health checker via services:snapshot WS push
  const health = service.health ?? null;

  const handleAction = useCallback(async (e, action) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await api.post(`/services/${service.id}/${action}`, {});
      // Small delay to let the FSM transition settle before refreshing
      setTimeout(() => onRefresh?.(), 500);
    } finally { setBusy(false); }
  }, [service.id, onRefresh]);

  const logSizeStr = formatLogSize(service.logSize);

  // Health dot rendering
  const healthDot = (() => {
    if (!service.running) return null;
    if (!service.port) return null;
    if (!health) return <Circle className="size-1.5 text-base-content/20 fill-base-content/20" title="Checking..." />;
    if (health.healthy) {
      return (
        <span className="flex items-center gap-0.5 text-success/70" title={`Healthy — ${health.latencyMs}ms`}>
          <Circle className="size-1.5 fill-current" />
          <span className="text-[10px] tabular-nums">{health.latencyMs}ms</span>
        </span>
      );
    }
    return (
      <span className="flex items-center gap-0.5 text-error/70" title="Unhealthy">
        <Circle className="size-1.5 fill-current" />
        <span className="text-[10px]">down</span>
      </span>
    );
  })();

  const accentColor = state === "running" ? "bg-success/50" : state === "starting" ? "bg-success/30 animate-pulse" : state === "crashed" ? "bg-error/50" : "bg-base-content/10";

  return (
    <button
      type="button"
      onClick={() => onSelect(service.id)}
      className={`group relative text-left rounded-md border border-base-content/[0.08] bg-base-200/40 transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 overflow-hidden
        ${selected ? "ring-1 ring-primary/30 bg-base-200/70" : "hover:bg-base-200/60"}${state === "crashed" ? " border-error/20" : ""}`}
    >
      {/* Left accent bar */}
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${accentColor} transition-colors duration-300`} />
      <div className="pl-3.5 pr-3 py-2.5">
        {/* Row 1: dot + name + actions */}
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
              className="btn btn-xs btn-ghost h-5 min-h-0 px-1 opacity-0 group-hover:opacity-100 hover:bg-base-300/50 transition-opacity"
              onClick={(e) => handleAction(e, "restart")}
              title="Restart"
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-2.5 opacity-50" />}
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
        <div className="font-mono text-[11px] opacity-35 truncate mt-1 leading-none">{service.command}</div>

        {/* Row 3: stats — only for active services */}
        {(state === "running" || state === "starting" || state === "crashed") && (
        <div className="flex items-center gap-x-2.5 gap-y-0.5 flex-wrap text-[11px] tabular-nums opacity-40 mt-1.5 leading-tight">
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
          {healthDot}
          {logSizeStr && (
            <span><span className="opacity-60">log</span> {logSizeStr}</span>
          )}
          {service.crashCount > 0 && (
            <span className="text-error/70 flex items-center gap-0.5">
              <AlertTriangle className="size-2.5" />{service.crashCount}
            </span>
          )}
          {service.errorCount > 0 && (
            <span className="text-error/70 flex items-center gap-0.5">
              <AlertTriangle className="size-2.5" />{service.errorCount} err
            </span>
          )}
          {service.autoStart && (
            <span className="opacity-40">auto</span>
          )}
        </div>
        )}

        {/* Row 4: log volume sparkline — running services only */}
        {state === "running" && (
          <div className="mt-1.5" title="Log volume — 5min window, 10s buckets">
            <LogSparkline id={service.id} running={service.running} />
          </div>
        )}
      </div>

    </button>
  );
}

function RuntimeServiceDrawer({ service, onClose, onRefresh }) {
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusData, setStatusData] = useState(null);
  const [graphData, setGraphData] = useState(null);
  const state = service.state ?? (service.running ? "running" : "stopped");
  const info = stateInfo(state);
  const canStart = state === "stopped" || state === "crashed";
  const canStop = state === "running" || state === "starting";
  const runtimeKind = service.runtimeServiceKind === "mesh" ? "mesh" : "proxy";
  const runtimeLabel = runtimeKind === "mesh" ? "network runtime · mesh" : "network runtime · ingress";

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setClosing(false); onClose(); }, 250);
  }, [onClose]);

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose]);

  useEffect(() => {
    const statusEndpoint = runtimeKind === "mesh" ? "/mesh/status" : "/proxy/reverse/status";
    api.get(statusEndpoint).then(setStatusData).catch(() => {});
    if (runtimeKind === "mesh") {
      api.get("/mesh").then((res) => setGraphData(res?.graph ?? null)).catch(() => {});
    }
  }, [runtimeKind]);

  // Derive rich stats from status + graph
  const derivedStats = useMemo(() => {
    if (!statusData) return null;
    if (runtimeKind === "mesh") {
      const graph = graphData;
      const edges = Array.isArray(graph?.edges) ? graph.edges : [];
      const totalRequests = graph?.totalRequests ?? edges.reduce((s, e) => s + Number(e.requestCount ?? 0), 0);
      const totalErrors = edges.reduce((s, e) => s + Number(e.errorCount ?? 0), 0);
      const totalBytesIn = edges.reduce((s, e) => s + Number(e.bytesIn ?? 0), 0);
      const totalBytesOut = edges.reduce((s, e) => s + Number(e.bytesOut ?? 0), 0);
      const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;
      return {
        running: statusData.running,
        port: statusData.port,
        totalRequests,
        totalErrors,
        errorRate,
        totalBytesIn,
        totalBytesOut,
        activeEdges: edges.length,
        nodeCount: Array.isArray(graph?.nodes) ? graph.nodes.length : 0,
      };
    }
    return {
      running: statusData.running,
      port: statusData.port,
      routeCount: statusData.routes?.length ?? 0,
      localDomain: statusData.localDomain ?? null,
    };
  }, [statusData, graphData, runtimeKind]);

  const handleAction = useCallback(async (action) => {
    setBusy(true);
    try {
      await api.post(`/services/${service.id}/${action}`, {});
      setTimeout(() => onRefresh?.(), 300);
    } finally {
      setBusy(false);
    }
  }, [service.id, onRefresh]);

  return (
    <>
      <DrawerBackdrop onClick={handleClose} className={closing ? "animate-fade-out" : "animate-fade-in"} />
      <DrawerPanel closing={closing} width="w-full sm:w-[560px] lg:w-[42vw] lg:min-w-[540px]" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between px-5 pt-5 pb-4 border-b border-base-content/[0.07] shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <ShieldCheck className={`size-4 shrink-0 ${info.dot}${info.spinning ? " animate-pulse" : ""}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm leading-tight truncate">{service.name}</span>
                <span className="badge badge-xs badge-outline opacity-60">{runtimeLabel}</span>
                {service.port && <span className="text-[10px] font-mono opacity-40">:{service.port}</span>}
              </div>
              {service.command && (
                <div className="font-mono text-[11px] opacity-35 truncate mt-0.5">{service.command}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-3">
            {canStart && (
              <button className="btn btn-xs btn-ghost text-success opacity-60 hover:opacity-100" onClick={() => handleAction("start")} disabled={busy} title="Start">
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
              </button>
            )}
            {canStop && (
              <button className="btn btn-xs btn-ghost text-error opacity-60 hover:opacity-100" onClick={() => handleAction("stop")} disabled={busy} title="Stop">
                {busy ? <Loader2 className="size-3 animate-spin" /> : <Square className="size-3" />}
              </button>
            )}
            <button className="btn btn-xs btn-ghost opacity-50 hover:opacity-90" onClick={() => handleAction("restart")} disabled={busy} title="Restart">
              {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
            </button>
            <DrawerCloseButton onClick={handleClose} />
          </div>
        </div>
        {/* Stats panel */}
        {derivedStats && (
          <div className="px-5 py-3 border-b border-base-content/[0.06] shrink-0">
            <div className="flex items-center gap-1.5 mb-2">
              <span className={`text-[10px] font-semibold ${derivedStats.running ? "text-success" : "opacity-25"}`}>
                {derivedStats.running ? "running" : "stopped"}
              </span>
              {derivedStats.port && (
                <span className="text-[10px] font-mono opacity-35">:{derivedStats.port}</span>
              )}
            </div>
            {runtimeKind === "mesh" ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2">
                <div>
                  <div className="text-[9px] opacity-30 uppercase tracking-widest mb-0.5">requests</div>
                  <div className="text-sm font-semibold font-mono tabular-nums opacity-70">
                    {derivedStats.totalRequests > 0 ? derivedStats.totalRequests.toLocaleString() : <span className="opacity-30 text-xs">—</span>}
                  </div>
                </div>
                <div>
                  <div className="text-[9px] opacity-30 uppercase tracking-widest mb-0.5">error rate</div>
                  <div className={`text-sm font-semibold font-mono tabular-nums ${derivedStats.errorRate > 0.05 ? "text-error/80" : "opacity-70"}`}>
                    {derivedStats.totalRequests > 0
                      ? `${Math.round(derivedStats.errorRate * 100)}%`
                      : <span className="opacity-30 text-xs">—</span>
                    }
                  </div>
                </div>
                <div>
                  <div className="text-[9px] opacity-30 uppercase tracking-widest mb-0.5">data in/out</div>
                  <div className="text-sm font-semibold font-mono tabular-nums opacity-70">
                    {(derivedStats.totalBytesIn + derivedStats.totalBytesOut) > 0
                      ? formatBytes(derivedStats.totalBytesIn + derivedStats.totalBytesOut)
                      : <span className="opacity-30 text-xs">—</span>
                    }
                  </div>
                </div>
                <div>
                  <div className="text-[9px] opacity-30 uppercase tracking-widest mb-0.5">connections</div>
                  <div className="text-sm font-semibold font-mono tabular-nums opacity-70">
                    {derivedStats.activeEdges > 0
                      ? `${derivedStats.activeEdges} paths`
                      : <span className="opacity-30 text-xs">—</span>
                    }
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2">
                <div>
                  <div className="text-[9px] opacity-30 uppercase tracking-widest mb-0.5">routes</div>
                  <div className="text-sm font-semibold font-mono tabular-nums opacity-70">
                    {derivedStats.routeCount > 0 ? derivedStats.routeCount : <span className="opacity-30 text-xs">—</span>}
                  </div>
                </div>
                {derivedStats.localDomain && (
                  <div className="col-span-2">
                    <div className="text-[9px] opacity-30 uppercase tracking-widest mb-0.5">domain</div>
                    <div className="text-xs font-mono opacity-55 truncate">{derivedStats.localDomain}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* Log area — fills remaining height */}
        <div className="flex-1 min-h-0 overflow-hidden">
          <LogViewer id={service.id} running={service.running} state={state} />
        </div>
      </DrawerPanel>
    </>
  );
}

function RuntimeServiceCard({ service, onRefresh }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = service.state ?? (service.running ? "running" : "stopped");
  const info = stateInfo(state);
  const canStart = state === "stopped" || state === "crashed";
  const canStop = state === "running" || state === "starting";
  const runtimeKind = service.runtimeServiceKind === "mesh" ? "mesh" : "proxy";
  const runtimeLabel = runtimeKind === "mesh" ? "network runtime · mesh" : "network runtime · ingress";

  const handleAction = useCallback(async (action) => {
    setBusy(true);
    try {
      await api.post(`/services/${service.id}/${action}`, {});
      setTimeout(() => onRefresh?.(), 300);
    } finally {
      setBusy(false);
    }
  }, [service.id, onRefresh]);

  const runtimeAccent = state === "running" ? "bg-primary/40" : state === "starting" ? "bg-primary/20 animate-pulse" : "bg-base-content/10";

  return (
    <>
      <div className="rounded-md border border-base-content/[0.08] bg-base-200/30 overflow-hidden relative">
        <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${runtimeAccent} transition-colors duration-300`} />
        <div className="pl-3.5 pr-3 py-2.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className={`size-3.5 shrink-0 ${info.dot}${info.spinning ? " animate-pulse" : ""}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm truncate">{service.name}</span>
                <span className="badge badge-xs badge-outline opacity-60">{runtimeLabel}</span>
                {service.port && <span className="text-[10px] font-mono opacity-35">:{service.port}</span>}
              </div>
              <div className="font-mono text-[11px] opacity-35 truncate mt-1">{service.command}</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button className="btn btn-xs btn-ghost opacity-45 hover:opacity-90" onClick={() => setDrawerOpen(true)} title="Logs">
                <Terminal className="size-3.5" />
              </button>
              <button className="btn btn-xs btn-ghost opacity-45 hover:opacity-90" onClick={() => handleAction("restart")} disabled={busy} title="Restart">
                {busy ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
              </button>
              {canStop && (
                <button className="btn btn-xs btn-ghost text-error opacity-50 hover:opacity-100" onClick={() => handleAction("stop")} disabled={busy} title="Stop">
                  {busy ? <Loader2 className="size-3 animate-spin" /> : <Square className="size-3" />}
                </button>
              )}
              {canStart && (
                <button className="btn btn-xs btn-ghost text-success opacity-50 hover:opacity-100" onClick={() => handleAction("start")} disabled={busy} title="Start">
                  {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {drawerOpen && (
        <RuntimeServiceDrawer
          service={service}
          onClose={() => setDrawerOpen(false)}
          onRefresh={onRefresh}
        />
      )}
    </>
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

// ── Mesh Graph (ReactFlow) ────────────────────────────────────────────────────

const stateColor = (state) => {
  if (state === "running" || state === "starting") return "#22c55e";
  if (state === "crashed") return "#ef4444";
  return "#6b7280";
};

function protocolColor(protocol) {
  const normalized = (protocol || "unknown").toLowerCase();
  if (normalized === "https") return "#2563eb";
  if (normalized === "http") return "#22c55e";
  if (normalized === "wss") return "#7c3aed";
  if (normalized === "ws") return "#c026d3";
  if (normalized === "tcp") return "#f59e0b";
  if (normalized === "grpc") return "#0ea5e9";
  return "#6b7280";
}

function errorRateColor(rate) {
  const clamped = Math.min(Math.max(rate ?? 0, 0), 1);
  const hue = 120 * (1 - clamped);
  return `hsl(${hue}, 86%, 42%)`;
}

function formatProtocol(value) {
  if (!value) return "unknown";
  return String(value).toUpperCase();
}

function formatMeshWindow(windowStart, windowEnd) {
  if (!windowStart || !windowEnd) return null;
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const durationMs = Math.max(0, end - start);
  if (durationMs < 1_000) return "<1s window";
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s window`;
  const minutes = durationMs / 60_000;
  if (minutes < 10) return `${minutes.toFixed(1)}m window`;
  return `${Math.round(minutes)}m window`;
}

function formatConfiguredMeshWindow(seconds) {
  const value = Number(seconds ?? 0);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 60) return `${value}s target`;
  const minutes = value / 60;
  if (minutes < 10) return `${minutes.toFixed(1)}m target`;
  return `${Math.round(minutes)}m target`;
}

function formatBytes(value) {
  const bytes = Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatRelativeSeenAt(value, nowTs = Date.now()) {
  const seenAt = Date.parse(value ?? "");
  if (!Number.isFinite(seenAt)) return null;
  const ageMs = Math.max(0, nowTs - seenAt);
  if (ageMs < 1_000) return "just now";
  if (ageMs < 60_000) return `${Math.round(ageMs / 1_000)}s ago`;
  const minutes = ageMs / 60_000;
  if (minutes < 10) return `${minutes.toFixed(1)}m ago`;
  return `${Math.round(minutes)}m ago`;
}

function topBreakdownEntries(record, limit = 4) {
  return Object.entries(record ?? {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, limit);
}

function topNodeProtocols(protocols, limit = 2) {
  const entries = Object.entries(protocols ?? {})
    .filter(([, count]) => Number(count) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, limit);
  return entries.map(([protocol]) => formatProtocol(protocol));
}

function topPeerSummaries(graph, serviceId, direction, limit = 3) {
  if (!graph?.edges?.length || !serviceId) return [];
  const peerMap = new Map();
  for (const edge of graph.edges) {
    const src = typeof edge.source === "object" ? edge.source.id : edge.source;
    const tgt = typeof edge.target === "object" ? edge.target.id : edge.target;
    const peerId = direction === "inbound"
      ? (tgt === serviceId ? src : null)
      : (src === serviceId ? tgt : null);
    if (!peerId) continue;
    const current = peerMap.get(peerId) ?? {
      id: peerId,
      requestCount: 0,
      errorCount: 0,
      bytesIn: 0,
      bytesOut: 0,
      lastSeenAt: null,
      protocols: {},
    };
    current.requestCount += Number(edge.requestCount ?? 0);
    current.errorCount += Number(edge.errorCount ?? 0);
    current.bytesIn += Number(edge.bytesIn ?? 0);
    current.bytesOut += Number(edge.bytesOut ?? 0);
    const protocol = String(edge.dominantProtocol ?? "unknown").toLowerCase();
    current.protocols[protocol] = Number(current.protocols[protocol] ?? 0) + Number(edge.requestCount ?? 0);
    if (!current.lastSeenAt || Date.parse(edge.lastSeenAt ?? "") > Date.parse(current.lastSeenAt ?? "")) {
      current.lastSeenAt = edge.lastSeenAt ?? current.lastSeenAt;
    }
    peerMap.set(peerId, current);
  }
  return Array.from(peerMap.values())
    .sort((a, b) => {
      if (b.requestCount !== a.requestCount) return b.requestCount - a.requestCount;
      return Date.parse(b.lastSeenAt ?? "") - Date.parse(a.lastSeenAt ?? "");
    })
    .slice(0, limit)
    .map((peer) => ({
      ...peer,
      errorRate: peer.requestCount > 0 ? peer.errorCount / peer.requestCount : 0,
      topProtocols: topNodeProtocols(peer.protocols, 2),
    }));
}

function computeRecentActivity(lastSeenAt, nowTs, active = false) {
  if (active) return 1;
  const seenAt = Date.parse(lastSeenAt ?? "");
  if (!Number.isFinite(seenAt)) return 0;
  const ageMs = Math.max(0, nowTs - seenAt);
  const fadeWindowMs = 60_000;
  return Math.max(0, 1 - ageMs / fadeWindowMs);
}

function ServiceNode({ data }) {
  const isExternal = data.external === true;
  const offline = !isExternal && data.state !== "running" && data.state !== "starting";
  const color = isExternal ? "#6b7280" : stateColor(data.state);
  const selected = data.selected === true;
  const relatedToSelection = data.relatedToSelection !== false;

  const borderColor = selected ? "currentColor" : color;
  const opacity = isExternal ? 0.45 : offline ? 0.4 : relatedToSelection ? 0.85 : 0.3;

  return (
    <div
      className="px-3 py-2 rounded border bg-base-200/90 text-center min-w-[100px]"
      style={{
        borderColor,
        borderWidth: selected ? 2 : 1,
        borderStyle: isExternal ? "dashed" : "solid",
        opacity,
      }}
    >
      <Handle type="target" position={Position.Left} className="!bg-base-content/20 !w-1.5 !h-1.5 !border-0" />
      <div className="flex items-center justify-center gap-1.5 mb-0.5">
        <div className="size-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
        <span className="text-[11px] font-medium leading-tight truncate max-w-[120px]">
          {data.name}
        </span>
      </div>
      {!isExternal && (
        <>
          {data.port && <div className="text-[9px] font-mono opacity-30">:{data.port}</div>}
          {(data.incomingRequestCount > 0 || data.errorRate > 0) && (
            <div className="text-[10px] font-mono mt-0.5 flex items-center justify-center gap-1.5">
              {data.incomingRequestCount > 0 && (
                <span className="opacity-50">{data.incomingRequestCount} req</span>
              )}
              {data.errorRate > 0 && (
                <span className="text-error/70">{Math.round(data.errorRate * 100)}% err</span>
              )}
            </div>
          )}
        </>
      )}
      {isExternal && <div className="text-[9px] opacity-30 mt-0.5">external</div>}
      <Handle type="source" position={Position.Right} className="!bg-base-content/20 !w-1.5 !h-1.5 !border-0" />
    </div>
  );
}

const meshNodeTypes = { service: ServiceNode };

function MetricEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style }) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const hasErrors = data?.errorCount > 0;
  const errPct = data?.requestCount > 0 ? Math.round((data.errorCount / data.requestCount) * 100) : 0;
  const protocol = formatProtocol(data?.dominantProtocol);
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, position: "absolute", pointerEvents: "none" }}
          className="nodrag nopan"
        >
          <div className="flex items-center gap-1 bg-base-300/90 border border-base-content/10 rounded-full px-2 py-0.5 text-[9px] font-mono shadow-sm backdrop-blur-sm whitespace-nowrap">
            <span className="opacity-70">{data?.requestCount ?? 0} req</span>
            <span className="opacity-70">· {protocol}</span>
            {data?.avgLatencyMs != null && (
              <span className={`opacity-70 ${data.avgLatencyMs > 200 ? "text-warning" : ""}`}>· {data.avgLatencyMs}ms</span>
            )}
            {hasErrors && (
              <span className="text-error">· {errPct}% err</span>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const meshEdgeTypes = { metric: MetricEdge };

function meshEdgeIdentity(edge) {
  if (edge?.id) return edge.id;
  const source = typeof edge?.source === "object" ? edge.source.id : edge?.source;
  const target = typeof edge?.target === "object" ? edge.target.id : edge?.target;
  const protocol = edge?.dominantProtocol ?? edge?.protocol ?? "unknown";
  return `${source ?? "unknown"}\u0000${target ?? "unknown"}\u0000${protocol}`;
}

function computeRankedLayout(nodes, edges) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const inEdges = new Map();
  const outEdges = new Map();

  for (const node of nodes) {
    inEdges.set(node.id, new Set());
    outEdges.set(node.id, new Set());
  }
  for (const edge of edges) {
    const src = typeof edge.source === "object" ? edge.source.id : edge.source;
    const tgt = typeof edge.target === "object" ? edge.target.id : edge.target;
    if (nodeIds.has(src) && nodeIds.has(tgt)) {
      inEdges.get(tgt)?.add(src);
      outEdges.get(src)?.add(tgt);
    }
  }

  // Assign ranks via BFS from roots (nodes with no incoming edges)
  const ranks = new Map();
  const queue = [];
  for (const node of nodes) {
    if (inEdges.get(node.id).size === 0) {
      ranks.set(node.id, 0);
      queue.push(node.id);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    const rank = ranks.get(id);
    for (const tgt of (outEdges.get(id) ?? [])) {
      const currentRank = ranks.get(tgt) ?? -1;
      if (currentRank < rank + 1) {
        ranks.set(tgt, rank + 1);
        queue.push(tgt);
      }
    }
  }
  // Any unranked nodes (cycles, isolated) get rank 0
  for (const node of nodes) {
    if (!ranks.has(node.id)) ranks.set(node.id, 0);
  }

  // Group by rank, position left-to-right
  const byRank = new Map();
  for (const [id, rank] of ranks) {
    if (!byRank.has(rank)) byRank.set(rank, []);
    byRank.get(rank).push(id);
  }

  const H_SPACING = 240;
  const V_SPACING = 120;
  const positions = new Map();
  for (const [rank, ids] of byRank) {
    const totalH = (ids.length - 1) * V_SPACING;
    ids.forEach((id, i) => {
      positions.set(id, {
        x: rank * H_SPACING + 40,
        y: i * V_SPACING - totalH / 2 + 200,
      });
    });
  }

  return positions;
}

function buildFlowElements(graph, selectedEdge, selectedServiceId, proxyRoutes, localDomain, proxyPort, nowTs) {
  if (!graph?.nodes?.length) return { nodes: [], edges: [] };

  const maxEdgeRequests = Math.max(...graph.edges.map((edge) => edge.requestCount), 1);
  const incoming = new Map();

  for (const edge of graph.edges) {
    const tgt = typeof edge.target === "object" ? edge.target.id : edge.target;
    if (!tgt) continue;
    const acc = incoming.get(tgt) ?? { requestCount: 0, errorCount: 0 };
    acc.requestCount += edge.requestCount;
    acc.errorCount += edge.errorCount;
    incoming.set(tgt, acc);
  }
  const relatedNodeIds = new Set();
  if (selectedServiceId != null) {
    relatedNodeIds.add(selectedServiceId);
    for (const edge of graph.edges) {
      const src = typeof edge.source === "object" ? edge.source.id : edge.source;
      const tgt = typeof edge.target === "object" ? edge.target.id : edge.target;
      if (src === selectedServiceId && tgt) relatedNodeIds.add(tgt);
      if (tgt === selectedServiceId && src) relatedNodeIds.add(src);
    }
  }

  const edgeWidth = (value) => {
    const normalized = Math.log1p(value) / Math.log1p(maxEdgeRequests);
    return Number((1.4 + normalized * 4.2).toFixed(2));
  };

  // Topology-aware ranked layout
  const positions = computeRankedLayout(graph.nodes, graph.edges);

  const nodes = graph.nodes.map((n) => {
    const isExternal = n.external === true;
    const derivedInbound = incoming.get(n.id) ?? { requestCount: 0, errorCount: 0 };
    const incomingRequestCount = isExternal ? 0 : Number(n.requestsIn ?? derivedInbound.requestCount ?? 0);
    const incomingErrorCount = isExternal ? 0 : Number(n.errorsIn ?? derivedInbound.errorCount ?? 0);
    const errorRate = incomingRequestCount > 0 ? incomingErrorCount / incomingRequestCount : 0;
    const routes = isExternal ? [] : getServiceRouteEntries(n.id, proxyRoutes, localDomain, proxyPort);
    const recentActivity = isExternal ? 0 : computeRecentActivity(n.lastSeenAt, nowTs, Number(n.activeFlows ?? 0) > 0);
    const pos = positions.get(n.id) ?? { x: 40, y: 200 };
    return {
      id: n.id,
      type: "service",
      position: pos,
      data: {
        name: n.name,
        state: n.state,
        port: n.port,
        external: isExternal,
        incomingRequestCount,
        errorRate,
        routes,
        activeFlows: n.activeFlows,
        protocols: n.protocols,
        recentActivity,
        bytesIn: n.bytesIn,
        lastSeenAt: n.lastSeenAt,
        selected: selectedServiceId === n.id,
        relatedToSelection: selectedServiceId == null || relatedNodeIds.has(n.id),
      },
    };
  });

  const edges = graph.edges.map((e, i) => {
    const src = typeof e.source === "object" ? e.source.id : e.source;
    const tgt = typeof e.target === "object" ? e.target.id : e.target;
    const edgeIdentity = meshEdgeIdentity(e);
    const isSelected = selectedEdge && meshEdgeIdentity(selectedEdge) === edgeIdentity;
    const touchesSelectedService = selectedServiceId != null && (src === selectedServiceId || tgt === selectedServiceId);
    const color = protocolColor(e.dominantProtocol);
    const recentActivity = computeRecentActivity(e.lastSeenAt, nowTs, Number(e.activeFlows ?? 0) > 0);
    const baseOpacity = 0.2 + recentActivity * 0.55;
    return {
      id: edgeIdentity || `e-${i}`,
      type: "metric",
      source: src,
      target: tgt,
      animated: Number(e.activeFlows ?? 0) > 0 || recentActivity > 0.8,
      style: {
        stroke: color,
        strokeWidth: edgeWidth(e.requestCount),
        opacity: isSelected ? 0.95 : selectedServiceId == null ? baseOpacity : touchesSelectedService ? Math.min(0.9, baseOpacity + 0.18) : Math.max(0.1, baseOpacity * 0.45),
      },
      data: e,
    };
  });

  return { nodes, edges };
}

function escapeDot(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DEFAULT_MESH_THEME = {
  base: "#ffffff",
  surface: "#f8fafc",
  surfaceAlt: "#eef2ff",
  border: "#cbd5e1",
  borderStrong: "#94a3b8",
  text: "#0f172a",
  textMuted: "#64748b",
  primary: "#2563eb",
  success: "#16a34a",
  error: "#dc2626",
  warning: "#d97706",
};

function hslTripletToHex(raw, fallback) {
  const match = String(raw ?? "").trim().match(/^([0-9.]+)\s+([0-9.]+)%\s+([0-9.]+)%$/);
  if (!match) return fallback;
  const h = Number(match[1]) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  if (![h, s, l].every((value) => Number.isFinite(value))) return fallback;

  if (s === 0) {
    const gray = Math.round(l * 255);
    const hex = gray.toString(16).padStart(2, "0");
    return `#${hex}${hex}${hex}`;
  }

  const hueToRgb = (p, q, t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hueToRgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hueToRgb(p, q, h) * 255);
  const b = Math.round(hueToRgb(p, q, h - 1 / 3) * 255);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function readMeshTheme() {
  if (typeof window === "undefined") return DEFAULT_MESH_THEME;
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) => {
    const raw = styles.getPropertyValue(name).trim();
    return raw ? hslTripletToHex(raw, fallback) : fallback;
  };

  return {
    base: read("--b1", DEFAULT_MESH_THEME.base),
    surface: read("--b2", DEFAULT_MESH_THEME.surface),
    surfaceAlt: read("--b3", DEFAULT_MESH_THEME.surfaceAlt),
    border: read("--b3", DEFAULT_MESH_THEME.border),
    borderStrong: read("--n", DEFAULT_MESH_THEME.borderStrong),
    text: read("--bc", DEFAULT_MESH_THEME.text),
    textMuted: read("--nc", DEFAULT_MESH_THEME.textMuted),
    primary: read("--p", DEFAULT_MESH_THEME.primary),
    success: read("--su", DEFAULT_MESH_THEME.success),
    error: read("--er", DEFAULT_MESH_THEME.error),
    warning: read("--wa", DEFAULT_MESH_THEME.warning),
  };
}

function buildMeshDot(graph, selectedEdge, selectedServiceId, theme) {
  if (!graph?.nodes?.length) {
    return { dot: "", edgeLookup: new Map() };
  }

  const selectedEdgeId = selectedEdge ? meshEdgeIdentity(selectedEdge) : null;
  const selectedNeighbors = new Set();
  if (selectedServiceId != null) {
    selectedNeighbors.add(selectedServiceId);
    for (const edge of graph.edges ?? []) {
      const src = typeof edge.source === "object" ? edge.source.id : edge.source;
      const tgt = typeof edge.target === "object" ? edge.target.id : edge.target;
      if (src === selectedServiceId && tgt) selectedNeighbors.add(tgt);
      if (tgt === selectedServiceId && src) selectedNeighbors.add(src);
    }
  }

  const maxEdgeRequests = Math.max(...(graph.edges ?? []).map((edge) => Number(edge.requestCount ?? 0)), 1);
  const nodeIds = new Map();
  graph.nodes.forEach((node, index) => {
    nodeIds.set(node.id, `node_${index}`);
  });

  const edgeLookup = new Map();
  const lines = [
    "digraph ServiceMesh {",
    '  graph [rankdir=LR, bgcolor="transparent", pad="0.3", nodesep="0.45", ranksep="0.85", overlap=false, splines=true, concentrate=true];',
    `  node [shape=box, style="rounded,filled", fontname="Helvetica", fontsize=11, margin="0.18,0.14", color="${theme.border}", fillcolor="${theme.base}", fontcolor="${theme.text}", penwidth=1.1];`,
    `  edge [fontname="Helvetica", fontsize=9, color="${theme.borderStrong}", arrowsize=0.7, penwidth=1.6];`,
  ];

  for (const node of graph.nodes) {
    const dotId = nodeIds.get(node.id);
    const isExternal = node.external === true;
    const inboundReq = Number(node.requestsIn ?? 0);
    const inboundErr = Number(node.errorsIn ?? 0);
    const errorRate = inboundReq > 0 ? Math.round((inboundErr / inboundReq) * 100) : 0;
    const selected = selectedServiceId === node.id;
    const deemphasized = selectedServiceId != null && !selectedNeighbors.has(node.id);
    const baseColor = isExternal ? theme.borderStrong : node.state === "crashed" ? theme.error : node.state === "running" || node.state === "starting" ? theme.success : theme.borderStrong;
    const borderColor = selected ? theme.primary : deemphasized ? theme.border : baseColor;
    const fillColor = selected ? theme.surfaceAlt : deemphasized ? theme.surface : isExternal ? theme.surface : theme.base;
    const fontColor = deemphasized ? theme.textMuted : theme.text;
    const metricColor = deemphasized ? theme.textMuted : selected ? theme.primary : theme.textMuted;
    const penwidth = selected ? 2.4 : 1.2;
    const style = isExternal ? "rounded,dashed,filled" : "rounded,filled";
    const metrics = [];
    if (node.port) metrics.push(`:${node.port}`);
    if (!isExternal && inboundReq > 0) metrics.push(`${inboundReq} req`);
    if (!isExternal && errorRate > 0) metrics.push(`${errorRate}% err`);
    const title = escapeHtml(node.name);
    const subtitle = metrics.length > 0 ? escapeHtml(metrics.join(" · ")) : "";
    const label = subtitle
      ? `<
        <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0">
          <TR><TD><FONT POINT-SIZE="12"><B>${title}</B></FONT></TD></TR>
          <TR><TD><FONT POINT-SIZE="9" COLOR="${metricColor}">${subtitle}</FONT></TD></TR>
        </TABLE>
      >`
      : `<
        <TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0">
          <TR><TD><FONT POINT-SIZE="12"><B>${title}</B></FONT></TD></TR>
        </TABLE>
      >`;

    lines.push(
      `  ${dotId} [label=${label}, color="${borderColor}", fillcolor="${fillColor}", fontcolor="${fontColor}", penwidth=${penwidth}, style="${style}", URL="mesh://node/${encodeURIComponent(node.id)}", tooltip="${escapeDot(node.name)}"];`,
    );
  }

  for (const edge of graph.edges ?? []) {
    const sourceId = typeof edge.source === "object" ? edge.source.id : edge.source;
    const targetId = typeof edge.target === "object" ? edge.target.id : edge.target;
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) continue;

    const edgeId = meshEdgeIdentity(edge);
    edgeLookup.set(edgeId, edge);

    const requestCount = Number(edge.requestCount ?? 0);
    const errorCount = Number(edge.errorCount ?? 0);
    const latency = Number(edge.avgLatencyMs ?? 0);
    const errRate = requestCount > 0 ? errorCount / requestCount : 0;
    const selected = selectedEdgeId === edgeId;
    const touchesSelectedService = selectedServiceId != null && (sourceId === selectedServiceId || targetId === selectedServiceId);
    const deemphasized = selectedServiceId != null && !touchesSelectedService;
    const baseWidth = 1.4 + (Math.log1p(requestCount) / Math.log1p(maxEdgeRequests)) * 4.2;
    const color = selected
      ? theme.primary
      : deemphasized
        ? theme.border
        : errorCount > 0
          ? errRate >= 0.15 ? theme.error : theme.warning
          : theme.borderStrong;
    const penwidth = selected ? (baseWidth + 1.4).toFixed(2) : baseWidth.toFixed(2);
    const tooltip = `${sourceId} → ${targetId} | ${requestCount} req | ${formatProtocol(edge.dominantProtocol)}${latency > 0 ? ` | ${latency}ms` : ""}${errorCount > 0 ? ` | ${errorCount} err` : ""}`;

    lines.push(
      `  ${nodeIds.get(sourceId)} -> ${nodeIds.get(targetId)} [color="${color}", penwidth=${penwidth}, URL="mesh://edge/${encodeURIComponent(edgeId)}", tooltip="${escapeDot(tooltip)}"];`,
    );
  }

  lines.push("}");
  return { dot: lines.join("\n"), edgeLookup };
}

function MeshGraph({ graph, onSelectEdge, selectedEdge, selectedServiceId, proxyRoutes, localDomain, proxyPort, onSelectService }) {
  const [svg, setSvg] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(() => DEFAULT_MESH_THEME);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const applyTheme = () => setTheme(readMeshTheme());
    applyTheme();
    const observer = new MutationObserver(() => applyTheme());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => observer.disconnect();
  }, []);
  const { dot, edgeLookup } = useMemo(
    () => buildMeshDot(graph, selectedEdge, selectedServiceId, theme),
    [graph, selectedEdge, selectedServiceId, theme],
  );

  useEffect(() => {
    if (!dot) {
      setSvg(null);
      return;
    }

    let alive = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { instance } = await import("@viz-js/viz");
        const viz = await instance();
        const rendered = viz.renderString(dot, { format: "svg", engine: "dot" });
        if (alive) setSvg(rendered);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [dot]);

  const handleSvgClick = useCallback((event) => {
    const anchor = event.target?.closest?.("a");
    if (!anchor) return;

    const href = anchor.getAttribute("xlink:href") || anchor.getAttribute("href") || "";
    if (!href.startsWith("mesh://")) return;
    event.preventDefault();

    if (href.startsWith("mesh://node/")) {
      const id = decodeURIComponent(href.slice("mesh://node/".length));
      if (id) onSelectService?.(id);
      return;
    }

    if (href.startsWith("mesh://edge/")) {
      const id = decodeURIComponent(href.slice("mesh://edge/".length));
      onSelectEdge?.(edgeLookup.get(id) ?? null);
    }
  }, [edgeLookup, onSelectEdge, onSelectService]);

  if (!graph || !graph.nodes.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 opacity-20">
        <Zap className="size-5" />
        <span className="text-xs">Start services and trigger inter-service HTTP(S) traffic to see the mesh</span>
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-auto rounded-box bg-base-100/40 border border-base-content/[0.06]">
      {loading && (
        <div className="flex items-center justify-center h-full text-sm opacity-40">
          Rendering graph...
        </div>
      )}
      {error && (
        <div className="flex items-center justify-center h-full text-sm text-error/70 px-6 text-center">
          Failed to render service mesh: {error}
        </div>
      )}
      {!loading && !error && svg && (
        <div
          className="min-w-max min-h-full p-4 [&_svg]:max-w-none [&_svg]:h-auto [&_svg]:cursor-default [&_a]:cursor-pointer"
          onClick={handleSvgClick}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}

function MeshLegend() {
  return (
    <div className="absolute top-2 right-2 z-10 pointer-events-none">
      <div className="bg-base-200/80 backdrop-blur-sm border border-base-content/[0.06] rounded px-2.5 py-2 text-[10px] space-y-1.5 shadow-sm">
        <div className="font-semibold opacity-45 uppercase tracking-wider">Graph Legend</div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <div className="h-[2px] w-5 rounded-full bg-base-content/35" />
            <div className="h-[2px] w-8 rounded-full bg-base-content/35" />
          </div>
          <span className="opacity-45">width = volume</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <div className="h-[2px] w-6 rounded-full bg-success/80" />
            <div className="h-[2px] w-6 rounded-full bg-error/80" />
          </div>
          <span className="opacity-45">edge color = health</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <div className="size-4 rounded border-2 bg-base-100 border-success/80" />
            <div className="size-4 rounded border-2 bg-base-100 border-error/80" />
            <div className="size-4 rounded border-2 border-dashed bg-base-100 border-base-content/40" />
          </div>
          <span className="opacity-45">node border = state</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="px-2 py-0.5 rounded bg-info/20 border border-info/60 text-[9px] font-mono">click</div>
          <span className="opacity-45">click node/edge to inspect</span>
        </div>
      </div>
    </div>
  );
}

function SelectedServiceOverlay({
  service,
  nodeMetrics,
  inboundPeers,
  outboundPeers,
  inboundPeerTotal = 0,
  outboundPeerTotal = 0,
  onSelectPeer,
}) {
  if (!service || !nodeMetrics) return null;
  const topProtocols = topNodeProtocols(nodeMetrics.protocols, 3);
  const inboundMoreCount = Math.max(0, Number(inboundPeerTotal ?? 0) - Number(inboundPeers?.length ?? 0));
  const outboundMoreCount = Math.max(0, Number(outboundPeerTotal ?? 0) - Number(outboundPeers?.length ?? 0));
  const peerTone = (peer) => {
    const errorRate = Number(peer?.errorRate ?? 0);
    if (errorRate >= 0.25) return "text-error";
    if (errorRate > 0) return "text-warning";
    return "";
  };
  return (
    <div className="absolute bottom-2 left-2 z-10">
      <div className="bg-base-200/88 backdrop-blur-sm border border-base-content/[0.06] rounded px-2.5 py-2 text-[10px] shadow-sm max-w-[320px]">
        <div className="flex items-center gap-2">
          <span className="font-semibold opacity-70 truncate">{service.name}</span>
          {service.port && <span className="font-mono opacity-30">:{service.port}</span>}
          <span className="flex-1" />
          {nodeMetrics.lastSeenAt && (
            <span className="opacity-25">{formatRelativeSeenAt(nodeMetrics.lastSeenAt)}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 font-mono">
          <span className="opacity-45">{nodeMetrics.requestsIn ?? 0} in</span>
          <span className="opacity-45">{nodeMetrics.requestsOut ?? 0} out</span>
          {((nodeMetrics.bytesIn ?? 0) > 0 || (nodeMetrics.bytesOut ?? 0) > 0) && (
            <span className="opacity-40">{formatBytes(nodeMetrics.bytesIn)} / {formatBytes(nodeMetrics.bytesOut)}</span>
          )}
          {(nodeMetrics.activeFlows ?? 0) > 0 && (
            <span className="opacity-45">{nodeMetrics.activeFlows} active</span>
          )}
          {(nodeMetrics.errorsIn ?? 0) > 0 && (
            <span className="text-error/80">{nodeMetrics.errorsIn} err in</span>
          )}
          {(nodeMetrics.errorsOut ?? 0) > 0 && (
            <span className="text-error/80">{nodeMetrics.errorsOut} err out</span>
          )}
        </div>
        {topProtocols.length > 0 && (
          <div className="mt-1 font-mono opacity-35">{topProtocols.join(" · ")}</div>
        )}
        {(inboundPeers?.length > 0 || outboundPeers?.length > 0) && (
          <div className="mt-1.5 space-y-1 font-mono">
            {inboundPeers?.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="opacity-25 shrink-0">in</span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                  {inboundPeers.map((peer) => (
                    <button
                      key={`in-${peer.id}`}
                      type="button"
                      onClick={() => onSelectPeer?.(peer.id)}
                      className={`pointer-events-auto opacity-40 hover:opacity-75 truncate transition-opacity ${peerTone(peer)}`}
                      title={peer.errorCount > 0 ? `${peer.errorCount} errors · ${Math.round((peer.errorRate ?? 0) * 100)}% error` : `${peer.requestCount} requests`}
                    >
                      {peer.id}
                      <span className="opacity-30">:{peer.requestCount}</span>
                      {peer.errorCount > 0 && (
                        <span className="opacity-45"> !{peer.errorCount}</span>
                      )}
                      {peer.topProtocols.length > 0 && (
                        <span className="opacity-25"> {peer.topProtocols.join("/")}</span>
                      )}
                    </button>
                  ))}
                  {inboundMoreCount > 0 && (
                    <span className="opacity-25">+{inboundMoreCount} more</span>
                  )}
                </div>
              </div>
            )}
            {outboundPeers?.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="opacity-25 shrink-0">out</span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                  {outboundPeers.map((peer) => (
                    <button
                      key={`out-${peer.id}`}
                      type="button"
                      onClick={() => onSelectPeer?.(peer.id)}
                      className={`pointer-events-auto opacity-40 hover:opacity-75 truncate transition-opacity ${peerTone(peer)}`}
                      title={peer.errorCount > 0 ? `${peer.errorCount} errors · ${Math.round((peer.errorRate ?? 0) * 100)}% error` : `${peer.requestCount} requests`}
                    >
                      {peer.id}
                      <span className="opacity-30">:{peer.requestCount}</span>
                      {peer.errorCount > 0 && (
                        <span className="opacity-45"> !{peer.errorCount}</span>
                      )}
                      {peer.topProtocols.length > 0 && (
                        <span className="opacity-25"> {peer.topProtocols.join("/")}</span>
                      )}
                    </button>
                  ))}
                  {outboundMoreCount > 0 && (
                    <span className="opacity-25">+{outboundMoreCount} more</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SelectedEdgeOverlay({ edge }) {
  if (!edge) return null;
  const source = typeof edge.source === "object" ? edge.source.id : edge.source;
  const target = typeof edge.target === "object" ? edge.target.id : edge.target;
  const protocols = (edge.protocolCounts ?? []).slice(0, 3);
  const methods = topBreakdownEntries(edge.methodCounts);
  const statusClasses = topBreakdownEntries(edge.statusClassCounts);
  return (
    <div className="absolute bottom-2 left-2 z-10 pointer-events-none">
      <div className="bg-base-200/90 backdrop-blur-sm border border-base-content/[0.06] rounded px-2.5 py-2 text-[10px] shadow-sm max-w-[320px]">
        <div className="flex items-center gap-2">
          <span className="font-mono opacity-65 truncate">{source} → {target}</span>
          <span className="flex-1" />
          {edge.lastSeenAt && (
            <span className="opacity-25">{formatRelativeSeenAt(edge.lastSeenAt)}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 font-mono">
          <span className="opacity-45">{edge.requestCount} req</span>
          <span className="opacity-45">{edge.avgLatencyMs}ms</span>
          <span className="opacity-45">{formatProtocol(edge.dominantProtocol)}</span>
          {(edge.bytesIn > 0 || edge.bytesOut > 0) && (
            <span className="opacity-40">{formatBytes(edge.bytesIn)} in / {formatBytes(edge.bytesOut)} out</span>
          )}
          {(edge.activeFlows ?? 0) > 0 && (
            <span className="opacity-45">{edge.activeFlows} active</span>
          )}
          {(edge.errorCount ?? 0) > 0 && (
            <span className="text-error/80">{edge.errorCount} err</span>
          )}
        </div>
        {protocols.length > 0 && (
          <div className="mt-1 font-mono opacity-35">
            {protocols.map((entry) => `${formatProtocol(entry.protocol)}:${entry.count}`).join(" · ")}
          </div>
        )}
        {methods.length > 0 && (
          <div className="mt-1 font-mono opacity-35">
            {methods.map(([method, count]) => `${method}:${count}`).join(" · ")}
          </div>
        )}
        {statusClasses.length > 0 && (
          <div className="mt-1 font-mono opacity-35">
            {statusClasses.map(([statusClass, count]) => `${statusClass}:${count}`).join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

// ── ServicesPage ───────────────────────────────────────────────────────────────

function ServicesPage() {
  const { liveMode } = useDashboard();
  const { services, runtimeServices, loading, refresh } = useServices({ liveMode, pollInterval: liveMode ? false : 15_000 });
  const { graph, nativeGraph, status: meshStatus, clearMesh } = useMesh({ liveMode });
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [proxyStatus, setProxyStatus] = useState({ routes: [], localDomain: null });

  useEffect(() => {
    api.get("/proxy/reverse/status").then((res) => setProxyStatus(res)).catch(() => {});
  }, []);

  const proxyRoutes = proxyStatus?.routes ?? [];
  const localDomain = proxyStatus?.localDomain ?? null;
  const proxyPort = proxyStatus?.port ?? 4433;
  const meshRunning = meshStatus?.running ?? false;
  const meshWindowLabel = formatMeshWindow(
    nativeGraph?.windowStart ?? graph?.windowStart,
    nativeGraph?.windowEnd ?? graph?.windowEnd,
  );
  const meshConfiguredWindowLabel = formatConfiguredMeshWindow(meshStatus?.liveWindowSeconds);
  const servicesRefresh = useCallback(() => {
    return refresh();
  }, [refresh]);

  const selectedService = services.find((s) => s.id === selectedId) ?? null;
  const selectedNodeMetrics = graph?.nodes?.find((node) => node.id === selectedId) ?? null;
  const selectedInboundPeers = useMemo(
    () => topPeerSummaries(graph, selectedId, "inbound", 3),
    [graph, selectedId],
  );
  const selectedOutboundPeers = useMemo(
    () => topPeerSummaries(graph, selectedId, "outbound", 3),
    [graph, selectedId],
  );
  const selectedInboundPeerTotal = useMemo(
    () => topPeerSummaries(graph, selectedId, "inbound", Number.MAX_SAFE_INTEGER).length,
    [graph, selectedId],
  );
  const selectedOutboundPeerTotal = useMemo(
    () => topPeerSummaries(graph, selectedId, "outbound", Number.MAX_SAFE_INTEGER).length,
    [graph, selectedId],
  );

  useEffect(() => {
    if (selectedId && !loading && !selectedService) setSelectedId(null);
  }, [selectedId, selectedService, loading]);

  const handleSelect = useCallback((id) => {
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const handleClose = useCallback(() => setSelectedId(null), []);

  const handleStartAll = useCallback(async () => {
    await api.post("/services/start-all", {});
    await servicesRefresh();
  }, [servicesRefresh]);

  const handleStopAll = useCallback(async () => {
    await Promise.all(services.filter((s) => s.running).map((s) => api.post(`/services/${s.id}/stop`, {})));
    await servicesRefresh();
  }, [services, servicesRefresh]);

  const [killing, setKilling] = useState(false);
  const handleKillAll = useCallback(async () => {
    setKilling(true);
    try {
      await api.post("/services/kill-all", {});
      await servicesRefresh();
    } finally {
      setKilling(false);
    }
  }, [servicesRefresh]);

  const anyRunning   = services.some((s) => s.running);
  const allRunning   = services.length > 0 && services.every((s) => s.running);
  const runningCount = services.filter((s) => s.running).length;

  const isActive = (s) => s.running || s.state === "starting" || s.state === "crashed";
  const activeServices = services.filter(isActive);
  const idleServices = services.filter((s) => !isActive(s));

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-base-200 shrink-0">
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
          {meshStatus && (
            <div className="flex items-center gap-1.5 mr-2" title={meshRunning ? "Mesh runtime active" : "Configure mesh in Settings → Services"}>
              <Network className={`size-3 ${meshRunning ? "text-success/70" : "opacity-25"}`} />
              <span className="text-[10px] opacity-35">HTTP mesh</span>
              {meshConfiguredWindowLabel && (
                <span className="text-[10px] opacity-20 tabular-nums">{meshConfiguredWindowLabel}</span>
              )}
            </div>
          )}
          {meshRunning && (graph?.totalRequests ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 mr-1">
              <span className="text-[10px] opacity-25 tabular-nums">
                {graph.totalRequests} req · {graph.edges?.length ?? 0} conn
              </span>
              {meshWindowLabel && (
                <span className="text-[10px] opacity-20 tabular-nums">{meshWindowLabel}</span>
              )}
              {selectedEdge && (
                <button className="btn btn-xs btn-ghost opacity-40 hover:opacity-80 h-4 min-h-0 px-1 text-[10px]"
                  onClick={() => setSelectedEdge(null)}>
                  clear filter
                </button>
              )}
              <button className="btn btn-xs btn-ghost opacity-25 hover:opacity-60 h-4 min-h-0 px-1"
                onClick={clearMesh} title="Clear traffic data">
                <Trash2 className="size-2.5" />
              </button>
            </div>
          )}
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
          {(anyRunning || meshRunning || runtimeServices.some((s) => s.running)) && (
            <button
              className="btn btn-xs btn-error opacity-70 hover:opacity-100 gap-1"
              onClick={handleKillAll}
              disabled={killing}
              title="Stop all services, mesh, and proxy"
            >
              {killing ? <Loader2 className="size-3 animate-spin" /> : <Square className="size-3" />}
              Kill all
            </button>
          )}
        </div>
      </div>

      {/* Two-column body */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">

        {/* ── Left column: services list ─────────────────────────────── */}
        <div className="lg:w-[360px] xl:w-[392px] shrink-0 overflow-y-auto border-b lg:border-b-0 lg:border-r border-base-content/[0.06] p-2.5">

          {/* Loading */}
          {loading && (
            <div className="space-y-2">
              <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
            </div>
          )}

          {/* Empty */}
          {!loading && services.length === 0 && runtimeServices.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 px-5 py-12">
                <Server className="size-8 opacity-10" />
                <div className="text-center">
                  <p className="text-sm font-medium opacity-60">No services configured</p>
                <p className="text-xs opacity-35 mt-1">Add services in Settings to manage them here.</p>
              </div>
            </div>
          )}

          {!loading && runtimeServices.length > 0 && (
            <section className="mb-4">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-[10px] font-semibold opacity-30 uppercase tracking-widest">Network Runtime</span>
                <div className="flex-1 h-px bg-base-content/5" />
                <span className="text-[10px] opacity-20 tabular-nums">{runtimeServices.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {runtimeServices.map((service) => (
                  <RuntimeServiceCard
                    key={service.id}
                    service={service}
                    onRefresh={servicesRefresh}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Online */}
          {!loading && activeServices.length > 0 && (
            <section className="mb-4">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-success/60 shrink-0" />
                <span className="text-[10px] font-semibold text-success/60 uppercase tracking-widest">Online</span>
                <div className="flex-1 h-px bg-success/[0.06]" />
                <span className="text-[10px] opacity-25 tabular-nums">{activeServices.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {activeServices.map((service) => (
                  <ServiceCard
                    key={service.id}
                    service={service}
                    selected={service.id === selectedId}
                    onSelect={handleSelect}
                    onRefresh={servicesRefresh}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Offline */}
          {!loading && idleServices.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-base-content/15 shrink-0" />
                <span className="text-[10px] font-semibold opacity-25 uppercase tracking-widest">Offline</span>
                <div className="flex-1 h-px bg-base-content/[0.04]" />
                <span className="text-[10px] opacity-20 tabular-nums">{idleServices.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {idleServices.map((service) => (
                  <ServiceCard
                    key={service.id}
                    service={service}
                    selected={service.id === selectedId}
                    onSelect={handleSelect}
                    onRefresh={servicesRefresh}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        {/* ── Right column: mesh ──────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

          {/* Graph area — fills all available height */}
          <div className="flex-1 min-h-[300px] lg:min-h-0 relative">
            {meshRunning ? (
              <>
                {/* Selected edge info bar */}
                {selectedEdge && (
                  <div className="absolute top-2 left-2 right-2 z-10 flex items-center gap-2 bg-base-200/90 backdrop-blur-sm rounded border border-base-content/[0.06] px-2.5 py-1.5 text-[10px] shadow-sm pointer-events-none">
                    <span className="font-mono opacity-60 truncate">
                      {typeof selectedEdge.source === "object" ? selectedEdge.source.id : selectedEdge.source}
                      {" → "}
                      {typeof selectedEdge.target === "object" ? selectedEdge.target.id : selectedEdge.target}
                    </span>
                    <span className="opacity-40 shrink-0 tabular-nums">
                      {selectedEdge.requestCount}req · {selectedEdge.avgLatencyMs}ms
                      {" · "}{formatProtocol(selectedEdge.dominantProtocol)}
                      {(selectedEdge.bytesIn > 0 || selectedEdge.bytesOut > 0) && (
                        <span> · {formatBytes(selectedEdge.bytesIn)} in / {formatBytes(selectedEdge.bytesOut)} out</span>
                      )}
                      {selectedEdge.activeFlows > 0 && <span> · {selectedEdge.activeFlows} active</span>}
                      {selectedEdge.errorCount > 0 && <span className="text-error"> · {selectedEdge.errorCount}err</span>}
                    </span>
                    <span className="flex-1" />
                    {selectedEdge.lastSeenAt && (
                      <span className="opacity-25 shrink-0">{formatRelativeSeenAt(selectedEdge.lastSeenAt)}</span>
                    )}
                    {meshWindowLabel && (
                      <span className="opacity-25 shrink-0">{meshWindowLabel}</span>
                    )}
                    <button
                      className="pointer-events-auto opacity-40 hover:opacity-80"
                      onClick={() => setSelectedEdge(null)}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                )}

                <MeshGraph
                  graph={graph}
                  onSelectEdge={setSelectedEdge}
                  selectedEdge={selectedEdge}
                  selectedServiceId={selectedId}
                  proxyRoutes={proxyRoutes}
                  localDomain={localDomain}
                  proxyPort={proxyPort}
                  onSelectService={handleSelect}
                />

                {!selectedEdge && <MeshLegend />}
                {!selectedEdge && selectedService && selectedNodeMetrics && (
                  <SelectedServiceOverlay
                    service={selectedService}
                    nodeMetrics={selectedNodeMetrics}
                    inboundPeers={selectedInboundPeers}
                    outboundPeers={selectedOutboundPeers}
                    inboundPeerTotal={selectedInboundPeerTotal}
                    outboundPeerTotal={selectedOutboundPeerTotal}
                    onSelectPeer={handleSelect}
                  />
                )}

                {selectedEdge && <SelectedEdgeOverlay edge={selectedEdge} />}

                {/* Edge detail overlay — paths + protocols */}
                {selectedEdge && (
                  <div className="absolute bottom-2 right-2 bg-base-200/90 backdrop-blur-sm rounded border border-base-content/[0.06] px-2.5 py-2 text-[10px] pointer-events-none max-w-[280px]">
                    {selectedEdge.protocolCounts?.length > 0 && (
                      <div className="flex items-center gap-2 mb-1.5 font-mono">
                        <span className="opacity-40 shrink-0">observed</span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {selectedEdge.protocolCounts.slice(0, 3).map((entry) => (
                            <span key={entry.protocol} className="opacity-60"
                              style={{ color: protocolColor(entry.protocol) }}>
                              {entry.protocol}<span className="opacity-40 text-base-content">:{entry.count}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {topBreakdownEntries(selectedEdge.methodCounts).length > 0 && (
                      <div className="flex items-center gap-2 mb-1.5 font-mono">
                        <span className="opacity-40 shrink-0">methods</span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {topBreakdownEntries(selectedEdge.methodCounts).map(([method, count]) => (
                            <span key={method} className="opacity-60">
                              {method}<span className="opacity-40 text-base-content">:{count}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {topBreakdownEntries(selectedEdge.statusClassCounts).length > 0 && (
                      <div className="flex items-center gap-2 mb-1.5 font-mono">
                        <span className="opacity-40 shrink-0">status</span>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {topBreakdownEntries(selectedEdge.statusClassCounts).map(([statusClass, count]) => (
                            <span
                              key={statusClass}
                              className={statusClass.startsWith("4") || statusClass.startsWith("5") ? "text-error/80" : "opacity-60"}
                            >
                              {statusClass}<span className="opacity-40 text-base-content">:{count}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedEdge.topPaths?.length > 0 && (
                      <div className="space-y-0.5">
                        {selectedEdge.topPaths.slice(0, 4).map((p) => (
                          <div key={p.path} className="flex items-center gap-2 font-mono">
                            <span className="opacity-35 truncate">{p.path}</span>
                            <span className="shrink-0 opacity-50 tabular-nums">{p.count}×</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {(selectedEdge.bytesIn > 0 || selectedEdge.bytesOut > 0) && (
                      <div className="flex items-center gap-2 mt-1.5 font-mono">
                        <span className="opacity-40 shrink-0">bytes</span>
                        <span className="opacity-60">{formatBytes(selectedEdge.bytesIn)} in</span>
                        <span className="opacity-60">{formatBytes(selectedEdge.bytesOut)} out</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Mesh summary — bottom-right when no edge selected */}
                {!selectedEdge && (graph?.totalRequests ?? 0) > 0 && (
                  <div className="absolute bottom-2 right-2 pointer-events-none">
                    <div className="flex items-center gap-3 bg-base-200/80 backdrop-blur-sm border border-base-content/[0.06] rounded px-2.5 py-1.5 text-[10px] font-mono tabular-nums">
                      <span className="opacity-30">{graph.totalRequests} req</span>
                      <span className="opacity-20">·</span>
                      <span className="opacity-30">{graph.edges?.length ?? 0} paths</span>
                      {meshWindowLabel && (
                        <>
                          <span className="opacity-20">·</span>
                          <span className="opacity-30">{meshWindowLabel}</span>
                        </>
                      )}
                      {nativeGraph?.edges?.length > 0 && (() => {
                        const allP50 = nativeGraph.edges
                          .map((e) => e.latency?.percentiles?.["0.5"] ?? e.latency?.percentiles?.p50)
                          .filter((v) => v != null);
                        const avgP50 = allP50.length ? Math.round((allP50.reduce((a, b) => a + b, 0) / allP50.length) * 1000) : null;
                        return avgP50 != null ? (
                          <>
                            <span className="opacity-20">·</span>
                            <span className={`opacity-40 ${avgP50 > 200 ? "text-warning" : ""}`}>p50 {avgP50}ms</span>
                          </>
                        ) : null;
                      })()}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-2">
                <Network className="size-6 opacity-10" />
                <div className="text-center">
                  <p className="text-sm font-medium opacity-30">Service Mesh</p>
                  <p className="text-xs opacity-20 mt-0.5">
                    {meshStatus ? "Enable and configure mesh in /settings/services to capture traffic" : "Loading…"}
                  </p>
                </div>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Overlay drawer */}
      {selectedService && (
        <ServiceDrawer
          key={selectedService.id}
          service={selectedService}
          onClose={handleClose}
          onRefresh={servicesRefresh}
          graph={graph}
          proxyRoutes={proxyRoutes}
          localDomain={localDomain}
          proxyPort={proxyPort}
        />
      )}
    </div>
  );
}
