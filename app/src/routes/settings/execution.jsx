import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api.js";
import { useSettings, getSettingsList, getSettingValue, SETTINGS_QUERY_KEY, upsertSettingPayload } from "../../hooks.js";
import { SettingsSection } from "../../components/SettingsSection.jsx";
import { QualitySettingsPanel } from "./quality.jsx";
import {
  Container, Cpu, FlaskConical, GitMerge, Check, Loader2, AlertTriangle,
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
  const [concurrency, setConcurrency] = useState("3");
  const [testCommand, setTestCommand] = useState("");
  const [autoReviewApproval, setAutoReviewApproval] = useState(true);
  const [maxTurns, setMaxTurns] = useState(4);
  const [autoCommitBeforeMerge, setAutoCommitBeforeMerge] = useState(true);
  const [autoResolveConflicts, setAutoResolveConflicts] = useState(false);

  // Saved indicators
  const [sandboxSaved, setSandboxSaved] = useState(false);
  const [concurrencySaved, setConcurrencySaved] = useState(false);
  const [testSaved, setTestSaved] = useState(false);
  const [approveSaved, setApproveSaved] = useState(false);
  const [turnsSaved, setTurnsSaved] = useState(false);
  const [autoCommitSaved, setAutoCommitSaved] = useState(false);
  const [autoResolveSaved, setAutoResolveSaved] = useState(false);

  // ── Debounce timers ────────────────────────────────────────────────────────
  const sandboxTimer = useRef(null);
  const concurrencyTimer = useRef(null);
  const testTimer = useRef(null);
  const approveTimer = useRef(null);
  const turnsTimer = useRef(null);
  const autoCommitTimer = useRef(null);
  const autoResolveTimer = useRef(null);

  // Current value refs (avoid stale closures in timers)
  const sandboxRef = useRef({ docker: false, image: "fifony-agent:latest" });
  const concurrencyRef = useRef("3");
  const testRef = useRef("");
  const approveRef = useRef(true);
  const turnsRef = useRef(4);
  const autoCommitRef = useRef(true);
  const autoResolveRef = useRef(false);

  // ── Hydration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (hydrated || !settings?.length) return;
    const docker = getSettingValue(settings, "runtime.dockerExecution", false);
    const image = getSettingValue(settings, "runtime.dockerImage", "fifony-agent:latest") || "fifony-agent:latest";
    const conc = String(getSettingValue(settings, "runtime.workerConcurrency", 3));
    const test = getSettingValue(settings, "runtime.testCommand", "") || "";
    const approve = getSettingValue(settings, "runtime.autoReviewApproval", true);
    const turns = getSettingValue(settings, "runtime.maxTurns", 4);
    setDockerExecution(docker);
    setDockerImage(image);
    setConcurrency(conc);
    setTestCommand(test);
    const commitMerge = getSettingValue(settings, "runtime.autoCommitBeforeMerge", true);
    const resolveConf = getSettingValue(settings, "runtime.autoResolveConflicts", false);
    setAutoReviewApproval(approve);
    setMaxTurns(turns);
    setAutoCommitBeforeMerge(commitMerge);
    setAutoResolveConflicts(resolveConf);
    sandboxRef.current = { docker, image };
    concurrencyRef.current = conc;
    testRef.current = test;
    approveRef.current = approve;
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

  const handleDockerChange = useCallback((docker) => {
    setDockerExecution(docker);
    sandboxRef.current.docker = docker;
    if (sandboxTimer.current) clearTimeout(sandboxTimer.current);
    sandboxTimer.current = setTimeout(async () => {
      try {
        await saveSetting("runtime.dockerExecution", sandboxRef.current.docker);
        await saveSetting("runtime.dockerImage", sandboxRef.current.image || "fifony-agent:latest");
        flash(setSandboxSaved);
      } catch {}
    }, 600);
  }, [saveSetting]);

  const handleImageChange = useCallback((image) => {
    setDockerImage(image);
    sandboxRef.current.image = image;
    if (sandboxTimer.current) clearTimeout(sandboxTimer.current);
    sandboxTimer.current = setTimeout(async () => {
      try {
        await saveSetting("runtime.dockerExecution", sandboxRef.current.docker);
        await saveSetting("runtime.dockerImage", sandboxRef.current.image || "fifony-agent:latest");
        flash(setSandboxSaved);
      } catch {}
    }, 600);
  }, [saveSetting]);

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
    [sandboxTimer, concurrencyTimer, testTimer, approveTimer, turnsTimer, autoCommitTimer, autoResolveTimer].forEach((t) => {
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
        description="Where agent code runs — directly on your system or inside an isolated container."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${!dockerExecution ? "border-base-content/30 bg-base-300" : "border-base-content/10 bg-base-100/50 opacity-60"}`}>
            <input
              type="radio"
              className="radio radio-sm mt-0.5"
              checked={!dockerExecution}
              onChange={() => handleDockerChange(false)}
            />
            <div className="space-y-1">
              <p className="text-xs font-medium">Script (host)</p>
              <p className="text-xs opacity-50 leading-relaxed">
                Runs directly on your system with the same user and permissions as fifony.
                Full filesystem and network access. No setup required.
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
              <p className="text-xs font-medium">Docker container</p>
              <p className="text-xs opacity-50 leading-relaxed">
                Each execution runs in an isolated container. The agent only sees the issue workspace
                and the project <code className="font-mono">.git</code> — nothing else on the host filesystem.
                Linux capabilities dropped, privilege escalation blocked.
              </p>
            </div>
          </label>
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
