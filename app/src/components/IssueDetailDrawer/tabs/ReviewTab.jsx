import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  GitMerge, GitBranch, CheckCircle2, AlertTriangle, ClipboardCheck,
  Code, Terminal, ThumbsUp, ThumbsDown, RotateCcw, ImageIcon, Paperclip, Loader,
  ExternalLink,
} from "lucide-react";
import { api } from "../../../api.js";
import { Section } from "../shared.jsx";
import { DiffFileItem, DiffViewer } from "./DiffTab.jsx";

export function ReviewTab({ issue, issueId, onStateChange, onRetry }) {
  const [diffData, setDiffData] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState(null);
  const [expandedFile, setExpandedFile] = useState(null);
  const [reviewImages, setReviewImages] = useState(issue.images ?? []);
  const [imgUploading, setImgUploading] = useState(false);
  const reviewFileRef = useRef(null);

  const fetchDiff = useCallback(async () => {
    setDiffLoading(true);
    try {
      const res = await api.get(`/diff/${encodeURIComponent(issueId)}`);
      setDiffData(res);
    } catch { setDiffData(null); }
    finally { setDiffLoading(false); }
  }, [issueId]);

  useEffect(() => { setDiffData(null); setVerdict(null); setNote(""); setExpandedFile(null); setReviewImages(issue.images ?? []); }, [issueId]);
  useEffect(() => { fetchDiff(); }, [fetchDiff]);

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
    } catch {}
    finally {
      setImgUploading(false);
      if (reviewFileRef.current) reviewFileRef.current.value = "";
    }
  }, [issueId]);

  const isInReview = issue.state === "Reviewing" || issue.state === "PendingDecision";
  const isDone = issue.state === "Approved";

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

  const files = diffData?.files || [];
  const diff = diffData?.diff || "";

  // Parse diff into per-file chunks
  const diffChunks = {};
  if (diff) {
    for (const chunk of diff.split(/(?=^diff --git )/m)) {
      const m = chunk.match(/^diff --git a\/(.+?) b\//);
      if (m) diffChunks[m[1]] = chunk.split("\n");
    }
  }

  const handleApprove = () => { setVerdict("approved"); onStateChange?.(issue.id, "Approved"); };
  const handleRework = () => {
    setVerdict("rework");
    onRetry?.(issue.id, note || undefined);
  };
  const handleReject = () => { setVerdict("rejected"); onStateChange?.(issue.id, "Blocked"); };

  const mergeResult = issue.mergeResult;
  const isMerged = !!issue.mergedAt;

  return (
    <div className="space-y-5">
      {/* Merge / approval banner */}
      {isMerged && (
        <div className={`alert border text-sm ${mergeResult?.conflicts > 0 ? "border-warning/30 bg-warning/5" : "border-success/30 bg-success/5"}`}>
          <GitMerge className={`size-4 shrink-0 ${mergeResult?.conflicts > 0 ? "text-warning" : "text-success"}`} />
          <div>
            <span className="font-semibold">Code merged to project root</span>
            {mergeResult && (
              <span className="opacity-70"> — {mergeResult.copied} file{mergeResult.copied !== 1 ? "s" : ""} copied{mergeResult.deleted > 0 ? `, ${mergeResult.deleted} deleted` : ""}</span>
            )}
            {mergeResult?.conflicts > 0 && (
              <>
                <p className="text-xs text-warning font-medium mt-0.5">
                  Merge aborted — {mergeResult.conflicts} file{mergeResult.conflicts !== 1 ? "s" : ""} had conflicts. No changes were applied.
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
      {!isMerged && isDone && mergeResult?.conflicts > 0 && (
        <div className="alert border border-warning/30 bg-warning/5 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <div className="flex-1">
            <span className="font-semibold">Merge failed due to conflicts</span>
            <p className="text-xs opacity-70 mt-0.5">
              The branch {issue.branchName ? <span className="font-mono">{issue.branchName}</span> : ""} could not be merged because {mergeResult.conflicts} file{mergeResult.conflicts !== 1 ? "s" : ""} diverged from the base branch.
              You can send it back for rework so the agent resolves the conflicts.
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
      {!isMerged && isDone && (!mergeResult || mergeResult.conflicts === 0) && (
        <div className="alert border border-info/30 bg-info/5 text-sm">
          <GitBranch className="size-4 shrink-0 text-info" />
          <div>
            <span className="font-semibold">Review approved, merge still pending</span>
            <p className="text-xs opacity-70 mt-0.5">
              The code is still isolated on {issue.branchName ? <span className="font-mono">{issue.branchName}</span> : "the issue branch"} and in the worktree until you run Merge.
            </p>
          </div>
        </div>
      )}

      {/* Status banners */}
      {isDone && (
        <div className="alert alert-success text-sm"><CheckCircle2 className="size-4" /> This issue has been approved.</div>
      )}
      {issue.state === "Blocked" && (
        <div className="alert alert-error text-sm"><AlertTriangle className="size-4" /> Review failed. Check execution output.</div>
      )}
      {verdict === "approved" && isInReview && (
        <div className="alert alert-success text-sm"><ThumbsUp className="size-4" /> Approved! Moving to Approved.</div>
      )}
      {verdict === "rework" && (
        <div className="alert alert-warning text-sm"><RotateCcw className="size-4" /> Sent back for rework.</div>
      )}

      {/* Checklist */}
      {isInReview && !verdict && (
        <Section title="Review Checklist" icon={ClipboardCheck}>
          <div className="space-y-2 text-sm">
            <p className="opacity-60">Before deciding, consider:</p>
            <ul className="list-disc ml-5 space-y-1 opacity-80">
              <li>Does the diff address the issue title and description?</li>
              <li>Are there unintended side effects or regressions?</li>
              <li>Is the scope appropriate — no unnecessary changes?</li>
              <li>Are there files that shouldn't have been modified?</li>
            </ul>
          </div>
        </Section>
      )}

      {/* Changes — GitHub PR style */}
      <Section title="Changes" icon={Code}>
        {diffLoading ? (
          <div className="flex items-center gap-2 text-sm opacity-50 py-4">
            <span className="loading loading-spinner loading-xs" /> Loading changes...
          </div>
        ) : files.length > 0 ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-sm">
              <span className="opacity-60">{files.length} file{files.length !== 1 ? "s" : ""}</span>
              <span className="text-success font-mono text-xs">+{diffData?.totalAdditions || 0}</span>
              <span className="text-error font-mono text-xs">-{diffData?.totalDeletions || 0}</span>
            </div>
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
          </div>
        ) : (
          <div className="text-sm opacity-40 py-4">No changes detected.</div>
        )}
      </Section>

      {/* Agent output context */}
      {(issue.lastError || issue.commandOutputTail) && (
        <Section title="Agent Output" icon={Terminal}>
          {issue.lastError && (
            <pre className="text-xs bg-error/10 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto mb-2">
              {issue.lastError}
            </pre>
          )}
          {issue.commandOutputTail && !issue.lastError && (
            <pre className="text-xs bg-base-200 rounded-box p-3 overflow-x-auto whitespace-pre-wrap max-h-40 overflow-y-auto">
              {issue.commandOutputTail}
            </pre>
          )}
        </Section>
      )}

      {/* Evidence Images */}
      {(isInReview || isDone) && (
        <Section title="Evidence" icon={ImageIcon}>
          <input
            ref={reviewFileRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => uploadReviewImages(Array.from(e.target.files ?? []))}
          />
          {reviewImages.length > 0 ? (
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
          ) : (
            <p className="text-xs opacity-40">No screenshots attached yet.</p>
          )}
          {isInReview && (
            <button
              type="button"
              className="btn btn-xs btn-soft btn-ghost gap-1 mt-2"
              onClick={() => reviewFileRef.current?.click()}
              disabled={imgUploading}
            >
              {imgUploading ? <Loader className="size-3 animate-spin" /> : <Paperclip className="size-3" />}
              Attach Screenshot
            </button>
          )}
        </Section>
      )}

      {/* Note */}
      {isInReview && !verdict && (
        <Section title="Review Note" icon={Terminal}>
          <textarea
            className="textarea textarea-bordered w-full text-sm"
            rows={3}
            placeholder="Describe what needs to change (sent to the agent on Rework)..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Section>
      )}

      {/* Decision buttons */}
      {isInReview && !verdict && (
        <div className="border-t border-base-300 pt-4 space-y-3">
          <div className="text-sm font-semibold">Verdict</div>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-success btn-sm gap-1.5 flex-1" onClick={handleApprove}>
              <ThumbsUp className="size-4" /> Approve
            </button>
            <button className="btn btn-warning btn-sm gap-1.5 flex-1" onClick={handleRework}>
              <RotateCcw className="size-4" /> Request Rework
            </button>
            <button className="btn btn-error btn-sm gap-1.5 flex-1" onClick={handleReject}>
              <ThumbsDown className="size-4" /> Reject
            </button>
          </div>
          <p className="text-xs opacity-40">
            <strong>Approve</strong> moves to Approved. <strong>Rework</strong> sends back to executor. <strong>Reject</strong> blocks the issue.
          </p>
        </div>
      )}
    </div>
  );
}
