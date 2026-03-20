import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../context/DashboardContext";
import ListView from "../components/ListView";
import { Search, X, Filter, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";

const STATE_GROUPS = [
  { label: "Active", states: ["Planning", "Planned", "Queued", "Running"] },
  { label: "Review", states: ["Reviewing", "Reviewed"] },
  { label: "Waiting", states: ["Blocked", "Done"] },
  { label: "Final", states: ["Merged", "Cancelled"] },
];

const ALL_STATES = STATE_GROUPS.flatMap((g) => g.states);

const STATE_COLOR = {
  Planning: "badge-info", Planned: "badge-warning", Queued: "badge-info", Running: "badge-primary",
  Reviewing: "badge-secondary", Reviewed: "badge-success", Blocked: "badge-error", Done: "badge-success",
  Merged: "badge-success", Cancelled: "badge-neutral",
};

const SORT_OPTIONS = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Newest first" },
  { value: "priority", label: "Priority" },
  { value: "tokens", label: "Most tokens" },
];

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
  const [sortBy, setSortBy] = useState("updated");

  // Multi-select state filter: Set of active states (empty = all)
  const [activeStates, setActiveStates] = useState(new Set());

  const toggleState = (s) => {
    setActiveStates((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const toggleGroup = (states) => {
    setActiveStates((prev) => {
      const next = new Set(prev);
      const allActive = states.every((s) => next.has(s));
      if (allActive) { for (const s of states) next.delete(s); }
      else { for (const s of states) next.add(s); }
      return next;
    });
  };

  const hasFilters = activeStates.size > 0 || ctx.categoryFilter !== "all" || ctx.completionFilter !== "recent" || ctx.query.length > 0;
  const hiddenCount = (ctx.data._totalIssues ?? 0) - (ctx.issues.length ?? 0);

  const stateCounts = {};
  for (const issue of ctx.issues) {
    stateCounts[issue.state] = (stateCounts[issue.state] || 0) + 1;
  }

  // Filter: multi-state + category + text query
  const filtered = useMemo(() => {
    const q = ctx.query.toLowerCase();
    return ctx.issues.filter((i) => {
      if (activeStates.size > 0 && !activeStates.has(i.state)) return false;
      if (ctx.categoryFilter !== "all" && (i.capabilityCategory || "default") !== ctx.categoryFilter) return false;
      if (q) {
        const haystack = `${i.identifier} ${i.title} ${i.description || ""} ${(i.labels || []).join(" ")} ${i.issueType || ""} ${i.capabilityCategory || ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [ctx.issues, activeStates, ctx.categoryFilter, ctx.query]);

  // Sort
  const sortedIssues = useMemo(() => {
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "created":
          return (b.createdAt || "").localeCompare(a.createdAt || "");
        case "priority":
          return (a.priority ?? 99) - (b.priority ?? 99);
        case "tokens":
          return (b.tokenUsage?.totalTokens || 0) - (a.tokenUsage?.totalTokens || 0);
        case "updated":
        default:
          return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
      }
    });
  }, [filtered, sortBy]);

  const clearAll = () => {
    ctx.setQuery("");
    setActiveStates(new Set());
    ctx.setCategoryFilter("all");
    ctx.setCompletionFilter("recent");
    setSortBy("updated");
  };

  const activeFilterCount = (activeStates.size > 0 ? 1 : 0) + (ctx.categoryFilter !== "all" ? 1 : 0) + (ctx.completionFilter !== "recent" ? 1 : 0);

  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 pb-4">
      {/* Sticky toolbar */}
      <div className="sticky top-0 z-10 bg-base-100 pt-3 pb-3 border-b border-base-300 space-y-3">
        {/* Row 1: Search + filter toggle + sort + result count */}
        <div className="flex items-center gap-2">
          <label className="input input-bordered input-sm flex items-center gap-2 flex-1">
            <Search className="size-4 opacity-40" />
            <input
              type="text"
              className="grow"
              placeholder="Search title, ID, labels, type..."
              value={ctx.query}
              onChange={(e) => ctx.setQuery(e.target.value)}
            />
            {ctx.query && (
              <button className="btn btn-xs btn-ghost btn-circle" onClick={() => ctx.setQuery("")}>
                <X className="size-3" />
              </button>
            )}
          </label>

          <select
            className="select select-bordered select-sm w-auto"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            title="Sort by"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

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
            {sortedIssues.length} result{sortedIssues.length !== 1 ? "s" : ""}
            {hiddenCount > 0 && ctx.completionFilter === "recent" && (
              <span> · {hiddenCount} older hidden</span>
            )}
          </div>
        </div>

        {/* Row 2: Filters panel (collapsible) */}
        {filtersOpen && (
          <div className="bg-base-200 rounded-box p-3 space-y-3">
            {/* State filter — grouped multi-select */}
            <div>
              <div className="text-xs font-semibold opacity-50 mb-1.5">State</div>
              <div className="flex flex-wrap gap-2">
                {activeStates.size > 0 && (
                  <button
                    className="badge badge-sm badge-ghost cursor-pointer opacity-60 hover:opacity-100"
                    onClick={() => setActiveStates(new Set())}
                  >
                    Clear
                  </button>
                )}
                {STATE_GROUPS.map((g) => {
                  const groupActive = g.states.every((s) => activeStates.has(s));
                  const groupPartial = !groupActive && g.states.some((s) => activeStates.has(s));
                  return (
                    <div key={g.label} className="flex items-center gap-1">
                      <button
                        className={`badge badge-sm cursor-pointer font-semibold transition-all ${groupActive ? "badge-primary" : groupPartial ? "badge-primary badge-outline" : "badge-ghost opacity-50 hover:opacity-80"}`}
                        onClick={() => toggleGroup(g.states)}
                        title={`Toggle all ${g.label} states`}
                      >
                        {g.label}
                      </button>
                      {g.states.map((s) => {
                        const count = stateCounts[s] || 0;
                        const isActive = activeStates.has(s);
                        return (
                          <button
                            key={s}
                            className={`badge badge-sm gap-1 cursor-pointer transition-all ${isActive ? STATE_COLOR[s] : "badge-outline opacity-50 hover:opacity-100"}`}
                            onClick={() => toggleState(s)}
                          >
                            {s}
                            {count > 0 && <span className="font-mono text-[10px]">{count}</span>}
                          </button>
                        );
                      })}
                    </div>
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
            {activeStates.size > 0 && (
              <span className="badge badge-sm badge-primary gap-1">
                {activeStates.size} state{activeStates.size > 1 ? "s" : ""}
                <button className="ml-0.5" onClick={() => setActiveStates(new Set())}><X className="size-2.5" /></button>
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
