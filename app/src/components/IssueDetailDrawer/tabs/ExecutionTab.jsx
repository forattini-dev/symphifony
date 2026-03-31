import React, { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, Terminal, SlidersHorizontal, Zap, Send, ChevronDown, Activity } from "lucide-react";
import { api } from "../../../api.js";
import { formatDate, formatDuration } from "../../../utils.js";
import { Section, Field, CopyButton, ConfigStrip, TokenPhaseBreakdown, resolveStageDisplay } from "../shared.jsx";
import { useDashboard } from "../../../context/DashboardContext.jsx";

// ── LiveMonitor ───────────────────────────────────────────────────────────────

function LiveMonitor({ issueId, running, startedAt, onOutput, onLive }) {
  const [live, setLive] = useState(null);

  const fetchLive = useCallback(async () => {
    try {
      const res = await api.get(`/issues/${encodeURIComponent(issueId)}/live`);
      setLive(res);
      onOutput?.(res?.logTail || "");
      onLive?.(res);
    } catch { /* ignore */ }
  }, [issueId, onLive]);

  useEffect(() => {
    if (!running) {
      setLive(null);
      onOutput?.(null);
      onLive?.(null);
      return;
    }
    fetchLive();
    const interval = setInterval(fetchLive, 3000);
    return () => clearInterval(interval);
  }, [running, fetchLive, onOutput, onLive]);

  if (!running || !live) return null;

  const elapsed = Number.isFinite(Number(live.elapsed))
    ? Number(live.elapsed)
    : startedAt
      ? Math.max(Date.now() - new Date(startedAt).getTime(), 0)
      : 0;
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const logKb = live.logSize ? (live.logSize / 1024).toFixed(1) : "0";

  return (
    <div className="rounded-box border border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="loading loading-spinner loading-xs text-primary" />
        <span className="text-sm font-semibold text-primary">Agent running</span>
        <span className="text-xs opacity-50 ml-auto">{mins}m {secs}s elapsed</span>
      </div>
      <div className="flex gap-3 text-xs opacity-60">
        <span>Log: {logKb} KB</span>
        {live.agentPid && <span>PID: {live.agentPid}</span>}
        {live.daemonSocketReady && <span className="text-success">daemon ●</span>}
        {live.agentAlive === false && live.agentPid && <span className="text-error">process dead</span>}
      </div>
    </div>
  );
}

// ── ProgressStrip (real-time WS progress) ────────────────────────────────────

function ProgressStrip({ issueId }) {
  const { issueProgress } = useDashboard();
  const progress = issueProgress[issueId];
  if (!progress) return null;

  const fmtTokens = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const elapsed = progress.elapsedMs > 0
    ? `${Math.floor(progress.elapsedMs / 60000)}m ${Math.floor((progress.elapsedMs % 60000) / 1000)}s`
    : null;

  return (
    <div className="rounded-box border border-info/30 bg-info/5 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <Activity className="size-3 text-info" />
        <span className="font-medium text-info">
          Turn {progress.turn}/{progress.maxTurns}
        </span>
        <span className="opacity-50">({progress.role})</span>
        {progress.tokens && (
          <span className="opacity-60">
            {fmtTokens(progress.tokens.total)} tokens
          </span>
        )}
        {progress.cumulativeTokens && progress.cumulativeTokens.total > (progress.tokens?.total || 0) && (
          <span className="opacity-40">
            | {fmtTokens(progress.cumulativeTokens.total)} total
          </span>
        )}
        {elapsed && <span className="opacity-40 ml-auto">{elapsed}</span>}
      </div>
      {progress.toolsUsed?.length > 0 && (
        <div className="flex gap-1 mt-1 flex-wrap">
          {progress.toolsUsed.slice(-5).map((t, i) => (
            <span key={i} className="badge badge-xs badge-ghost opacity-60">{t}</span>
          ))}
        </div>
      )}
      {progress.directiveSummary && (
        <div className="text-xs opacity-50 mt-1 truncate">{progress.directiveSummary}</div>
      )}
    </div>
  );
}

// ── AgentCommandBar ───────────────────────────────────────────────────────────

const QUICK_COMMANDS = [
  { label: "/usage", value: "/usage" },
  { label: "/status", value: "/status" },
  { label: "/stats", value: "/stats session" },
];

function AgentCommandBar({ issueId, daemonReady }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState(null); // { ok, msg }
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef(null);

  const send = useCallback(async (text) => {
    const cmd = (text ?? input).trim();
    if (!cmd) return;
    setSending(true);
    setFeedback(null);
    try {
      await api.post(`/issues/${encodeURIComponent(issueId)}/agent/write`, { text: cmd });
      setFeedback({ ok: true, msg: `sent: ${cmd}` });
      setInput("");
      setTimeout(() => setFeedback(null), 2500);
    } catch (e) {
      setFeedback({ ok: false, msg: e.message || "failed" });
      setTimeout(() => setFeedback(null), 4000);
    } finally {
      setSending(false);
    }
  }, [issueId, input]);

  const handleKey = useCallback((e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }, [send]);

  // Collapsed: just a toggle row
  if (!expanded) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-box border border-base-300 cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-colors group"
        onClick={() => { setExpanded(true); setTimeout(() => inputRef.current?.focus(), 50); }}
        title="Send a slash command to the running agent"
      >
        <Terminal className="size-3.5 opacity-40 group-hover:opacity-70 transition-opacity" />
        <span className="text-xs opacity-40 group-hover:opacity-70 transition-opacity flex-1">
          Send command to agent…
        </span>
        {QUICK_COMMANDS.map((q) => (
          <span key={q.value} className="hidden sm:inline text-xs font-mono opacity-30 group-hover:opacity-60 transition-opacity">{q.label}</span>
        ))}
        <ChevronDown className="size-3 opacity-30 group-hover:opacity-60 transition-opacity" />
      </div>
    );
  }

  return (
    <div className="rounded-box border border-base-300 bg-base-100 overflow-hidden">
      {/* Quick command chips */}
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 border-b border-base-200 flex-wrap">
        <span className="text-xs opacity-40 mr-1 shrink-0">Quick:</span>
        {QUICK_COMMANDS.map((q) => (
          <button
            key={q.value}
            className="btn btn-xs btn-ghost font-mono text-xs h-6 min-h-0 px-2 opacity-60 hover:opacity-100"
            onClick={() => send(q.value)}
            disabled={sending}
          >
            {q.label}
          </button>
        ))}
        <button
          className="btn btn-xs btn-ghost text-xs h-6 min-h-0 px-2 opacity-30 hover:opacity-70 ml-auto"
          onClick={() => setExpanded(false)}
        >
          ✕
        </button>
      </div>

      {/* Input row */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-xs opacity-30 font-mono shrink-0">&gt;</span>
        <input
          ref={inputRef}
          type="text"
          className="input input-xs input-ghost flex-1 font-mono text-xs focus:outline-none px-0 min-w-0"
          placeholder="/insights, /simplify, /frontend-design…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          disabled={sending}
          spellCheck={false}
        />
        <button
          className={`btn btn-xs btn-primary h-7 min-h-0 gap-1 ${sending ? "btn-disabled" : ""}`}
          onClick={() => send()}
          disabled={sending || !input.trim()}
        >
          {sending
            ? <span className="loading loading-spinner loading-xs" />
            : <Send className="size-3" />}
        </button>
      </div>

      {/* Feedback */}
      {feedback && (
        <div className={`px-3 pb-2 text-xs font-mono ${feedback.ok ? "text-success" : "text-error"}`}>
          {feedback.ok ? "✓" : "✗"} {feedback.msg}
        </div>
      )}

      {!daemonReady && (
        <div className="px-3 pb-2 text-xs opacity-40 italic">
          Daemon socket not detected — write requires PTY daemon mode.
        </div>
      )}
    </div>
  );
}

// ── ExecutionTab ──────────────────────────────────────────────────────────────

export function ExecutionTab({ issue, workflowConfig }) {
  const isRunning = issue.state === "Running" || issue.state === "Reviewing";
  const PAST_EXECUTION = new Set(["Reviewing", "PendingDecision", "Approved", "Merged", "Blocked"]);
  const executionRan = isRunning || PAST_EXECUTION.has(issue.state) || issue.durationMs > 0 || issue.commandExitCode != null;
  const executeConfig = workflowConfig?.workflow?.execute;
  const [liveOutput, setLiveOutput] = useState("");
  const [liveData, setLiveData] = useState(null);
  const handleLiveOutput = useCallback((value) => setLiveOutput(value || ""), []);
  const handleLiveData = useCallback((data) => setLiveData(data), []);
  const [autoScroll, setAutoScroll] = useState(true);
  const outputRef = useRef(null);
  const commandOutput = isRunning ? (liveOutput || issue.commandOutputTail || "") : (issue.commandOutputTail || "");
  const hasCommandOutput = Boolean(commandOutput);

  // Auto-scroll to bottom when output updates
  useEffect(() => {
    if (autoScroll && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [commandOutput, autoScroll]);

  return (
    <div className="space-y-5">
      {/* Real-time progress strip (WS-pushed) */}
      {isRunning && <ProgressStrip issueId={issue.id} />}

      {/* Live monitor */}
      <LiveMonitor
        issueId={issue.id}
        running={isRunning}
        startedAt={issue.startedAt}
        onOutput={handleLiveOutput}
        onLive={handleLiveData}
      />

      {/* Command bar — shown only when running */}
      {isRunning && (
        <AgentCommandBar
          issueId={issue.id}
          daemonReady={liveData?.daemonSocketReady ?? false}
        />
      )}

      {(() => {
        const stage = resolveStageDisplay({
          phaseTokens: issue.tokensByPhase?.executor,
          tokensByModel: issue.tokensByModel,
          workflowConfig,
          stageName: "execute",
          phaseRan: executionRan,
        });
        return stage ? (
          <Section
            title={stage.variant === "historical" ? "Ran with" : "Execution Config"}
            icon={SlidersHorizontal}
          >
            <ConfigStrip config={stage.config} variant={stage.variant} />
          </Section>
        ) : null;
      })()}

      <Section title="Run Info" icon={Terminal}>
        <div className="space-y-0.5">
          <Field label="Exit code" value={issue.commandExitCode ?? "-"} mono />
          <Field label="Duration" value={formatDuration(issue.durationMs)} />
          {issue.workspacePath && <Field label="Issue workspace root" value={issue.workspacePath} mono />}
          {issue.worktreePath && <Field label="Issue code checkout" value={issue.worktreePath} mono />}
          {issue.workspacePreparedAt && <Field label="Workspace prepared at" value={formatDate(issue.workspacePreparedAt)} />}
        </div>
      </Section>

      {issue.lastError && (
        <Section title="Last Error" icon={AlertTriangle}>
          <pre className="text-xs bg-error/10 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto">
            {issue.lastError}
          </pre>
        </Section>
      )}

      {hasCommandOutput ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-sm flex items-center gap-1.5">
              <Terminal className="size-4 opacity-50" /> CLI Output
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs checkbox-primary"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                />
                <span className="text-xs opacity-50">Auto-scroll</span>
              </label>
              <CopyButton text={commandOutput} />
            </div>
          </div>
          <pre ref={outputRef} className="text-xs bg-base-200 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-[50vh] overflow-y-auto">
            {commandOutput}
          </pre>
        </div>
      ) : (
        <div className="text-sm opacity-40 text-center py-4">No command output yet.</div>
      )}

      {(issue.tokensByPhase || issue.tokensByModel) && (
        <Section title="Token Usage" icon={Zap}>
          <TokenPhaseBreakdown tokensByPhase={issue.tokensByPhase} tokensByModel={issue.tokensByModel} />
        </Section>
      )}

      {!issue.lastError && !hasCommandOutput && !issue.tokensByPhase && !issue.tokensByModel && (
        <div className="text-sm opacity-40 text-center py-8">No execution data yet.</div>
      )}
    </div>
  );
}
