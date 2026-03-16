import React, { useMemo } from "react";

export function InsightsView({ issues, metrics }) {
  const byCapability = useMemo(() => {
    const counts = {};
    for (const issue of issues) {
      const key = issue.capabilityCategory || "default";
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [issues]);

  const avgCompletionTime = useMemo(() => {
    const durations = issues
      .filter((i) => typeof i.durationMs === "number")
      .map((i) => i.durationMs);
    if (durations.length === 0) return null;
    return Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 1000);
  }, [issues]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Throughput card */}
      <div className="card bg-base-200">
        <div className="card-body">
          <h3 className="card-title text-sm">Throughput</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="opacity-70">Total</span>
              <span className="font-semibold">{metrics.total ?? issues.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-70">Queued</span>
              <span className="font-semibold">{metrics.queued ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-70">Running</span>
              <span className="font-semibold text-primary">{metrics.inProgress ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-70">Avg completion time</span>
              <span className="font-semibold">
                {avgCompletionTime !== null ? `${avgCompletionTime}s` : "-"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* By Capability card */}
      <div className="card bg-base-200">
        <div className="card-body">
          <h3 className="card-title text-sm">By Capability</h3>
          {byCapability.length === 0 ? (
            <p className="text-sm opacity-50">No data</p>
          ) : (
            <div className="space-y-1">
              {byCapability.map(([name, count]) => (
                <div key={name} className="flex justify-between items-center text-sm">
                  <span>{name}</span>
                  <span className="badge badge-sm badge-outline">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default InsightsView;
