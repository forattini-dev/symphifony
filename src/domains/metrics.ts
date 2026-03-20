import type { IssueEntry, RuntimeMetrics } from "../types.ts";

export function computeMetrics(issues: IssueEntry[]): RuntimeMetrics {
  let planning = 0;
  let queued = 0;
  let inProgress = 0;
  let blocked = 0;
  let done = 0;
  let cancelled = 0;
  const completionTimes: number[] = [];

  for (const issue of issues) {
    const duration = issue.durationMs;
    if (issue.state === "Done") {
      const candidate = typeof duration === "number" && Number.isFinite(duration)
        ? duration
        : Number.isFinite(Date.parse(issue.startedAt ?? "")) && Number.isFinite(Date.parse(issue.completedAt ?? ""))
          ? Date.parse(issue.completedAt) - Date.parse(issue.startedAt)
          : NaN;
      if (Number.isFinite(candidate) && candidate >= 0) {
        completionTimes.push(candidate);
      }
    }

    switch (issue.state) {
      case "Planning":
        planning += 1;
        break;
      case "Planned":
        queued += 1;
        break;
      case "Queued":
      case "Running":
      case "Reviewing":
      case "Reviewed":
        inProgress += 1;
        break;
      case "Blocked":
        blocked += 1;
        break;
      case "Done":
        done += 1;
        break;
      case "Cancelled":
        cancelled += 1;
        break;
    }
  }

  if (completionTimes.length === 0) {
    return {
      total: issues.length,
      planning,
      queued,
      inProgress,
      blocked,
      done,
      cancelled,
      activeWorkers: 0,
    };
  }

  const sortedCompletionTimes = completionTimes.slice().sort((a, b) => a - b);
  const totalCompletionMs = sortedCompletionTimes.reduce((acc, value) => acc + value, 0);
  const mid = Math.floor(sortedCompletionTimes.length / 2);
  const medianCompletionMs = sortedCompletionTimes.length % 2 === 1
    ? sortedCompletionTimes[mid]
    : Math.round((sortedCompletionTimes[mid - 1] + sortedCompletionTimes[mid]) / 2);

  return {
    total: issues.length,
    planning,
    queued,
    inProgress,
    blocked,
    done,
    cancelled,
    activeWorkers: 0,
    avgCompletionMs: Math.round(totalCompletionMs / completionTimes.length),
    medianCompletionMs,
    fastestCompletionMs: sortedCompletionTimes[0]!,
    slowestCompletionMs: sortedCompletionTimes[sortedCompletionTimes.length - 1]!,
  };
}

export function computeCapabilityCounts(issues: IssueEntry[]): Record<string, number> {
  return issues.reduce<Record<string, number>>((accumulator, issue) => {
    const key = issue.capabilityCategory?.trim() || "default";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}
