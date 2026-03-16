import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { IssueCard } from "./IssueCard.jsx";
import { EmptyState } from "./EmptyState.jsx";
import { Lightbulb, Plus, Play, Eye, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { useDragAndDrop } from "../hooks/useDragAndDrop.js";

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

// Kanban columns — Queued/Running/Interrupted are grouped as "In Progress"
const COLUMNS = ["Planning", "In Progress", "In Review", "Blocked", "Done", "Cancelled"];
const IN_PROGRESS_STATES = new Set(["Todo", "Queued", "Running", "Interrupted"]);

const COLUMN_BADGE = {
  Planning: "badge-info",
  "In Progress": "badge-primary",
  "In Review": "badge-secondary",
  Blocked: "badge-error",
  Done: "badge-success",
  Cancelled: "badge-neutral",
};

const COLUMN_ACCENT_STYLE = {
  Planning: { borderTopColor: 'oklch(var(--in) / 0.4)' },
  "In Progress": { borderTopColor: 'oklch(var(--p) / 0.5)' },
  "In Review": { borderTopColor: 'oklch(var(--s) / 0.4)' },
  Blocked: { borderTopColor: 'oklch(var(--er) / 0.4)' },
  Done: { borderTopColor: 'oklch(var(--su) / 0.4)' },
  Cancelled: { borderTopColor: 'oklch(var(--bc) / 0.15)' },
};

const COLUMN_HEADER_COLOR = {
  Planning: 'oklch(var(--in))',
  "In Progress": 'oklch(var(--p))',
  "In Review": 'oklch(var(--s))',
  Blocked: 'oklch(var(--er))',
  Done: 'oklch(var(--su))',
  Cancelled: undefined,
};

const EMPTY_CONFIG = {
  Planning: { icon: Lightbulb, desc: "Create an issue to start planning" },
  "In Progress": { icon: Play, desc: "Issues move here when agents start" },
  "In Review": { icon: Eye, desc: "Awaiting review" },
  Blocked: { icon: AlertTriangle, desc: "Needs attention" },
  Done: { icon: CheckCircle, desc: "Completed" },
  Cancelled: { icon: XCircle, desc: "Cancelled" },
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

function KanbanColumn({ col, issues, empty, badgeClass, dragState, registerColumn, getCardHandlers, onSelect, onCreateIssue, lastDroppedId, hasRunningAgents, totalIssues }) {
  const colRef = useRef(null);

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
              {issues.map((issue) => {
                const beingDragged = dragState?.issueId === issue.id;
                const justDropped = lastDroppedId === issue.id;
                return (
                  <div
                    key={issue.id}
                    className={`${beingDragged ? "kanban-card-dragging-source" : ""} ${justDropped ? "animate-pop" : ""}`}
                  >
                    <IssueCard
                      issue={issue}
                      onSelect={onSelect}
                      dragHandlers={getCardHandlers(issue, col)}
                      isDragging={beingDragged}
                    />
                  </div>
                );
              })}
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

export function BoardView({ issues, onStateChange, onRetry, onCancel, onSelect, onCreateIssue, isLoading }) {
  const [lastDroppedId, setLastDroppedId] = useState(null);

  const grouped = useMemo(() => {
    const buckets = Object.fromEntries(COLUMNS.map((c) => [c, []]));
    for (const issue of issues) {
      const col = IN_PROGRESS_STATES.has(issue.state) ? "In Progress" : (buckets[issue.state] ? issue.state : "Todo");
      buckets[col].push(issue);
    }
    for (const c of COLUMNS) {
      buckets[c].sort((a, b) => a.priority - b.priority);
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

  if (isLoading) {
    return (
      <div className="overflow-x-auto pb-2 flex-1 flex flex-col min-h-0">
        <div
          className="grid gap-3 flex-1 stagger-children"
          style={{
            gridTemplateColumns: `repeat(${COLUMNS.length}, minmax(0, 1fr))`,
            minWidth: `${COLUMNS.length * 180}px`,
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
    <div
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
          minWidth: `${COLUMNS.length * 180}px`,
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
          />
        ))}
      </div>

      <DragGhost dragState={dragState} ghostRef={ghostRef} />
    </div>
  );
}

export default BoardView;
