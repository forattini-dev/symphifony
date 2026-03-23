import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Code, FlaskConical, ThumbsUp, RotateCcw, XCircle, AlertTriangle,
  CheckCircle2, GitMerge, Rocket, Paperclip, Loader,
  ExternalLink, ImageIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api.js";
import { Section } from "../shared.jsx";
import { DiffFileItem, DiffViewer } from "./DiffTab.jsx";

export function ReviewTab({ issue, issueId, onStateChange, onRetry }) {
  const qc = useQueryClient();

  // ── Diff state ──────────────────────────────────────────────────────────────
  const [diffData, setDiffData] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [expandedFile, setExpandedFile] = useState(null);

  // ── Merge preview + git status ──────────────────────────────────────────────
  const [mergePreview, setMergePreview] = useState(null);
  const [gitClean, setGitClean] = useState(null); // null = loading, true = clean, false = dirty

  // ── Test Live state ─────────────────────────────────────────────────────────
  const [tested, setTested] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState(null);

  // ── Evidence images ─────────────────────────────────────────────────────────
  const [reviewImages, setReviewImages] = useState(issue.images ?? []);
  const [imgUploading, setImgUploading] = useState(false);
  const reviewFileRef = useRef(null);

  // ── Rework feedback ─────────────────────────────────────────────────────────
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkNote, setReworkNote] = useState("");

  // ── Approve & Merge ─────────────────────────────────────────────────────────
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState(null);

  // ── Cancel ──────────────────────────────────────────────────────────────────
  const [cancelBusy, setCancelBusy] = useState(false);

  // ── Derived state ───────────────────────────────────────────────────────────
  const isInReview = issue.state === "Reviewing" || issue.state === "PendingDecision";
  const isApproved = issue.state === "Approved";
  const isMergedState = issue.state === "Merged";
  const isMerged = !!issue.mergedAt || isMergedState;
  const mergeResult = issue.mergeResult;

  // ── Fetch diff ──────────────────────────────────────────────────────────────
  const fetchDiff = useCallback(async () => {
    setDiffLoading(true);
    try {
      const res = await api.get(`/diff/${encodeURIComponent(issueId)}`);
      setDiffData(res);
    } catch {
      setDiffData(null);
    } finally {
      setDiffLoading(false);
    }
  }, [issueId]);

  // ── Fetch merge preview ─────────────────────────────────────────────────────
  const fetchMergePreview = useCallback(async () => {
    try {
      const res = await api.get(`/issues/${encodeURIComponent(issueId)}/merge-preview`);
      setMergePreview(res);
    } catch {
      setMergePreview(null);
    }
  }, [issueId]);

  // ── Reset on issue change ───────────────────────────────────────────────────
  useEffect(() => {
    setTested(!!issue.testApplied);
    setDiffData(null);
    setExpandedFile(null);
    setMergePreview(null);
    setGitClean(null);
    setTestError(null);
    setReworkOpen(false);
    setReworkNote("");
    setMergeError(null);
    setReviewImages(issue.images ?? []);
  }, [issueId, issue.testApplied]);

  useEffect(() => { fetchDiff(); }, [fetchDiff]);
  useEffect(() => { fetchMergePreview(); }, [fetchMergePreview]);
  useEffect(() => {
    api.get("/git/status")
      .then((s) => setGitClean(s.isClean !== false))
      .catch(() => setGitClean(null));
  }, [issueId]);

  // ── Paste handler for images ────────────────────────────────────────────────
  const uploadReviewImages = useCallback(async (files) => {
    if (!files.length) return;
    setImgUploading(true);
    try {
      const encoded = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, data: reader.result.split(",")[1], type: file.type });
        reader.onerror = reject;
        reader.readAsDataURL(file);
      })));
      const res = await api.post(`/issues/${encodeURIComponent(issueId)}/images`, { files: encoded });
      if (res.ok && res.paths) setReviewImages((prev) => [...prev, ...res.paths]);
    } catch { /* ignore */ }
    finally {
      setImgUploading(false);
      if (reviewFileRef.current) reviewFileRef.current.value = "";
    }
  }, [issueId]);

  useEffect(() => {
    if (!isInReview) return;
    const handlePaste = (e) => {
      const pastedFiles = Array.from(e.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (pastedFiles.length) uploadReviewImages(pastedFiles);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [isInReview, uploadReviewImages]);

  // ── Diff parsing ────────────────────────────────────────────────────────────
  const files = diffData?.files || [];
  const diff = diffData?.diff || "";
  const diffChunks = {};
  if (diff) {
    for (const chunk of diff.split(/(?=^diff --git )/m)) {
      const m = chunk.match(/^diff --git a\/(.+?) b\//);
      if (m) diffChunks[m[1]] = chunk.split("\n");
    }
  }

  // ── Action handlers ─────────────────────────────────────────────────────────
  const handleTryLive = useCallback(async () => {
    setTestBusy(true);
    setTestError(null);
    try {
      await api.post(`/issues/${encodeURIComponent(issue.id)}/try`);
      setTested(true);
    } catch (err) {
      setTestError(err.message);
    } finally {
      setTestBusy(false);
    }
  }, [issue.id]);

  const handleRevertTry = useCallback(async () => {
    setTestBusy(true);
    setTestError(null);
    try {
      await api.post(`/issues/${encodeURIComponent(issue.id)}/revert-try`);
      setTested(false);
    } catch (err) {
      setTestError(err.message);
    } finally {
      setTestBusy(false);
    }
  }, [issue.id]);

  const handleApproveAndMerge = useCallback(async () => {
    setMergeBusy(true);
    setMergeError(null);
    try {
      await api.post(`/issues/${encodeURIComponent(issue.id)}/approve-and-merge`);
      qc.invalidateQueries({ queryKey: ["runtime-state"] });
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergeBusy(false);
    }
  }, [issue.id, qc]);

  const handleApproveOnly = useCallback(async () => {
    onStateChange?.(issue.id, "Approved");
  }, [issue.id, onStateChange]);

  const handleRework = useCallback(async () => {
    onRetry?.(issue.id, reworkNote || undefined);
    setReworkOpen(false);
    setReworkNote("");
  }, [issue.id, reworkNote, onRetry]);

  const handleCancel = useCallback(async () => {
    setCancelBusy(true);
    try {
      await api.post(`/issues/${encodeURIComponent(issue.id)}/cancel`);
      qc.invalidateQueries({ queryKey: ["runtime-state"] });
    } catch { /* ignore */ }
    finally {
      setCancelBusy(false);
    }
  }, [issue.id, qc]);

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div className="space-y-6">

      {/* ── Status Banners ─────────────────────────────────────────────────── */}

      {isApproved && !isMerged && (!mergeResult || mergeResult.conflicts === 0) && (
        <div className="alert border border-success/30 bg-success/5 text-sm">
          <CheckCircle2 className="size-4 shrink-0 text-success" />
          <span className="font-semibold">Approved — ready to merge</span>
        </div>
      )}

      {isMerged && (
        <div className={`alert border text-sm ${mergeResult?.conflicts > 0 ? "border-warning/30 bg-warning/5" : "border-success/30 bg-success/5"}`}>
          <GitMerge className={`size-4 shrink-0 ${mergeResult?.conflicts > 0 ? "text-warning" : "text-success"}`} />
          <div>
            <span className="font-semibold">Merged</span>
            {mergeResult && (
              <span className="opacity-70"> — {mergeResult.copied} file{mergeResult.copied !== 1 ? "s" : ""} copied{mergeResult.deleted > 0 ? `, ${mergeResult.deleted} deleted` : ""}</span>
            )}
            {mergeResult?.conflicts > 0 && (
              <>
                <p className="text-xs text-warning font-medium mt-0.5">
                  Merge aborted — {mergeResult.conflicts} file{mergeResult.conflicts !== 1 ? "s" : ""} had conflicts.
                </p>
                {mergeResult.conflictFiles?.length > 0 && (
                  <ul className="text-xs text-warning/80 mt-1 ml-4 list-disc space-y-0.5">
                    {mergeResult.conflictFiles.map((f) => (
                      <li key={f} className="font-mono">{f}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {(!mergeResult?.conflicts || mergeResult.conflicts === 0) && (
              <p className="text-xs opacity-50 mt-0.5">The approved branch has been integrated into the current project branch.</p>
            )}
          </div>
        </div>
      )}

      {!isMerged && isApproved && mergeResult?.conflicts > 0 && (
        <div className="alert border border-warning/30 bg-warning/5 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <div className="flex-1">
            <span className="font-semibold">Merge failed due to conflicts</span>
            <p className="text-xs opacity-70 mt-0.5">
              The branch {issue.branchName ? <span className="font-mono">{issue.branchName}</span> : ""} could not be merged — {mergeResult.conflicts} file{mergeResult.conflicts !== 1 ? "s" : ""} diverged.
            </p>
            {mergeResult.conflictFiles?.length > 0 && (
              <ul className="text-xs opacity-60 mt-1 ml-4 list-disc space-y-0.5">
                {mergeResult.conflictFiles.map((f) => (
                  <li key={f} className="font-mono">{f}</li>
                ))}
              </ul>
            )}
            <button
              className="btn btn-xs btn-warning gap-1 mt-2"
              onClick={() => onRetry?.(issue.id)}
            >
              <RotateCcw className="size-3" /> Requeue for Rework
            </button>
          </div>
        </div>
      )}

      {issue.prUrl && (
        <div className="alert border border-primary/30 bg-primary/5 text-sm">
          <ExternalLink className="size-4 shrink-0 text-primary" />
          <div>
            <span className="font-semibold">Pull request created</span>
            <a
              href={issue.prUrl}
              target="_blank"
              rel="noreferrer"
              className="block text-xs text-primary hover:underline mt-0.5 font-mono break-all"
            >
              {issue.prUrl}
            </a>
          </div>
        </div>
      )}


      {/* ── Phase 1: Review Changes ────────────────────────────────────────── */}

      <Section title="Review Changes" icon={Code}>
        {diffLoading ? (
          <div className="flex items-center gap-2 text-sm opacity-50 py-4">
            <span className="loading loading-spinner loading-xs" /> Loading changes...
          </div>
        ) : files.length > 0 ? (
          <div className="space-y-3">
            {/* Diff stats bar */}
            <div className="flex items-center gap-3 text-sm">
              <span className="opacity-60">{files.length} file{files.length !== 1 ? "s" : ""} changed</span>
              <span className="text-success font-mono text-xs">+{diffData?.totalAdditions || 0}</span>
              <span className="text-error font-mono text-xs">-{diffData?.totalDeletions || 0}</span>
            </div>

            {/* File list with expandable diffs */}
            <div className="space-y-1">
              {files.map((file) => (
                <DiffFileItem
                  key={file.path}
                  file={file}
                  isOpen={expandedFile === file.path}
                  onToggle={() => setExpandedFile(expandedFile === file.path ? null : file.path)}
                />
              ))}
            </div>
            {expandedFile && diffChunks[expandedFile] && (
              <div>
                <div className="text-xs font-mono opacity-50 mb-1">{expandedFile}</div>
                <DiffViewer lines={diffChunks[expandedFile]} />
              </div>
            )}

            {/* Merge preview */}
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
          </div>
        ) : (
          <div className="text-sm opacity-40 py-4">No changes detected.</div>
        )}

        {/* Git dirty warning */}
        {gitClean === false && (
          <div className="alert alert-warning text-xs py-2 gap-1.5 mt-3">
            <AlertTriangle className="size-3.5 shrink-0" />
            <span>Project has uncommitted changes — merge and test will fail. Commit or stash them first.</span>
          </div>
        )}

        {/* AI reviewer output */}
        {issue.lastError && (
          <pre className="text-xs bg-error/10 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto mt-3">
            {issue.lastError}
          </pre>
        )}
        {issue.commandOutputTail && !issue.lastError && (
          <pre className="text-xs bg-base-200 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto mt-3">
            {issue.commandOutputTail}
          </pre>
        )}
      </Section>


      {/* ── Phase 2: Test Live (collapsible) ───────────────────────────────── */}

      {isInReview && (
        <div className="collapse collapse-arrow border border-base-300 rounded-box bg-base-100">
          <input type="checkbox" />
          <div className="collapse-title text-sm font-semibold flex items-center gap-1.5 py-3 min-h-0">
            <FlaskConical className="size-4 opacity-50" />
            Optional: Test in your workspace
          </div>
          <div className="collapse-content space-y-4">
            {testError && (
              <div className="alert alert-error text-xs py-2 gap-1.5">
                <AlertTriangle className="size-3.5 shrink-0" /> {testError}
              </div>
            )}

            {!tested ? (
              <div className="space-y-3">
                <p className="text-xs opacity-60">
                  Apply the branch changes to your workspace to test with hot reload before deciding.
                </p>
                <button
                  className="btn btn-info btn-sm btn-soft gap-1.5 w-full"
                  onClick={handleTryLive}
                  disabled={testBusy || gitClean === false}
                  title={gitClean === false ? "Cannot test — working tree has uncommitted changes" : "Apply changes to workspace for testing"}
                >
                  {testBusy ? <Loader className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />}
                  Apply Changes
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="alert alert-info text-xs py-2 gap-1.5">
                  <FlaskConical className="size-3.5 shrink-0" />
                  <span>Changes applied to your dev server. Test them, then decide below.</span>
                </div>
                <button
                  className="btn btn-warning btn-sm btn-soft gap-1.5 w-full"
                  onClick={handleRevertTry}
                  disabled={testBusy}
                >
                  {testBusy ? <Loader className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                  Revert Changes
                </button>
              </div>
            )}

            <div className="h-0" /> {/* spacer — evidence section moved outside isInReview */}
          </div>
        </div>
      )}

      {/* ── Evidence (always visible — not gated by review state) ──────────── */}

      <Section title="Evidence" icon={ImageIcon}>
        <input
          ref={reviewFileRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => uploadReviewImages(Array.from(e.target.files ?? []))}
        />
        {reviewImages.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {reviewImages.map((imgPath, i) => {
              const filename = imgPath.split("/").pop();
              const src = `/api/issues/${encodeURIComponent(issueId)}/images/${encodeURIComponent(filename)}`;
              return (
                <a key={i} href={src} target="_blank" rel="noreferrer" className="block">
                  <img src={src} alt={filename} className="size-20 object-cover rounded-lg border border-base-300 hover:opacity-80 transition-opacity" />
                </a>
              );
            })}
          </div>
        )}
        {reviewImages.length === 0 && (
          <p className="text-xs opacity-40">No screenshots attached. Paste or upload images as evidence.</p>
        )}
        <button
          type="button"
          className="btn btn-xs btn-soft btn-ghost gap-1 mt-2"
          onClick={() => reviewFileRef.current?.click()}
          disabled={imgUploading}
        >
          {imgUploading ? <Loader className="size-3 animate-spin" /> : <Paperclip className="size-3" />}
          Attach Screenshot
        </button>
      </Section>


      {/* ── Phase 3: Decision ──────────────────────────────────────────────── */}

      {isInReview && (
        <Section title="Decision" icon={ThumbsUp}>
          <div className="space-y-4">
            {mergeError && (
              <div className="alert alert-error text-xs py-2 gap-1.5">
                <AlertTriangle className="size-3.5 shrink-0" /> {mergeError}
              </div>
            )}

            {/* Approve & Merge */}
            <button
              className="btn btn-success w-full gap-1.5"
              onClick={handleApproveAndMerge}
              disabled={mergeBusy}
            >
              {mergeBusy ? (
                <Loader className="size-4 animate-spin" />
              ) : tested ? (
                <Rocket className="size-4" />
              ) : (
                <GitMerge className="size-4" />
              )}
              {mergeBusy ? "Merging..." : tested ? "Ship It" : "Approve & Merge"}
            </button>

            {/* Approve Only */}
            <button
              className="btn btn-success btn-outline btn-sm w-full gap-1.5"
              onClick={handleApproveOnly}
            >
              <ThumbsUp className="size-3.5" />
              Approve Only
            </button>

            {/* Request Rework */}
            {!reworkOpen ? (
              <button
                className="btn btn-warning btn-outline btn-sm w-full gap-1.5"
                onClick={() => setReworkOpen(true)}
              >
                <RotateCcw className="size-3.5" />
                Request Rework
              </button>
            ) : (
              <div className="border border-warning/30 rounded-box p-3 space-y-3 bg-warning/5">
                <textarea
                  className="textarea textarea-bordered w-full text-sm"
                  rows={3}
                  placeholder="Describe what needs to change (sent to the agent)..."
                  value={reworkNote}
                  onChange={(e) => setReworkNote(e.target.value)}
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <button
                    className="btn btn-ghost btn-sm flex-1"
                    onClick={() => { setReworkOpen(false); setReworkNote(""); }}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-warning btn-sm flex-1 gap-1.5"
                    onClick={handleRework}
                  >
                    <RotateCcw className="size-3.5" />
                    Send Rework
                  </button>
                </div>
              </div>
            )}

            {/* Cancel Issue */}
            <div className="pt-2 border-t border-base-300">
              <button
                className="btn btn-ghost btn-sm text-error w-full gap-1.5"
                onClick={handleCancel}
                disabled={cancelBusy}
              >
                {cancelBusy ? <Loader className="size-3.5 animate-spin" /> : <XCircle className="size-3.5" />}
                Cancel Issue
              </button>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
