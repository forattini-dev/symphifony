import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { IssueCard } from "./IssueCard.jsx";
import { EmptyState } from "./EmptyState.jsx";
import { Lightbulb, Plus, Play, Eye, AlertTriangle, CheckCircle, XCircle, RotateCcw, ArrowRight, ChevronDown, X } from "lucide-react";
import { useDragAndDrop } from "../hooks/useDragAndDrop.js";
import { getIssueTransitions } from "../utils.js";

function ColumnBadge({ count, className }) {
  const prevRef = useRef(count);
  const [bumping, setBumping] = useState(false);
  useEffect(() => {
    if (prevRef.current !== count) {
      prevRef.current = count;
      setBumping(true);
      const t = setTimeout(() => setBumping(false), 300);
      return () => clearTimeout(t);
    }
  }, [count]);
  if (count === 0) return null;
  return (
    <span className={`badge badge-xs ${className} ${bumping ? "animate-count-bump" : ""}`}>
      {count}
    </span>
  );
}

// Kanban columns — grouped by who acts:
//   Planning (AI), In Progress (AI), Needs Approval (Human), Blocked (Human), Done (terminal)
const COLUMNS = ["Planning", "In Progress", "Needs Approval", "Blocked", "Done"];
const PLANNING_STATES = new Set(["Planning"]);
const NEEDS_APPROVAL_STATES = new Set(["PendingApproval", "PendingDecision"]);
const IN_PROGRESS_STATES = new Set(["Queued", "Running", "Reviewing"]);
const DONE_STATES = new Set(["Approved", "Merged", "Cancelled"]);
const HIDDEN_STATES = new Set(["Archived"]);

const COLUMN_BADGE = {
  Planning: "badge-info",
  "Needs Approval": "badge-warning",
  "In Progress": "badge-primary",
  Blocked: "badge-error",
  Done: "badge-success",
};

const COLUMN_ACCENT_STYLE = {
  Planning: { borderTopColor: 'color-mix(in oklab, var(--color-info) 40%, transparent)' },
  "Needs Approval": { borderTopColor: 'color-mix(in oklab, var(--color-warning) 40%, transparent)' },
  "In Progress": { borderTopColor: 'color-mix(in oklab, var(--color-primary) 50%, transparent)' },
  Blocked: { borderTopColor: 'color-mix(in oklab, var(--color-error) 40%, transparent)' },
  Done: { borderTopColor: 'color-mix(in oklab, var(--color-success) 40%, transparent)' },
};

const COLUMN_HEADER_COLOR = {
  Planning: 'var(--color-info)',
  "Needs Approval": 'var(--color-warning)',
  "In Progress": 'var(--color-primary)',
  Blocked: 'var(--color-error)',
  Done: 'var(--color-success)',
};

const COLUMN_DOT_COLOR = {
  Planning: 'var(--color-info)',
  "Needs Approval": 'var(--color-warning)',
  "In Progress": 'var(--color-primary)',
  Blocked: 'var(--color-error)',
  Done: 'var(--color-success)',
};

const EMPTY_CONFIG = {
  Planning: { icon: Lightbulb, desc: "Create an issue to start planning" },
  "Needs Approval": { icon: Eye, desc: "Issues waiting for your approval" },
  "In Progress": { icon: Play, desc: "Issues move here when agents start" },
  Blocked: { icon: AlertTriangle, desc: "Needs attention" },
  Done: { icon: CheckCircle, desc: "Completed" },
};

function SkeletonCard({ delay = 0 }) {
  return (
    <div className="skeleton-card h-20 w-full rounded-lg" style={{ animationDelay: `${delay}ms` }} />
  );
}

function DragGhost({ dragState, ghostRef }) {
  if (!dragState) return null;
  const { issue } = dragState;
  return (
    <div
      ref={ghostRef}
      className="drag-ghost"
      aria-hidden="true"
    >
      <div className="card card-compact bg-base-100 border border-primary border-l-[3px] shadow-2xl p-3 w-56">
        <span className="font-mono text-xs opacity-50">{issue.identifier}</span>
        <h3 className="font-semibold text-sm truncate">{issue.title}</h3>
      </div>
    </div>
  );
}

function PlanningEmptyState({ onCreateIssue }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 px-3 animate-fade-in-up">
      <div className="bg-primary/10 rounded-full p-4 mb-3 animate-pulse-soft">
        <Lightbulb className="size-8 text-primary" />
      </div>
      <h3 className="text-sm font-semibold mb-1">Start here</h3>
      <p className="text-xs opacity-50 text-center mb-3">Create your first issue to begin</p>
      {onCreateIssue && (
        <button className="btn btn-primary btn-sm gap-1" onClick={onCreateIssue}>
          <Plus className="size-3.5" />
          New Issue
        </button>
      )}
    </div>
  );
}

/** Mobile long-press action sheet */
function ActionSheet({ issue, onClose, onStateChange, onSelect }) {
  const transitions = getIssueTransitions(issue.state).filter((s) => s !== issue.state);

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-50 animate-fade-in" onClick={onClose} />
      <div
        className="fixed bottom-0 left-0 right-0 z-50 bg-base-100 rounded-t-2xl shadow-2xl animate-slide-up-sheet"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-base-content/20" />
        </div>

        {/* Issue info */}
        <div className="px-4 py-2 border-b border-base-300">
          <span className="font-mono text-xs opacity-50">{issue.identifier}</span>
          <h3 className="font-semibold text-sm truncate">{issue.title}</h3>
        </div>

        {/* Actions */}
        <div className="p-3 space-y-1">
          <button
            className="btn btn-ghost btn-sm w-full justify-start gap-2"
            onClick={() => { onSelect(issue); onClose(); }}
          >
            <Eye className="size-4" /> View Details
          </button>

          {transitions.length > 0 && (
            <div className="text-[10px] uppercase tracking-wide opacity-40 px-3 pt-2">Move to</div>
          )}
          {transitions.map((state) => (
            <button
              key={state}
              className="btn btn-ghost btn-sm w-full justify-start gap-2"
              onClick={() => { onStateChange(issue.id, state); onClose(); }}
            >
              <ArrowRight className="size-4" /> {state}
            </button>
          ))}
        </div>

        <div className="p-3 pt-0">
          <button className="btn btn-ghost btn-sm w-full" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </>
  );
}

/** Column indicator dots for mobile */
function ColumnDots({ columns, activeIndex }) {
  return (
    <div className="kanban-dots md:hidden">
      {columns.map((col, i) => (
        <div
          key={col}
          className={`kanban-dot ${i === activeIndex ? "active" : ""}`}
          style={{ backgroundColor: COLUMN_DOT_COLOR[col] }}
        />
      ))}
    </div>
  );
}

// Default visible card limits for collapsible columns
const COLLAPSE_LIMITS = {
  Done: 20,
};

function KanbanColumn({ col, issues, empty, badgeClass, dragState, registerColumn, getCardHandlers, onSelect, onCreateIssue, lastDroppedId, hasRunningAgents, totalIssues, onLongPress, selectedIds, onToggleSelect, hasSelection }) {
  const colRef = useRef(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    registerColumn(col, colRef.current);
    return () => registerColumn(col, null);
  }, [col, registerColumn]);

  const isDragging = dragState != null;
  const isOver = dragState?.overColumn === col;
  const isSource = dragState?.sourceColumn === col;
  const isValid = dragState?.validColumns?.has(col) ?? false;
  const isDimmed = isDragging && !isValid && !isSource;
  const isEmpty = issues.length === 0;
  const isCollapsedEmpty = isEmpty && col !== "Planning" && totalIssues === 0;

  // Collapsible columns: Done shows 20 by default
  const collapseLimit = COLLAPSE_LIMITS[col];
  const isCollapsible = collapseLimit != null && issues.length > collapseLimit;
  const visibleIssues = (isCollapsible && !expanded) ? issues.slice(0, collapseLimit) : issues;
  const hiddenCount = issues.length - visibleIssues.length;

  let columnClass = `kanban-column bg-base-200 rounded-box p-3 flex flex-col min-h-0 overflow-hidden`;
  if (isCollapsedEmpty) {
    columnClass += " kanban-column-collapsed";
  }
  if (isDragging) {
    if (isOver && isValid) {
      columnClass += " kanban-column-drop-valid";
    } else if (isOver && !isValid) {
      columnClass += " kanban-column-drop-invalid";
    } else if (isDimmed) {
      columnClass += " kanban-column-dimmed";
    }
  }

  const colStyle = {
    borderTop: '3px solid transparent',
    ...(COLUMN_ACCENT_STYLE[col] || {}),
    ...(isCollapsedEmpty ? { alignSelf: 'start' } : {}),
  };

  return (
    <div key={col} ref={colRef} className={columnClass} style={colStyle}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold tracking-wide flex items-center gap-1.5" style={{ color: COLUMN_HEADER_COLOR[col], fontFamily: "'Space Grotesk', system-ui, sans-serif" }}>
          {col}
          {col === "In Progress" && hasRunningAgents && (
            <span className="issue-phase-dot" title="Agents working" />
          )}
        </h3>
        <ColumnBadge count={issues.length} className={badgeClass} />
      </div>

      {!isCollapsedEmpty && (
        <div className="space-y-2 flex-1 overflow-y-auto kanban-card-list">
          {isEmpty ? (
            isOver && isValid ? (
              <div className="kanban-drop-placeholder" />
            ) : col === "Planning" && totalIssues === 0 ? (
              <PlanningEmptyState onCreateIssue={onCreateIssue} />
            ) : (
              <div className="flex flex-col items-center py-6 opacity-30">
                <empty.icon className="size-5 mb-1" />
                <span className="text-[10px]">{empty.desc}</span>
              </div>
            )
          ) : (
            <div className="stagger-children space-y-2">
              {visibleIssues.map((issue) => {
                const beingDragged = dragState?.issueId === issue.id;
                const justDropped = lastDroppedId === issue.id;
                return (
                  <div
                    key={issue.id}
                    className={`${beingDragged ? "kanban-card-dragging-source" : ""} ${justDropped ? "animate-pop" : ""}`}
                    onContextMenu={(e) => {
                      // Long press on mobile triggers context menu — use action sheet instead
                      if ('ontouchstart' in window) {
                        e.preventDefault();
                        onLongPress?.(issue);
                      }
                    }}
                  >
                    <IssueCard
                      issue={issue}
                      onSelect={onSelect}
                      dragHandlers={getCardHandlers(issue, col)}
                      isDragging={beingDragged}
                      isSelected={selectedIds?.has(issue.id)}
                      onToggleSelect={onToggleSelect}
                      hasSelection={hasSelection}
                    />
                  </div>
                );
              })}

              {/* Collapse/expand toggle for Done column */}
              {isCollapsible && (
                <button
                  className="btn btn-ghost btn-xs w-full gap-1 opacity-50 hover:opacity-80"
                  onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
                >
                  <ChevronDown className={`size-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
                  {expanded ? "Show less" : `+${hiddenCount} more`}
                </button>
              )}

              {isOver && isValid && (
                <div className="kanban-drop-placeholder" />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Compute valid bulk transitions: intersection of transitions for all selected issues */
function computeBulkTransitions(selectedIds, issues) {
  const selectedIssues = issues.filter((i) => selectedIds.has(i.id));
  if (selectedIssues.length === 0) return [];

  // Get valid transitions for each selected issue (excluding current state)
  const transitionSets = selectedIssues.map((issue) => {
    const transitions = getIssueTransitions(issue.state);
    return new Set(transitions.filter((s) => s !== issue.state));
  });

  // Intersection of all sets
  const first = transitionSets[0];
  const common = [...first].filter((t) =>
    transitionSets.every((set) => set.has(t))
  );

  return common;
}

/** Floating action bar for bulk operations */
function BulkActionBar({ count, transitions, onBulkAction, onClear }) {
  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-base-100 border border-base-300 rounded-box shadow-2xl px-4 py-2.5 flex items-center gap-3 animate-slide-up-sheet"
      role="toolbar"
      aria-label="Bulk actions"
    >
      <div className="flex items-center gap-2 flex-wrap">
        {transitions.map((state) => (
          <button
            key={state}
            className="btn btn-sm btn-outline gap-1"
            onClick={() => onBulkAction(state)}
          >
            <ArrowRight className="size-3" />
            {state}
          </button>
        ))}
      </div>

      <div className="divider divider-horizontal mx-0" />

      <span className="text-sm font-medium whitespace-nowrap opacity-70">
        {count} selected
      </span>

      <button
        className="btn btn-sm btn-ghost btn-square"
        onClick={onClear}
        aria-label="Clear selection"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

export function BoardView({ issues, onStateChange, onRetry, onCancel, onSelect, onCreateIssue, isLoading }) {
  const [lastDroppedId, setLastDroppedId] = useState(null);
  const [activeColumn, setActiveColumn] = useState(0);
  const [actionSheetIssue, setActionSheetIssue] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const scrollContainerRef = useRef(null);

  const hasSelection = selectedIds.size > 0;

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // Escape key clears selection
  useEffect(() => {
    if (!hasSelection) return;
    const handler = (e) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hasSelection, clearSelection]);

  // Clean up selectedIds when issues change (remove stale IDs)
  useEffect(() => {
    if (!hasSelection) return;
    const issueIdSet = new Set(issues.map((i) => i.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => issueIdSet.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [issues, hasSelection]);

  const bulkTransitions = useMemo(
    () => computeBulkTransitions(selectedIds, issues),
    [selectedIds, issues]
  );

  const handleBulkAction = useCallback(
    (newState) => {
      for (const id of selectedIds) {
        onStateChange(id, newState);
      }
      clearSelection();
    },
    [selectedIds, onStateChange, clearSelection]
  );

  const grouped = useMemo(() => {
    const buckets = Object.fromEntries(COLUMNS.map((c) => [c, []]));
    for (const issue of issues) {
      if (HIDDEN_STATES.has(issue.state)) continue;
      let col;
      if (PLANNING_STATES.has(issue.state)) col = "Planning";
      else if (NEEDS_APPROVAL_STATES.has(issue.state)) col = "Needs Approval";
      else if (IN_PROGRESS_STATES.has(issue.state)) col = "In Progress";
      else if (issue.state === "Blocked") col = "Blocked";
      else col = "Done";
      buckets[col].push(issue);
    }
    for (const c of COLUMNS) {
      buckets[c].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    }
    return buckets;
  }, [issues]);

  const hasRunningAgents = useMemo(() => {
    return issues.some((i) => i.state === "Running");
  }, [issues]);

  const handleStateChange = useCallback((id, state) => {
    setLastDroppedId(id);
    const timer = setTimeout(() => setLastDroppedId(null), 400);
    onStateChange(id, state);
    return () => clearTimeout(timer);
  }, [onStateChange]);

  const {
    dragState,
    ghostRef,
    getCardHandlers,
    registerColumn,
    onBoardPointerMove,
    onBoardPointerUp,
    onBoardPointerCancel,
    shouldSuppressClick,
  } = useDragAndDrop({ onStateChange: handleStateChange });

  // Wrap onSelect to suppress clicks that follow a drag
  const guardedOnSelect = useCallback(
    (issue) => {
      if (shouldSuppressClick()) return;
      onSelect?.(issue);
    },
    [onSelect, shouldSuppressClick]
  );

  // Track active column via scroll on mobile
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const grid = container.querySelector(".grid, [class*='grid']");
    if (!grid) return;

    const handleScroll = () => {
      const cols = grid.children;
      if (!cols.length) return;
      const scrollLeft = container.scrollLeft;
      const containerWidth = container.clientWidth;
      let bestIndex = 0;
      let bestDistance = Infinity;

      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        const colCenter = col.offsetLeft + col.offsetWidth / 2;
        const viewCenter = scrollLeft + containerWidth / 2;
        const distance = Math.abs(colCenter - viewCenter);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }
      setActiveColumn(bestIndex);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Long press handler for mobile action sheet
  const longPressTimerRef = useRef(null);
  const handleLongPress = useCallback((issue) => {
    setActionSheetIssue(issue);
  }, []);

  if (isLoading) {
    return (
      <div className="overflow-x-auto pb-2 flex-1 flex flex-col min-h-0">
        <div
          className="grid gap-3 flex-1 stagger-children"
          style={{
            gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0, 1fr))`,
            minWidth: `${COLUMNS.length * 200}px`,
          }}
        >
          {COLUMNS.map((col, i) => (
            <div key={col} className="bg-base-200 rounded-box p-3 flex flex-col gap-2">
              <div className="skeleton-line h-4 w-20 mb-2" />
              <SkeletonCard delay={i * 80} />
              <SkeletonCard delay={i * 80 + 120} />
              {i < 2 && <SkeletonCard delay={i * 80 + 240} />}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div
        ref={scrollContainerRef}
        className="overflow-x-auto pb-2 flex-1 flex flex-col min-h-0"
        onPointerMove={onBoardPointerMove}
        onPointerUp={onBoardPointerUp}
        onPointerCancel={onBoardPointerCancel}
        style={{ touchAction: dragState ? "none" : undefined }}
      >
        <div
          className={`grid gap-3 flex-1 stagger-children ${dragState ? "kanban-dragging" : ""}`}
          style={{
            gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0, 1fr))`,
            minWidth: `${COLUMNS.length * 200}px`,
          }}
        >
          {COLUMNS.map((col) => (
            <KanbanColumn
              key={col}
              col={col}
              issues={grouped[col]}
              empty={EMPTY_CONFIG[col]}
              badgeClass={COLUMN_BADGE[col]}
              dragState={dragState}
              registerColumn={registerColumn}
              getCardHandlers={getCardHandlers}
              onSelect={guardedOnSelect}
              onCreateIssue={onCreateIssue}
              lastDroppedId={lastDroppedId}
              hasRunningAgents={hasRunningAgents}
              totalIssues={issues.length}
              onLongPress={handleLongPress}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              hasSelection={hasSelection}
            />
          ))}
        </div>

        <DragGhost dragState={dragState} ghostRef={ghostRef} />
      </div>

      {/* Column indicator dots (mobile) */}
      <ColumnDots columns={COLUMNS} activeIndex={activeColumn} />

      {/* Mobile long-press action sheet */}
      {actionSheetIssue && (
        <ActionSheet
          issue={actionSheetIssue}
          onClose={() => setActionSheetIssue(null)}
          onStateChange={handleStateChange}
          onSelect={guardedOnSelect}
        />
      )}

      {/* Bulk selection floating action bar */}
      {hasSelection && (
        <BulkActionBar
          count={selectedIds.size}
          transitions={bulkTransitions}
          onBulkAction={handleBulkAction}
          onClear={clearSelection}
        />
      )}
    </>
  );
}

export default BoardView;
