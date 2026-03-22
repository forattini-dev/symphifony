import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useRef, useCallback } from "react";
import { api } from "../../api.js";
import { useQueryClient } from "@tanstack/react-query";
import { useSettings, getSettingsList, getSettingValue, SETTINGS_QUERY_KEY, upsertSettingPayload } from "../../hooks";
import { PROJECT_SETTING_ID, buildQueueTitle, normalizeProjectName, resolveProjectMeta } from "../../project-meta.js";
import {
  FolderRoot,
  GitMerge,
  GitPullRequest,
  Flame,
  Loader2,
  CheckCircle,
  PencilLine,
  Radio,
  ShieldCheck,
  FlaskConical,
  GitBranch,
} from "lucide-react";

const PROTECTED_BRANCHES = new Set(["main", "master"]);

export const Route = createFileRoute("/settings/project")({
  component: ProjectSettings,
});

function ProjectSettings() {
  const qc = useQueryClient();
  const settingsQuery = useSettings();
  const settings = getSettingsList(settingsQuery.data);
  const [hydrated, setHydrated] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectSource, setProjectSource] = useState("missing");
  const [mergeMode, setMergeMode] = useState("local");
  const [prBaseBranch, setPrBaseBranch] = useState("");
  const [autoReviewApproval, setAutoReviewApproval] = useState(true);
  const [testCommand, setTestCommand] = useState("");

  const [gitStatus, setGitStatus] = useState(null);
  const [currentBranch, setCurrentBranch] = useState("");
  const [loadingGit, setLoadingGit] = useState(true);
  const [editingBranch, setEditingBranch] = useState(false);
  const [branchInput, setBranchInput] = useState("");
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState(null);
  const [branchResult, setBranchResult] = useState(null);
  const [initBusy, setInitBusy] = useState(false);
  const [initError, setInitError] = useState(null);

  const [savingProject, setSavingProject] = useState(false);
  const [savingDelivery, setSavingDelivery] = useState(false);
  const [savingValidation, setSavingValidation] = useState(false);
  const [savingBranch, setSavingBranch] = useState(false);
  const [validationMessage, setValidationMessage] = useState("");

  const runtimeMetaRef = useRef(null);

  const normalizedProjectName = normalizeProjectName(projectName);
  const queueTitle = buildQueueTitle(normalizedProjectName || runtimeMetaRef.current?.detectedProjectName || runtimeMetaRef.current?.projectName);

  const persistSetting = useCallback((id, value, scope) => {
    qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, {
      id,
      scope,
      value,
      source: "user",
      updatedAt: new Date().toISOString(),
    }));
  }, [qc]);

  useEffect(() => {
    setLoadingGit(true);
    Promise.allSettled([
      api.get("/state"),
      api.get("/git/status"),
    ]).then(([stateResult, gitResult]) => {
      const state = stateResult.status === "fulfilled" ? stateResult.value : null;
      if (state && typeof state === "object") {
        runtimeMetaRef.current = state;
        const detected = normalizeProjectName(state.detectedProjectName || "");
        if (!currentBranch && (state.config?.defaultBranch || detected)) {
          setCurrentBranch(state.config?.defaultBranch || detected);
        }
      }

      if (gitResult.status === "fulfilled" && gitResult.value) {
        setGitStatus(gitResult.value);
        if (gitResult.value.branch && !currentBranch) {
          setCurrentBranch(gitResult.value.branch);
        }
      }
    }).finally(() => {
      setLoadingGit(false);
    });
  }, []);

  useEffect(() => {
    if (hydrated || settingsQuery.isLoading) return;
    setHydrated(true);

    const nextMergeMode = getSettingValue(settings, "runtime.mergeMode", "local");
    if (nextMergeMode === "local" || nextMergeMode === "push-pr") {
      setMergeMode(nextMergeMode);
    }

    const nextPrBaseBranch = getSettingValue(settings, "runtime.prBaseBranch", "");
    if (typeof nextPrBaseBranch === "string") {
      setPrBaseBranch(nextPrBaseBranch);
    }

    const nextAutoReviewApproval = getSettingValue(settings, "runtime.autoReviewApproval", true);
    if (typeof nextAutoReviewApproval === "boolean") {
      setAutoReviewApproval(nextAutoReviewApproval);
    }

    const nextTestCommand = getSettingValue(settings, "runtime.testCommand", "");
    if (typeof nextTestCommand === "string") {
      setTestCommand(nextTestCommand);
    }

    const projectMeta = resolveProjectMeta(settings, runtimeMetaRef.current || {});
    setProjectName(projectMeta.projectName || "");
    setProjectSource(projectMeta.source);

    if (!prBaseBranch && projectMeta.projectName) {
      setPrBaseBranch(projectMeta.detectedProjectName || currentBranch || nextPrBaseBranch || "");
    }
  }, [settings, settingsQuery.isLoading, hydrated]);

  const rehydrateGit = useCallback(async () => {
    setLoadingGit(true);
    try {
      const [state, status] = await Promise.all([
        api.get("/state"),
        api.get("/git/status"),
      ]);
      runtimeMetaRef.current = state;
      if (state?.config?.defaultBranch) {
        setCurrentBranch(state.config.defaultBranch);
      }
      if (status) {
        setGitStatus(status);
        if (status.branch) {
          setCurrentBranch(status.branch);
        }
      }
    } finally {
      setLoadingGit(false);
    }
  }, []);

  const saveProjectName = useCallback(async () => {
    const normalized = normalizeProjectName(projectName);
    if (!normalized) {
      setValidationMessage("Project name cannot be empty.");
      return;
    }

    setSavingProject(true);
    setValidationMessage("");
    try {
      await api.post(`/settings/${encodeURIComponent(PROJECT_SETTING_ID)}`, {
        scope: "system",
        value: normalized,
        source: "user",
      });
      persistSetting(PROJECT_SETTING_ID, normalized, "system");
      setProjectName(normalized);
      setValidationMessage("Project name updated.");
      setTimeout(() => setValidationMessage(""), 1400);
    } finally {
      setSavingProject(false);
    }
  }, [projectName, persistSetting]);

  const saveDeliveryConfig = useCallback(async () => {
    setSavingDelivery(true);
    setValidationMessage("");
    try {
      await api.post(`/settings/${encodeURIComponent("runtime.mergeMode")}`, {
        scope: "runtime",
        value: mergeMode,
        source: "user",
      });
      persistSetting("runtime.mergeMode", mergeMode, "runtime");

      await api.post(`/settings/${encodeURIComponent("runtime.prBaseBranch")}`, {
        scope: "runtime",
        value: prBaseBranch.trim(),
        source: "user",
      });
      persistSetting("runtime.prBaseBranch", prBaseBranch.trim(), "runtime");

      await api.post(`/settings/${encodeURIComponent("runtime.autoReviewApproval")}`, {
        scope: "runtime",
        value: autoReviewApproval,
        source: "user",
      });
      persistSetting("runtime.autoReviewApproval", autoReviewApproval, "runtime");

      setValidationMessage("Delivery settings updated.");
      setTimeout(() => setValidationMessage(""), 1400);
    } finally {
      setSavingDelivery(false);
    }
  }, [autoReviewApproval, mergeMode, prBaseBranch, persistSetting]);

  const saveTestConfig = useCallback(async () => {
    setSavingValidation(true);
    setValidationMessage("");
    try {
      await api.post(`/settings/${encodeURIComponent("runtime.testCommand")}`, {
        scope: "runtime",
        value: testCommand.trim(),
        source: "user",
      });
      persistSetting("runtime.testCommand", testCommand.trim(), "runtime");
      setValidationMessage("Validation command updated.");
      setTimeout(() => setValidationMessage(""), 1400);
    } finally {
      setSavingValidation(false);
    }
  }, [testCommand, persistSetting]);

  const startBranchEdit = useCallback(() => {
    setEditingBranch(true);
    setBranchInput(currentBranch || "");
    setBranchError(null);
    setBranchResult(null);
  }, [currentBranch]);

  const saveBranch = useCallback(async () => {
    const trimmedInput = branchInput.trim();
    const isValidInput = /^[a-zA-Z0-9/_.-]+$/.test(trimmedInput) && trimmedInput.length > 0;
    if (!isValidInput || trimmedInput === currentBranch) return;

    setBranchBusy(true);
    setSavingBranch(true);
    setBranchError(null);
    try {
      const res = await api.post("/git/switch", { branchName: trimmedInput });
      if (!res?.ok) throw new Error(res?.error || "Failed to switch branch.");
      setCurrentBranch(trimmedInput);
      setBranchResult({ branch: trimmedInput, created: !!res.created });
      setEditingBranch(false);
      setSavingBranch(false);
      if (!prBaseBranch && mergeMode === "push-pr") {
        setPrBaseBranch(trimmedInput);
      }
      if (!mergeMode) {
        setMergeMode("local");
      }
      await rehydrateGit();
      if (!mergeMode && prBaseBranch === "") {
        setPrBaseBranch(trimmedInput);
      }
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : String(err));
      setSavingBranch(false);
    } finally {
      setBranchBusy(false);
    }
  }, [branchInput, currentBranch, mergeMode, prBaseBranch, rehydrateGit]);

  const initGitRepository = useCallback(async () => {
    setInitBusy(true);
    setInitError(null);
    try {
      const res = await api.post("/git/init", {});
      if (!res?.ok) throw new Error(res?.error || "Failed to initialize git.");
      await rehydrateGit();
    } catch (err) {
      setInitError(err instanceof Error ? err.message : String(err));
    } finally {
      setInitBusy(false);
    }
  }, [rehydrateGit]);

  const isGit = gitStatus === null || gitStatus.isGit;
  const hasCommits = gitStatus?.hasCommits === true;
  const isProtected = currentBranch && PROTECTED_BRANCHES.has(currentBranch);

  return (
    <div className="space-y-4">
      <div className="card bg-base-200">
        <div className="card-body gap-4 p-6">
          <div className="flex items-center gap-2">
            <FolderRoot className="size-4 opacity-50" />
            <h2 className="card-title text-sm">Project settings</h2>
          </div>
          <p className="text-xs opacity-50">Match your workspace identity and queue naming.</p>

          <label className="form-control w-full gap-2">
            <span className="label-text text-sm font-medium">Project name</span>
            <input
              type="text"
              className="input input-bordered w-full"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name"
            />
          </label>

          <div className="rounded-xl border border-base-300/70 bg-base-100 px-4 py-3">
            <div className="text-xs uppercase tracking-[0.2em] text-base-content/40">Queue title preview</div>
            <div className="mt-1.5 text-base font-semibold tracking-tight break-words">{queueTitle || "fifony"}</div>
          </div>

          <div className="flex gap-2 items-center">
            <button className="btn btn-sm btn-primary" onClick={saveProjectName} disabled={savingProject || !normalizeProjectName(projectName)}>
              {savingProject ? <Loader2 className="size-3 animate-spin" /> : "Save project name"}
            </button>
            <span className="text-xs opacity-50">Source: {projectSource}</span>
          </div>
        </div>
      </div>

      <div className="card bg-base-200">
        <div className="card-body gap-4 p-6">
          <div className="flex items-center gap-2">
            <Radio className="size-4 opacity-50" />
            <h2 className="card-title text-sm">Working branch</h2>
          </div>
          <p className="text-xs opacity-50">Where issue worktrees are created from. Local operations use this branch.</p>

          {loadingGit && (
            <div className="text-xs text-base-content/60 flex items-center gap-2">
              <Loader2 className="size-3 animate-spin" />
              Loading git status...
            </div>
          )}

          {!loadingGit && !isGit && (
            <div className="flex flex-col gap-3">
              <div className="alert alert-warning py-3">
                <GitMerge className="size-4 shrink-0" />
                <div className="text-sm">
                  <p className="font-semibold">Not a git repository</p>
                  <p className="opacity-80 mt-0.5">fifony requires git and an initial commit to create agent worktrees.</p>
                </div>
              </div>
              <button className="btn btn-primary gap-2 self-start" onClick={initGitRepository} disabled={initBusy}>
                {initBusy ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
                Initialize git repository
              </button>
              {initError && <p className="text-xs text-error">{initError}</p>}
            </div>
          )}

          {(!loadingGit && isGit && !hasCommits) && (
            <div className="flex flex-col gap-3">
              <div className="alert alert-warning py-3">
                <Flame className="size-4 shrink-0" />
                <div className="text-sm">
                  <p className="font-semibold">Repository has no commits yet</p>
                  <p className="opacity-80 mt-0.5">Create an initial commit before agent worktrees can be prepared.</p>
                </div>
              </div>
              <button className="btn btn-primary gap-2 self-start" onClick={initGitRepository} disabled={initBusy}>
                {initBusy ? <Loader2 className="size-4 animate-spin" /> : <GitMerge className="size-4" />}
                Create initial commit
              </button>
            </div>
          )}

          {isGit && (
            <>
              {editingBranch ? (
                <div className="flex gap-2">
                  <label className="input input-bordered flex items-center gap-2 flex-1">
                    <GitBranch className="size-3.5 opacity-40" />
                    <input
                      type="text"
                      className="grow font-mono text-sm"
                      value={branchInput}
                      onChange={(e) => setBranchInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveBranch();
                        if (e.key === "Escape") setEditingBranch(false);
                      }}
                      disabled={branchBusy}
                    />
                  </label>
                  <button className="btn btn-primary" onClick={saveBranch} disabled={branchBusy || !branchInput.trim()}>
                    {branchBusy ? <Loader2 className="size-3 animate-spin" /> : "Switch"}
                  </button>
                  <button className="btn btn-ghost" onClick={() => setEditingBranch(false)} disabled={branchBusy}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div
                  className="rounded-box border border-base-300 bg-base-100 px-4 py-3 cursor-pointer hover:border-primary/40 transition-colors group"
                  onClick={startBranchEdit}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && startBranchEdit()}
                >
                  <div className="flex items-center gap-2">
                    <GitBranch className="size-4 opacity-50 shrink-0" />
                    <span className="text-sm opacity-60">Current branch:</span>
                    <span className="font-mono text-sm font-semibold">{currentBranch || "—"}</span>
                    {isProtected && <span className="badge badge-warning badge-sm ml-auto shrink-0">protected</span>}
                    {!editingBranch && <PencilLine className="size-3.5 opacity-0 group-hover:opacity-40 ml-auto shrink-0 transition-opacity" />}
                  </div>
                </div>
              )}

              {branchError && <p className="text-xs text-error">{branchError}</p>}
              {branchResult && (
                <div className="alert alert-success py-2 text-xs">
                  <CheckCircle className="size-3 shrink-0" />
                  {branchResult.created ? "Branch created" : "Branch switched"}: <span className="font-mono">{branchResult.branch}</span>
                </div>
              )}

              {isProtected && (
                <p className="text-xs text-warning">
                  You are on a protected branch. If needed, switch to another branch before running local merges.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card bg-base-200">
        <div className="card-body gap-4 p-6">
          <div className="flex items-center gap-2">
            <GitPullRequest className="size-4 opacity-50" />
            <h2 className="card-title text-sm">Delivery mode</h2>
          </div>
          <p className="text-xs opacity-50">Pick how completed issues are integrated.</p>

          <div className="flex gap-3">
            <label className={`flex-1 cursor-pointer rounded-xl border-2 p-3 text-center text-sm font-medium transition-colors ${mergeMode === "local" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}>
              <input type="radio" name="settings-merge-mode" className="hidden" checked={mergeMode === "local"} onChange={() => setMergeMode("local")} />
              <GitMerge className="size-4 mx-auto mb-1 opacity-60" />
              Local merge
            </label>
            <label className={`flex-1 cursor-pointer rounded-xl border-2 p-3 text-center text-sm font-medium transition-colors ${mergeMode === "push-pr" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}>
              <input type="radio" name="settings-merge-mode" className="hidden" checked={mergeMode === "push-pr"} onChange={() => setMergeMode("push-pr")} />
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
              <p className="text-xs opacity-40">Branch that PRs target.</p>
            </label>
          )}

          <label className="label cursor-pointer justify-start gap-3">
            <input
              type="checkbox"
              className="toggle toggle-sm toggle-primary"
              checked={autoReviewApproval}
              onChange={(e) => setAutoReviewApproval(e.target.checked)}
            />
            <span className="label-text text-sm">Automatic review approval</span>
          </label>
          <p className="text-xs opacity-50">{autoReviewApproval ? "Reviewer success marks issue done." : "Reviewer success requires manual decision."}</p>

          <button className="btn btn-sm btn-primary" onClick={saveDeliveryConfig} disabled={savingDelivery}>
            {savingDelivery ? <Loader2 className="size-3 animate-spin" /> : "Save delivery settings"}
          </button>
        </div>
      </div>

      <div className="card bg-base-200">
        <div className="card-body gap-4 p-6">
          <div className="flex items-center gap-2">
            <FlaskConical className="size-4 opacity-50" />
            <h2 className="card-title text-sm">Validation command</h2>
          </div>
          <p className="text-xs opacity-50">Runs before issue completion and merge/done.</p>
          <input
            type="text"
            className="input input-bordered w-full text-sm font-mono"
            placeholder="pnpm test"
            value={testCommand}
            onChange={(e) => setTestCommand(e.target.value)}
          />
          <button className="btn btn-sm btn-primary" onClick={saveTestConfig} disabled={savingValidation}>
            {savingValidation ? <Loader2 className="size-3 animate-spin" /> : "Save validation command"}
          </button>
        </div>
      </div>

      {validationMessage && (
        <div className="alert alert-success py-2 text-xs">
          <ShieldCheck className="size-3" /> {validationMessage}
        </div>
      )}

      <div className="text-xs text-base-content/40">
        <p>These settings mirror the onboarding setup. Use Workflow for pipeline, Agents for catalog installs, and Preferences for workers/theme.</p>
      </div>
    </div>
  );
}
