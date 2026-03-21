import React from "react";
import { useElapsedTime } from "../hooks/useElapsedTime.js";
import {
  Loader, Clock, Play, Eye, AlertTriangle, CheckCircle2,
  XCircle, ListOrdered, Lightbulb, Timer, GitMerge,
} from "lucide-react";

/**
 * Derives a contextual sub-status label, description, and icon
 * based on the full issue state and metadata — not just the state name.
 *
 * This is the core "what is happening RIGHT NOW" indicator.
 */
function deriveSubStatus(issue) {
  const { state, planningStatus, assignedToWorker, startedAt, tokenUsage, tokensByPhase } = issue;

  switch (state) {
    case "Planning": {
      if (planningStatus === "planning") {
        return { label: "Generating plan...", icon: Loader, color: "text-info", spin: true };
      }
      if (issue.plan) {
        return { label: "Plan ready", icon: Lightbulb, color: "text-info", spin: false };
      }
      if (issue.planningError) {
        return { label: "Plan failed", icon: AlertTriangle, color: "text-error", spin: false };
      }
      return { label: "Aguardando scheduler…", icon: Clock, color: "text-info/60", spin: false };
    }

    case "PendingApproval":
      return { label: "Ready to queue", icon: ListOrdered, color: "text-warning/70", spin: false };

    case "Queued": {
      if (assignedToWorker) {
        return { label: "Worker assigned, starting...", icon: Play, color: "text-primary", spin: false, pulse: true };
      }
      return { label: "Waiting for worker slot...", icon: Clock, color: "text-info/70", spin: false };
    }

    case "Running": {
      // Derive phase from token usage
      const phase = derivePhase(tokensByPhase);
      const hasTokens = tokenUsage?.totalTokens > 0;

      if (!hasTokens && !startedAt) {
        return { label: "Spawning agent...", icon: Loader, color: "text-primary", spin: true };
      }
      if (!hasTokens) {
        return { label: "Starting agent...", icon: Loader, color: "text-primary", spin: true };
      }
      if (phase === "Reviewing") {
        return { label: "Agent reviewing...", icon: Eye, color: "text-secondary", spin: false, pulse: true };
      }
      if (phase === "Planning") {
        return { label: "Agent planning...", icon: Lightbulb, color: "text-info", spin: false, pulse: true };
      }
      return { label: "Agent working...", icon: Play, color: "text-primary", spin: false, pulse: true };
    }

    case "Reviewing": {
      const phase = derivePhase(tokensByPhase);
      if (phase === "Reviewing") {
        return { label: "Review in progress...", icon: Eye, color: "text-secondary", spin: false, pulse: true };
      }
      return { label: "Reviewing", icon: Eye, color: "text-secondary/70", spin: false };
    }

    case "PendingDecision":
      return { label: "Review complete", icon: Eye, color: "text-success/70", spin: false };

    case "Blocked":
      return {
        label: issue.lastError ? "Blocked: error" : issue.blockedBy?.length ? "Blocked by dependency" : "Needs attention",
        icon: AlertTriangle,
        color: "text-error",
        spin: false,
      };

    case "Approved":
      return { label: "Approved", icon: CheckCircle2, color: "text-success", spin: false };

    case "Merged":
      return { label: "Merged", icon: GitMerge, color: "text-success", spin: false };

    case "Cancelled":
      return { label: "Cancelled", icon: XCircle, color: "text-neutral", spin: false };

    default:
      return { label: state, icon: null, color: "opacity-50", spin: false };
  }
}

function derivePhase(tokensByPhase) {
  if (!tokensByPhase) return null;
  if (tokensByPhase.reviewer?.totalTokens > 0) return "Reviewing";
  if (tokensByPhase.executor?.totalTokens > 0) return "Executing";
  if (tokensByPhase.planner?.totalTokens > 0) return "Planning";
  return null;
}

/**
 * Compact inline status indicator for issue cards.
 * Shows: icon + contextual label + optional elapsed time.
 */
export function StatusIndicator({ issue, showElapsed = true, compact = false }) {
  const sub = deriveSubStatus(issue);
  const Icon = sub.icon;
  const isActive = ["Running", "Queued", "Planning", "Reviewing"].includes(issue.state);
  const elapsed = useElapsedTime(isActive && showElapsed ? issue.startedAt : null);

  return (
    <span className={`inline-flex items-center gap-1 text-xs ${sub.color} ${compact ? "" : "font-medium"}`}>
      {Icon && (
        <Icon
          size={compact ? 10 : 12}
          className={[
            sub.spin ? "animate-spin" : "",
            sub.pulse ? "status-indicator-pulse" : "",
          ].filter(Boolean).join(" ")}
        />
      )}
      <span className={compact ? "truncate max-w-[120px]" : "truncate"}>{sub.label}</span>
      {elapsed && (
        <span className="font-mono opacity-60 tabular-nums shrink-0">
          {elapsed}
        </span>
      )}
    </span>
  );
}

/**
 * Larger status display for the issue detail drawer.
 * Shows a richer view with background tint.
 */
export function StatusBadgeExpanded({ issue }) {
  const sub = deriveSubStatus(issue);
  const Icon = sub.icon;
  const isActive = ["Running", "Queued", "Planning", "Reviewing"].includes(issue.state);
  const elapsed = useElapsedTime(isActive ? issue.startedAt : null);

  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium ${sub.color} bg-base-200`}>
      {Icon && (
        <Icon
          size={16}
          className={[
            sub.spin ? "animate-spin" : "",
            sub.pulse ? "status-indicator-pulse" : "",
          ].filter(Boolean).join(" ")}
        />
      )}
      <span>{sub.label}</span>
      {elapsed && (
        <span className="font-mono text-xs opacity-60 tabular-nums">
          <Timer size={10} className="inline mr-0.5" />
          {elapsed}
        </span>
      )}
    </div>
  );
}

export default StatusIndicator;
