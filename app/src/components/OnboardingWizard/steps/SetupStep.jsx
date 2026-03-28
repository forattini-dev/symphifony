import { useState, useEffect } from "react";
import {
  FolderRoot, GitBranch, AlertTriangle, CheckCircle, Loader,
  ShieldCheck, Loader2, Sparkles, PencilLine, GitMerge, FlaskConical, GitPullRequest,
} from "lucide-react";
import { api } from "../../../api";
import { buildQueueTitle, normalizeProjectName } from "../../../project-meta.js";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

function GitignoreBanner() {
  const [status, setStatus] = useState(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    api.get("/gitignore/status")
      .then(setStatus)
      .catch(() => setStatus({ exists: false, hasFifony: false }));
  }, []);

  if (status === null || status.hasFifony) return null;

  if (added) {
    return (
      <div className="alert alert-success py-2.5 text-sm animate-fade-in">
        <ShieldCheck className="size-4 shrink-0" />
        <span><code>.fifony/</code> adicionado ao <code>.gitignore</code></span>
      </div>
    );
  }

  return (
    <div className="alert alert-warning py-2.5 text-sm">
      <ShieldCheck className="size-4 shrink-0" />
      <div className="flex-1">
        <span><code>.fifony/</code> não está no <code>.gitignore</code></span>
        <span className="text-base-content/50 block text-xs mt-0.5">O fifony guarda estado local lá — não deve ser commitado.</span>
      </div>
      <button
        className="btn btn-xs btn-warning"
        onClick={async () => {
          setAdding(true);
          try { await api.post("/gitignore/add"); setAdded(true); } catch { /* not critical */ }
          finally { setAdding(false); }
        }}
        disabled={adding}
      >
        {adding ? <Loader2 className="size-3 animate-spin" /> : "Adicionar"}
      </button>
    </div>
  );
}

function BranchCard({ currentBranch, onBranchCreated, onGitStatusChange }) {
  // Git status
  const [gitStatus, setGitStatus] = useState(null); // null = loading
  const [initBusy, setInitBusy] = useState(false);
  const [initError, setInitError] = useState(null);
  const [activeBranch, setActiveBranch] = useState(currentBranch);

  useEffect(() => {
    api.get("/git/status")
      .then((data) => {
        setGitStatus(data);
        if (data.branch) setActiveBranch(data.branch);
      })
      .catch(() => setGitStatus({ isGit: false, branch: currentBranch || null, hasCommits: false }));
  }, []);

  useEffect(() => {
    onGitStatusChange?.(gitStatus);
  }, [gitStatus, onGitStatusChange]);

  // Branch switch/create
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [branchError, setBranchError] = useState(null);
  const [switchResult, setSwitchResult] = useState(null); // { branch, created }

  const isGit = gitStatus === null || gitStatus.isGit;
  const hasCommits = gitStatus?.hasCommits ?? false;
  const isProtected = PROTECTED_BRANCHES.has(activeBranch);
  const trimmedInput = inputValue.trim();
  const isValidInput = /^[a-zA-Z0-9/_.-]+$/.test(trimmedInput) && trimmedInput.length > 0;
  const isSameBranch = trimmedInput === activeBranch;

  function startEditing() {
    setEditing(true);
    setInputValue(activeBranch || "");
    setBranchError(null);
    setSwitchResult(null);
  }

  async function handleSwitch() {
    if (!isValidInput || isSameBranch || busy) return;
    setBusy(true);
    setBranchError(null);
    try {
      const res = await api.post("/git/switch", { branchName: trimmedInput });
      if (!res.ok) throw new Error(res.error || "Failed to switch branch.");
      setActiveBranch(trimmedInput);
      setSwitchResult({ branch: trimmedInput, created: res.created });
      setEditing(false);
      onBranchCreated?.(trimmedInput);
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleGitInit() {
    setInitBusy(true);
    setInitError(null);
    try {
      const res = await api.post("/git/init", {});
      if (!res.ok) throw new Error(res.error || "Failed to initialize git.");
      setGitStatus({ isGit: Boolean(res.isGit ?? true), branch: res.branch || null, hasCommits: Boolean(res.hasCommits ?? true) });
      setActiveBranch(res.branch || activeBranch);
    } catch (err) {
      setInitError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitBusy(false);
    }
  }

  return (
    <div className="bg-base-200 rounded-2xl p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <GitBranch className="size-4 text-primary" />
        <div className="text-sm font-semibold">Working branch</div>
      </div>
      <p className="text-xs text-base-content/50 -mt-2">
        Agents create worktrees based on the current branch. We recommend not working directly on main.
      </p>

      {/* Not a git repo */}
      {gitStatus !== null && !gitStatus.isGit && (
        <div className="flex flex-col gap-3">
          <div className="alert alert-warning py-3">
            <GitMerge className="size-4 shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">Not a git repository</p>
              <p className="opacity-80 mt-0.5">fifony requires git and an initial commit to create agent worktrees. Initialize it here to continue.</p>
            </div>
          </div>
          {initError && (
            <p className="text-xs text-error flex items-center gap-1">
              <AlertTriangle className="size-3" /> {initError}
            </p>
          )}
          <button className="btn btn-primary gap-2 self-start" onClick={handleGitInit} disabled={initBusy}>
            {initBusy ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
            Initialize git repository
          </button>
        </div>
      )}

      {gitStatus !== null && gitStatus.isGit && !hasCommits && (
        <div className="flex flex-col gap-3">
          <div className="alert alert-warning py-3">
            <GitMerge className="size-4 shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">Repository has no commits yet</p>
              <p className="opacity-80 mt-0.5">fifony needs one initial commit before it can create per-issue git worktrees. Create it here to continue.</p>
            </div>
          </div>
          {initError && (
            <p className="text-xs text-error flex items-center gap-1">
              <AlertTriangle className="size-3" /> {initError}
            </p>
          )}
          <button className="btn btn-primary gap-2 self-start" onClick={handleGitInit} disabled={initBusy}>
            {initBusy ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
            Create initial commit
          </button>
        </div>
      )}

      {/* Untracked files warning — merge will fail if working tree is dirty */}
      {gitStatus?.isGit && gitStatus?.hasCommits && gitStatus?.isClean === false && (
        <div className="alert alert-info py-3 text-sm">
          <AlertTriangle className="size-4 shrink-0" />
          <div>
            <p className="font-semibold">Working tree has uncommitted changes</p>
            <p className="opacity-80 mt-0.5">
              {gitStatus.untrackedCount > 0
                ? `${gitStatus.untrackedCount} untracked file${gitStatus.untrackedCount > 1 ? "s" : ""} found. `
                : ""}
              Commit or stash your changes before merging issues — fifony requires a clean working tree to merge agent work.
            </p>
          </div>
        </div>
      )}

      {/* Git initialized */}
      {isGit && (
        <div className="flex flex-col gap-4">
          {/* Current branch — editable */}
          {editing ? (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <label className="input input-bordered flex items-center gap-2 flex-1">
                  <GitBranch className="size-3.5 opacity-40" />
                  <input
                    type="text"
                    className="grow font-mono text-sm"
                    value={inputValue}
                    onChange={(e) => { setInputValue(e.target.value); setBranchError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSwitch();
                      if (e.key === "Escape") { setEditing(false); setBranchError(null); }
                    }}
                    placeholder="develop"
                    autoFocus
                    disabled={busy}
                  />
                </label>
                <button
                  className="btn btn-primary"
                  onClick={handleSwitch}
                  disabled={!isValidInput || isSameBranch || busy}
                >
                  {busy ? <Loader className="size-4 animate-spin" /> : "Switch"}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => { setEditing(false); setBranchError(null); }}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
              {branchError && (
                <p className="text-xs text-error flex items-center gap-1">
                  <AlertTriangle className="size-3" /> {branchError}
                </p>
              )}
              <p className="text-xs opacity-40">
                Switches to the branch if it exists, or creates it from the current HEAD.
              </p>
            </div>
          ) : (
            <div
              className="flex items-center gap-2 px-4 py-3 rounded-box border border-base-300 bg-base-100 cursor-pointer hover:border-primary/40 transition-colors group"
              onClick={startEditing}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === "Enter" && startEditing()}
            >
              <GitBranch className="size-4 opacity-50 shrink-0" />
              <span className="text-sm opacity-50">Current branch:</span>
              <span className="font-mono text-sm font-semibold">
                {activeBranch || (gitStatus === null ? "…" : "—")}
              </span>
              {isProtected && (
                <span className="badge badge-warning badge-sm ml-auto shrink-0">protected</span>
              )}
              {!isProtected && (
                <PencilLine className="size-3.5 opacity-0 group-hover:opacity-40 ml-auto shrink-0 transition-opacity" />
              )}
            </div>
          )}

          {/* Switch result feedback */}
          {switchResult && (
            <div className="alert alert-success py-3 text-sm animate-fade-in">
              <CheckCircle className="size-4 shrink-0" />
              <div>
                <p className="font-semibold">
                  {switchResult.created ? "Branch created" : "Switched to branch"}
                </p>
                <p className="opacity-75 font-mono mt-0.5">
                  Now on <span className="text-success-content">{switchResult.branch}</span> — agents will use this as the base branch
                </p>
              </div>
            </div>
          )}

          {isProtected && !editing && (
            <div className="alert alert-warning py-3">
              <AlertTriangle className="size-4 shrink-0" />
              <div className="text-sm">
                <p className="font-semibold">Working directly on <span className="font-mono">{activeBranch}</span></p>
                <p className="opacity-80 mt-0.5">In teams with protected branches, local merges are rejected. Click the branch above to switch, or use Push PR mode.</p>
              </div>
            </div>
          )}

          <GitignoreBanner />
        </div>
      )}
    </div>
  );
}

function MergeModeCard({ mergeMode, setMergeMode, prBaseBranch, setPrBaseBranch, currentBranch }) {
  return (
    <div className="bg-base-200 rounded-2xl p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <GitPullRequest className="size-4 text-primary" />
        <div className="text-sm font-semibold">Merge mode</div>
      </div>
      <p className="text-xs text-base-content/50 -mt-2">
        Choose how completed issues are integrated: local git merge or push a PR to GitHub.
      </p>
      <div className="flex gap-3">
        <label className={`flex-1 cursor-pointer rounded-xl border-2 p-3 text-center text-sm font-medium transition-colors ${mergeMode === "local" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}>
          <input type="radio" name="mergeMode" className="hidden" checked={mergeMode === "local"} onChange={() => setMergeMode("local")} />
          <GitMerge className="size-4 mx-auto mb-1 opacity-60" />
          Local merge
        </label>
        <label className={`flex-1 cursor-pointer rounded-xl border-2 p-3 text-center text-sm font-medium transition-colors ${mergeMode === "push-pr" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}>
          <input type="radio" name="mergeMode" className="hidden" checked={mergeMode === "push-pr"} onChange={() => setMergeMode("push-pr")} />
          <GitPullRequest className="size-4 mx-auto mb-1 opacity-60" />
          Push PR
        </label>
      </div>
      {mergeMode === "push-pr" && (
        <label className="form-control w-full gap-2">
          <span className="label-text text-sm font-medium">PR base branch</span>
          <input
            type="text"
            className="input input-bordered w-full text-sm font-mono"
            placeholder={currentBranch || "main"}
            value={prBaseBranch}
            onChange={(e) => setPrBaseBranch(e.target.value)}
          />
          <p className="text-xs opacity-40">Branch that PRs will target. Defaults to the current branch.</p>
        </label>
      )}
    </div>
  );
}

function TestCommandCard({ testCommand, setTestCommand }) {
  const hasCommand = Boolean(testCommand?.trim());

  return (
    <div className="bg-base-200 rounded-2xl p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <FlaskConical className="size-4 text-primary" />
        <div className="text-sm font-semibold">Validation gate</div>
      </div>
      <p className="text-xs text-base-content/50 -mt-2">
        This command runs <strong>after every execution</strong>, before the AI review starts.
        If it fails, the issue is retried automatically — bad code never reaches the review phase.
      </p>
      <input
        type="text"
        className="input input-bordered w-full text-sm font-mono"
        placeholder="pnpm test"
        value={testCommand}
        onChange={(e) => setTestCommand(e.target.value)}
      />
      <p className="text-xs text-base-content/40">
        For monorepos (pnpm/yarn/npm workspaces), Spark automatically scopes tests to
        affected packages only — no need for <code className="opacity-60">turbo</code> or full-suite runs.
      </p>

      {!hasCommand && (
        <div className="alert alert-warning py-3 text-sm">
          <AlertTriangle className="size-4 shrink-0" />
          <div>
            <p className="font-semibold">No safety net configured</p>
            <p className="opacity-80 mt-0.5">
              Without a test command, Spark cannot validate that agent changes actually work.
              Issues will skip the validation gate entirely — if you enable automatic merge,
              broken code could be merged into your branch without any checks.
            </p>
            <p className="opacity-60 mt-1.5 text-xs">
              You can always add a test command later in Settings &rarr; Workflow.
            </p>
          </div>
        </div>
      )}

      {hasCommand && (
        <div className="alert alert-success py-2.5 text-sm">
          <ShieldCheck className="size-4 shrink-0" />
          <span>Validation gate active — every execution will be tested before review.</span>
        </div>
      )}
    </div>
  );
}

function ReviewApprovalCard({ autoReviewApproval, setAutoReviewApproval }) {
  return (
    <div className="bg-base-200 rounded-2xl p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-primary" />
        <div className="text-sm font-semibold">Review completion</div>
      </div>
      <p className="text-xs text-base-content/50 -mt-2">
        Control whether completed reviews move issues directly to Done or require manual confirmation.
      </p>
      <label className="label cursor-pointer justify-start gap-3">
        <input
          type="checkbox"
          className="toggle toggle-sm toggle-primary"
          checked={autoReviewApproval}
          onChange={(e) => setAutoReviewApproval(e.target.checked)}
        />
        <span className="label-text text-sm">Automatic review approval</span>
      </label>
      <p className="text-xs text-base-content/50">
        {autoReviewApproval
          ? "Checked: issues move to Approved when the reviewer succeeds, or when no reviewer is configured."
          : "Unchecked: issues stop in Pending Decision and require manual approval action."
        }
      </p>
    </div>
  );
}

function MergeOptionsCard({ autoCommitBeforeMerge, setAutoCommitBeforeMerge, autoResolveConflicts, setAutoResolveConflicts }) {
  return (
    <div className="bg-base-200 rounded-2xl p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <GitMerge className="size-4 text-primary" />
        <div className="text-sm font-semibold">Merge behavior</div>
      </div>
      <p className="text-xs text-base-content/50 -mt-2">
        Control how fifony handles merge blockers automatically.
      </p>
      <label className="label cursor-pointer justify-start gap-3">
        <input
          type="checkbox"
          className="toggle toggle-sm toggle-primary"
          checked={autoCommitBeforeMerge}
          onChange={(e) => setAutoCommitBeforeMerge(e.target.checked)}
        />
        <div>
          <span className="label-text text-sm">Auto-commit before merge</span>
          <p className="text-xs text-base-content/50 mt-0.5">
            {autoCommitBeforeMerge
              ? "Uncommitted changes are committed automatically so merges aren't blocked."
              : "Merge will fail if there are uncommitted changes — issues move to Blocked."}
          </p>
        </div>
      </label>
      <label className="label cursor-pointer justify-start gap-3">
        <input
          type="checkbox"
          className="toggle toggle-sm toggle-primary"
          checked={autoResolveConflicts}
          onChange={(e) => setAutoResolveConflicts(e.target.checked)}
        />
        <div>
          <span className="label-text text-sm">Auto-resolve merge conflicts</span>
          <p className="text-xs text-base-content/50 mt-0.5">
            {autoResolveConflicts
              ? "An agent is spawned to resolve conflicts automatically when a merge collides."
              : "Merge conflicts block the issue — you must resolve them manually."}
          </p>
        </div>
      </label>
    </div>
  );
}

function SetupStep({
  projectName, setProjectName,
  detectedProjectName, projectSource, workspacePath,
  currentBranch, onGitStatusChange, onBranchCreated,
  mergeMode, setMergeMode, prBaseBranch, setPrBaseBranch,
  autoReviewApproval, setAutoReviewApproval,
  testCommand, setTestCommand,
  autoCommitBeforeMerge, setAutoCommitBeforeMerge,
  autoResolveConflicts, setAutoResolveConflicts,
}) {
  const normalizedProjectName = normalizeProjectName(projectName);
  const queueTitle = buildQueueTitle(normalizedProjectName || detectedProjectName);

  const effectiveSource = normalizedProjectName
    ? projectSource === "saved" || projectSource === "detected" ? projectSource : "manual"
    : detectedProjectName ? "detected" : "missing";

  return (
    <div className="flex flex-col gap-6 py-4">
      <div className="text-center space-y-3">
        <div className="inline-flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary mx-auto">
          <FolderRoot className="size-7" />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">Set up your workspace</h2>
          <p className="text-base-content/60 max-w-xl mx-auto text-sm">
            Name your project and configure the working branch
          </p>
        </div>
      </div>

      {/* Project name card */}
      <div className="bg-base-200 rounded-2xl p-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">Project name</div>
            <div className="text-xs text-base-content/50">This becomes the default queue title for future runs.</div>
          </div>
          {effectiveSource === "saved" && (
            <span className="badge badge-primary badge-soft gap-1.5"><Sparkles className="size-3" />Saved configuration</span>
          )}
          {effectiveSource === "detected" && (
            <span className="badge badge-secondary badge-soft gap-1.5"><Sparkles className="size-3" />Detected automatically</span>
          )}
          {effectiveSource === "manual" && (
            <span className="badge badge-accent badge-soft gap-1.5"><PencilLine className="size-3" />Edited manually</span>
          )}
          {effectiveSource === "missing" && (
            <span className="badge badge-warning badge-soft gap-1.5"><AlertTriangle className="size-3" />Manual entry required</span>
          )}
        </div>

        <label className="form-control w-full gap-2">
          <span className="label-text text-sm font-medium">Project</span>
          <input
            type="text"
            className="input input-bordered w-full text-base"
            placeholder={detectedProjectName || "Enter your project name"}
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            onBlur={(e) => {
              const nextValue = normalizeProjectName(e.target.value);
              if (nextValue !== projectName) setProjectName(nextValue);
            }}
          />
        </label>

        {workspacePath && (
          <div className="text-xs text-base-content/50 break-all">Workspace: {workspacePath}</div>
        )}

        {!detectedProjectName && !normalizedProjectName && (
          <div className="alert alert-warning text-sm">
            <AlertTriangle className="size-4 shrink-0" />
            <span>We could not detect a project name from the current directory. Enter one to continue.</span>
          </div>
        )}

        <div className="rounded-xl border border-base-300/70 bg-base-100 px-4 py-3">
          <div className="text-xs uppercase tracking-[0.2em] text-base-content/40">Queue title preview</div>
          <div className="mt-1.5 text-base font-semibold tracking-tight break-words">{queueTitle}</div>
        </div>
      </div>

      <BranchCard currentBranch={currentBranch} onGitStatusChange={onGitStatusChange} onBranchCreated={onBranchCreated} />
      <MergeModeCard mergeMode={mergeMode} setMergeMode={setMergeMode} prBaseBranch={prBaseBranch} setPrBaseBranch={setPrBaseBranch} currentBranch={currentBranch} />
      <ReviewApprovalCard autoReviewApproval={autoReviewApproval} setAutoReviewApproval={setAutoReviewApproval} />
      <MergeOptionsCard autoCommitBeforeMerge={autoCommitBeforeMerge} setAutoCommitBeforeMerge={setAutoCommitBeforeMerge} autoResolveConflicts={autoResolveConflicts} setAutoResolveConflicts={setAutoResolveConflicts} />
      <TestCommandCard testCommand={testCommand} setTestCommand={setTestCommand} />
    </div>
  );
}

export default SetupStep;
