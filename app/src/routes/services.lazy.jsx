import { createLazyFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Server, Play, Square, Terminal, Circle, Loader2, X,
  AlertTriangle, ChevronRight, Folder, Scan, Wrench, CheckCircle2,
  Network, Trash2, ArrowRight, Zap, RotateCcw, ShieldCheck,
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
import { useReverseProxy } from "../hooks/useReverseProxy.js";
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

function LogViewer({ id, running, state }) {
  const { liveMode } = useDashboard();
  const [log, setLog] = useState("");
  const [logSize, setLogSize] = useState(0);
  const [status, setStatus] = useState("idle"); // idle | loading | live | stale | error
  const [error, setError] = useState(null);
  const [pollInterval, setPollInterval] = useState(0); // 0 = auto (WS + fallback), >0 = forced poll
  const [showPollControls, setShowPollControls] = useState(false);
  const logRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const html = useMemo(() => (log ? ansiToHtml(log) : ""), [log]);
  const hasLog = Boolean(log && log.trim());
  const lastSizeRef = useRef(0);
  const lastChunkAtRef = useRef(0); // timestamp of last WS chunk
  const wsChunkCountRef = useRef(0);
  const [lastChunkAgo, setLastChunkAgo] = useState(null); // seconds since last chunk

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
    wsChunkCountRef.current = 0;
    lastChunkAtRef.current = 0;
    setLastChunkAgo(null);
    if (!id) return;

    fetchFull();
    subscribeServiceLog(id);

    const unsub = onServiceLog(id, (chunk) => {
      setLog((prev) => prev + chunk);
      lastSizeRef.current += new TextEncoder().encode(chunk).length;
      lastChunkAtRef.current = Date.now();
      wsChunkCountRef.current++;
      setStatus("live");
    });

    return () => {
      unsubscribeServiceLog(id);
      unsub();
    };
  }, [id, fetchFull]);

  // Auto-fallback: only poll when WS is disconnected AND service is running.
  // When WS is live, the server pushes chunks via fs.watch — no polling needed.
  // Quiet logs (idle service) must not be mistaken for a broken WS connection.
  useEffect(() => {
    if (!running || !id || pollInterval > 0 || liveMode) return;
    const checker = setInterval(() => {
      const elapsed = lastChunkAtRef.current ? (Date.now() - lastChunkAtRef.current) / 1000 : null;
      setLastChunkAgo(elapsed);
      fetchIncremental();
      if (lastChunkAtRef.current && Date.now() - lastChunkAtRef.current > 15_000) {
        setStatus("stale");
      }
    }, 5_000);
    return () => clearInterval(checker);
  }, [running, id, pollInterval, liveMode, fetchIncremental]);

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

  const agoText = lastChunkAgo != null && lastChunkAgo > 5
    ? `${Math.round(lastChunkAgo)}s ago`
    : null;

  const statusBadge = status === "loading"
    ? <span className="flex items-center gap-1.5 text-xs opacity-40"><Loader2 className="size-2.5 animate-spin" />loading</span>
    : status === "error"
      ? <span className="text-xs text-error/70">error</span>
    : hasLog && state === "crashed"
      ? <span className="flex items-center gap-1.5 text-xs text-error/70"><Circle className="size-2 fill-current" />crash log</span>
    : status === "stale"
      ? <span className="flex items-center gap-1.5 text-xs text-warning/70"><Circle className="size-2 fill-warning animate-pulse" />stale{agoText ? ` · ${agoText}` : ""}</span>
    : status === "live"
      ? <span className="flex items-center gap-1.5 text-xs text-success"><Circle className="size-2 fill-success" />{pollInterval > 0 ? `poll ${pollInterval / 1000}s` : "ws"}{agoText ? ` · ${agoText}` : ""}</span>
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

// ── Service Traffic Panel (for drawer) ────────────────────────────────────────

function ServiceTrafficPanel({ serviceId, traffic, graph }) {
  const entries = useMemo(() => {
    if (!traffic?.length) return [];
    return traffic.filter(
      (e) => e.sourceServiceId === serviceId || e.targetServiceId === serviceId,
    ).slice(-30);
  }, [traffic, serviceId]);

  const connections = useMemo(() => {
    if (!graph?.edges?.length) return { inbound: [], outbound: [] };
    const inbound = graph.edges.filter((e) => {
      const tgt = typeof e.target === "object" ? e.target.id : e.target;
      return tgt === serviceId;
    });
    const outbound = graph.edges.filter((e) => {
      const src = typeof e.source === "object" ? e.source.id : e.source;
      return src === serviceId;
    });
    return { inbound, outbound };
  }, [graph, serviceId]);

  const hasData = entries.length > 0 || connections.inbound.length > 0 || connections.outbound.length > 0;
  if (!hasData) return null;

  const statusColor = (code) => {
    if (code < 300) return "text-success";
    if (code < 400) return "text-warning";
    return "text-error";
  };

  return (
    <div className="border-t border-base-200/60 shrink-0">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-base-200/30">
        <Network className="size-3 opacity-30" />
        <span className="text-[10px] font-medium opacity-50 uppercase tracking-widest">Traffic</span>
        <span className="flex-1" />
        <span className="text-[10px] opacity-20 tabular-nums">{entries.length} requests</span>
      </div>

      {/* Connection summary */}
      {(connections.inbound.length > 0 || connections.outbound.length > 0) && (
        <div className="px-3 py-2 border-t border-base-200/40 flex flex-wrap gap-x-4 gap-y-1">
          {connections.inbound.map((edge) => {
            const src = typeof edge.source === "object" ? edge.source.id : edge.source;
            return (
              <div key={`in-${src}`} className="flex items-center gap-1.5 text-[10px]">
                <ArrowRight className="size-2.5 opacity-30 rotate-180" />
                <span className="font-mono opacity-50">{src}</span>
                <span className="opacity-25">{edge.requestCount}req</span>
                {edge.errorCount > 0 && <span className="text-error/70">{edge.errorCount}err</span>}
              </div>
            );
          })}
          {connections.outbound.map((edge) => {
            const tgt = typeof edge.target === "object" ? edge.target.id : edge.target;
            return (
              <div key={`out-${tgt}`} className="flex items-center gap-1.5 text-[10px]">
                <ArrowRight className="size-2.5 opacity-30" />
                <span className="font-mono opacity-50">{tgt}</span>
                <span className="opacity-25">{edge.requestCount}req</span>
                {edge.errorCount > 0 && <span className="text-error/70">{edge.errorCount}err</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Recent requests */}
      {entries.length > 0 && (
        <div className="max-h-[140px] overflow-y-auto border-t border-base-200/40">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 px-3 py-0.5 text-[10px] border-b border-base-content/[0.06] hover:bg-base-200/20">
              <span className="font-mono opacity-40 w-8 shrink-0">{entry.method}</span>
              <span className="font-mono opacity-35 truncate flex-1">{entry.path}</span>
              <span className={`font-mono shrink-0 ${statusColor(entry.statusCode)}`}>{entry.statusCode}</span>
              <span className="font-mono opacity-30 shrink-0 tabular-nums w-10 text-right">{entry.durationMs}ms</span>
            </div>
          ))}
        </div>
      )}
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

function ServiceDrawerBody({ service, onClose, onRefresh, traffic, graph }) {
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

  const handleRestart = useCallback(async () => {
    setBusy(true);
    try { await api.post(`/services/${service.id}/restart`, {}); await onRefresh(); }
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

      {/* Traffic for this service */}
      <ServiceTrafficPanel serviceId={service.id} traffic={traffic} graph={graph} />

      {/* Log volume sparkline — running services only */}
      {service.running && <DrawerSparkline id={service.id} running={service.running} />}

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

function ServiceDrawer({ service, onClose, onRefresh, traffic, graph }) {
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
        <ServiceDrawerBody service={service} onClose={handleClose} onRefresh={onRefresh} traffic={traffic} graph={graph} />
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
  const [health, setHealth] = useState(null); // null | { ok, healthy, latencyMs }
  const state = service.state ?? (service.running ? "running" : "stopped");
  const info = stateInfo(state);
  const canStart = state === "stopped" || state === "crashed";
  const canStop = state === "running" || state === "starting";

  // Health check — fetch on mount and every 30s for running services with a port
  useEffect(() => {
    if (!service.running || !service.port) { setHealth(null); return; }
    let cancelled = false;
    const ping = async () => {
      try {
        const res = await api.get(`/services/${encodeURIComponent(service.id)}/health`);
        if (!cancelled) setHealth(res);
      } catch {
        if (!cancelled) setHealth(null);
      }
    };
    ping();
    const id = setInterval(ping, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [service.id, service.running, service.port]);

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

  return (
    <button
      type="button"
      onClick={() => onSelect(service.id)}
      className={`group relative text-left rounded-md border border-base-content/[0.08] bg-base-200/40 transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30
        ${selected ? "ring-1 ring-primary/30 bg-base-200/70" : "hover:bg-base-200/60"}${state === "crashed" ? " border-error/20" : ""}`}
    >
      <div className="px-3.5 py-3">
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
          <div className="mt-2.5" title="Log volume — 5min window, 10s buckets">
            <LogSparkline id={service.id} running={service.running} />
          </div>
        )}
      </div>

    </button>
  );
}

function RuntimeServiceCard({ service, onRefresh }) {
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const state = service.state ?? (service.running ? "running" : "stopped");
  const info = stateInfo(state);
  const canStart = state === "stopped" || state === "crashed";
  const canStop = state === "running" || state === "starting";

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
    <div className="rounded-md border border-base-content/[0.08] bg-base-200/30 overflow-hidden">
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className={`size-3.5 shrink-0 ${info.dot}${info.spinning ? " animate-pulse" : ""}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm truncate">{service.name}</span>
              <span className="badge badge-xs badge-outline opacity-60">runtime</span>
              {service.port && <span className="text-[10px] font-mono opacity-35">:{service.port}</span>}
            </div>
            <div className="font-mono text-[11px] opacity-35 truncate mt-1">{service.command}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button className="btn btn-xs btn-ghost opacity-45 hover:opacity-90" onClick={() => setShowLog((v) => !v)} title="Logs">
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
      {showLog && <div className="h-72 border-t border-base-content/[0.06]"><LogViewer id={service.id} running={service.running} state={state} /></div>}
    </div>
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

function ServiceNode({ data, style }) {
  const color = stateColor(data.state);
  const nodeStyle = {
    ...style,
    borderColor: errorRateColor(data.errorRate),
    borderWidth: `${1 + (data.errorRate ?? 0) * 2}px`,
    borderStyle: "solid",
  };

  return (
    <div className="relative px-4 py-2.5 rounded-md border bg-base-200/80 text-center"
      style={nodeStyle}>
      <Handle type="target" position={Position.Left} className="!bg-base-content/20 !w-1.5 !h-1.5 !border-0" />
      <div className="flex items-center justify-center gap-1.5 mb-0.5">
        <div className="size-2 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-xs font-medium opacity-80">{data.name}</span>
      </div>
      {data.port && (
        <span className="text-[10px] font-mono opacity-30">:{data.port}</span>
      )}
      <div className="text-[10px] font-mono opacity-40 mt-1">{data.incomingRequestCount ?? 0} req in</div>
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

function buildFlowElements(graph, selectedEdge) {
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

  const maxIncoming = Math.max(...incoming.values().map((value) => value.requestCount), 0);
  const nodeSize = (value) => {
    if (maxIncoming <= 0 || value <= 0) return 112;
    const normalized = Math.pow(Math.min(value / maxIncoming, 1), 0.5);
    return Math.round(112 + normalized * 86);
  };
  const edgeWidth = (value) => {
    const normalized = Math.log1p(value) / Math.log1p(maxEdgeRequests);
    return Number((1.4 + normalized * 4.2).toFixed(2));
  };

  // Simple grid layout — arrange nodes in a horizontal line with spacing
  const spacing = 220;
  const nodes = graph.nodes.map((n, i) => {
    const inbound = incoming.get(n.id) ?? { requestCount: 0, errorCount: 0 };
    const size = nodeSize(inbound.requestCount);
    const errorRate = inbound.requestCount > 0 ? inbound.errorCount / inbound.requestCount : 0;
    return {
      id: n.id,
      type: "service",
      position: { x: (i % 4) * spacing + 40, y: Math.floor(i / 4) * 120 + 40 },
      data: {
        name: n.name,
        state: n.state,
        port: n.port,
        incomingRequestCount: inbound.requestCount,
        errorRate,
      },
      style: {
        width: `${size}px`,
        minWidth: `${size}px`,
        minHeight: `${Math.max(56, Math.round(size * 0.62))}px`,
      },
    };
  });

  const edges = graph.edges.map((e, i) => {
    const src = typeof e.source === "object" ? e.source.id : e.source;
    const tgt = typeof e.target === "object" ? e.target.id : e.target;
    const isSelected = selectedEdge && (
      (typeof selectedEdge.source === "object" ? selectedEdge.source.id : selectedEdge.source) === src &&
      (typeof selectedEdge.target === "object" ? selectedEdge.target.id : selectedEdge.target) === tgt
    );
    const color = protocolColor(e.dominantProtocol);
    return {
      id: `e-${i}`,
      type: "metric",
      source: src,
      target: tgt,
      animated: e.requestCount > 0,
      style: {
        stroke: color,
        strokeWidth: edgeWidth(e.requestCount),
        opacity: isSelected ? 0.9 : 0.5,
      },
      data: e,
    };
  });

  return { nodes, edges };
}

function MeshGraph({ graph, onSelectEdge, selectedEdge }) {
  const { nodes: flowNodes, edges: flowEdges } = useMemo(
    () => buildFlowElements(graph, selectedEdge),
    [graph, selectedEdge],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

  // Sync when graph data changes
  useEffect(() => { setNodes(flowNodes); }, [flowNodes, setNodes]);
  useEffect(() => { setEdges(flowEdges); }, [flowEdges, setEdges]);

  const onEdgeClick = useCallback((_event, edge) => {
    const graphEdge = graph?.edges?.find((e) => {
      const src = typeof e.source === "object" ? e.source.id : e.source;
      const tgt = typeof e.target === "object" ? e.target.id : e.target;
      return src === edge.source && tgt === edge.target;
    });
    onSelectEdge?.(graphEdge ?? null);
  }, [graph, onSelectEdge]);

  if (!graph || !graph.nodes.length) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 opacity-20">
        <Zap className="size-5" />
        <span className="text-xs">Start services and trigger inter-service HTTP calls to see the mesh</span>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onEdgeClick={onEdgeClick}
      nodeTypes={meshNodeTypes}
      edgeTypes={meshEdgeTypes}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      proOptions={{ hideAttribution: true }}
      className="[&_.react-flow__edge]:cursor-pointer"
    >
      <Background gap={20} size={1} color="currentColor" className="opacity-[0.03]" />
      <MiniMap
        nodeColor={(n) => stateColor(n.data?.state)}
        maskColor="rgba(0,0,0,0.7)"
        className="!bg-base-200/80 !border-base-content/10 !rounded"
        pannable
        zoomable
      />
    </ReactFlow>
  );
}

// ── MeshNativeStats ────────────────────────────────────────────────────────────
// Shows per-edge latency percentiles + rates from the native raffel graph snapshot

function fmtMs(seconds) {
  if (seconds == null) return "—";
  return `${Math.round(seconds * 1000)}ms`;
}

function fmtPct(ratio) {
  if (ratio == null) return "—";
  const pct = ratio * 100;
  return pct < 0.1 ? "<0.1%" : `${pct.toFixed(1)}%`;
}

function MeshNativeStats({ snapshot }) {
  if (!snapshot?.edges?.length) return null;
  const edges = [...snapshot.edges].sort((a, b) => b.requestsTotal - a.requestsTotal).slice(0, 8);

  return (
    <div className="rounded-md border border-base-content/[0.06] bg-base-200/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-base-content/[0.04]">
        <span className="text-[10px] font-medium opacity-25 uppercase tracking-widest">Edge latency</span>
        <span className="text-[10px] opacity-15 tabular-nums ml-auto">{snapshot.edges.length} pairs · p{snapshot.percentiles?.join("/p") ?? "50/90/95"}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="border-b border-base-content/[0.04]">
              <th className="px-3 py-1 text-left font-medium opacity-25">Source</th>
              <th className="px-3 py-1 text-left font-medium opacity-25">Target</th>
              <th className="px-3 py-1 text-right font-medium opacity-25 tabular-nums">req/s</th>
              <th className="px-3 py-1 text-right font-medium opacity-25 tabular-nums">p50</th>
              <th className="px-3 py-1 text-right font-medium opacity-25 tabular-nums">p90</th>
              <th className="px-3 py-1 text-right font-medium opacity-25 tabular-nums">p95</th>
              <th className="px-3 py-1 text-right font-medium opacity-25 tabular-nums">err%</th>
            </tr>
          </thead>
          <tbody>
            {edges.map((edge) => {
              const p = edge.latency?.percentiles ?? {};
              const errPct = edge.rates?.failureRatio;
              return (
                <tr key={edge.id} className="border-t border-base-content/[0.03] hover:bg-base-200/30">
                  <td className="px-3 py-1 font-mono opacity-50 truncate max-w-[120px]">{edge.source}</td>
                  <td className="px-3 py-1 font-mono opacity-50 truncate max-w-[120px]">{edge.target}</td>
                  <td className="px-3 py-1 text-right font-mono opacity-40 tabular-nums">
                    {edge.rates?.requestsPerSecond != null ? edge.rates.requestsPerSecond.toFixed(2) : "—"}
                  </td>
                  <td className="px-3 py-1 text-right font-mono opacity-60 tabular-nums">{fmtMs(p["0.5"] ?? p.p50)}</td>
                  <td className="px-3 py-1 text-right font-mono opacity-40 tabular-nums">{fmtMs(p["0.9"] ?? p.p90)}</td>
                  <td className="px-3 py-1 text-right font-mono opacity-30 tabular-nums">{fmtMs(p["0.95"] ?? p.p95)}</td>
                  <td className={`px-3 py-1 text-right font-mono tabular-nums ${errPct > 0.05 ? "text-error" : errPct > 0 ? "text-warning" : "opacity-20"}`}>
                    {fmtPct(errPct)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── ReverseProxyPanel ──────────────────────────────────────────────────────────
// Shows reverse proxy stats + per-route breakdown when the proxy is running

function ReverseProxyPanel({ stats, graph, port }) {
  if (!stats) return null;

  const edges = graph?.edges ?? [];
  const topEdges = [...edges].sort((a, b) => b.requestsTotal - a.requestsTotal).slice(0, 6);

  return (
    <section>
      <div className="flex items-center gap-2.5 mb-2.5">
        <ShieldCheck className="size-3 opacity-30" />
        <span className="text-[11px] font-medium opacity-30 uppercase tracking-wider">HTTPS Proxy</span>
        <div className="flex-1 h-px bg-base-content/5" />
        <span className="text-[10px] opacity-25 font-mono">:{port}</span>
      </div>

      <div className="rounded-md border border-base-content/[0.06] bg-base-200/20 overflow-hidden">
        {/* Stats bar */}
        <div className="flex items-center gap-4 px-3 py-2 border-b border-base-content/[0.04] flex-wrap">
          {[
            { label: "active", value: stats.connectionsActive },
            { label: "total", value: stats.connectionsTotal },
            { label: "errors", value: stats.connectionsErrored },
            { label: "↓", value: stats.bytesFromClient != null ? `${(stats.bytesFromClient / 1024).toFixed(1)}KB` : "—" },
            { label: "↑", value: stats.bytesToClient != null ? `${(stats.bytesToClient / 1024).toFixed(1)}KB` : "—" },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center gap-1.5">
              <span className="text-[10px] opacity-25">{label}</span>
              <span className="text-[11px] font-mono tabular-nums opacity-60">{value}</span>
            </div>
          ))}
        </div>

        {/* Per-route table */}
        {topEdges.length > 0 && (
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-base-content/[0.04]">
                <th className="px-3 py-1 text-left font-medium opacity-25">Source → Target</th>
                <th className="px-3 py-1 text-right font-medium opacity-25">reqs</th>
                <th className="px-3 py-1 text-right font-medium opacity-25">p50</th>
                <th className="px-3 py-1 text-right font-medium opacity-25">p95</th>
                <th className="px-3 py-1 text-right font-medium opacity-25">err%</th>
              </tr>
            </thead>
            <tbody>
              {topEdges.map((edge) => {
                const p = edge.latency?.percentiles ?? {};
                return (
                  <tr key={edge.id} className="border-t border-base-content/[0.03] hover:bg-base-200/30">
                    <td className="px-3 py-1 font-mono opacity-40 truncate max-w-[260px]">
                      {edge.source} <ArrowRight className="inline size-2.5 opacity-30 mx-0.5" /> {edge.target}
                    </td>
                    <td className="px-3 py-1 text-right font-mono opacity-60 tabular-nums">{edge.requestsTotal}</td>
                    <td className="px-3 py-1 text-right font-mono opacity-50 tabular-nums">{fmtMs(p["0.5"] ?? p.p50)}</td>
                    <td className="px-3 py-1 text-right font-mono opacity-30 tabular-nums">{fmtMs(p["0.95"] ?? p.p95)}</td>
                    <td className={`px-3 py-1 text-right font-mono tabular-nums ${(edge.rates?.failureRatio ?? 0) > 0.05 ? "text-error" : "opacity-20"}`}>
                      {fmtPct(edge.rates?.failureRatio)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {topEdges.length === 0 && (
          <p className="px-3 py-2.5 text-[10px] opacity-25">No traffic recorded yet.</p>
        )}
      </div>
    </section>
  );
}

// ── ServicesPage ───────────────────────────────────────────────────────────────

function ServicesPage() {
  const { liveMode } = useDashboard();
  const { services, runtimeServices, loading, refresh } = useServices({ liveMode, pollInterval: liveMode ? false : 15_000 });
  const { graph, nativeGraph, traffic, status: meshStatus, clearMesh, toggleMesh } = useMesh({ liveMode });
  const { stats: reverseStats, graph: reverseGraph, status: reverseStatus } = useReverseProxy();
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const meshEnabled = meshStatus?.enabled ?? false;
  const meshRunning = meshStatus?.running ?? false;
  const servicesRefresh = useCallback(() => {
    return refresh();
  }, [refresh]);

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
    await servicesRefresh();
  }, [services, servicesRefresh]);

  const handleStopAll = useCallback(async () => {
    await Promise.all(services.filter((s) => s.running).map((s) => api.post(`/services/${s.id}/stop`, {})));
    await servicesRefresh();
  }, [services, servicesRefresh]);

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
          {/* Mesh toggle */}
          {meshStatus && (
            <label className="flex items-center gap-1.5 mr-2 cursor-pointer" title={meshEnabled ? "Mesh proxy is active — capturing inter-service traffic" : "Enable mesh proxy to capture inter-service traffic"}>
              <Network className={`size-3 ${meshRunning ? "text-success/70" : "opacity-25"}`} />
              <span className="text-[10px] opacity-35">Mesh</span>
              <input
                type="checkbox"
                className="toggle toggle-xs toggle-success"
                checked={meshEnabled}
                onChange={(e) => toggleMesh(e.target.checked)}
              />
            </label>
          )}
          {meshRunning && (graph?.totalRequests ?? 0) > 0 && (
            <div className="flex items-center gap-1.5 mr-1">
              <span className="text-[10px] opacity-25 tabular-nums">
                {graph.totalRequests} req · {graph.edges?.length ?? 0} conn
              </span>
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
        </div>
      </div>

      {/* Two-column body */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">

        {/* ── Left column: services list ─────────────────────────────── */}
        <div className="lg:w-[380px] xl:w-[420px] shrink-0 overflow-y-auto border-b lg:border-b-0 lg:border-r border-base-content/[0.06] p-3">

          {/* Loading */}
          {loading && (
            <div className="space-y-2">
              <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
            </div>
          )}

          {/* Empty */}
          {!loading && services.length === 0 && runtimeServices.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16">
              <Server className="size-8 opacity-10" />
              <div className="text-center">
                <p className="text-sm font-medium opacity-60">No services configured</p>
                <p className="text-xs opacity-35 mt-1">Add services in Settings to manage them here.</p>
              </div>
            </div>
          )}

          {!loading && runtimeServices.length > 0 && (
            <section className="mb-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold opacity-30 uppercase tracking-widest">Runtime</span>
                <div className="flex-1 h-px bg-base-content/5" />
                <span className="text-[10px] opacity-20 tabular-nums">{runtimeServices.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-2">
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
            <section className="mb-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold opacity-30 uppercase tracking-widest">Online</span>
                <div className="flex-1 h-px bg-base-content/5" />
                <span className="text-[10px] opacity-20 tabular-nums">{activeServices.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-2">
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
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold opacity-20 uppercase tracking-widest">Offline</span>
                <div className="flex-1 h-px bg-base-content/5" />
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
                      {selectedEdge.errorCount > 0 && <span className="text-error"> · {selectedEdge.errorCount}err</span>}
                    </span>
                    <span className="flex-1" />
                    <button
                      className="pointer-events-auto opacity-40 hover:opacity-80"
                      onClick={() => setSelectedEdge(null)}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                )}

                <MeshGraph graph={graph} onSelectEdge={setSelectedEdge} selectedEdge={selectedEdge} />

                {/* Edge top paths overlay */}
                {selectedEdge && selectedEdge.topPaths?.length > 0 && (
                  <div className="absolute bottom-2 left-2 bg-base-200/90 backdrop-blur-sm rounded border border-base-content/[0.06] px-2.5 py-1.5 text-[10px] pointer-events-none">
                    <div className="space-y-0.5">
                      {selectedEdge.protocolCounts?.length > 0 && (
                        <div className="flex items-center gap-2 opacity-60 font-mono">
                          <span className="font-medium opacity-90">protocols:</span>
                          {selectedEdge.protocolCounts.slice(0, 2).map((entry) => (
                            <span key={entry.protocol}>{entry.protocol}:{entry.count}</span>
                          ))}
                          {selectedEdge.protocolCounts.length > 2 && <span>…</span>}
                        </div>
                      )}
                      {selectedEdge.topPaths.map((p) => (
                        <div key={p.path} className="flex items-center gap-2 opacity-40 font-mono">
                          <span className="truncate max-w-[200px]">{p.path}</span>
                          <span className="shrink-0">{p.count}x</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <Network className="size-7 opacity-10" />
                <div className="text-center">
                  <p className="text-sm font-medium opacity-30">Service Mesh</p>
                  <p className="text-xs opacity-20 mt-1">
                    {meshStatus ? "Enable Mesh in the toolbar to capture traffic" : "Loading…"}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Stats panel — pinned below the graph */}
          {(meshRunning || reverseStatus?.running) && (
            <div className="shrink-0 overflow-y-auto border-t border-base-content/[0.06] p-3 space-y-3 max-h-[260px]">
              {meshRunning && <MeshNativeStats snapshot={nativeGraph} />}
              {reverseStatus?.running && (
                <ReverseProxyPanel stats={reverseStats} graph={reverseGraph} port={reverseStatus.port} />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Overlay drawer */}
      {selectedService && (
        <ServiceDrawer
          key={selectedService.id}
          service={selectedService}
          onClose={handleClose}
          onRefresh={servicesRefresh}
          traffic={traffic}
          graph={graph}
        />
      )}
    </div>
  );
}
