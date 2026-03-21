import React, { useMemo } from "react";
import { Play, Clock, Eye, Lightbulb, AlertTriangle, Loader } from "lucide-react";

/**
 * A compact global activity indicator that shows "2 agents running, 1 queued"
 * so users always know the system is alive. Renders inline in the header area.
 */
export function GlobalActivityBar({ issues }) {
  const counts = useMemo(() => {
    if (!Array.isArray(issues)) return null;
    let running = 0;
    let queued = 0;
    let planning = 0;
    let reviewing = 0;
    let blocked = 0;

    for (const issue of issues) {
      switch (issue.state) {
        case "Running": running++; break;
        case "Queued": queued++; break;
        case "Planning":
          planning++;
          break;
        case "Reviewing":
        case "PendingDecision": reviewing++; break;
        case "Blocked": blocked++; break;
      }
    }
    return { running, queued, planning, reviewing, blocked };
  }, [issues]);

  if (!counts) return null;

  const { running, queued, planning, reviewing, blocked } = counts;
  const totalActive = running + queued + planning + reviewing;

  if (totalActive === 0 && blocked === 0) return null;

  return (
    <div className="flex items-center gap-1.5 text-xs">
      {running > 0 && (
        <span className="inline-flex items-center gap-1 text-primary font-medium global-activity-pill" title={`${running} running`}>
          <Play size={10} className="fill-current" />
          <span className="tabular-nums">{running}</span>
        </span>
      )}
      {queued > 0 && (
        <span className="inline-flex items-center gap-1 text-info font-medium" title={`${queued} queued`}>
          <Clock size={10} />
          <span className="tabular-nums">{queued}</span>
        </span>
      )}
      {planning > 0 && (
        <span className="inline-flex items-center gap-1 text-info font-medium" title={`${planning} planning`}>
          <Loader size={10} className="animate-spin" />
          <span className="tabular-nums">{planning}</span>
        </span>
      )}
      {reviewing > 0 && (
        <span className="inline-flex items-center gap-1 text-secondary font-medium" title={`${reviewing} reviewing`}>
          <Eye size={10} />
          <span className="tabular-nums">{reviewing}</span>
        </span>
      )}
      {blocked > 0 && (
        <span className="inline-flex items-center gap-1 text-error font-medium" title={`${blocked} blocked`}>
          <AlertTriangle size={10} />
          <span className="tabular-nums">{blocked}</span>
        </span>
      )}
      {totalActive > 0 && (
        <span className="global-activity-dot" title="System active" />
      )}
    </div>
  );
}

/**
 * Queue position indicator for issues in the Queued state.
 * Shows "Position X of Y" based on the issue's position among all queued issues.
 */
export function QueuePosition({ issue, allIssues }) {
  if (issue.state !== "Queued" || !Array.isArray(allIssues)) return null;

  const queued = allIssues
    .filter((i) => i.state === "Queued")
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const position = queued.findIndex((i) => i.id === issue.id) + 1;
  const total = queued.length;

  if (position === 0 || total === 0) return null;

  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] opacity-50 font-mono">
      #{position}/{total}
    </span>
  );
}

export default GlobalActivityBar;
