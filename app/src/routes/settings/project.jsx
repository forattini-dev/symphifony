import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useRef, useCallback } from "react";
import { api } from "../../api.js";
import { useQueryClient } from "@tanstack/react-query";
import { useSettings, getSettingsList, getSettingValue, SETTINGS_QUERY_KEY, upsertSettingPayload } from "../../hooks";
import { PROJECT_SETTING_ID, normalizeProjectName, resolveProjectMeta } from "../../project-meta.js";
import {
  FolderRoot,
  GitMerge,
  GitPullRequest,
  Flame,
  Loader2,
  CheckCircle,
  Check,
  PencilLine,
  Radio,
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
  const [mergeMode, setMergeMode] = useState("local");
  const [prBaseBranch, setPrBaseBranch] = useState("");

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

  // Auto-save indicators
  const [projectSaved, setProjectSaved] = useState(false);
  const [deliverySaved, setDeliverySaved] = useState(false);
  const autoSaveProjectTimer = useRef(null);
  const autoSaveDeliveryTimer = useRef(null);

  const runtimeMetaRef = useRef(null);


  const persistSetting = useCallback((id, value, scope) => {
    qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, {
      id,
      scope,
      value,
      source: "user",
      updatedAt: new Date().toISOString(),
    }));
  }, [qc]);

  useEffect(() => () => {
    if (autoSaveProjectTimer.current) clearTimeout(autoSaveProjectTimer.current);
    if (autoSaveDeliveryTimer.current) clearTimeout(autoSaveDeliveryTimer.current);
  }, []);

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

    const projectMeta = resolveProjectMeta(settings, runtimeMetaRef.current || {});
    setProjectName(projectMeta.projectName || "");

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

  const flash = useCallback((setter) => {
    setter(true);
    setTimeout(() => setter(false), 1400);
  }, []);

  const autoSaveProjectName = useCallback((name) => {
    if (autoSaveProjectTimer.current) clearTimeout(autoSaveProjectTimer.current);
    const normalized = normalizeProjectName(name);
    if (!normalized) return;
    autoSaveProjectTimer.current = setTimeout(async () => {
      try {
        await api.post(`/settings/${encodeURIComponent(PROJECT_SETTING_ID)}`, {
          scope: "system",
          value: normalized,
          source: "user",
        });
        persistSetting(PROJECT_SETTING_ID, normalized, "system");
        flash(setProjectSaved);
      } catch {}
    }, 600);
  }, [persistSetting, flash]);

  const autoSaveDelivery = useCallback((mode, baseBranch) => {
    if (autoSaveDeliveryTimer.current) clearTimeout(autoSaveDeliveryTimer.current);
    autoSaveDeliveryTimer.current = setTimeout(async () => {
      try {
        await api.post(`/settings/${encodeURIComponent("runtime.mergeMode")}`, {
          scope: "runtime",
          value: mode,
          source: "user",
        });
        persistSetting("runtime.mergeMode", mode, "runtime");

        await api.post(`/settings/${encodeURIComponent("runtime.prBaseBranch")}`, {
          scope: "runtime",
          value: baseBranch.trim(),
          source: "user",
        });
        persistSetting("runtime.prBaseBranch", baseBranch.trim(), "runtime");
        flash(setDeliverySaved);
      } catch {}
    }, 600);
  }, [persistSetting, flash]);

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
    setBranchError(null);
    try {
      const res = await api.post("/git/switch", { branchName: trimmedInput });
      if (!res?.ok) throw new Error(res?.error || "Failed to switch branch.");
      setCurrentBranch(trimmedInput);
      setBranchResult({ branch: trimmedInput, created: !!res.created });
      setEditingBranch(false);
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
            <span className="label-text text-sm font-medium flex items-center gap-2">
              Project name
              {projectSaved && <span className="badge badge-success badge-xs gap-1 font-normal"><Check className="size-3" /> saved</span>}
            </span>
            <input
              type="text"
              className="input input-bordered w-full"
              value={projectName}
              onChange={(e) => { setProjectName(e.target.value); autoSaveProjectName(e.target.value); }}
              placeholder="Project name"
            />
          </label>
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
            {deliverySaved && <span className="badge badge-success badge-xs gap-1 font-normal"><Check className="size-3" /> saved</span>}
          </div>
          <p className="text-xs opacity-50">Pick how completed issues are integrated.</p>

          <div className="flex flex-col sm:flex-row gap-3">
            <label className={`flex-1 cursor-pointer rounded-xl border-2 p-3 text-center text-sm font-medium transition-colors ${mergeMode === "local" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}>
              <input type="radio" name="settings-merge-mode" className="hidden" checked={mergeMode === "local"} onChange={() => { setMergeMode("local"); autoSaveDelivery("local", prBaseBranch); }} />
              <GitMerge className="size-4 mx-auto mb-1 opacity-60" />
              Local merge
            </label>
            <label className={`flex-1 cursor-pointer rounded-xl border-2 p-3 text-center text-sm font-medium transition-colors ${mergeMode === "push-pr" ? "border-primary bg-primary/10" : "border-base-300 bg-base-100"}`}>
              <input type="radio" name="settings-merge-mode" className="hidden" checked={mergeMode === "push-pr"} onChange={() => { setMergeMode("push-pr"); autoSaveDelivery("push-pr", prBaseBranch); }} />
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
                onChange={(e) => { setPrBaseBranch(e.target.value); autoSaveDelivery(mergeMode, e.target.value); }}
              />
              <p className="text-xs opacity-40">Branch that PRs target.</p>
            </label>
          )}
        </div>
      </div>

    </div>
  );
}
