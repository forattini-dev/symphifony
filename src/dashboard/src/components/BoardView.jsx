import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { IssueCard } from "./IssueCard.jsx";
import { EmptyState } from "./EmptyState.jsx";
import { Plus, Play, Eye, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
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
  return (
    <span className={`badge badge-xs ${className} ${bumping ? "animate-count-bump" : ""}`}>
      {count}
    </span>
  );
}

// Kanban columns — Queued/Running/Interrupted are grouped as "In Progress"
const COLUMNS = ["Todo", "In Progress", "In Review", "Blocked", "Done", "Cancelled"];
const IN_PROGRESS_STATES = new Set(["Queued", "Running", "Interrupted"]);

const COLUMN_BADGE = {
  Todo: "badge-warning",
  "In Progress": "badge-primary",
  "In Review": "badge-secondary",
  Blocked: "badge-error",
  Done: "badge-success",
  Cancelled: "badge-neutral",
};

const EMPTY_CONFIG = {
  Todo: { icon: Plus, desc: "Create an issue to get started" },
  "In Progress": { icon: Play, desc: "Issues move here when agents start" },
  "In Review": { icon: Eye, desc: "Awaiting review" },
  Blocked: { icon: AlertTriangle, desc: "Needs attention" },
  Done: { icon: CheckCircle, desc: "Completed" },
  Cancelled: { icon: XCircle, desc: "Cancelled" },
};

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

function KanbanColumn({ col, issues, empty, badgeClass, dragState, registerColumn, getCardHandlers, onSelect }) {
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

  let columnClass = "kanban-column bg-base-200 rounded-box p-3 flex flex-col min-h-0 overflow-hidden";
  if (isDragging) {
    if (isOver && isValid) {
      columnClass += " kanban-column-drop-valid";
    } else if (isOver && !isValid) {
      columnClass += " kanban-column-drop-invalid";
    } else if (isDimmed) {
      columnClass += " kanban-column-dimmed";
    }
  }

  return (
    <div key={col} ref={colRef} className={columnClass}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold uppercase tracking-wide opacity-70">
          {col}
        </h3>
        <ColumnBadge count={issues.length} className={badgeClass} />
      </div>

      <div className="space-y-2 flex-1 overflow-y-auto kanban-card-list">
        {issues.length === 0 ? (
          isOver && isValid ? (
            <div className="kanban-drop-placeholder" />
          ) : (
            <EmptyState
              icon={empty.icon}
              title="No issues"
              description={empty.desc}
            />
          )
        ) : (
          <div className="stagger-children space-y-2">
            {issues.map((issue) => {
              const beingDragged = dragState?.issueId === issue.id;
              return (
                <div
                  key={issue.id}
                  className={beingDragged ? "kanban-card-dragging-source" : ""}
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
    </div>
  );
}

export function BoardView({ issues, onStateChange, onRetry, onCancel, onSelect }) {
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

  const {
    dragState,
    ghostRef,
    getCardHandlers,
    registerColumn,
    onBoardPointerMove,
    onBoardPointerUp,
    onBoardPointerCancel,
    shouldSuppressClick,
  } = useDragAndDrop({ onStateChange });

  // Wrap onSelect to suppress clicks that follow a drag
  const guardedOnSelect = useCallback(
    (issue) => {
      if (shouldSuppressClick()) return;
      onSelect?.(issue);
    },
    [onSelect, shouldSuppressClick]
  );

  return (
    <div
      className="overflow-x-auto pb-2 flex-1 flex flex-col min-h-0"
      onPointerMove={onBoardPointerMove}
      onPointerUp={onBoardPointerUp}
      onPointerCancel={onBoardPointerCancel}
      style={{ touchAction: dragState ? "none" : undefined }}
    >
      <div
        className={`grid gap-3 flex-1 ${dragState ? "kanban-dragging" : ""}`}
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
          />
        ))}
      </div>

      <DragGhost dragState={dragState} ghostRef={ghostRef} />
    </div>
  );
}

export default BoardView;
