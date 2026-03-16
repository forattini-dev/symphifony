import React, { useState, useEffect, useCallback } from "react";
import {
  X, FileText, Tag, RotateCcw, GitBranch, Clock, AlertTriangle,
  Folder, Layers, Gauge, History, Terminal, ArrowRight, Circle, CheckCircle2,
  PlayCircle, Eye, Ban, XCircle, Diff, Wrench, Copy, Check,
  Info, Code, Route, ClipboardCheck, ThumbsUp, ThumbsDown, MessageSquare,
} from "lucide-react";
import { STATES, ISSUE_STATE_MACHINE, getIssueTransitions, timeAgo, formatDate, formatDuration } from "../utils.js";
import { api } from "../api.js";

// ── Constants ───────────────────────────────────────────────────────────────

const STATE_ICON = {
  Todo: Circle, "In Progress": PlayCircle, "In Review": Eye,
  Blocked: AlertTriangle, Done: CheckCircle2, Cancelled: XCircle,
};
const STATE_COLOR = {
  Todo: "text-warning", "In Progress": "text-primary", "In Review": "text-secondary",
  Blocked: "text-error", Done: "text-success", Cancelled: "text-neutral",
};
const STATE_BTN = {
  Todo: "btn-warning", "In Progress": "btn-primary", "In Review": "btn-secondary",
  Blocked: "btn-error", Done: "btn-success", Cancelled: "btn-neutral",
};
const STATE_BADGE = {
  Todo: "badge-warning", "In Progress": "badge-primary", "In Review": "badge-secondary",
  Blocked: "badge-error", Done: "badge-success", Cancelled: "badge-neutral",
};
const STATE_BG = {
  Todo: "bg-warning/10 border-warning/30", "In Progress": "bg-primary/10 border-primary/30",
  "In Review": "bg-secondary/10 border-secondary/30", Blocked: "bg-error/10 border-error/30",
  Done: "bg-success/10 border-success/30", Cancelled: "bg-neutral/10 border-neutral/30",
};

const BASE_TABS = [
  { id: "overview", label: "Overview", icon: Info },
  { id: "execution", label: "Execution", icon: Terminal },
  { id: "diff", label: "Diff", icon: Code },
  { id: "routing", label: "Routing", icon: Route },
  { id: "history", label: "History", icon: History },
];

const REVIEW_TAB = { id: "review", label: "Review", icon: ClipboardCheck };

function getTabs(issueState) {
  // Show Review tab for In Review, Done (to see verdict), and Blocked (review may have failed)
  if (issueState === "In Review" || issueState === "Done" || issueState === "Blocked") {
    return [BASE_TABS[0], REVIEW_TAB, ...BASE_TABS.slice(1)];
  }
  return BASE_TABS;
}

// ── Shared components ───────────────────────────────────────────────────────

function Section({ title, icon: Icon, children, badge }) {
  return (
    <div className="space-y-2">
      <div className="font-semibold text-sm flex items-center gap-1.5">
        {Icon && <Icon className="size-4 opacity-50" />}
        {title}
        {badge != null && <span className="badge badge-xs badge-ghost ml-auto">{badge}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Field({ label, value, mono }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="flex justify-between items-baseline gap-4 py-0.5">
      <span className="text-xs opacity-50 shrink-0">{label}</span>
      <span className={`text-sm text-right truncate ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <button className="btn btn-xs btn-ghost gap-1" onClick={copy} title="Copy to clipboard">
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// formatDuration imported from utils.js

function getStateMachineOrder(state) {
  return { Todo: 0, "In Progress": 1, "In Review": 2, Blocked: 2, Done: 3, Cancelled: 3 }[state] ?? 0;
}

// ── Tab: Overview ───────────────────────────────────────────────────────────

function OverviewTab({ issue, onStateChange, onRetry, onCancel }) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const blockedBy = Array.isArray(issue.blockedBy) ? issue.blockedBy : [];
  const transitions = getIssueTransitions(issue.state);
  const nextStates = transitions.filter((s) => s !== issue.state);

  return (
    <div className="space-y-5">
      {/* Description */}
      {issue.description && (
        <p className="text-sm opacity-70 whitespace-pre-wrap">{issue.description}</p>
      )}

      {/* Actions */}
      <Section title="Actions" icon={Wrench}>
        <div className="space-y-3">
          <div>
            <div className="text-xs opacity-50 mb-1.5">Move to</div>
            <div className="flex flex-wrap gap-1.5">
              {nextStates.map((s) => {
                const Icon = STATE_ICON[s] || Circle;
                return (
                  <button key={s} className={`btn btn-sm btn-soft gap-1.5 ${STATE_BTN[s] || ""}`}
                    onClick={() => onStateChange?.(issue.id, s)}>
                    <Icon className="size-3.5" />{s}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-sm btn-soft gap-1" onClick={() => onRetry?.(issue.id)}
              disabled={issue.state === "In Progress" || issue.state === "In Review"}>
              <RotateCcw className="size-3" /> Retry
            </button>
            <button className="btn btn-sm btn-error btn-soft gap-1" onClick={() => onCancel?.(issue.id)}
              disabled={issue.state === "Done" || issue.state === "Cancelled"}>
              <XCircle className="size-3" /> Cancel
            </button>
          </div>
        </div>
      </Section>

      {/* Details */}
      <Section title="Details" icon={Layers}>
        <div className="space-y-0.5">
          <Field label="State" value={issue.state} />
          <Field label="Priority" value={`P${issue.priority}`} />
          <Field label="Attempts" value={`${issue.attempts ?? 0} / ${issue.maxAttempts ?? 0}`} />
          <Field label="Assigned" value={issue.assignedToWorker ? "Yes" : "No"} />
          {issue.assigneeId && <Field label="Assignee" value={issue.assigneeId} mono />}
          {issue.branchName && <Field label="Branch" value={issue.branchName} mono />}
          {issue.url && <Field label="URL" value={issue.url} mono />}
        </div>
      </Section>

      {/* Timing */}
      <Section title="Timing" icon={Clock}>
        <div className="space-y-0.5">
          <Field label="Created" value={formatDate(issue.createdAt)} />
          <Field label="Updated" value={formatDate(issue.updatedAt)} />
          {issue.startedAt && <Field label="Started" value={formatDate(issue.startedAt)} />}
          {issue.completedAt && <Field label="Completed" value={formatDate(issue.completedAt)} />}
          {issue.nextRetryAt && <Field label="Next retry" value={formatDate(issue.nextRetryAt)} />}
          <Field label="Duration" value={formatDuration(issue.durationMs)} />
        </div>
      </Section>

      {/* Labels */}
      {labels.length > 0 && (
        <Section title="Labels" icon={Tag} badge={labels.length}>
          <div className="flex flex-wrap gap-1.5">
            {labels.map((l) => <span key={l} className="badge badge-sm badge-outline">{l}</span>)}
          </div>
        </Section>
      )}

      {/* Dependencies */}
      {blockedBy.length > 0 && (
        <Section title="Dependencies" icon={Ban} badge={blockedBy.length}>
          <div className="space-y-0.5">
            {blockedBy.map((d) => <div key={d} className="font-mono text-xs">{d}</div>)}
          </div>
        </Section>
      )}
    </div>
  );
}

// ── Live Monitor ────────────────────────────────────────────────────────────

function LiveMonitor({ issueId, running, startedAt }) {
  const [live, setLive] = useState(null);

  const fetchLive = useCallback(async () => {
    try {
      const res = await api.get(`/live/${encodeURIComponent(issueId)}`);
      setLive(res);
    } catch { /* ignore */ }
  }, [issueId]);

  useEffect(() => {
    if (!running) { setLive(null); return; }
    fetchLive();
    const interval = setInterval(fetchLive, 3000);
    return () => clearInterval(interval);
  }, [running, fetchLive]);

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
      </div>
      {live.logTail && (
        <pre className="text-xs bg-base-200 rounded-box p-2 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto font-mono opacity-80">
          {live.logTail}
        </pre>
      )}
    </div>
  );
}

// ── Tab: Execution ──────────────────────────────────────────────────────────

function ExecutionTab({ issue }) {
  const isRunning = issue.state === "In Progress" || issue.state === "In Review";

  return (
    <div className="space-y-5">
      {/* Live monitor */}
      <LiveMonitor issueId={issue.id} running={isRunning} startedAt={issue.startedAt} />

      <Section title="Run Info" icon={Terminal}>
        <div className="space-y-0.5">
          <Field label="Exit code" value={issue.commandExitCode ?? "-"} mono />
          <Field label="Duration" value={formatDuration(issue.durationMs)} />
          {issue.workspacePath && <Field label="Workspace" value={issue.workspacePath} mono />}
          {issue.workspacePreparedAt && <Field label="Workspace ready" value={formatDate(issue.workspacePreparedAt)} />}
        </div>
      </Section>

      {issue.lastError && (
        <Section title="Last Error" icon={AlertTriangle}>
          <pre className="text-xs bg-error/10 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-72 overflow-y-auto">
            {issue.lastError}
          </pre>
        </Section>
      )}

      {issue.commandOutputTail && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-sm flex items-center gap-1.5">
              <Terminal className="size-4 opacity-50" /> Command Output
            </div>
            <CopyButton text={issue.commandOutputTail} />
          </div>
          <pre className="text-xs bg-base-200 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-[50vh] overflow-y-auto">
            {issue.commandOutputTail}
          </pre>
        </div>
      )}

      {!issue.lastError && !issue.commandOutputTail && (
        <div className="text-sm opacity-40 text-center py-8">No execution data yet.</div>
      )}
    </div>
  );
}

// ── Tab: Diff ───────────────────────────────────────────────────────────────

function DiffTab({ issueId }) {
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/diff/${encodeURIComponent(issueId)}`);
      setDiff(res.diff || res.message || "(no changes)");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [issueId]);

  useEffect(() => { setDiff(null); setError(null); }, [issueId]);

  // Auto-load on mount
  useEffect(() => { fetchDiff(); }, [fetchDiff]);

  if (loading) {
    return <div className="flex items-center justify-center gap-2 text-sm opacity-50 py-12"><span className="loading loading-spinner loading-sm" /> Generating diff...</div>;
  }
  if (error) {
    return <div className="text-sm text-error py-4">{error}</div>;
  }
  if (!diff) return null;

  const lines = (diff || "").split("\n");
  const statSection = [];
  const diffSection = [];
  let pastSeparator = false;
  for (const line of lines) {
    if (line === "---") { pastSeparator = true; continue; }
    if (pastSeparator) diffSection.push(line);
    else statSection.push(line);
  }

  return (
    <div className="space-y-4">
      {statSection.length > 0 && (
        <div>
          <div className="text-xs opacity-50 font-semibold mb-1">Summary</div>
          <pre className="text-xs bg-base-200 rounded-box p-2 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">{statSection.join("\n")}</pre>
        </div>
      )}
      {diffSection.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs opacity-50 font-semibold">Full diff</div>
            <CopyButton text={diffSection.join("\n")} />
          </div>
          <pre className="text-xs rounded-box p-3 overflow-x-auto max-h-[60vh] overflow-y-auto leading-relaxed bg-base-200">
            {diffSection.map((line, i) => {
              let cls = "";
              if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-success bg-success/10";
              else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-error bg-error/10";
              else if (line.startsWith("@@")) cls = "text-info opacity-70";
              else if (line.startsWith("diff ")) cls = "font-bold opacity-80 border-t border-base-300 pt-1 mt-1";
              return <div key={i} className={cls}>{line}</div>;
            })}
          </pre>
        </div>
      )}
      {diff === "(no changes)" && (
        <div className="text-sm opacity-40 text-center py-8">No changes detected in workspace.</div>
      )}
      <div className="flex justify-end">
        <button className="btn btn-xs btn-ghost gap-1" onClick={fetchDiff}>
          <RotateCcw className="size-3" /> Refresh
        </button>
      </div>
    </div>
  );
}

// ── Tab: Routing ────────────────────────────────────────────────────────────

const INTERNAL_PATH_RE = /^(\.symphifony|symphifony[-_]|WORKFLOW\.local)/;
function filterPaths(arr) {
  return (Array.isArray(arr) ? arr : []).filter((p) => !INTERNAL_PATH_RE.test(p));
}

function RoutingTab({ issue }) {
  const paths = filterPaths(issue.paths);
  const explicitSet = new Set(paths);
  const inferredPaths = filterPaths(issue.inferredPaths).filter((p) => !explicitSet.has(p));
  const overlays = Array.isArray(issue.capabilityOverlays) ? issue.capabilityOverlays : [];
  const rationale = Array.isArray(issue.capabilityRationale) ? issue.capabilityRationale : [];

  return (
    <div className="space-y-5">
      {/* State Machine */}
      <Section title="State Machine" icon={GitBranch}>
        <div className="space-y-1">
          {STATES.map((state) => {
            const isCurrent = state === issue.state;
            const Icon = STATE_ICON[state] || Circle;
            const transitions = ISSUE_STATE_MACHINE[state] || [];
            const isPast = getStateMachineOrder(state) < getStateMachineOrder(issue.state);
            return (
              <div key={state} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 border text-sm ${isCurrent ? STATE_BG[state] + " font-semibold" : isPast ? "border-transparent opacity-40" : "border-transparent opacity-60"}`}>
                <Icon className={`size-4 mt-0.5 shrink-0 ${isCurrent ? STATE_COLOR[state] : ""}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span>{state}</span>
                    {isCurrent && <span className="badge badge-xs badge-primary">current</span>}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {transitions.map((t) => (
                      <span key={t} className="inline-flex items-center gap-0.5 text-xs opacity-50">
                        <ArrowRight className="size-2.5" />{t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      {/* Capability */}
      <Section title="Capability Routing" icon={Gauge}>
        <div className="space-y-2">
          <Field label="Category" value={issue.capabilityCategory || "default"} />
          {overlays.length > 0 && (
            <div>
              <div className="text-xs opacity-50 mb-1">Overlays</div>
              <div className="flex flex-wrap gap-1">
                {overlays.map((o) => <span key={o} className="badge badge-xs badge-outline">{o}</span>)}
              </div>
            </div>
          )}
          {rationale.length > 0 && (
            <div>
              <div className="text-xs opacity-50 mb-1">Rationale</div>
              <ul className="text-xs opacity-70 list-disc ml-4 space-y-0.5">
                {rationale.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
        </div>
      </Section>

      {/* Paths */}
      {(paths.length > 0 || inferredPaths.length > 0) && (
        <Section title="Paths" icon={Folder} badge={paths.length + inferredPaths.length}>
          {paths.length > 0 && (
            <div className="mb-2">
              <div className="text-xs opacity-50 mb-1">Explicit</div>
              <div className="space-y-0.5">
                {paths.map((p) => <div key={p} className="font-mono text-xs truncate">{p}</div>)}
              </div>
            </div>
          )}
          {inferredPaths.length > 0 && (
            <div>
              <div className="text-xs opacity-50 mb-1">Inferred</div>
              <div className="space-y-0.5">
                {inferredPaths.map((p) => <div key={p} className="font-mono text-xs truncate opacity-60">{p}</div>)}
              </div>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

// ── Tab: History ────────────────────────────────────────────────────────────

function HistoryTab({ issue }) {
  const history = Array.isArray(issue.history) ? issue.history : [];

  if (history.length === 0) {
    return <div className="text-sm opacity-40 text-center py-8">No history entries.</div>;
  }

  return (
    <div className="space-y-1">
      {history.slice().reverse().map((entry, i) => {
        // Try to parse [timestamp] message
        const match = entry.match(/^\[(.+?)\]\s*(.*)$/);
        return (
          <div key={i} className="flex gap-3 py-1.5 border-b border-base-200 last:border-0">
            <div className="text-xs font-mono opacity-40 shrink-0 w-20 truncate" title={match?.[1]}>
              {match ? timeAgo(match[1]) : ""}
            </div>
            <div className="text-xs leading-relaxed min-w-0">
              {match ? match[2] : entry}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tab: Review ─────────────────────────────────────────────────────────

function ReviewTab({ issue, issueId, onStateChange }) {
  const [diff, setDiff] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState(null); // "approved" | "rework" | "rejected"

  const fetchDiff = useCallback(async () => {
    setDiffLoading(true);
    try {
      const res = await api.get(`/diff/${encodeURIComponent(issueId)}`);
      setDiff(res.diff || res.message || "(no changes)");
    } catch { setDiff(null); }
    finally { setDiffLoading(false); }
  }, [issueId]);

  useEffect(() => { setDiff(null); setVerdict(null); setNote(""); }, [issueId]);
  useEffect(() => { fetchDiff(); }, [fetchDiff]);

  const isInReview = issue.state === "In Review";
  const isDone = issue.state === "Done";

  const handleApprove = () => {
    setVerdict("approved");
    onStateChange?.(issue.id, "Done");
  };
  const handleRework = () => {
    setVerdict("rework");
    onStateChange?.(issue.id, "In Progress");
  };
  const handleReject = () => {
    setVerdict("rejected");
    onStateChange?.(issue.id, "Blocked");
  };

  // Parse diff for inline display
  const diffLines = (diff || "").split("\n");
  const diffContent = [];
  let pastSep = false;
  for (const line of diffLines) {
    if (line === "---") { pastSep = true; continue; }
    if (pastSep) diffContent.push(line);
  }

  return (
    <div className="space-y-5">
      {/* Status banner */}
      {isDone && (
        <div className="alert alert-success text-sm">
          <CheckCircle2 className="size-4" />
          This issue has been approved and is Done.
        </div>
      )}
      {issue.state === "Blocked" && (
        <div className="alert alert-error text-sm">
          <AlertTriangle className="size-4" />
          Review was blocked or failed. Check execution output for details.
        </div>
      )}
      {verdict === "approved" && isInReview && (
        <div className="alert alert-success text-sm">
          <ThumbsUp className="size-4" /> Approved! Moving to Done.
        </div>
      )}
      {verdict === "rework" && (
        <div className="alert alert-warning text-sm">
          <RotateCcw className="size-4" /> Sent back for rework.
        </div>
      )}

      {/* Checklist */}
      {isInReview && !verdict && (
        <Section title="Review Checklist" icon={ClipboardCheck}>
          <div className="space-y-2 text-sm">
            <p className="opacity-60">Before deciding, consider:</p>
            <ul className="list-disc ml-5 space-y-1 opacity-80">
              <li>Does the diff address the issue title and description?</li>
              <li>Are there unintended side effects or regressions?</li>
              <li>Is the scope appropriate — no unnecessary changes?</li>
              <li>Are there files that shouldn't have been modified?</li>
            </ul>
          </div>
        </Section>
      )}

      {/* Inline diff */}
      <Section title="Changes" icon={Code}>
        {diffLoading ? (
          <div className="flex items-center gap-2 text-sm opacity-50 py-4">
            <span className="loading loading-spinner loading-xs" /> Loading diff...
          </div>
        ) : diffContent.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs opacity-50">{diffContent.filter(l => l.startsWith("diff ")).length} file(s) changed</span>
              <CopyButton text={diffContent.join("\n")} />
            </div>
            <pre className="text-xs rounded-box p-3 overflow-x-auto max-h-[45vh] overflow-y-auto leading-relaxed bg-base-200">
              {diffContent.map((line, i) => {
                let cls = "";
                if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-success bg-success/10";
                else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-error bg-error/10";
                else if (line.startsWith("@@")) cls = "text-info opacity-70";
                else if (line.startsWith("diff ")) cls = "font-bold opacity-80 border-t border-base-300 pt-1 mt-1";
                return <div key={i} className={cls}>{line}</div>;
              })}
            </pre>
          </div>
        ) : (
          <div className="text-sm opacity-40 py-4">No changes detected.</div>
        )}
      </Section>

      {/* Execution context */}
      {(issue.lastError || issue.commandOutputTail) && (
        <Section title="Agent Output" icon={Terminal}>
          {issue.lastError && (
            <pre className="text-xs bg-error/10 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto mb-2">
              {issue.lastError}
            </pre>
          )}
          {issue.commandOutputTail && !issue.lastError && (
            <pre className="text-xs bg-base-200 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">
              {issue.commandOutputTail}
            </pre>
          )}
        </Section>
      )}

      {/* Note */}
      {isInReview && !verdict && (
        <Section title="Review Note" icon={MessageSquare}>
          <textarea
            className="textarea textarea-bordered w-full text-sm"
            rows={3}
            placeholder="Optional: leave a note about your decision..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Section>
      )}

      {/* Decision buttons */}
      {isInReview && !verdict && (
        <div className="border-t border-base-300 pt-4 space-y-3">
          <div className="text-sm font-semibold">Verdict</div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-success btn-sm gap-1.5 flex-1" onClick={handleApprove}>
              <ThumbsUp className="size-4" /> Approve
            </button>
            <button className="btn btn-warning btn-sm gap-1.5 flex-1" onClick={handleRework}>
              <RotateCcw className="size-4" /> Request Rework
            </button>
            <button className="btn btn-error btn-sm gap-1.5 flex-1" onClick={handleReject}>
              <ThumbsDown className="size-4" /> Reject
            </button>
          </div>
          <p className="text-xs opacity-40">
            <strong>Approve</strong> moves to Done. <strong>Rework</strong> sends back to executor. <strong>Reject</strong> blocks the issue.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main Drawer ─────────────────────────────────────────────────────────────

export function IssueDetailDrawer({ issue, onClose, onStateChange, onRetry, onCancel }) {
  const [tab, setTab] = useState("overview");

  // Reset tab when issue changes — auto-open Review tab when In Review
  useEffect(() => {
    setTab(issue?.state === "In Review" ? "review" : "overview");
  }, [issue?.id, issue?.state]);

  if (!issue) return null;

  return (
    <div
      className="fixed inset-0 z-40 transition-opacity bg-black/35"
      onClick={onClose}
    >
      <div
        className="fixed top-0 right-0 z-50 h-full w-full md:w-[520px] lg:w-[600px] bg-base-100 shadow-2xl transform transition-transform duration-200 ease-out translate-x-0 flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-4 pb-0 shrink-0">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="size-5 opacity-60 shrink-0" />
              <span className="font-mono text-sm opacity-60">{issue.identifier}</span>
              <span className={`badge badge-sm ${STATE_BADGE[issue.state] || "badge-ghost"}`}>{issue.state}</span>
            </div>
            <button type="button" className="btn btn-sm btn-ghost btn-circle shrink-0" onClick={onClose} aria-label="Close">
              <X className="size-4" />
            </button>
          </div>

          <h2 className="text-lg font-bold leading-tight mb-3">{issue.title || "-"}</h2>

          {/* Tabs */}
          <div role="tablist" className="tabs tabs-lift">
            {getTabs(issue.state).map(({ id, label, icon: Icon }) => (
              <a
                key={id}
                role="tab"
                className={`tab gap-1.5 ${tab === id ? "tab-active" : ""} ${id === "review" ? "text-secondary font-semibold" : ""}`}
                onClick={() => setTab(id)}
              >
                <Icon className="size-3.5" />
                {label}
                {id === "review" && issue.state === "In Review" && (
                  <span className="badge badge-xs badge-secondary">!</span>
                )}
              </a>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
          {tab === "overview" && <OverviewTab issue={issue} onStateChange={onStateChange} onRetry={onRetry} onCancel={onCancel} />}
          {tab === "review" && <ReviewTab issue={issue} issueId={issue.id} onStateChange={onStateChange} />}
          {tab === "execution" && <ExecutionTab issue={issue} />}
          {tab === "diff" && <DiffTab issueId={issue.id} />}
          {tab === "routing" && <RoutingTab issue={issue} />}
          {tab === "history" && <HistoryTab issue={issue} />}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-base-300 shrink-0 flex items-center justify-end">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default IssueDetailDrawer;
