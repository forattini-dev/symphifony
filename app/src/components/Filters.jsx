import { Search, SlidersHorizontal } from "lucide-react";

const STATES = ["Todo", "Queued", "Running", "Interrupted", "In Review", "Blocked", "Done", "Cancelled"];

const COMPLETION_OPTIONS = [
  { value: "recent", label: "Active + recent" },
  { value: "all", label: "All issues" },
];

export function Filters({
  query, setQuery,
  stateFilter, setStateFilter,
  categoryFilter, setCategoryFilter,
  categoryOptions,
  completionFilter, setCompletionFilter,
  totalIssues, visibleIssues,
}) {
  const hasActiveFilters = stateFilter !== "all" || categoryFilter !== "all" || query.trim() !== "" || completionFilter !== "recent";
  const hiddenCount = (totalIssues ?? 0) - (visibleIssues ?? 0);

  return (
    <div className="collapse collapse-arrow bg-base-200 rounded-box">
      <input type="checkbox" />
      <div className="collapse-title flex items-center gap-2 text-sm font-medium min-h-0 py-2 px-4">
        <SlidersHorizontal className="size-3.5 opacity-60" />
        Filters
        {hasActiveFilters && (
          <span className="badge badge-xs badge-primary">active</span>
        )}
        {hiddenCount > 0 && completionFilter === "recent" && (
          <span className="text-xs opacity-40 ml-auto">{hiddenCount} older hidden</span>
        )}
      </div>
      <div className="collapse-content px-4 pb-3">
        <div className="flex flex-wrap gap-2 items-center pt-1">
          <label className="input input-bordered input-sm flex items-center gap-2 grow">
            <Search className="size-4 opacity-50" />
            <input
              type="text"
              className="grow"
              placeholder="Search issues..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search issues"
            />
          </label>

          <select
            className="select select-bordered select-sm"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            aria-label="Filter by state"
          >
            <option value="all">All states</option>
            {STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select
            className="select select-bordered select-sm"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            aria-label="Filter by category"
          >
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c === "all" ? "All capabilities" : c}
              </option>
            ))}
          </select>

          <select
            className="select select-bordered select-sm"
            value={completionFilter}
            onChange={(e) => setCompletionFilter(e.target.value)}
            aria-label="Filter by completion"
          >
            {COMPLETION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          {hasActiveFilters && (
            <button
              className="btn btn-xs btn-ghost opacity-60"
              onClick={() => { setQuery(""); setStateFilter("all"); setCategoryFilter("all"); setCompletionFilter("recent"); }}
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default Filters;
