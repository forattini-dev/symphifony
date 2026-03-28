import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useSettings, getSettingsList, getSettingValue, SETTINGS_QUERY_KEY, upsertSettingPayload } from "../../hooks";
import { PROJECT_SETTING_ID, buildQueueTitle, normalizeProjectName, resolveProjectMeta } from "../../project-meta.js";
import Confetti from "../Confetti";
import OnboardingParticles from "../OnboardingParticles";

import { getStepLabels, getStepCount } from "./constants";
import {
  buildWorkflowConfig,
  canProceedFromSetup,
  normalizeRoleEfforts,
  saveSetting,
} from "./helpers";

import StepIndicator from "./steps/StepIndicator";
import StepContent from "./steps/StepContent";
import WizardNavFooter from "./steps/WizardNavFooter";
import WelcomeStep from "./steps/WelcomeStep";
import SetupStep from "./steps/SetupStep";
import PipelineStep from "./steps/PipelineStep";
import AgentsSkillsStep from "./steps/AgentsSkillsStep";
import WorkersThemeStep from "./steps/WorkersThemeStep";
import CompleteStep from "./steps/CompleteStep";

// ── Main Wizard Component ─────────────────────────────────────────────────────

export default function OnboardingWizard({ onComplete }) {
  const qc = useQueryClient();
  const settingsQuery = useSettings();
  const settings = getSettingsList(settingsQuery.data);

  // Wizard state
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState("forward");
  const [launching, setLaunching] = useState(false);
  const [confetti, setConfetti] = useState(null);
  const hydratedRef = useRef(false);
  const projectHydratedRef = useRef(false);

  // Config state
  const [pipeline, setPipeline] = useState({ planner: "", executor: "", reviewer: "" });
  const [efforts, setEfforts] = useState(() => normalizeRoleEfforts(null));
  const [concurrency, setConcurrency] = useState(3);
  const [selectedTheme, setSelectedTheme] = useState("auto");

  // New step state
  const [projectName, setProjectNameState] = useState("");
  const [projectSource, setProjectSource] = useState("missing");
  const [setupGitStatus, setSetupGitStatus] = useState(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState(null);
  const [selectedAgents, setSelectedAgents] = useState([]);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [mergeMode, setMergeMode] = useState("local");
  const [prBaseBranch, setPrBaseBranch] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [autoReviewApproval, setAutoReviewApproval] = useState(true);
  const [autoCommitBeforeMerge, setAutoCommitBeforeMerge] = useState(true);
  const [autoResolveConflicts, setAutoResolveConflicts] = useState(false);

  const STEP_COUNT = getStepCount();
  const STEP_LABELS = getStepLabels();

  // Map logical step index to step name.
  const stepName = STEP_LABELS[step] || "";

  // Provider detection
  const [providers, setProviders] = useState(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [modelsByProvider, setModelsByProvider] = useState({});
  const [models, setModels] = useState({ plan: "", execute: "", review: "" });

  // Workspace path and default branch from runtime state
  const [workspacePath, setWorkspacePath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");

  // Load workspace path and branch on mount
  useEffect(() => {
    api.get("/state").then((data) => {
      setRuntimeSnapshot(data || {});
      const path = data?.sourceRepoUrl || data?.config?.sourceRepo || "";
      setWorkspacePath(path);
      setDefaultBranch(data?.config?.defaultBranch || "");
    }).catch(() => {
      setRuntimeSnapshot({});
    });
  }, []);

  useEffect(() => {
    if (hydratedRef.current || settingsQuery.isLoading) return;
    hydratedRef.current = true;

    const savedPipeline = getSettingValue(settings, "runtime.pipeline", null);
    const savedWorkflowConfig = getSettingValue(settings, "runtime.workflowConfig", null);
    const savedEfforts = getSettingValue(settings, "runtime.defaultEffort", null);
    const savedTheme = getSettingValue(settings, "ui.theme", "auto");
    const savedConcurrency = getSettingValue(settings, "runtime.workerConcurrency", 3);

    if (Array.isArray(savedPipeline) && savedPipeline.length > 0) {
      const byRole = Object.fromEntries(savedPipeline.map((entry) => [entry.role, entry.provider]));
      setPipeline({
        planner: byRole.planner || "",
        executor: byRole.executor || "",
        reviewer: byRole.reviewer || "",
      });
    }

    if (savedWorkflowConfig && typeof savedWorkflowConfig === "object") {
      setModels({
        plan: savedWorkflowConfig.plan?.model || "",
        execute: savedWorkflowConfig.execute?.model || "",
        review: savedWorkflowConfig.review?.model || "",
      });
    }

    setEfforts(normalizeRoleEfforts(savedEfforts));
    if (typeof savedTheme === "string" && savedTheme.trim()) {
      setSelectedTheme(savedTheme);
    }

    const parsedConcurrency = Number.parseInt(String(savedConcurrency ?? 2), 10);
    if (Number.isFinite(parsedConcurrency)) {
      setConcurrency(Math.min(10, Math.max(1, parsedConcurrency)));
    }

    const savedAutoReviewApproval = getSettingValue(settings, "runtime.autoReviewApproval", true);
    if (typeof savedAutoReviewApproval === "boolean") {
      setAutoReviewApproval(savedAutoReviewApproval);
    }
    const savedAutoCommit = getSettingValue(settings, "runtime.autoCommitBeforeMerge", true);
    if (typeof savedAutoCommit === "boolean") setAutoCommitBeforeMerge(savedAutoCommit);
    const savedAutoResolve = getSettingValue(settings, "runtime.autoResolveConflicts", false);
    if (typeof savedAutoResolve === "boolean") setAutoResolveConflicts(savedAutoResolve);

    const savedMergeMode = getSettingValue(settings, "runtime.mergeMode", "local");
    if (savedMergeMode === "local" || savedMergeMode === "push-pr") setMergeMode(savedMergeMode);
    const savedPrBaseBranch = getSettingValue(settings, "runtime.prBaseBranch", "");
    if (typeof savedPrBaseBranch === "string") setPrBaseBranch(savedPrBaseBranch);
    const savedTestCommand = getSettingValue(settings, "runtime.testCommand", "");
    if (typeof savedTestCommand === "string") setTestCommand(savedTestCommand);
  }, [settings, settingsQuery.isLoading]);

  useEffect(() => {
    if (projectHydratedRef.current || settingsQuery.isLoading || runtimeSnapshot === null) return;
    projectHydratedRef.current = true;

    const projectMeta = resolveProjectMeta(settings, runtimeSnapshot);
    setProjectNameState(projectMeta.projectName);
    setProjectSource(projectMeta.source);
  }, [runtimeSnapshot, settings, settingsQuery.isLoading]);

  const setProjectName = useCallback((value) => {
    setProjectNameState(value);
    setProjectSource("manual");
  }, []);

  const normalizedProjectName = normalizeProjectName(projectName);
  const queueTitle = buildQueueTitle(normalizedProjectName);

  useEffect(() => {
    document.title = buildQueueTitle(normalizedProjectName || runtimeSnapshot?.detectedProjectName || runtimeSnapshot?.projectName || "");
  }, [normalizedProjectName, runtimeSnapshot]);

  // Fetch providers (and models) shortly before the pipeline step
  useEffect(() => {
    if (step >= 1 && providers === null) {
      setProvidersLoading(true);
      Promise.all([
        api.get("/providers"),
        api.get("/config/workflow?details=1").catch(() => null),
      ]).then(([provData, workflowData]) => {
        const list = Array.isArray(provData) ? provData : provData?.providers || [];
        setProviders(list);

        // Models from workflow endpoint
        const fetchedModels = workflowData?.models || {};
        setModelsByProvider(fetchedModels);

        // Auto-select first available + set default pipeline
        const available = list.filter((p) => p.available !== false);
        const firstName = available[0]?.id || available[0]?.name || "";

        // Default pipeline: claude plans + reviews, first available executes
        const claudeAvailable = available.find((p) => (p.id || p.name) === "claude");
        const defaultCli = firstName;
        const planReviewCli = claudeAvailable ? "claude" : defaultCli;
        const newPipeline = {
          planner: planReviewCli,
          executor: defaultCli,
          reviewer: planReviewCli,
        };
        setPipeline((prev) => ({
          planner: prev.planner || newPipeline.planner,
          executor: prev.executor || newPipeline.executor,
          reviewer: prev.reviewer || newPipeline.reviewer,
        }));

        // Auto-select first model per stage
        setModels((prev) => ({
          plan: prev.plan || fetchedModels[planReviewCli]?.[0]?.id || "",
          execute: prev.execute || fetchedModels[defaultCli]?.[0]?.id || "",
          review: prev.review || fetchedModels[planReviewCli]?.[0]?.id || "",
        }));
      }).catch(() => {
        setProviders([]);
      }).finally(() => {
        setProvidersLoading(false);
      });
    }
  }, [step, providers]);

  // Apply theme preview immediately
  useEffect(() => {
    const resolved = selectedTheme === "auto"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : selectedTheme;
    document.documentElement.setAttribute("data-theme", resolved);
  }, [selectedTheme]);

  // Save settings progressively as user advances
  const saveStepSettings = useCallback((currentStepName) => {
    if (currentStepName === "Setup") {
      if (normalizedProjectName) {
        saveSetting(PROJECT_SETTING_ID, normalizedProjectName, "system").catch(() => {});
      }
      saveSetting("runtime.mergeMode", mergeMode, "runtime").catch(() => {});
      if (mergeMode === "push-pr" && prBaseBranch.trim()) {
        saveSetting("runtime.prBaseBranch", prBaseBranch.trim(), "runtime").catch(() => {});
      }
      saveSetting("runtime.autoReviewApproval", autoReviewApproval, "runtime").catch(() => {});
      saveSetting("runtime.autoCommitBeforeMerge", autoCommitBeforeMerge, "runtime").catch(() => {});
      saveSetting("runtime.autoResolveConflicts", autoResolveConflicts, "runtime").catch(() => {});
      if (testCommand.trim()) {
        saveSetting("runtime.testCommand", testCommand.trim(), "runtime").catch(() => {});
      }
    } else if (currentStepName === "Pipeline") {
      const pipelineProviders = [
        { provider: pipeline.planner, role: "planner" },
        { provider: pipeline.executor, role: "executor" },
        { provider: pipeline.reviewer, role: "reviewer" },
      ];
      saveSetting("runtime.agentProvider", pipeline.executor, "runtime").catch(() => {});
      saveSetting("runtime.pipeline", pipelineProviders, "runtime").catch(() => {});
      saveSetting("runtime.defaultEffort", efforts, "runtime").catch(() => {});
      saveSetting("runtime.workflowConfig", buildWorkflowConfig(pipeline, efforts, models), "runtime").catch(() => {});
    } else if (currentStepName === "Preferences") {
      saveSetting("ui.theme", selectedTheme, "ui").catch(() => {});
      api.post("/config/concurrency", { concurrency }).catch(() => {});
    }
  }, [pipeline, efforts, models, concurrency, selectedTheme, normalizedProjectName, mergeMode, prBaseBranch, testCommand, autoReviewApproval, autoCommitBeforeMerge, autoResolveConflicts]);

  const goNext = useCallback(() => {
    if (step < STEP_COUNT - 1) {
      saveStepSettings(stepName);
      setDirection("forward");
      setStep((s) => s + 1);
    }
  }, [step, STEP_COUNT, stepName, saveStepSettings]);

  const goBack = useCallback(() => {
    if (step > 0) {
      setDirection("backward");
      setStep((s) => s - 1);
    }
  }, [step]);

  const handleLaunch = useCallback(async () => {
    if (!normalizedProjectName) return;
    setLaunching(true);
    try {
      // Save all settings in parallel
      const saves = [
        saveSetting(PROJECT_SETTING_ID, normalizedProjectName, "system"),
        saveSetting("ui.theme", selectedTheme, "ui"),
        saveSetting("ui.onboarding.completed", true, "ui"),
      ];

      // Save pipeline configuration
      const pipelineProviders = [
        { provider: pipeline.planner, role: "planner" },
        { provider: pipeline.executor, role: "executor" },
        { provider: pipeline.reviewer, role: "reviewer" },
      ];
      saves.push(saveSetting("runtime.agentProvider", pipeline.executor, "runtime"));
      saves.push(saveSetting("runtime.pipeline", pipelineProviders, "runtime"));

      saves.push(saveSetting("runtime.defaultEffort", efforts, "runtime"));
      // Save as WorkflowConfig (the format read by planner, executor, reviewer stages)
      saves.push(saveSetting("runtime.workflowConfig", buildWorkflowConfig(pipeline, efforts, models), "runtime"));
      saves.push(api.post("/config/concurrency", { concurrency }));
      saves.push(saveSetting("runtime.mergeMode", mergeMode, "runtime"));
      saves.push(saveSetting("runtime.autoReviewApproval", autoReviewApproval, "runtime"));
      saves.push(saveSetting("runtime.autoCommitBeforeMerge", autoCommitBeforeMerge, "runtime"));
      saves.push(saveSetting("runtime.autoResolveConflicts", autoResolveConflicts, "runtime"));
      if (mergeMode === "push-pr" && prBaseBranch.trim()) {
        saves.push(saveSetting("runtime.prBaseBranch", prBaseBranch.trim(), "runtime"));
      }
      if (testCommand.trim()) {
        saves.push(saveSetting("runtime.testCommand", testCommand.trim(), "runtime"));
      }

      // Install selected agents and skills
      if (selectedAgents.length > 0) {
        saves.push(api.post("/install/agents", { agents: selectedAgents }));
      }
      if (selectedSkills.length > 0) {
        saves.push(api.post("/install/skills", { skills: selectedSkills }));
      }

      await Promise.allSettled(saves);

      // Optimistically update settings cache so OnboardingGate immediately sees completed=true
      qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, {
        id: PROJECT_SETTING_ID,
        scope: "system",
        value: normalizedProjectName,
        source: "user",
        updatedAt: new Date().toISOString(),
      }));
      qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, {
        id: "ui.onboarding.completed",
        scope: "ui",
        value: true,
        source: "user",
        updatedAt: new Date().toISOString(),
      }));

      // Show confetti, then navigate based on optimistic cache (completed=true already set above).
      // Invalidate in background AFTER navigation so a slow server flush can't race with OnboardingGate.
      setConfetti({ x: window.innerWidth / 2, y: window.innerHeight / 3 });
      setTimeout(() => {
        onComplete?.();
        qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      }, 1200);
    } catch {
      // Even on error, mark as done so user isn't stuck
      qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, {
        id: PROJECT_SETTING_ID,
        scope: "system",
        value: normalizedProjectName,
        source: "user",
        updatedAt: new Date().toISOString(),
      }));
      qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, {
        id: "ui.onboarding.completed",
        scope: "ui",
        value: true,
        source: "user",
        updatedAt: new Date().toISOString(),
      }));
      await saveSetting("ui.onboarding.completed", true, "ui").catch(() => {});
      qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      onComplete?.();
    }
  }, [normalizedProjectName, pipeline, efforts, models, concurrency, selectedTheme, selectedAgents, selectedSkills, mergeMode, prBaseBranch, testCommand, autoReviewApproval, autoCommitBeforeMerge, autoResolveConflicts, qc, onComplete]);

  // Can proceed from step
  const canProceed =
    stepName === "Welcome" ||
    (stepName === "Setup" && canProceedFromSetup(normalizedProjectName, setupGitStatus)) ||
    (stepName === "Pipeline" && (pipeline.executor || providersLoading)) ||
    stepName === "Agents & Skills" ||
    stepName === "Preferences" ||
    stepName === "Launch";

  const existingAgents = [];
  const existingSkills = [];

  const config = {
    projectName: normalizedProjectName,
    queueTitle,
    pipeline,
    efforts,
    concurrency,
    theme: selectedTheme,
    agents: selectedAgents,
    skills: selectedSkills,
  };

  return (
    <div className="fixed inset-0 z-50 bg-base-100 flex flex-col overflow-hidden">
      {step === 0 && <OnboardingParticles />}

      {confetti && (
        <Confetti x={confetti.x} y={confetti.y} active onDone={() => setConfetti(null)} />
      )}

      {/* Header with step indicator — hidden on welcome screen */}
      {step > 0 && (
        <div className="relative z-10 pt-6 pb-2 px-4 flex justify-center">
          <StepIndicator current={step} />
        </div>
      )}

      {/* Step content area */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-start px-4 py-6 overflow-y-auto">
        <StepContent
          direction={direction}
          stepKey={step}
          center={
            stepName === "Welcome" ||
            stepName === "Setup" ||
            stepName === "Pipeline" ||
            stepName === "Launch"
          }
        >
          {stepName === "Welcome" && (
            <WelcomeStep workspacePath={workspacePath} onGetStarted={goNext} />
          )}
          {stepName === "Setup" && (
            <SetupStep
              projectName={projectName}
              setProjectName={setProjectName}
              detectedProjectName={runtimeSnapshot?.detectedProjectName || ""}
              projectSource={projectSource}
              workspacePath={workspacePath}
              currentBranch={defaultBranch}
              onGitStatusChange={setSetupGitStatus}
              onBranchCreated={(branch) => { setDefaultBranch(branch); if (!prBaseBranch) setPrBaseBranch(branch); }}
              mergeMode={mergeMode}
              setMergeMode={setMergeMode}
              prBaseBranch={prBaseBranch}
              setPrBaseBranch={setPrBaseBranch}
              autoReviewApproval={autoReviewApproval}
              setAutoReviewApproval={setAutoReviewApproval}
              testCommand={testCommand}
              setTestCommand={setTestCommand}
              autoCommitBeforeMerge={autoCommitBeforeMerge}
              setAutoCommitBeforeMerge={setAutoCommitBeforeMerge}
              autoResolveConflicts={autoResolveConflicts}
              setAutoResolveConflicts={setAutoResolveConflicts}
            />
          )}
          {stepName === "Pipeline" && (
            <PipelineStep
              providers={providers || []}
              providersLoading={providersLoading}
              pipeline={pipeline}
              setPipeline={setPipeline}
              efforts={efforts}
              setEfforts={setEfforts}
              models={models}
              setModels={setModels}
              modelsByProvider={modelsByProvider}
            />
          )}
          {stepName === "Agents & Skills" && (
            <AgentsSkillsStep
              selectedAgents={selectedAgents}
              setSelectedAgents={setSelectedAgents}
              selectedSkills={selectedSkills}
              setSelectedSkills={setSelectedSkills}
              existingAgents={existingAgents}
              existingSkills={existingSkills}
            />
          )}
          {stepName === "Preferences" && (
            <WorkersThemeStep
              concurrency={concurrency}
              setConcurrency={setConcurrency}
              selectedTheme={selectedTheme}
              setSelectedTheme={setSelectedTheme}
            />
          )}
          {stepName === "Launch" && <CompleteStep config={config} launching={launching} />}
        </StepContent>
      </div>

      {/* Navigation footer — hidden on welcome (button is inline) */}
      <WizardNavFooter
        step={step}
        stepCount={STEP_COUNT}
        stepName={stepName}
        canProceed={canProceed}
        launching={launching}
        onBack={goBack}
        onNext={goNext}
        onLaunch={handleLaunch}
      />
    </div>
  );
}
