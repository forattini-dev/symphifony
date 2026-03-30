import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  X, AlertTriangle, Loader, RotateCcw, PlayCircle, GitMerge,
  GitPullRequest, Trash2, MessageSquare,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { DrawerBackdrop } from "../DrawerPrimitives.jsx";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.js";
import { useSwipeToDismiss } from "../../hooks/useSwipeToDismiss.js";
import { useWorkflowConfig } from "../../hooks/useWorkflowConfig.js";
import {
  ISSUE_DRAWER_TABS,
  ISSUE_TYPE_COLORS,
  getDefaultIssueDrawerTab,
} from "./constants.js";
import { PipelineStepper } from "./PipelineStepper.jsx";
import { StateActionMenu } from "./StateActionMenu.jsx";
import { OverviewTab } from "./tabs/OverviewTab.jsx";
import { ExecutionTab } from "./tabs/ExecutionTab.jsx";
import { DiffTab } from "./tabs/DiffTab.jsx";
import { RoutingTab } from "./tabs/RoutingTab.jsx";
import { EventsTab } from "./tabs/EventsTab.jsx";
import { PlanningTab } from "./tabs/PlanningTab.jsx";
import { ReviewTab } from "./tabs/ReviewTab.jsx";
import { SessionsTab } from "./tabs/SessionsTab.jsx";

// ── DrawerFooter ─────────────────────────────────────────────────────────────

function DrawerFooter({ issue, onStateChange, onRetry, onMerge, onPush, onReplan, replanBusy, mergeBusy, mergeError, mergeNotice, mergeMode }) {
  const footerStyle = { paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)" };
  const qc = useQueryClient();
  const [executeBusy, setExecuteBusy] = useState(false);
  const [executeError, setExecuteError] = useState(null);

  const handleExecute = useCallback(async () => {
    setExecuteBusy(true);
    setExecuteError(null);
    try {
      const res = await api.post(`/issues/${encodeURIComponent(issue.id)}/execute`);
      if (!res.ok) throw new Error(res.error || "Execute failed.");
      qc.invalidateQueries({ queryKey: ["runtime-state"] });
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuteBusy(false);
    }
  }, [issue.id, qc]);

  const isPlanning = issue.state === "Planning";
  const isPlanned = issue.state === "PendingApproval";
  const isRunning = issue.state === "Running" || issue.state === "Queued";
  const isInReview = issue.state === "Reviewing" || issue.state === "PendingDecision";
  const isDone = issue.state === "Approved";
  const isMergedState = issue.state === "Merged";
  const isMerged = !!issue.mergedAt || isMergedState;

  // Hooks must be called unconditionally (Rules of Hooks)
  const [gitClean, setGitClean] = useState(null);
  useEffect(() => {
    if (!isDone || isMerged) return;
    api.get("/git/status").then((s) => setGitClean(s.isClean !== false)).catch(() => setGitClean(null));
  }, [isDone, isMerged]);

  if (isPlanning) return null;

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
          {executeError && (
            <button
              className="btn btn-ghost btn-sm gap-1.5"
              onClick={onReplan}
              disabled={replanBusy}
              title="Re-run planning to fix the issue"
            >
              {replanBusy ? <Loader className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              Replan
            </button>
          )}
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

  if (isInReview) return null;

  if (isDone && !isMerged) {
    const isPushPr = mergeMode === "push-pr";
    return (
      <div className="px-6 py-3 border-t border-base-300 shrink-0 space-y-2" style={footerStyle}>
        {gitClean === false && (
          <div className="alert alert-warning text-xs py-1.5">
            <AlertTriangle className="size-3.5" />
            <span>Project has uncommitted changes — merge will fail. Commit or stash them first.</span>
          </div>
        )}
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

export function IssueDetailDrawer({ issue, onClose, onStateChange, onRetry, onCancel, onDelete, events, mergeMode, tabRef }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState("overview");
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState(null);
  const [mergeNotice, setMergeNotice] = useState(null);
  const [replanBusy, setReplanBusy] = useState(false);
  const [replanError, setReplanError] = useState(null);
  const navigate = useNavigate();
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

  const handleExecuteFromDrawer = useCallback(async () => {
    if (!issue?.id) return;
    try {
      const res = await api.post(`/issues/${encodeURIComponent(issue.id)}/execute`);
      if (!res.ok) throw new Error(res.error || "Execute failed.");
      qc.invalidateQueries({ queryKey: ["runtime-state"] });
    } catch { /* footer handles errors for its own execute button */ }
  }, [issue?.id, qc]);

  const handleDeleteFromDrawer = useCallback(() => {
    if (!issue?.id) return;
    onDelete?.(issue.id);
    handleClose();
  }, [issue?.id, onDelete]);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setVisible(false); setClosing(false); onClose(); }, 250);
  }, [onClose]);

  const { ref: swipeRef, handlers: swipeHandlers } = useSwipeToDismiss({ onDismiss: handleClose, direction: "right" });

  // Initialize the most relevant tab when switching issues.
  useEffect(() => {
    if (issue) {
      setTab(getDefaultIssueDrawerTab(issue.state));
    }
  }, [issue?.id]);

  // Expose tab get/set to parent via ref for keyboard shortcuts
  useEffect(() => {
    if (tabRef) {
      tabRef.current = { get: () => tab, set: (t) => setTab(t) };
    }
  }, [tabRef, tab]);

  useEffect(() => {
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
      const conflictNames = Array.isArray(res?.conflicts) ? res.conflicts : [];
      if (conflicts > 0) {
        setMergeError(`Merge aborted — ${conflicts} conflict${conflicts !== 1 ? "s" : ""}: ${conflictNames.join(", ")}`);
      } else {
        setMergeNotice(`Merged ${mergedFiles} file${mergedFiles !== 1 ? "s" : ""} into the project.`);
        qc.invalidateQueries({ queryKey: ["runtime-state"] });
      }
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergeBusy(false);
    }
  }, [issue?.id, mergeBusy, qc]);

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
      qc.invalidateQueries({ queryKey: ["runtime-state"] });
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergeBusy(false);
    }
  }, [issue?.id, mergeBusy]);

  // Auto-scroll active tab into view
  useEffect(() => {
    if (!tabsContainerRef.current) return;
    const active = tabsContainerRef.current.querySelector(".tab-active");
    active?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [tab]);

  if (!issue && !visible) return null;
  if (!issue) return null;
  const displayIssue = issue;
  const isPendingPlanning = issue?.state === "Planning" && !issue?.plan && !issue?.planningError && issue?.planningStatus !== "planning";

  return (
    <div>
      <DrawerBackdrop
        onClick={handleClose}
        className={closing ? "animate-fade-out" : "animate-fade-in"}
      />
      <div
        ref={swipeRef}
        className={`fixed top-0 right-0 z-50 h-full w-full md:w-[40vw] md:min-w-[520px] lg:min-w-[600px] bg-base-100 shadow-2xl flex flex-col ${closing ? "animate-slide-out-right" : "animate-slide-in-right"}`}
        onClick={(event) => event.stopPropagation()}
        {...swipeHandlers}
      >
        {/* Header */}
        <div className="px-6 pt-4 pb-0 shrink-0">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-xs opacity-40 shrink-0">{issue.identifier}</span>
              <StateActionMenu
                issue={issue}
                onStateChange={onStateChange}
                onRetry={onRetry}
                onCancel={onCancel}
                onReplan={handleReplanFromDrawer}
                onExecute={handleExecuteFromDrawer}
              />
              {issue.baseBranch && (
                <span className="flex items-center gap-0.5 text-[10px] font-mono opacity-40 shrink-0 border border-base-300 rounded px-1 py-0.5">
                  <GitMerge className="size-2.5" />
                  {issue.baseBranch}
                </span>
              )}
              {replanError && (
                <span className="text-xs text-error truncate">{replanError}</span>
              )}
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <button
                type="button"
                className="btn btn-sm btn-ghost btn-circle opacity-40 hover:opacity-80"
                onClick={() => { onClose?.(); navigate({ to: `/chat/${issue.id}` }); }}
                aria-label="Chat about issue"
                title="Chat about this issue"
              >
                <MessageSquare className="size-3.5" />
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost btn-circle text-error/40 hover:text-error hover:bg-error/10"
                onClick={handleDeleteFromDrawer}
                disabled={issue.state === "Running" || issue.state === "Reviewing"}
                aria-label="Delete issue"
                title="Delete issue permanently"
              >
                <Trash2 className="size-3.5" />
              </button>
              <button type="button" className="btn btn-sm btn-ghost btn-circle shrink-0" onClick={handleClose} aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
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
              className="tabs tabs-lift overflow-x-auto flex-nowrap -webkit-overflow-scrolling-touch scrollbar-none"
              style={{ scrollbarWidth: "none" }}
            >
              {ISSUE_DRAWER_TABS.map(({ id, label, icon: Icon, color, activeColor }) => {
                const isActive = tab === id;
                const iconColor = isActive ? activeColor.replace("tab-active ", "") : color;
                return (
                  <a
                    key={id}
                    role="tab"
                    className={`tab gap-1 text-xs whitespace-nowrap ${isActive ? activeColor : color} ${isActive ? "font-semibold" : ""}`}
                    onClick={() => setTab(id)}
                  >
                    <Icon className={`size-3 ${iconColor}`} />
                    {label}
                    {id === "review" && (issue.state === "Reviewing" || issue.state === "PendingDecision") && (
                      <span className="badge badge-xs badge-secondary">!</span>
                    )}
                    {id === "planning" && issue.planningStatus === "planning" && (
                      <span className="loading loading-spinner loading-xs text-info" />
                    )}
                    {id === "planning" && isPendingPlanning && (
                      <span className="loading loading-dots loading-xs text-info opacity-50" />
                    )}
                  </a>
                );
              })}
            </div>
            {/* Fade edges for scroll indication */}
            <div className="absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-base-100 to-transparent pointer-events-none md:hidden" />
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0 drawer-safe-bottom">
          <div key={tab} className="animate-fade-in">
            {tab === "overview" && <OverviewTab issue={issue} />}
            {tab === "planning" && <PlanningTab issue={issue} onStateChange={onStateChange} workflowConfig={workflowConfig} />}
            {tab === "review" && <ReviewTab issue={issue} issueId={issue.id} onStateChange={onStateChange} onRetry={onRetry} />}
            {tab === "execution" && <ExecutionTab issue={issue} workflowConfig={workflowConfig} />}
            {tab === "diff" && <DiffTab issueId={issue.id} />}
            {tab === "sessions" && <SessionsTab issueId={issue.id} />}
            {tab === "routing" && <RoutingTab issue={issue} />}
            {tab === "events" && <EventsTab issueId={issue.id} events={events} />}
          </div>
        </div>

        {/* Footer — contextual actions based on issue state */}
        <DrawerFooter
          issue={issue}
          onStateChange={onStateChange}
          onRetry={onRetry}
          onReplan={handleReplanFromDrawer}
          replanBusy={replanBusy}
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
