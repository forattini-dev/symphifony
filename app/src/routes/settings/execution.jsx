import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.js";
import { useSettings, getSettingsList, getSettingValue, SETTINGS_QUERY_KEY, upsertSettingPayload } from "../../hooks.js";
import { SettingsSection } from "../../components/SettingsSection.jsx";
import { QualitySettingsPanel } from "./quality.jsx";
import {
  Container, Cpu, FlaskConical, GitMerge, Check, Loader2, AlertTriangle, ShieldCheck,
} from "lucide-react";

export const Route = createFileRoute("/settings/execution")({
  component: ExecutionSettings,
});

function ExecutionSettings() {
  const qc = useQueryClient();
  const settingsQuery = useSettings();
  const settings = getSettingsList(settingsQuery.data);
  const [hydrated, setHydrated] = useState(false);

  // ── State ──────────────────────────────────────────────────────────────────
  const [dockerExecution, setDockerExecution] = useState(false);
  const [dockerImage, setDockerImage] = useState("fifony-agent:latest");
  const [sandboxExecution, setSandboxExecution] = useState(false);
  const [concurrency, setConcurrency] = useState("3");
  const [testCommand, setTestCommand] = useState("");
  const [autoReviewApproval, setAutoReviewApproval] = useState(true);
  const [autoApproveTrivialPlans, setAutoApproveTrivialPlans] = useState(true);
  const [maxTurns, setMaxTurns] = useState(4);
  const [autoCommitBeforeMerge, setAutoCommitBeforeMerge] = useState(true);
  const [autoResolveConflicts, setAutoResolveConflicts] = useState(false);

  // Saved indicators
  const [sandboxSaved, setSandboxSaved] = useState(false);
  const [concurrencySaved, setConcurrencySaved] = useState(false);
  const [testSaved, setTestSaved] = useState(false);
  const [approveSaved, setApproveSaved] = useState(false);
  const [trivialPlansSaved, setTrivialPlansSaved] = useState(false);
  const [turnsSaved, setTurnsSaved] = useState(false);
  const [autoCommitSaved, setAutoCommitSaved] = useState(false);
  const [autoResolveSaved, setAutoResolveSaved] = useState(false);

  // ── Debounce timers ────────────────────────────────────────────────────────
  const sandboxTimer = useRef(null);
  const concurrencyTimer = useRef(null);
  const testTimer = useRef(null);
  const approveTimer = useRef(null);
  const trivialPlansTimer = useRef(null);
  const turnsTimer = useRef(null);
  const autoCommitTimer = useRef(null);
  const autoResolveTimer = useRef(null);

  // Current value refs (avoid stale closures in timers)
  const sandboxRef = useRef({ docker: false, image: "fifony-agent:latest", aiJail: false });
  const concurrencyRef = useRef("3");
  const testRef = useRef("");
  const approveRef = useRef(true);
  const trivialPlansRef = useRef(true);
  const turnsRef = useRef(4);
  const autoCommitRef = useRef(true);
  const autoResolveRef = useRef(false);

  // ── Hydration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (hydrated || !settings?.length) return;
    const docker = getSettingValue(settings, "runtime.dockerExecution", false);
    const image = getSettingValue(settings, "runtime.dockerImage", "fifony-agent:latest") || "fifony-agent:latest";
    const aiJail = getSettingValue(settings, "runtime.sandboxExecution", false);
    const conc = String(getSettingValue(settings, "runtime.workerConcurrency", 3));
    const test = getSettingValue(settings, "runtime.testCommand", "") || "";
    const approve = getSettingValue(settings, "runtime.autoReviewApproval", true);
    const trivialPlans = getSettingValue(settings, "runtime.autoApproveTrivialPlans", true);
    const turns = getSettingValue(settings, "runtime.maxTurns", 4);
    setDockerExecution(docker);
    setDockerImage(image);
    setSandboxExecution(aiJail);
    setConcurrency(conc);
    setTestCommand(test);
    const commitMerge = getSettingValue(settings, "runtime.autoCommitBeforeMerge", true);
    const resolveConf = getSettingValue(settings, "runtime.autoResolveConflicts", false);
    setAutoReviewApproval(approve);
    setAutoApproveTrivialPlans(trivialPlans);
    setMaxTurns(turns);
    setAutoCommitBeforeMerge(commitMerge);
    setAutoResolveConflicts(resolveConf);
    sandboxRef.current = { docker, image, aiJail };
    concurrencyRef.current = conc;
    testRef.current = test;
    approveRef.current = approve;
    trivialPlansRef.current = trivialPlans;
    turnsRef.current = turns;
    autoCommitRef.current = commitMerge;
    autoResolveRef.current = resolveConf;
    setHydrated(true);
  }, [settings, hydrated]);

  // ── Save helpers ───────────────────────────────────────────────────────────
  const saveSetting = useCallback(async (id, value, scope = "runtime") => {
    await api.post(`/settings/${encodeURIComponent(id)}`, { scope, value, source: "user" });
    qc.setQueryData(SETTINGS_QUERY_KEY, (current) =>
      upsertSettingPayload(current, { id, scope, value, source: "user", updatedAt: new Date().toISOString() })
    );
  }, [qc]);

  const flash = (setter) => { setter(true); setTimeout(() => setter(false), 1500); };

  // ── Handlers (auto-save on user change) ───────────────────────────────────

  const saveSandboxSettings = useCallback(() => {
    if (sandboxTimer.current) clearTimeout(sandboxTimer.current);
    sandboxTimer.current = setTimeout(async () => {
      try {
        await saveSetting("runtime.dockerExecution", sandboxRef.current.docker);
        await saveSetting("runtime.dockerImage", sandboxRef.current.image || "fifony-agent:latest");
        await saveSetting("runtime.sandboxExecution", sandboxRef.current.aiJail);
        flash(setSandboxSaved);
      } catch {}
    }, 600);
  }, [saveSetting]);

  const handleDockerChange = useCallback((docker) => {
    setDockerExecution(docker);
    if (docker) setSandboxExecution(false);
    sandboxRef.current.docker = docker;
    if (docker) sandboxRef.current.aiJail = false;
    saveSandboxSettings();
  }, [saveSandboxSettings]);

  const handleSandboxChange = useCallback((aiJail) => {
    setSandboxExecution(aiJail);
    if (aiJail) setDockerExecution(false);
    sandboxRef.current.aiJail = aiJail;
    if (aiJail) sandboxRef.current.docker = false;
    saveSandboxSettings();
  }, [saveSandboxSettings]);

  const handleImageChange = useCallback((image) => {
    setDockerImage(image);
    sandboxRef.current.image = image;
    saveSandboxSettings();
  }, [saveSandboxSettings]);

  const handleConcurrencyChange = useCallback((val) => {
    setConcurrency(val);
    concurrencyRef.current = val;
    if (concurrencyTimer.current) clearTimeout(concurrencyTimer.current);
    concurrencyTimer.current = setTimeout(async () => {
      const n = parseInt(concurrencyRef.current, 10);
      if (!n || n < 1 || n > 10) return;
      try {
        await api.post("/config/concurrency", { concurrency: n });
        qc.invalidateQueries({ queryKey: ["runtime-state"] });
        flash(setConcurrencySaved);
      } catch {}
    }, 600);
  }, [qc]);

  const handleTestCommandChange = useCallback((val) => {
    setTestCommand(val);
    testRef.current = val;
    if (testTimer.current) clearTimeout(testTimer.current);
    testTimer.current = setTimeout(async () => {
      try {
        await saveSetting("runtime.testCommand", testRef.current.trim());
        flash(setTestSaved);
      } catch {}
    }, 600);
  }, [saveSetting]);

  const handleAutoApproveChange = useCallback((val) => {
    setAutoReviewApproval(val);
    approveRef.current = val;
    if (approveTimer.current) clearTimeout(approveTimer.current);
    approveTimer.current = setTimeout(async () => {
      try {
        await saveSetting("runtime.autoReviewApproval", approveRef.current);
        flash(setApproveSaved);
      } catch {}
    }, 600);
  }, [saveSetting]);

  const handleTrivialPlansChange = useCallback((val) => {
    setAutoApproveTrivialPlans(val);
    trivialPlansRef.current = val;
    if (trivialPlansTimer.current) clearTimeout(trivialPlansTimer.current);
    trivialPlansTimer.current = setTimeout(async () => {
      try {
        await saveSetting("runtime.autoApproveTrivialPlans", trivialPlansRef.current);
        flash(setTrivialPlansSaved);
      } catch {}
    }, 600);
  }, [saveSetting]);

  const handleMaxTurnsChange = useCallback((val) => {
    setMaxTurns(val);
    turnsRef.current = val;
    if (turnsTimer.current) clearTimeout(turnsTimer.current);
    turnsTimer.current = setTimeout(async () => {
      const n = Number(turnsRef.current);
      if (!n || n < 1) return;
      try {
        await saveSetting("runtime.maxTurns", n);
        flash(setTurnsSaved);
      } catch {}
    }, 600);
  }, [saveSetting]);

  const handleAutoCommitChange = useCallback((val) => {
    setAutoCommitBeforeMerge(val);
    autoCommitRef.current = val;
    if (autoCommitTimer.current) clearTimeout(autoCommitTimer.current);
    autoCommitTimer.current = setTimeout(async () => {
      try {
        await saveSetting("runtime.autoCommitBeforeMerge", autoCommitRef.current);
        flash(setAutoCommitSaved);
      } catch {}
    }, 600);
  }, [saveSetting]);

  const handleAutoResolveChange = useCallback((val) => {
    setAutoResolveConflicts(val);
    autoResolveRef.current = val;
    if (autoResolveTimer.current) clearTimeout(autoResolveTimer.current);
    autoResolveTimer.current = setTimeout(async () => {
      try {
        await saveSetting("runtime.autoResolveConflicts", autoResolveRef.current);
        flash(setAutoResolveSaved);
      } catch {}
    }, 600);
  }, [saveSetting]);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    [sandboxTimer, concurrencyTimer, testTimer, approveTimer, trivialPlansTimer, turnsTimer, autoCommitTimer, autoResolveTimer].forEach((t) => {
      if (t.current) clearTimeout(t.current);
    });
  }, []);

  // ── Saved badge ────────────────────────────────────────────────────────────
  const SavedBadge = ({ show }) =>
    show ? (
      <span className="text-xs text-success flex items-center gap-1 animate-fade-in">
        <Check className="size-3" /> saved
      </span>
    ) : null;

  return (
    <div className="space-y-4">

      {/* Execution Sandbox */}
      <SettingsSection
        icon={Container}
        title={<span className="flex items-center gap-2">Execution Sandbox <SavedBadge show={sandboxSaved} /></span>}
        description="Where agent code runs — directly on your system, in a sandbox, or in a Docker container."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${!dockerExecution && !sandboxExecution ? "border-base-content/30 bg-base-300" : "border-base-content/10 bg-base-100/50 opacity-60"}`}>
            <input
              type="radio"
              className="radio radio-sm mt-0.5"
              checked={!dockerExecution && !sandboxExecution}
              onChange={() => {
                setDockerExecution(false);
                setSandboxExecution(false);
                sandboxRef.current = { ...sandboxRef.current, docker: false, aiJail: false };
                saveSandboxSettings();
              }}
            />
            <div className="space-y-1">
              <p className="text-xs font-medium">Host</p>
              <p className="text-xs opacity-50 leading-relaxed">
                Runs directly on your machine. Full filesystem and network access.
                Fast, zero overhead. No isolation.
              </p>
            </div>
          </label>

          <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${sandboxExecution ? "border-success/40 bg-success/5" : "border-base-content/10 bg-base-100/50 opacity-60"}`}>
            <input
              type="radio"
              className="radio radio-sm radio-success mt-0.5"
              checked={sandboxExecution}
              onChange={() => handleSandboxChange(true)}
            />
            <div className="space-y-1">
              <p className="text-xs font-medium flex items-center gap-1"><ShieldCheck className="size-3 text-success" /> Sandbox <span className="badge badge-xs badge-success ml-1">recommended</span></p>
              <p className="text-xs opacity-50 leading-relaxed">
                Lightweight process isolation. Only the issue worktree is writable.
                Namespace + seccomp + Landlock. Auto-downloads on first use.
              </p>
            </div>
          </label>

          <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${dockerExecution ? "border-warning/40 bg-warning/5" : "border-base-content/10 bg-base-100/50 opacity-60"}`}>
            <input
              type="radio"
              className="radio radio-sm radio-warning mt-0.5"
              checked={dockerExecution}
              onChange={() => handleDockerChange(true)}
            />
            <div className="space-y-1">
              <p className="text-xs font-medium">Docker</p>
              <p className="text-xs opacity-50 leading-relaxed">
                Full container isolation. Separate kernel namespace.
                Requires Docker daemon running and a pre-built image.
              </p>
            </div>
          </label>
        </div>

        {/* Tip: explain how each mode handles permissions */}
        <div className="text-[11px] leading-relaxed opacity-40 mt-3 space-y-1">
          <p><strong>Host</strong> — agent CLI runs with full system permissions. Changes are limited to the git worktree by convention, not enforcement.</p>
          <p><strong>Sandbox</strong> — the worktree is the only writable mount. The agent cannot read ~/.ssh, ~/.aws, or anything outside the project. Network access is preserved.</p>
          <p><strong>Docker</strong> — strongest isolation. Each run gets a fresh container. Slower startup (~2-5s) and requires a configured Docker image.</p>
        </div>

        {dockerExecution && (
          <div className="space-y-3">
            <label className="form-control w-full">
              <div className="label py-0.5">
                <span className="label-text text-xs">Docker image</span>
              </div>
              <input
                type="text"
                className="input input-bordered input-sm w-full font-mono text-xs"
                placeholder="fifony-agent:latest"
                value={dockerImage}
                onChange={(e) => handleImageChange(e.target.value)}
              />
            </label>
            <div className="flex items-start gap-2 text-xs opacity-60">
              <AlertTriangle className="size-3 shrink-0 mt-0.5 text-warning" />
              <span>
                Requires Docker installed and image built:{" "}
                <code className="font-mono">docker build -f Dockerfile.agent -t fifony-agent:latest .</code>
              </span>
            </div>
          </div>
        )}
      </SettingsSection>

      {/* Worker Concurrency */}
      <SettingsSection
        icon={Cpu}
        title={<span className="flex items-center gap-2">Worker Concurrency <SavedBadge show={concurrencySaved} /></span>}
        description="Number of issues that run in parallel (1–10). Higher values use more system resources."
      >
        <input
          className="input input-bordered input-sm w-24"
          type="number"
          min={1}
          max={10}
          value={concurrency}
          onChange={(e) => handleConcurrencyChange(e.target.value)}
        />
      </SettingsSection>

      {/* Max Turns */}
      <SettingsSection
        icon={null}
        title={<span className="flex items-center gap-2">Max turns per run <SavedBadge show={turnsSaved} /></span>}
        description="Maximum number of agent turns before a run is cut off. Higher = more attempts before the agent stops."
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            className="range range-sm range-primary w-48"
            min={1}
            max={50}
            step={1}
            value={maxTurns}
            onChange={(e) => handleMaxTurnsChange(Number(e.target.value))}
          />
          <span className="text-sm font-mono w-8 text-center">{maxTurns}</span>
        </div>
      </SettingsSection>

      {/* Validation Command */}
      <SettingsSection
        icon={FlaskConical}
        title={<span className="flex items-center gap-2">Validation command <SavedBadge show={testSaved} /></span>}
        description="Shell command run before merge/push. If it exits non-zero, the issue is blocked. Leave empty to skip."
      >
        <input
          type="text"
          className="input input-bordered input-sm w-full font-mono text-xs"
          placeholder="pnpm test"
          value={testCommand}
          onChange={(e) => handleTestCommandChange(e.target.value)}
        />
      </SettingsSection>

      {/* Auto-approve */}
      <SettingsSection
        icon={GitMerge}
        title={<span className="flex items-center gap-2">Auto-approve after review <SavedBadge show={approveSaved} /></span>}
        description={
          autoReviewApproval
            ? "Issues automatically move to Approved after the reviewer passes (or when no reviewer is configured)."
            : "Issues always land in Pending Decision for manual human approval, even after a passing review."
        }
      >
        <label className="label cursor-pointer justify-start gap-3 p-0">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={autoReviewApproval}
            onChange={(e) => handleAutoApproveChange(e.target.checked)}
          />
          <span className="label-text text-sm">{autoReviewApproval ? "Enabled" : "Disabled"}</span>
        </label>
      </SettingsSection>

      {/* Auto-approve trivial/low plans */}
      <SettingsSection
        icon={GitMerge}
        title={<span className="flex items-center gap-2">Auto-approve trivial/low plans <SavedBadge show={trivialPlansSaved} /></span>}
        description={
          autoApproveTrivialPlans
            ? "Plans with trivial or low complexity skip manual approval and go straight to execution."
            : "All plans require manual approval before execution, regardless of complexity."
        }
      >
        <label className="label cursor-pointer justify-start gap-3 p-0">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={autoApproveTrivialPlans}
            onChange={(e) => handleTrivialPlansChange(e.target.checked)}
          />
          <span className="label-text text-sm">{autoApproveTrivialPlans ? "Enabled" : "Disabled"}</span>
        </label>
      </SettingsSection>

      {/* Auto-commit before merge */}
      <SettingsSection
        icon={GitMerge}
        title={<span className="flex items-center gap-2">Auto-commit before merge <SavedBadge show={autoCommitSaved} /></span>}
        description={
          autoCommitBeforeMerge
            ? "Uncommitted changes in the project are automatically committed before merge so the process isn't blocked."
            : "Merge will fail if the project has uncommitted changes. Issues will move to Blocked until you commit manually."
        }
      >
        <label className="label cursor-pointer justify-start gap-3 p-0">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={autoCommitBeforeMerge}
            onChange={(e) => handleAutoCommitChange(e.target.checked)}
          />
          <span className="label-text text-sm">{autoCommitBeforeMerge ? "Enabled" : "Disabled"}</span>
        </label>
      </SettingsSection>

      {/* Auto-resolve merge conflicts */}
      <SettingsSection
        icon={GitMerge}
        title={<span className="flex items-center gap-2">Auto-resolve merge conflicts <SavedBadge show={autoResolveSaved} /></span>}
        description={
          autoResolveConflicts
            ? "When a merge has conflicts, an agent is spawned to resolve them automatically."
            : "Merge conflicts will block the issue. You must resolve conflicts manually."
        }
      >
        <label className="label cursor-pointer justify-start gap-3 p-0">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={autoResolveConflicts}
            onChange={(e) => handleAutoResolveChange(e.target.checked)}
          />
          <span className="label-text text-sm">{autoResolveConflicts ? "Enabled" : "Disabled"}</span>
        </label>
      </SettingsSection>

      <QualitySettingsPanel />
    </div>
  );
}
