import React, { useState, useEffect, useCallback } from "react";
import {
  X, GitMerge, RotateCcw, Copy, Check, AlertTriangle, Loader,
  FlaskConical, Undo2, Terminal, CheckCircle2, GitPullRequest,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.js";

const FILE_STATUS_BADGE = {
  added: "badge-success",
  removed: "badge-error",
  modified: "badge-info",
};

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button className="btn btn-xs btn-ghost shrink-0" onClick={handleCopy} title="Copy to clipboard">
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
    </button>
  );
}

function CmdLine({ cmd }) {
  return (
    <div className="flex items-center gap-1 bg-base-300 rounded px-2 py-1">
      <span className="font-mono text-xs flex-1 select-all">{cmd}</span>
      <CopyBtn text={cmd} />
    </div>
  );
}

export function PreviewModal({ issue, onClose }) {
  const qc = useQueryClient();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);

  // "tested" = git merge --squash was applied to TARGET_ROOT
  const [tested, setTested] = useState(false);

  // null | "merge" | "rollback"
  const [confirming, setConfirming] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const [showCmds, setShowCmds] = useState(false);
  const [mergePreview, setMergePreview] = useState(null);

  const fetchMergePreview = useCallback(async () => {
    try {
      const res = await api.get(`/issues/${encodeURIComponent(issue.id)}/merge-preview`);
      setMergePreview(res);
    } catch {
      setMergePreview(null);
    }
  }, [issue.id]);

  useEffect(() => { fetchMergePreview(); }, [fetchMergePreview]);

  const fetchDiff = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await api.get(`/diff/${encodeURIComponent(issue.id)}`);
      setData(res);
    } catch (err) {
      setFetchError(err.message);
    } finally {
      setLoading(false);
    }
  }, [issue.id]);

  useEffect(() => { fetchDiff(); }, [fetchDiff]);

  const handleTryLive = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await api.post(`/issues/${encodeURIComponent(issue.id)}/try`);
      setTested(true);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionBusy(false);
    }
  }, [issue.id]);

  const handleRevertTry = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await api.post(`/issues/${encodeURIComponent(issue.id)}/revert-try`);
      setTested(false);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setActionBusy(false);
    }
  }, [issue.id]);

  const handleMerge = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await api.post(`/issues/${encodeURIComponent(issue.id)}/merge`);
      qc.invalidateQueries({ queryKey: ["runtime-state"] });
      onClose();
    } catch (err) {
      setActionError(err.message);
      setActionBusy(false);
    }
  }, [issue.id, qc, onClose]);

  const handleRollback = useCallback(async () => {
    setActionBusy(true);
    setActionError(null);
    try {
      await api.post(`/issues/${encodeURIComponent(issue.id)}/rollback`);
      qc.invalidateQueries({ queryKey: ["runtime-state"] });
      onClose();
    } catch (err) {
      setActionError(err.message);
      setActionBusy(false);
    }
  }, [issue.id, qc, onClose]);

  const worktreePath = issue.worktreePath ?? issue.workspacePath ?? "";
  const branchName = issue.branchName ?? `fifony/${issue.id}`;
  const baseBranch = issue.baseBranch ?? "main";
  const { files = [], totalAdditions = 0, totalDeletions = 0, message } = data ?? {};

  // Manual git commands the dev can run in their terminal
  const cmdTest = `git merge --squash ${branchName}`;
  const cmdRevert = `git reset --hard HEAD && git clean -fd`;
  const cmdAccept = `git commit -m "feat: merge ${branchName}"`;
  const cmdInspect = `git diff ${baseBranch}...${branchName}`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-base-100 rounded-box shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-base-300 shrink-0">
          <div className="min-w-0">
            <div className="text-xs opacity-40 font-mono">{issue.identifier}</div>
            <div className="font-semibold text-sm truncate">{issue.title}</div>
          </div>
          <button className="btn btn-sm btn-ghost btn-circle shrink-0 ml-3" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">

          {/* Worktree path */}
          {worktreePath && (
            <div className="bg-base-200 rounded-box px-3 py-2 flex items-center gap-2">
              <span className="text-xs opacity-50 shrink-0">Worktree</span>
              <span className="font-mono text-xs truncate flex-1">{worktreePath}</span>
              <CopyBtn text={worktreePath} />
            </div>
          )}

          {/* Branch info */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs bg-base-200 px-2 py-0.5 rounded">{branchName}</span>
            <GitMerge className="size-3.5 opacity-40 shrink-0" />
            <span className="font-mono text-xs bg-base-200 px-2 py-0.5 rounded">{baseBranch}</span>
          </div>

          {/* Pre-merge conflict detection */}
          {mergePreview?.willConflict && (
            <div className="alert alert-warning text-xs py-2 gap-1.5">
              <AlertTriangle className="size-3.5 shrink-0" />
              <div>
                <span className="font-semibold">Merge will conflict</span>
                <span className="opacity-70"> — {mergePreview.conflictFiles.length} file{mergePreview.conflictFiles.length !== 1 ? "s" : ""}</span>
                {mergePreview.conflictFiles.length > 0 && (
                  <ul className="mt-1 ml-4 list-disc space-y-0.5 font-mono opacity-80">
                    {mergePreview.conflictFiles.map((f) => <li key={f}>{f}</li>)}
                  </ul>
                )}
              </div>
            </div>
          )}
          {mergePreview && !mergePreview.willConflict && (
            <div className="alert alert-success text-xs py-2 gap-1.5">
              <CheckCircle2 className="size-3.5 shrink-0" />
              <span>Merge is clean — no conflicts detected.</span>
            </div>
          )}

          {/* Test Live banner */}
          {tested && (
            <div className="alert alert-info text-xs py-2 gap-1.5">
              <FlaskConical className="size-3.5 shrink-0" />
              <span>
                Squash test applied to your workspace — your server rebuilt with the changes.
                Review then accept or revert it.
              </span>
            </div>
          )}

          {/* Diff loading / error / content */}
          {loading && (
            <div className="flex items-center gap-2 text-sm opacity-50 py-6 justify-center">
              <span className="loading loading-spinner loading-sm" /> Loading changes...
            </div>
          )}

          {fetchError && !loading && (
            <div className="text-sm text-error">{fetchError}</div>
          )}

          {data && !loading && (
            <>
              {/* Stats bar */}
              <div className="flex items-center gap-3 text-sm">
                <span className="opacity-60">{files.length} file{files.length !== 1 ? "s" : ""} changed</span>
                <span className="text-success font-mono text-xs">+{totalAdditions}</span>
                <span className="text-error font-mono text-xs">-{totalDeletions}</span>
              </div>

              {/* File list */}
              {files.length > 0 ? (
                <div className="space-y-0.5 max-h-[22vh] overflow-y-auto rounded-box border border-base-300 p-1">
                  {files.map((file) => (
                    <div key={file.path} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-base-200 transition-colors">
                      <span className={`badge badge-xs shrink-0 ${FILE_STATUS_BADGE[file.status] || "badge-ghost"}`}>
                        {file.status}
                      </span>
                      <span className="font-mono text-xs truncate flex-1">{file.path}</span>
                      <span className="text-xs text-success shrink-0">+{file.additions}</span>
                      <span className="text-xs text-error shrink-0">-{file.deletions}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm opacity-40 text-center py-4">{message || "No changes detected."}</div>
              )}
            </>
          )}

          {/* Manual git commands (collapsible) */}
          <div className="border border-base-300 rounded-box overflow-hidden">
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs opacity-60 hover:opacity-100 hover:bg-base-200 transition-colors"
              onClick={() => setShowCmds((v) => !v)}
            >
              <Terminal className="size-3.5 shrink-0" />
              <span className="flex-1">Comandos manuais</span>
              <span className="text-[10px] opacity-50">{showCmds ? "▲" : "▼"}</span>
            </button>
            {showCmds && (
              <div className="px-3 pb-3 space-y-2 border-t border-base-300 pt-2">
                <div className="space-y-1">
                  <div className="text-[10px] opacity-50 uppercase tracking-wide">Inspect only</div>
                  <CmdLine cmd={cmdInspect} />
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] opacity-50 uppercase tracking-wide">Test with hot reload (no commit)</div>
                  <CmdLine cmd={cmdTest} />
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] opacity-50 uppercase tracking-wide">Revert test</div>
                  <CmdLine cmd={cmdRevert} />
                </div>
                <div className="space-y-1">
                  <div className="text-[10px] opacity-50 uppercase tracking-wide">Accept manually</div>
                  <CmdLine cmd={cmdAccept} />
                </div>
              </div>
            )}
          </div>

          {/* Action error */}
          {actionError && (
            <div className="alert alert-error text-xs py-2 gap-1.5">
              <AlertTriangle className="size-3.5 shrink-0" /> {actionError}
            </div>
          )}

          {/* Confirmation inline panel */}
          {confirming && (
            <div className="border border-base-300 rounded-box p-4 space-y-3 bg-base-200">
              {confirming === "merge" ? (
                <p className="text-sm">
                  You are about to merge into{" "}
                  <span className="font-mono font-semibold">{baseBranch}</span>.
                  The worktree and branch will be removed after merge.
                </p>
              ) : (
                <p className="text-sm">
                  You are about to discard all changes from this issue.
                  The worktree and branch will be removed permanently.
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-sm btn-ghost flex-1"
                  onClick={() => setConfirming(null)}
                  disabled={actionBusy}
                >
                  Cancel
                </button>
                <button
                  className={`btn btn-sm flex-1 ${confirming === "merge" ? "btn-success" : "btn-error"}`}
                  onClick={confirming === "merge" ? handleMerge : handleRollback}
                  disabled={actionBusy}
                >
                  {actionBusy
                    ? <Loader className="size-4 animate-spin" />
                    : confirming === "merge"
                      ? "Confirm merge"
                      : "Confirm rollback"
                  }
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer actions */}
        {!confirming && (
          <div className="px-5 py-4 border-t border-base-300 shrink-0 space-y-2">
              {/* Test Live row */}
              {!tested ? (
                <button
                  className="btn btn-sm btn-info btn-soft gap-1.5 w-full"
                  onClick={handleTryLive}
                  disabled={actionBusy || !issue.branchName}
                  title="Run git merge --squash on your workspace to test with hot reload without committing"
                >
                {actionBusy ? <Loader className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
                Test Live
              </button>
            ) : (
              <button
                className="btn btn-sm btn-warning btn-soft gap-1.5 w-full"
                onClick={handleRevertTry}
                disabled={actionBusy}
                title="git reset --hard HEAD && git clean -fd"
              >
                {actionBusy ? <Loader className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
                Revert Test
              </button>
            )}

            {/* Approve / Reject row */}
            <div className="flex items-center gap-2">
              <button
                className="btn btn-sm btn-error btn-soft gap-1.5 flex-1"
                onClick={() => { setConfirming("rollback"); setActionError(null); }}
                disabled={actionBusy}
              >
                <RotateCcw className="size-3.5" /> Reject & Rollback
              </button>
              <button
                className={`btn btn-sm gap-1.5 flex-1 ${mergePreview?.willConflict ? "btn-warning" : "btn-success"}`}
                onClick={() => { setConfirming("merge"); setActionError(null); }}
                disabled={actionBusy}
              >
                <GitMerge className="size-3.5" /> {mergePreview?.willConflict ? "Merge (conflicts expected)" : "Approve & Merge"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
