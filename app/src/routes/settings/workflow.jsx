import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../../api.js";
import {
  Lightbulb,
  Play,
  Eye,
  RotateCcw,
  Loader2,
  Check,
  ArrowDown,
} from "lucide-react";

const STAGES = [
  {
    key: "plan",
    label: "Plan",
    icon: Lightbulb,
    description: "Generate the execution plan",
    accent: "info",
  },
  {
    key: "execute",
    label: "Execute",
    icon: Play,
    description: "Implement the changes",
    accent: "primary",
  },
  {
    key: "review",
    label: "Review",
    icon: Eye,
    description: "Review the implementation",
    accent: "secondary",
  },
];

const CLAUDE_MODELS = [
  { value: "claude-opus-4-6", label: "Opus 4.6" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
];

const CODEX_MODELS = [
  { value: "codex", label: "Codex (default)" },
];

const EFFORTS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "extra-high", label: "Extra High" },
];

function getModelsForProvider(provider) {
  if (provider === "claude") return CLAUDE_MODELS;
  if (provider === "codex") return CODEX_MODELS;
  return [];
}

const ACCENT_MAP = {
  info: {
    border: "border-info/30",
    bg: "bg-info/10",
    text: "text-info",
    step: "step-info",
    badge: "badge-info",
  },
  primary: {
    border: "border-primary/30",
    bg: "bg-primary/10",
    text: "text-primary",
    step: "step-primary",
    badge: "badge-primary",
  },
  secondary: {
    border: "border-secondary/30",
    bg: "bg-secondary/10",
    text: "text-secondary",
    step: "step-secondary",
    badge: "badge-secondary",
  },
};

function StageBlock({ stage, config, providers, onChange, isLast, saving }) {
  const Icon = stage.icon;
  const models = getModelsForProvider(config.provider);
  const availableProviders = (providers || []).filter((p) => p.available);
  const colors = ACCENT_MAP[stage.accent];

  return (
    <>
      <div className={`card bg-base-200 border-l-4 ${colors.border} animate-fade-in`}>
        <div className="card-body p-4 gap-3">
          <div className="flex items-center gap-3">
            <div className={`flex items-center justify-center size-9 rounded-lg ${colors.bg}`}>
              <Icon className={`size-4.5 ${colors.text}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm">{stage.label}</h3>
                <span className={`badge badge-xs ${colors.badge} badge-outline`}>
                  {config.provider}
                </span>
                {saving === stage.key && (
                  <span className="text-xs text-success flex items-center gap-1 animate-fade-in">
                    <Check className="size-3" /> saved
                  </span>
                )}
              </div>
              <p className="text-xs opacity-50">{stage.description}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="form-control">
              <div className="label py-0.5">
                <span className="label-text text-xs opacity-60">Provider</span>
              </div>
              <select
                className="select select-bordered select-sm w-full"
                value={config.provider}
                onChange={(e) => {
                  const newProvider = e.target.value;
                  const newModels = getModelsForProvider(newProvider);
                  const newEffort = newProvider !== "codex" && config.effort === "extra-high" ? "high" : config.effort;
                  onChange({
                    ...config,
                    provider: newProvider,
                    model: newModels[0]?.value || newProvider,
                    effort: newEffort,
                  });
                }}
              >
                {availableProviders.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </label>

            <label className="form-control">
              <div className="label py-0.5">
                <span className="label-text text-xs opacity-60">Model</span>
              </div>
              <select
                className="select select-bordered select-sm w-full"
                value={config.model}
                onChange={(e) => onChange({ ...config, model: e.target.value })}
              >
                {models.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>

            <label className="form-control">
              <div className="label py-0.5">
                <span className="label-text text-xs opacity-60">Effort</span>
              </div>
              <select
                className="select select-bordered select-sm w-full"
                value={config.effort}
                onChange={(e) => onChange({ ...config, effort: e.target.value })}
              >
                {EFFORTS.filter(
                  (e) => config.provider === "codex" || e.value !== "extra-high"
                ).map((e) => (
                  <option key={e.value} value={e.value}>{e.label}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      {!isLast && (
        <div className="flex justify-center py-0.5">
          <ArrowDown className="size-4 opacity-20" />
        </div>
      )}
    </>
  );
}

export const Route = createFileRoute("/settings/workflow")({
  component: WorkflowSettings,
});

function WorkflowSettings() {
  const [workflow, setWorkflow] = useState(null);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingStage, setSavingStage] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const saveTimer = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/config/workflow");
      setWorkflow(res.workflow);
      setProviders(res.providers || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-save with debounce
  const autoSave = useCallback((newWorkflow, changedStage) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await api.post("/config/workflow", { workflow: newWorkflow });
        setSavingStage(changedStage);
        setTimeout(() => setSavingStage(null), 1500);
      } catch {
        // silent fail — the user will see the stale state on next load
      }
    }, 600);
  }, []);

  const handleStageChange = useCallback((stageKey, newConfig) => {
    setWorkflow((prev) => {
      const next = { ...prev, [stageKey]: newConfig };
      autoSave(next, stageKey);
      return next;
    });
  }, [autoSave]);

  const handleRestoreDefaults = useCallback(async () => {
    setRestoring(true);
    try {
      const availableProviders = providers.filter((p) => p.available);
      const firstAvailable = availableProviders[0]?.name || "claude";
      const defaultModel = firstAvailable === "claude" ? "claude-sonnet-4-6" : "codex";

      const defaults = {
        plan: { provider: firstAvailable, model: defaultModel, effort: "medium" },
        execute: { provider: firstAvailable, model: defaultModel, effort: "medium" },
        review: { provider: firstAvailable, model: defaultModel, effort: "medium" },
      };

      setWorkflow(defaults);
      await api.post("/config/workflow", { workflow: defaults });
      setSavingStage("all");
      setTimeout(() => setSavingStage(null), 1500);
    } catch {}
    setRestoring(false);
  }, [providers]);

  // Cleanup timer on unmount
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  if (loading || !workflow) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin opacity-30" />
      </div>
    );
  }

  return (
    <div className="space-y-4 stagger-children">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold">Pipeline Workflow</h2>
          <p className="text-xs opacity-50 mt-0.5">
            Changes are saved automatically.
          </p>
        </div>
        <button
          className="btn btn-ghost btn-sm gap-1 shrink-0"
          onClick={handleRestoreDefaults}
          disabled={restoring}
        >
          {restoring ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
          Restore defaults
        </button>
      </div>

      {/* Pipeline steps indicator */}
      <ul className="steps steps-horizontal w-full text-xs">
        {STAGES.map((stage) => {
          const colors = ACCENT_MAP[stage.accent];
          return (
            <li key={stage.key} className={`step ${colors.step}`}>
              {stage.label}
            </li>
          );
        })}
      </ul>

      {/* Stage cards */}
      <div className="flex flex-col">
        {STAGES.map((stage, i) => (
          <StageBlock
            key={stage.key}
            stage={stage}
            config={workflow[stage.key]}
            providers={providers}
            onChange={(newConfig) => handleStageChange(stage.key, newConfig)}
            isLast={i === STAGES.length - 1}
            saving={savingStage === stage.key || savingStage === "all" ? stage.key : null}
          />
        ))}
      </div>
    </div>
  );
}
