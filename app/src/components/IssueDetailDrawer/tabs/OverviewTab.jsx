import React from "react";
import { Tag, Ban, Layers, Wrench, RotateCcw, XCircle, Circle, GitMerge, AlertOctagon } from "lucide-react";
import { getIssueTransitions, formatDate, formatDuration } from "../../../utils.js";
import { Section, Field } from "../shared.jsx";
import { STATE_ICON, STATE_BTN } from "../constants.js";

export function OverviewTab({ issue, onStateChange, onRetry, onCancel }) {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const blockedBy = Array.isArray(issue.blockedBy) ? issue.blockedBy : [];
  const transitions = getIssueTransitions(issue.state);
  const nextStates = transitions.filter((s) => s !== issue.state);

  return (
    <div className="space-y-5">

      {/* Merged reason banner */}
      {issue.mergedReason && (
        <div className="flex items-start gap-2 bg-success/10 border border-success/20 rounded-box px-3 py-2.5">
          <GitMerge className="size-3.5 text-success shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-success/70 mb-0.5">Merged</div>
            <div className="text-xs text-success/90">{issue.mergedReason}</div>
          </div>
        </div>
      )}

      {/* Cancelled reason banner */}
      {issue.cancelledReason && (
        <div className="flex items-start gap-2 bg-error/10 border border-error/20 rounded-box px-3 py-2.5">
          <AlertOctagon className="size-3.5 text-error shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-error/70 mb-0.5">Cancelled</div>
            <div className="text-xs text-error/90">{issue.cancelledReason}</div>
          </div>
        </div>
      )}

      {/* Details + Timing — collapsed into one compact section */}
      <Section title="Details" icon={Layers}>
        <div className="space-y-0.5">
          <Field label="Attempts" value={`${issue.attempts ?? 0} / ${issue.maxAttempts ?? 0}`} />
          {issue.branchName && <Field label="Branch" value={issue.branchName} mono />}
          {issue.baseBranch && <Field label="Base branch" value={issue.baseBranch} mono />}
          {issue.worktreePath && <Field label="Code worktree" value={issue.worktreePath} mono />}
          {issue.url && <Field label="URL" value={issue.url} mono />}
          <Field label="Created" value={formatDate(issue.createdAt)} />
          {issue.startedAt && <Field label="Started" value={formatDate(issue.startedAt)} />}
          {issue.completedAt && <Field label="Completed" value={formatDate(issue.completedAt)} />}
          {issue.nextRetryAt && <Field label="Next retry" value={formatDate(issue.nextRetryAt)} />}
          <Field label="Duration" value={formatDuration(issue.durationMs)} />
          {issue.tokenUsage?.totalTokens > 0 && (
            <Field label="Tokens" value={`${issue.tokenUsage.totalTokens.toLocaleString()}${issue.tokenUsage.costUsd ? ` ($${issue.tokenUsage.costUsd.toFixed(4)})` : ""}`} />
          )}
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

      {/* Actions — at the bottom since footer handles primary actions */}
      <Section title="Actions" icon={Wrench}>
        <div className="space-y-3">
          <div>
            <div className="text-xs opacity-50 mb-1.5">Move to</div>
            <div className="flex flex-wrap gap-1.5 max-sm:flex-col">
              {nextStates.map((s) => {
                const Icon = STATE_ICON[s] || Circle;
                return (
                  <button key={s} className={`btn btn-sm btn-soft gap-1.5 max-sm:w-full ${STATE_BTN[s] || ""}`}
                    onClick={() => onStateChange?.(issue.id, s)}>
                    <Icon className="size-3.5" />{s}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2 max-sm:flex-col">
            <button className="btn btn-sm btn-soft gap-1 max-sm:w-full" onClick={() => onRetry?.(issue.id)}
              disabled={issue.state === "Running" || issue.state === "Reviewing"}>
              <RotateCcw className="size-3" /> Retry
            </button>
            <button className="btn btn-sm btn-error btn-soft gap-1 max-sm:w-full" onClick={() => onCancel?.(issue.id)}
              disabled={issue.state === "Approved" || issue.state === "Cancelled"}>
              <XCircle className="size-3" /> Cancel
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}
