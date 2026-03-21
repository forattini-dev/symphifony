import { useState, useRef, useCallback, useEffect } from "react";
import { ISSUE_STATE_MACHINE } from "../utils.js";

/**
 * Column name → actual state to transition to when dropping.
 * "In Progress" maps to "Queued" (the entry state for that group).
 */
/** States that belong to each column (for resolving drop target). */
const COLUMN_STATES = {
  Planning: ["Planning"],
  "Needs Approval": ["PendingApproval", "PendingDecision"],
  "In Progress": ["Queued", "Running", "Reviewing"],
  Blocked: ["Blocked"],
  Done: ["Approved", "Merged", "Cancelled"],
};

/** Reverse: actual states → column name. Must match BoardView's grouping sets. */
const PLANNING_STATES = new Set(["Planning"]);
const NEEDS_APPROVAL_STATES = new Set(["PendingApproval", "PendingDecision"]);
const IN_PROGRESS_STATES = new Set(["Queued", "Running", "Reviewing"]);
const DONE_STATES = new Set(["Approved", "Merged", "Cancelled"]);
function stateToColumn(state) {
  if (PLANNING_STATES.has(state)) return "Planning";
  if (NEEDS_APPROVAL_STATES.has(state)) return "Needs Approval";
  if (IN_PROGRESS_STATES.has(state)) return "In Progress";
  if (DONE_STATES.has(state)) return "Done";
  return state;
}

/**
 * Given an issue's current state, return the set of column names it can be
 * dropped into (excluding its own column).
 */
function getValidDropColumns(issueState) {
  const transitions = ISSUE_STATE_MACHINE[issueState];
  if (!transitions) return new Set();
  const cols = new Set(transitions.map((s) => stateToColumn(s)));
  // Remove the column it's already in
  cols.delete(stateToColumn(issueState));
  return cols;
}

const LONG_PRESS_MS = 300;
const DRAG_THRESHOLD_PX = 5;

/**
 * Custom hook for native pointer-event based drag & drop on the kanban board.
 *
 * Returns:
 *  - dragState: { issueId, issue, sourceColumn, validColumns, overColumn } | null
 *  - ghostRef: ref to attach to the floating ghost element
 *  - getCardHandlers(issue, column): returns onPointerDown for a card
 *  - getColumnHandlers(column): returns onPointerMove, onPointerUp for a column
 *  - boardRef: ref to attach to the board container (for pointer capture)
 */
export function useDragAndDrop({ onStateChange }) {
  const [dragState, setDragState] = useState(null);
  const ghostRef = useRef(null);
  const internals = useRef({
    pointerId: null,
    startX: 0,
    startY: 0,
    isDragging: false,
    longPressTimer: null,
    longPressReady: false,
    pointerType: null,
    issue: null,
    sourceColumn: null,
    didDrag: false, // true after any drag completes — used to suppress click
  });
  const boardRef = useRef(null);
  const columnRectsRef = useRef(new Map());

  // Clean up on unmount
  useEffect(() => {
    return () => {
      clearTimeout(internals.current.longPressTimer);
    };
  }, []);

  const updateGhostPosition = useCallback((clientX, clientY) => {
    const ghost = ghostRef.current;
    if (!ghost) return;
    ghost.style.left = `${clientX}px`;
    ghost.style.top = `${clientY}px`;
  }, []);

  const findColumnAtPoint = useCallback((clientX, clientY) => {
    for (const [col, el] of columnRectsRef.current.entries()) {
      const rect = el.getBoundingClientRect();
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return col;
      }
    }
    return null;
  }, []);

  const startDrag = useCallback((issue, sourceColumn, clientX, clientY) => {
    const validColumns = getValidDropColumns(issue.state);
    internals.current.isDragging = true;
    setDragState({
      issueId: issue.id,
      issue,
      sourceColumn,
      validColumns,
      overColumn: null,
    });
    updateGhostPosition(clientX, clientY);
  }, [updateGhostPosition]);

  const cancelDrag = useCallback(() => {
    const wasDragging = internals.current.isDragging;
    clearTimeout(internals.current.longPressTimer);
    internals.current.isDragging = false;
    internals.current.longPressReady = false;
    internals.current.pointerId = null;
    internals.current.issue = null;
    // Mark that a drag just finished so we can suppress the upcoming click event
    internals.current.didDrag = wasDragging;
    if (wasDragging) {
      // Reset after a tick so the click event is caught
      requestAnimationFrame(() => {
        internals.current.didDrag = false;
      });
    }
    setDragState(null);
  }, []);

  const completeDrop = useCallback(
    (column) => {
      if (!dragState) return;
      if (dragState.validColumns.has(column)) {
        // Pick the first valid transition that belongs to the target column
        const transitions = ISSUE_STATE_MACHINE[dragState.issue.state] || [];
        const colStates = new Set(COLUMN_STATES[column] || []);
        const targetState = transitions.find((s) => colStates.has(s));
        if (targetState) {
          onStateChange(dragState.issueId, targetState);
        }
      }
      cancelDrag();
    },
    [dragState, onStateChange, cancelDrag]
  );

  const registerColumn = useCallback((column, element) => {
    if (element) {
      columnRectsRef.current.set(column, element);
    } else {
      columnRectsRef.current.delete(column);
    }
  }, []);

  const getCardHandlers = useCallback(
    (issue, column) => ({
      onPointerDown: (e) => {
        // Only primary button
        if (e.button !== 0) return;
        // Don't interfere with links or buttons inside the card
        if (e.target.closest("a, button")) return;

        internals.current.pointerId = e.pointerId;
        internals.current.startX = e.clientX;
        internals.current.startY = e.clientY;
        internals.current.pointerType = e.pointerType;
        internals.current.issue = issue;
        internals.current.sourceColumn = column;
        internals.current.longPressReady = false;

        if (e.pointerType === "touch") {
          // Touch: require long press before drag starts
          internals.current.longPressTimer = setTimeout(() => {
            internals.current.longPressReady = true;
            // Vibration feedback if available
            if (navigator.vibrate) navigator.vibrate(30);
            startDrag(issue, column, e.clientX, e.clientY);
          }, LONG_PRESS_MS);
        }
        // Mouse: don't start drag yet, wait for movement past threshold
      },
    }),
    [startDrag]
  );

  // Board-level pointer handlers (attached to the board container)
  const onBoardPointerMove = useCallback(
    (e) => {
      const int = internals.current;
      if (int.pointerId == null) return;
      if (e.pointerId !== int.pointerId) return;

      const dx = e.clientX - int.startX;
      const dy = e.clientY - int.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (!int.isDragging) {
        if (int.pointerType === "touch") {
          // If moved before long press fires, cancel the long press (user is scrolling)
          if (dist > DRAG_THRESHOLD_PX && !int.longPressReady) {
            clearTimeout(int.longPressTimer);
            int.pointerId = null;
            return;
          }
          // If long press already fired and we're now dragging, continue below
          if (!int.longPressReady) return;
        } else {
          // Mouse: start drag after threshold
          if (dist < DRAG_THRESHOLD_PX) return;
          startDrag(int.issue, int.sourceColumn, e.clientX, e.clientY);
        }
      }

      // We're dragging
      e.preventDefault();
      updateGhostPosition(e.clientX, e.clientY);

      const col = findColumnAtPoint(e.clientX, e.clientY);
      setDragState((prev) => {
        if (!prev || prev.overColumn === col) return prev;
        return { ...prev, overColumn: col };
      });
    },
    [startDrag, updateGhostPosition, findColumnAtPoint]
  );

  const onBoardPointerUp = useCallback(
    (e) => {
      const int = internals.current;
      if (int.pointerId == null) return;
      if (e.pointerId !== int.pointerId) return;

      clearTimeout(int.longPressTimer);

      if (!int.isDragging) {
        // Was just a click/tap, not a drag — reset and let the click handler fire
        int.pointerId = null;
        return;
      }

      const col = findColumnAtPoint(e.clientX, e.clientY);
      if (col) {
        completeDrop(col);
      } else {
        cancelDrag();
      }
    },
    [findColumnAtPoint, completeDrop, cancelDrag]
  );

  const onBoardPointerCancel = useCallback(() => {
    cancelDrag();
  }, [cancelDrag]);

  /** Call inside onClick to check if the click should be suppressed (was a drag). */
  const shouldSuppressClick = useCallback(() => {
    return internals.current.didDrag || internals.current.isDragging;
  }, []);

  return {
    dragState,
    ghostRef,
    boardRef,
    getCardHandlers,
    registerColumn,
    onBoardPointerMove,
    onBoardPointerUp,
    onBoardPointerCancel,
    cancelDrag,
    shouldSuppressClick,
  };
}
