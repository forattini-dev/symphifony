import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../context/DashboardContext";
import ListView from "../components/ListView";
import { Search, X, Filter, SlidersHorizontal, Download } from "lucide-react";
import { useMemo, useState, useCallback, useRef } from "react";
import { useHotkeys } from "react-hotkeys-hook";

const STATE_GROUPS = [
  { label: "Active", states: ["Planning", "PendingApproval", "Queued", "Running"] },
  { label: "Review", states: ["Reviewing", "PendingDecision"] },
  { label: "Waiting", states: ["Blocked", "Approved"] },
  { label: "Final", states: ["Merged", "Cancelled"] },
];

const ALL_STATES = STATE_GROUPS.flatMap((g) => g.states);

const ISSUE_TYPES = [
  { value: "bug", label: "Bug", color: "badge-error" },
  { value: "feature", label: "Feature", color: "badge-primary" },
  { value: "refactor", label: "Refactor", color: "badge-warning" },
  { value: "docs", label: "Docs", color: "badge-info" },
  { value: "chore", label: "Chore", color: "badge-secondary" },
];

const STATE_COLOR = {
  Planning: "badge-info", PendingApproval: "badge-warning", Queued: "badge-info", Running: "badge-primary",
  Reviewing: "badge-secondary", PendingDecision: "badge-success", Blocked: "badge-error", Approved: "badge-success",
  Merged: "badge-success", Cancelled: "badge-neutral",
};

const SORT_OPTIONS = [
  { value: "updated", label: "Last updated" },
  { value: "created", label: "Newest first" },
  { value: "state", label: "State" },
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
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const searchRef = useRef(null);

  // Multi-select state filter: Set of active states (empty = all)
  const [activeStates, setActiveStates] = useState(new Set());
  // Multi-select type filter: Set of active types (empty = all)
  const [activeTypes, setActiveTypes] = useState(new Set());

  const toggleType = (t) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

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

  const hasFilters = activeStates.size > 0 || activeTypes.size > 0 || ctx.completionFilter !== "recent" || ctx.query.length > 0;
  const hiddenCount = (ctx.data._totalIssues ?? 0) - (ctx.issues.length ?? 0);

  const stateCounts = {};
  for (const issue of ctx.issues) {
    stateCounts[issue.state] = (stateCounts[issue.state] || 0) + 1;
  }

  // Filter: multi-state + type + text query
  const filtered = useMemo(() => {
    const q = ctx.query.toLowerCase();
    return ctx.issues.filter((i) => {
      if (i.state === "Archived") return false;
      if (activeStates.size > 0 && !activeStates.has(i.state)) return false;
      if (activeTypes.size > 0 && !activeTypes.has(i.issueType || "")) return false;
      if (q) {
        const haystack = `${i.identifier} ${i.title} ${i.description || ""} ${i.issueType || ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [ctx.issues, activeStates, activeTypes, ctx.query]);

  // Sort
  const sortedIssues = useMemo(() => {
    return [...filtered].sort((a, b) => {
      switch (sortBy) {
        case "created":
          return (b.createdAt || "").localeCompare(a.createdAt || "");
        case "state":
          return (a.state || "").localeCompare(b.state || "");
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
    setActiveTypes(new Set());
    ctx.setCompletionFilter("recent");
    setSortBy("updated");
  };

  // ── Keyboard shortcuts ──────────────────────────────────────────────
  const noDrawer = !ctx.selectedIssue;
  const sortedRef = useRef(sortedIssues);
  sortedRef.current = sortedIssues;

  useHotkeys("slash", () => searchRef.current?.focus(), { enabled: noDrawer, preventDefault: true, description: "Focus search", metadata: { group: "issues" } }, [noDrawer]);
  useHotkeys("j", () => setFocusedIndex((i) => { const len = sortedRef.current.length; return len === 0 ? -1 : Math.min(i + 1, len - 1); }), { enabled: noDrawer, description: "Next issue", metadata: { group: "issues" } }, [noDrawer]);
  useHotkeys("k", () => setFocusedIndex((i) => Math.max(i <= 0 ? 0 : i - 1, 0)), { enabled: noDrawer, description: "Previous issue", metadata: { group: "issues" } }, [noDrawer]);
  useHotkeys("enter", () => { const item = sortedRef.current[focusedIndex]; if (item) ctx.setSelectedIssue(item); }, { enabled: noDrawer && focusedIndex >= 0, description: "Open issue", metadata: { group: "issues" } }, [focusedIndex, ctx, noDrawer]);
  useHotkeys("f", () => setFiltersOpen((v) => !v), { enabled: noDrawer, description: "Toggle filters", metadata: { group: "issues" } }, [noDrawer]);
  useHotkeys("x", clearAll, { enabled: noDrawer, description: "Clear all filters", metadata: { group: "issues" } }, [clearAll, noDrawer]);
  useHotkeys("escape", () => setFocusedIndex(-1), { enabled: focusedIndex >= 0 && noDrawer, description: "Clear focus", metadata: { group: "issues" } }, [focusedIndex, noDrawer]);

  const activeFilterCount = (activeStates.size > 0 ? 1 : 0) + (activeTypes.size > 0 ? 1 : 0) + (ctx.completionFilter !== "recent" ? 1 : 0);

  // Jira CSV state mapping
  const JIRA_STATE = {
    Planning: "To Do", PendingApproval: "To Do", Queued: "To Do",
    Running: "In Progress", Reviewing: "In Progress",
    PendingDecision: "In Review", Blocked: "Blocked",
    Approved: "Done", Merged: "Done", Cancelled: "Cancelled",
  };

  const JIRA_TYPE = {
    bug: "Bug", feature: "Story", refactor: "Task", docs: "Task", chore: "Task",
  };

  const exportCsv = useCallback(() => {
    const esc = (v) => {
      const s = String(v ?? "").replace(/"/g, '""');
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s}"` : s;
    };

    const headers = ["Summary", "Issue Type", "Status", "Description", "Created", "Updated"];
    const rows = sortedIssues.map((i) => [
      esc(i.title),
      esc(JIRA_TYPE[i.issueType] || "Task"),
      esc(JIRA_STATE[i.state] || "To Do"),
      esc(i.description),
      esc(i.createdAt?.slice(0, 10)),
      esc(i.updatedAt?.slice(0, 10)),
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fifony-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [sortedIssues]);

  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 pb-4">
      {/* Sticky toolbar */}
      <div className="sticky top-0 z-10 bg-base-100 pt-3 pb-3 border-b border-base-300 space-y-3">
        {/* Row 1: Search + controls */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="input input-bordered input-sm flex items-center gap-2 flex-1 min-w-0 basis-full sm:basis-0">
            <Search className="size-4 opacity-40" />
            <input
              ref={searchRef}
              type="text"
              className="grow"
              placeholder="Search title, ID, type..."
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
            className="btn btn-sm btn-ghost btn-square"
            onClick={exportCsv}
            title="Export to Jira CSV"
          >
            <Download className="size-4" />
          </button>

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

            {/* Type filter */}
            <div>
              <div className="text-xs font-semibold opacity-50 mb-1.5">Type</div>
              <div className="flex flex-wrap gap-1.5">
                {activeTypes.size > 0 && (
                  <button
                    className="badge badge-sm badge-ghost cursor-pointer opacity-60 hover:opacity-100"
                    onClick={() => setActiveTypes(new Set())}
                  >
                    Clear
                  </button>
                )}
                {ISSUE_TYPES.map((t) => {
                  const isActive = activeTypes.has(t.value);
                  const count = ctx.issues.filter((i) => (i.issueType || "") === t.value).length;
                  return (
                    <button
                      key={t.value}
                      className={`badge badge-sm gap-1 cursor-pointer transition-all ${isActive ? t.color : "badge-outline opacity-50 hover:opacity-100"}`}
                      onClick={() => toggleType(t.value)}
                    >
                      {t.label}
                      {count > 0 && <span className="font-mono text-[10px]">{count}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Completion row */}
            <div className="flex flex-wrap gap-4">
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
          focusedIndex={focusedIndex}
        />
      </div>
    </div>
  );
}
