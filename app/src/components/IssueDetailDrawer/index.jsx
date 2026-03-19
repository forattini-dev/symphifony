import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  X, AlertTriangle, Loader, RotateCcw, PlayCircle, GitMerge,
  ThumbsUp, GitPullRequest, Eye,
} from "lucide-react";
import { PreviewModal } from "./PreviewModal.jsx";
import { api } from "../../api.js";
import { useSwipeToDismiss } from "../../hooks/useSwipeToDismiss.js";
import { useWorkflowConfig } from "../../hooks/useWorkflowConfig.js";
import { ISSUE_TYPE_COLORS, getTabs } from "./constants.js";
import { PipelineStepper } from "./PipelineStepper.jsx";
import { OverviewTab } from "./tabs/OverviewTab.jsx";
import { ExecutionTab } from "./tabs/ExecutionTab.jsx";
import { DiffTab } from "./tabs/DiffTab.jsx";
import { RoutingTab } from "./tabs/RoutingTab.jsx";
import { EventsTab } from "./tabs/EventsTab.jsx";
import { HistoryTab } from "./tabs/HistoryTab.jsx";
import { PlanningTab } from "./tabs/PlanningTab.jsx";
import { ReviewTab } from "./tabs/ReviewTab.jsx";

// ── DrawerFooter ─────────────────────────────────────────────────────────────

function DrawerFooter({ issue, onStateChange, onMerge, onPush, mergeBusy, mergeError, mergeNotice, mergeMode }) {
  const footerStyle = { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)" };
  const [executeBusy, setExecuteBusy] = useState(false);
  const [executeError, setExecuteError] = useState(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const handleExecute = useCallback(async () => {
    setExecuteBusy(true);
    setExecuteError(null);
    try {
      const res = await api.post(`/issues/${encodeURIComponent(issue.id)}/execute`);
      if (!res.ok) throw new Error(res.error || "Execute failed.");
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuteBusy(false);
    }
  }, [issue.id]);

  const isPlanning = issue.state === "Planning";
  const isPlanned = issue.state === "Planned";
  const isRunning = issue.state === "Running" || issue.state === "Queued";
  const isInReview = issue.state === "Reviewing" || issue.state === "Reviewed";
  const isDone = issue.state === "Done";
  const isMerged = !!issue.mergedAt;

  // Planning: approve button lives inside PlanningTab, nothing to show here
  if (isPlanning) return null;

  // Planned: show Execute button to dispatch to Queued
  if (isPlanned) {
    return (
      <div className="px-6 py-3 border-t border-base-300 shrink-0 space-y-1.5" style={footerStyle}>
        {executeError && (
          <div className="alert alert-error text-xs py-1.5">
            <AlertTriangle className="size-3.5" /> {executeError}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            className="btn btn-primary btn-sm gap-1.5 flex-1"
            onClick={handleExecute}
            disabled={executeBusy}
          >
            {executeBusy ? <><Loader className="size-4 animate-spin" /> Starting...</> : <><PlayCircle className="size-4" /> Execute</>}
          </button>
        </div>
      </div>
    );
  }

  // Running: show watching status
  if (isRunning) {
    return (
      <div className="px-6 py-3 border-t border-base-300 shrink-0 flex items-center justify-center gap-2" style={footerStyle}>
        <span className="issue-phase-dot" />
        <span className="text-sm opacity-50">Watching...</span>
      </div>
    );
  }

  // Reviewing/Reviewed: preview + approve/rework actions
  if (isInReview) {
    return (
      <>
        {previewOpen && <PreviewModal issue={issue} onClose={() => setPreviewOpen(false)} />}
        <div className="px-6 py-3 border-t border-base-300 shrink-0 space-y-1.5" style={footerStyle}>
          <button
            className="btn btn-primary btn-sm btn-soft gap-1.5 w-full"
            onClick={() => setPreviewOpen(true)}
          >
            <Eye className="size-3.5" /> Preview Changes
          </button>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-success btn-sm gap-1.5 flex-1"
              onClick={() => onStateChange?.(issue.id, "Done")}
            >
              <ThumbsUp className="size-4" /> Approve
            </button>
            <button
              className="btn btn-warning btn-sm gap-1.5 flex-1"
              onClick={() => onStateChange?.(issue.id, "Queued")}
            >
              <RotateCcw className="size-4" /> Rework
            </button>
          </div>
        </div>
      </>
    );
  }

  if (isDone && !isMerged) {
    const isPushPr = mergeMode === "push-pr";
    return (
      <div className="px-6 py-3 border-t border-base-300 shrink-0 space-y-2" style={footerStyle}>
        {mergeError && (
          <div className="alert alert-error text-sm py-2">
            <AlertTriangle className="size-4" /> {mergeError}
          </div>
        )}
        {mergeNotice && !mergeError && (
          <div className="alert alert-success text-sm py-2">
            <span className="size-4" /> {mergeNotice}
          </div>
        )}
        <div className="flex items-center gap-2">
          {isPushPr ? (
            <button
              className={`btn btn-primary btn-sm gap-1.5 flex-1 ${mergeBusy ? "btn-disabled" : ""}`}
              onClick={() => onPush?.(issue.id)}
              disabled={mergeBusy}
            >
              {mergeBusy ? <Loader className="size-4 animate-spin" /> : <GitPullRequest className="size-4" />}
              {mergeBusy ? "Pushing..." : (
                issue.baseBranch ? <>Push PR → <span className="font-mono">{issue.baseBranch}</span></> : "Push & Open PR"
              )}
            </button>
          ) : (
            <button
              className={`btn btn-primary btn-sm gap-1.5 flex-1 ${mergeBusy ? "btn-disabled" : ""}`}
              onClick={() => onMerge?.(issue.id)}
              disabled={mergeBusy}
            >
              {mergeBusy ? <Loader className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
              {mergeBusy ? "Merging..." : (
                issue.baseBranch ? <>Merge → <span className="font-mono">{issue.baseBranch}</span></> : "Merge to Project"
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}

// ── IssueDetailDrawer ─────────────────────────────────────────────────────────

export function IssueDetailDrawer({ issue, onClose, onStateChange, onRetry, onCancel, events, mergeMode }) {
  const [tab, setTab] = useState("overview");
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState(null);
  const [mergeNotice, setMergeNotice] = useState(null);
  const [replanBusy, setReplanBusy] = useState(false);
  const [replanError, setReplanError] = useState(null);
  const tabsContainerRef = useRef(null);
  const { data: workflowConfig } = useWorkflowConfig();

  const handleReplanFromDrawer = useCallback(async () => {
    if (!issue?.id || replanBusy) return;
    setReplanBusy(true);
    setReplanError(null);
    try {
      const res = await api.post(`/issues/${encodeURIComponent(issue.id)}/replan`);
      if (!res.ok) throw new Error(res.error || "Replan failed.");
      setTab("planning");
    } catch (err) {
      setReplanError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplanBusy(false);
    }
  }, [issue?.id, replanBusy]);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setVisible(false); setClosing(false); onClose(); }, 250);
  }, [onClose]);

  const { ref: swipeRef, handlers: swipeHandlers } = useSwipeToDismiss({ onDismiss: handleClose, direction: "right" });

  // Reset tab when issue changes — auto-open Review tab when Reviewing/Reviewed
  useEffect(() => {
    setTab((issue?.state === "Planning" || issue?.state === "Planned") ? "planning" : (issue?.state === "Reviewing" || issue?.state === "Reviewed") ? "review" : "overview");
    setMergeBusy(false);
    setMergeError(null);
    setMergeNotice(null);
    if (issue) { setVisible(true); setClosing(false); }
  }, [issue?.id, issue?.state]);

  const handleMerge = useCallback(async () => {
    if (!issue?.id || mergeBusy) return;
    setMergeBusy(true);
    setMergeError(null);
    setMergeNotice(null);
    try {
      const res = await api.post(`/issues/${encodeURIComponent(issue.id)}/merge`);
      const mergedFiles = typeof res?.copied?.length === "number" ? res.copied.length : 0;
      const conflicts = typeof res?.conflicts?.length === "number" ? res.conflicts.length : 0;
      setMergeNotice(conflicts > 0
        ? `Merge completed with ${conflicts} conflict${conflicts !== 1 ? "s" : ""}.`
        : `Merged ${mergedFiles} file${mergedFiles !== 1 ? "s" : ""} into the project.`);
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergeBusy(false);
    }
  }, [issue?.id, mergeBusy]);

  const handlePush = useCallback(async () => {
    if (!issue?.id || mergeBusy) return;
    setMergeBusy(true);
    setMergeError(null);
    setMergeNotice(null);
    try {
      const res = await api.post(`/issues/${encodeURIComponent(issue.id)}/push`);
      if (!res.ok) throw new Error(res.error || "Push failed.");
      if (res.prUrl) {
        setMergeNotice(`Branch pushed. PR: ${res.prUrl}`);
        window.open(res.prUrl, "_blank", "noopener");
      } else {
        setMergeNotice("Branch pushed to origin.");
      }
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergeBusy(false);
    }
  }, [issue?.id, mergeBusy]);

  // Close drawer on Escape key
  useEffect(() => {
    if (!issue || !visible) return;
    const handler = (e) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [issue?.id, visible, handleClose]);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (!tabsContainerRef.current) return;
    const active = tabsContainerRef.current.querySelector(".tab-active");
    active?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [tab]);

  if (!issue && !visible) return null;
  const displayIssue = issue || {};
  const isPendingPlanning = issue?.state === "Planning" && !issue?.plan && !issue?.planningError && issue?.planningStatus !== "planning";

  return (
    <div
      className={`fixed inset-0 z-40 bg-black/35 ${closing ? "animate-fade-out" : "animate-fade-in"}`}
      onClick={handleClose}
    >
      <div
        ref={swipeRef}
        className={`fixed top-0 right-0 z-50 h-full w-full md:w-[520px] lg:w-[600px] bg-base-100 shadow-2xl flex flex-col ${closing ? "animate-slide-out-right" : "animate-slide-in-right"}`}
        onClick={(event) => event.stopPropagation()}
        {...swipeHandlers}
      >
        {/* Header */}
        <div className="px-6 pt-4 pb-0 shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-xs opacity-40 shrink-0">{issue.identifier}</span>
              {issue.baseBranch && (
                <span className="flex items-center gap-0.5 text-[10px] font-mono opacity-40 shrink-0 border border-base-300 rounded px-1 py-0.5">
                  <GitMerge className="size-2.5" />
                  {issue.baseBranch}
                </span>
              )}
              {issue.state !== "Planning" && issue.plan && !["Running", "Reviewing", "Queued"].includes(issue.state) && (
                <button
                  className="btn btn-ghost btn-xs gap-1 opacity-50 hover:opacity-100"
                  onClick={handleReplanFromDrawer}
                  disabled={replanBusy || issue.planningStatus === "planning"}
                  title="Archive current plan and request a new one"
                >
                  {replanBusy ? <Loader className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                  Replan
                </button>
              )}
              {replanError && (
                <span className="text-xs text-error truncate">{replanError}</span>
              )}
            </div>
            <button type="button" className="btn btn-sm btn-ghost btn-circle shrink-0" onClick={handleClose} aria-label="Close">
              <X className="size-4" />
            </button>
          </div>

          <div className="flex items-start gap-2 mb-1">
            <h2 className="text-lg font-bold leading-tight flex-1">{issue.title || "-"}</h2>
            <div className="flex items-center gap-1.5 shrink-0 mt-0.5 flex-wrap justify-end">
              {issue.issueType && ISSUE_TYPE_COLORS[issue.issueType] && (
                <span className={`badge badge-sm ${ISSUE_TYPE_COLORS[issue.issueType]} badge-soft`}>
                  {issue.issueType}
                </span>
              )}
              {(issue.planVersion ?? 0) > 0 && (
                <span className="badge badge-sm badge-info badge-soft font-mono">
                  Plan v{issue.planVersion}
                </span>
              )}
              {(issue.executeAttempt ?? 0) > 0 && (
                <span className="badge badge-sm badge-ghost font-mono opacity-60">
                  exec v{issue.planVersion ?? 1}a{issue.executeAttempt}
                </span>
              )}
            </div>
          </div>

          {/* Description */}
          {issue.description && (
            <p className="text-xs opacity-45 leading-relaxed mb-1 line-clamp-2">{issue.description}</p>
          )}

          {/* Pipeline stepper */}
          <PipelineStepper issue={issue} />

          {/* Tabs — horizontally scrollable on mobile with fade edges */}
          <div className="relative">
            <div
              ref={tabsContainerRef}
              role="tablist"
              className="tabs tabs-lift overflow-x-auto -webkit-overflow-scrolling-touch scrollbar-none"
              style={{ scrollbarWidth: "none" }}
            >
              {getTabs(issue.state).map(({ id, label, icon: Icon }) => (
                <a
                  key={id}
                  role="tab"
                  className={`tab gap-1 text-xs whitespace-nowrap ${tab === id ? "tab-active" : ""} ${id === "review" ? "text-secondary font-semibold" : ""}`}
                  onClick={() => setTab(id)}
                >
                  <Icon className="size-3" />
                  {label}
                  {id === "review" && (issue.state === "Reviewing" || issue.state === "Reviewed") && (
                    <span className="badge badge-xs badge-secondary">!</span>
                  )}
                  {id === "planning" && issue.planningStatus === "planning" && (
                    <span className="loading loading-spinner loading-xs text-info" />
                  )}
                  {id === "planning" && isPendingPlanning && (
                    <span className="loading loading-dots loading-xs text-info opacity-50" />
                  )}
                </a>
              ))}
            </div>
            {/* Fade edges for scroll indication */}
            <div className="absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-base-100 to-transparent pointer-events-none md:hidden" />
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 drawer-safe-bottom">
          <div key={tab} className="animate-fade-in">
            {tab === "overview" && <OverviewTab issue={issue} onStateChange={onStateChange} onRetry={onRetry} onCancel={onCancel} />}
            {tab === "planning" && <PlanningTab issue={issue} onStateChange={onStateChange} workflowConfig={workflowConfig} />}
            {tab === "review" && <ReviewTab issue={issue} issueId={issue.id} onStateChange={onStateChange} />}
            {tab === "execution" && <ExecutionTab issue={issue} workflowConfig={workflowConfig} />}
            {tab === "diff" && <DiffTab issueId={issue.id} />}
            {tab === "routing" && <RoutingTab issue={issue} />}
            {tab === "history" && <HistoryTab issue={issue} />}
            {tab === "events" && <EventsTab issueId={issue.id} events={events} />}
          </div>
        </div>

        {/* Footer — contextual actions based on issue state */}
        <DrawerFooter
          issue={issue}
          onStateChange={onStateChange}
          onMerge={handleMerge}
          onPush={handlePush}
          mergeBusy={mergeBusy}
          mergeError={mergeError}
          mergeNotice={mergeNotice}
          mergeMode={mergeMode}
        />
      </div>
    </div>
  );
}

export default IssueDetailDrawer;
