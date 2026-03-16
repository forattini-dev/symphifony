import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../context/DashboardContext";
import ListView from "../components/ListView";
import { Search, X, Filter, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";

const STATES = ["Todo", "Queued", "Running", "Interrupted", "In Review", "Blocked", "Done", "Cancelled"];

const STATE_COLOR = {
  Todo: "badge-warning", Queued: "badge-info", Running: "badge-primary", Interrupted: "badge-accent",
  "In Review": "badge-secondary", Blocked: "badge-error", Done: "badge-success", Cancelled: "badge-neutral",
};

const COMPLETION_OPTIONS = [
  { value: "recent", label: "Active + recent" },
  { value: "all", label: "All issues" },
];

export const Route = createFileRoute("/issues")({
  component: IssuesPage,
});

function IssuesPage() {
  const ctx = useDashboard();
  const [filtersOpen, setFiltersOpen] = useState(false);

  const hasFilters = ctx.stateFilter !== "all" || ctx.categoryFilter !== "all" || ctx.completionFilter !== "recent";
  const hiddenCount = (ctx.data._totalIssues ?? 0) - (ctx.issues.length ?? 0);
  const activeFilterCount = (ctx.stateFilter !== "all" ? 1 : 0) + (ctx.categoryFilter !== "all" ? 1 : 0) + (ctx.completionFilter !== "recent" ? 1 : 0);

  const stateCounts = {};
  for (const issue of ctx.issues) {
    stateCounts[issue.state] = (stateCounts[issue.state] || 0) + 1;
  }

  const sortedIssues = useMemo(() => {
    return [...ctx.filtered].sort((a, b) => {
      const aDate = a.updatedAt || a.createdAt || "";
      const bDate = b.updatedAt || b.createdAt || "";
      return bDate.localeCompare(aDate);
    });
  }, [ctx.filtered]);

  const clearAll = () => {
    ctx.setQuery("");
    ctx.setStateFilter("all");
    ctx.setCategoryFilter("all");
    ctx.setCompletionFilter("recent");
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 pb-4">
      {/* Sticky toolbar */}
      <div className="sticky top-0 z-10 bg-base-100 pt-3 pb-3 border-b border-base-300 space-y-3">
        {/* Row 1: Search + filter toggle + result count */}
        <div className="flex items-center gap-2">
          <label className="input input-bordered input-sm flex items-center gap-2 flex-1">
            <Search className="size-4 opacity-40" />
            <input
              type="text"
              className="grow"
              placeholder="Search by title, ID, or description..."
              value={ctx.query}
              onChange={(e) => ctx.setQuery(e.target.value)}
            />
            {ctx.query && (
              <button className="btn btn-xs btn-ghost btn-circle" onClick={() => ctx.setQuery("")}>
                <X className="size-3" />
              </button>
            )}
          </label>

          <button
            className={`btn btn-sm btn-square ${filtersOpen ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setFiltersOpen(!filtersOpen)}
            title="Toggle filters"
          >
            <SlidersHorizontal className="size-4" />
          </button>

          {activeFilterCount > 0 && (
            <span className="badge badge-sm badge-primary">{activeFilterCount}</span>
          )}

          <div className="text-xs opacity-40 shrink-0">
            {ctx.filtered.length} result{ctx.filtered.length !== 1 ? "s" : ""}
            {hiddenCount > 0 && ctx.completionFilter === "recent" && (
              <span> · {hiddenCount} older hidden</span>
            )}
          </div>
        </div>

        {/* Row 2: Filters panel (collapsible) */}
        {filtersOpen && (
          <div className="bg-base-200 rounded-box p-3 space-y-3">
            {/* State filter */}
            <div>
              <div className="text-xs font-semibold opacity-50 mb-1.5">State</div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  className={`badge badge-sm cursor-pointer ${ctx.stateFilter === "all" ? "badge-primary" : "badge-ghost opacity-60 hover:opacity-100"}`}
                  onClick={() => ctx.setStateFilter("all")}
                >
                  All
                </button>
                {STATES.map((s) => {
                  const count = stateCounts[s] || 0;
                  const isActive = ctx.stateFilter === s;
                  return (
                    <button
                      key={s}
                      className={`badge badge-sm gap-1 cursor-pointer transition-all ${isActive ? STATE_COLOR[s] : "badge-outline opacity-60 hover:opacity-100"}`}
                      onClick={() => ctx.setStateFilter(isActive ? "all" : s)}
                    >
                      {s}
                      {count > 0 && <span className="font-mono text-[10px]">{count}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Category + Completion row */}
            <div className="flex flex-wrap gap-4">
              {ctx.categoryOptions.length > 2 && (
                <div>
                  <div className="text-xs font-semibold opacity-50 mb-1.5">Capability</div>
                  <select
                    className="select select-bordered select-sm"
                    value={ctx.categoryFilter}
                    onChange={(e) => ctx.setCategoryFilter(e.target.value)}
                  >
                    {ctx.categoryOptions.map((c) => (
                      <option key={c} value={c}>{c === "all" ? "All capabilities" : c}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <div className="text-xs font-semibold opacity-50 mb-1.5">Show</div>
                <select
                  className="select select-bordered select-sm"
                  value={ctx.completionFilter}
                  onChange={(e) => ctx.setCompletionFilter(e.target.value)}
                >
                  {COMPLETION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {hasFilters && (
                <div className="flex items-end">
                  <button className="btn btn-sm btn-ghost gap-1" onClick={clearAll}>
                    <X className="size-3" />
                    Clear all
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Active filter pills (shown when panel is closed) */}
        {!filtersOpen && hasFilters && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <Filter className="size-3 opacity-40" />
            {ctx.stateFilter !== "all" && (
              <span className={`badge badge-sm gap-1 ${STATE_COLOR[ctx.stateFilter]}`}>
                {ctx.stateFilter}
                <button className="ml-0.5" onClick={() => ctx.setStateFilter("all")}><X className="size-2.5" /></button>
              </span>
            )}
            {ctx.categoryFilter !== "all" && (
              <span className="badge badge-sm badge-outline gap-1">
                {ctx.categoryFilter}
                <button className="ml-0.5" onClick={() => ctx.setCategoryFilter("all")}><X className="size-2.5" /></button>
              </span>
            )}
            {ctx.completionFilter !== "recent" && (
              <span className="badge badge-sm badge-ghost gap-1">
                All issues
                <button className="ml-0.5" onClick={() => ctx.setCompletionFilter("recent")}><X className="size-2.5" /></button>
              </span>
            )}
            <button className="text-xs opacity-40 hover:opacity-100 underline" onClick={clearAll}>
              clear all
            </button>
          </div>
        )}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto pt-3">
        <ListView
          issues={sortedIssues}
          onStateChange={ctx.updateState}
          onRetry={ctx.retryIssue}
          onCancel={ctx.cancelIssue}
          onSelect={ctx.setSelectedIssue}
          expanded
        />
      </div>
    </div>
  );
}
