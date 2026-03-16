import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { api } from "../../api.js";
import { Lightbulb, Play, Eye, Save, RotateCcw, Loader2, Check } from "lucide-react";

const STAGES = [
  { key: "plan", label: "Plan", icon: Lightbulb, description: "AI generates the execution plan" },
  { key: "execute", label: "Execute", icon: Play, description: "Agent implements the changes" },
  { key: "review", label: "Review", icon: Eye, description: "Agent reviews the implementation" },
];

const EFFORTS = [
  { value: "low", label: "Low", description: "Simple fixes, minimal reasoning" },
  { value: "medium", label: "Medium", description: "Standard work" },
  { value: "high", label: "High", description: "Complex tasks, deep reasoning" },
  { value: "extra-high", label: "Extra High", description: "Maximum reasoning (Codex only)" },
];

function StageCard({ stage, config, providers, modelsByProvider, onChange }) {
  const Icon = stage.icon;
  const models = modelsByProvider[config.provider] || [];
  const availableProviders = (providers || []).filter((p) => p.available);

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-4 p-5">
        <div className="flex items-center gap-2">
          <Icon className="size-5 text-primary" />
          <div>
            <h3 className="font-semibold">{stage.label}</h3>
            <p className="text-xs opacity-50">{stage.description}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Provider */}
          <div className="form-control">
            <label className="label pb-1"><span className="label-text text-xs font-medium">Provider</span></label>
            <select
              className="select select-bordered select-sm w-full"
              value={config.provider}
              onChange={(e) => {
                const newProvider = e.target.value;
                const newModels = modelsByProvider[newProvider] || [];
                onChange({
                  ...config,
                  provider: newProvider,
                  model: newModels[0]?.id || newProvider,
                });
              }}
            >
              {availableProviders.map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div className="form-control">
            <label className="label pb-1"><span className="label-text text-xs font-medium">Model</span></label>
            <select
              className="select select-bordered select-sm w-full"
              value={config.model}
              onChange={(e) => onChange({ ...config, model: e.target.value })}
            >
              {models.length === 0 && (
                <option value={config.model}>{config.model || "(detecting...)"}</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label} — {m.tier}</option>
              ))}
            </select>
          </div>

          {/* Effort */}
          <div className="form-control">
            <label className="label pb-1"><span className="label-text text-xs font-medium">Reasoning Effort</span></label>
            <select
              className="select select-bordered select-sm w-full"
              value={config.effort}
              onChange={(e) => onChange({ ...config, effort: e.target.value })}
            >
              {EFFORTS.filter((e) => config.provider === "codex" || e.value !== "extra-high").map((e) => (
                <option key={e.value} value={e.value}>{e.label} — {e.description}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings/workflow")({
  component: WorkflowSettings,
});

function WorkflowSettings() {
  const [workflow, setWorkflow] = useState(null);
  const [providers, setProviders] = useState([]);
  const [modelsByProvider, setModelsByProvider] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isDefault, setIsDefault] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [workflowRes, modelsRes] = await Promise.all([
        api.get("/config/workflow"),
        api.get("/config/models").catch(() => ({ models: {} })),
      ]);
      setWorkflow(workflowRes.workflow);
      setProviders(workflowRes.providers || []);
      setIsDefault(workflowRes.isDefault);
      setModelsByProvider(modelsRes.models || {});
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!workflow) return;
    setSaving(true);
    setSaved(false);
    try {
      await api.post("/config/workflow", { workflow });
      setSaved(true);
      setIsDefault(false);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    setSaving(false);
  };

  const handleReset = async () => {
    setLoading(true);
    try {
      // Get default by clearing
      const res = await api.get("/config/workflow");
      const defaultProviders = (res.providers || []).filter((p) => p.available);
      const hasClaude = defaultProviders.some((p) => p.name === "claude");
      const hasCodex = defaultProviders.some((p) => p.name === "codex");

      const defaults = {
        plan: { provider: hasClaude ? "claude" : "codex", model: hasClaude ? "claude-sonnet-4-6" : "o3", effort: "high" },
        execute: { provider: hasCodex ? "codex" : "claude", model: hasCodex ? "o4-mini" : "claude-sonnet-4-6", effort: "medium" },
        review: { provider: hasClaude ? "claude" : "codex", model: hasClaude ? "claude-sonnet-4-6" : "o3", effort: "medium" },
      };
      setWorkflow(defaults);
    } catch {}
    setLoading(false);
  };

  if (loading || !workflow) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="size-6 animate-spin opacity-30" /></div>;
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold mb-1">Pipeline Workflow</h2>
        <p className="text-xs opacity-50">
          Configure which CLI, model, and reasoning effort to use for each stage of the issue lifecycle.
          {isDefault && <span className="badge badge-xs badge-ghost ml-2">using defaults</span>}
        </p>
      </div>

      {/* Flow diagram */}
      <div className="flex items-center gap-2 text-xs opacity-40 px-1">
        <span className="badge badge-xs badge-info">Planning</span>
        <span>→</span>
        <span className="badge badge-xs badge-warning">Todo</span>
        <span>→</span>
        <span className="badge badge-xs badge-primary">Execute</span>
        <span>→</span>
        <span className="badge badge-xs badge-secondary">Review</span>
        <span>→</span>
        <span className="badge badge-xs badge-success">Done</span>
      </div>

      {/* Stage cards */}
      {STAGES.map((stage) => (
        <StageCard
          key={stage.key}
          stage={stage}
          config={workflow[stage.key]}
          providers={providers}
          modelsByProvider={modelsByProvider}
          onChange={(newConfig) => setWorkflow({ ...workflow, [stage.key]: newConfig })}
        />
      ))}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2">
        <button className="btn btn-primary btn-sm gap-1.5" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : saved ? <Check className="size-3.5" /> : <Save className="size-3.5" />}
          {saving ? "Saving..." : saved ? "Saved!" : "Save Workflow"}
        </button>
        <button className="btn btn-ghost btn-sm gap-1" onClick={handleReset}>
          <RotateCcw className="size-3" /> Reset to defaults
        </button>
      </div>
    </div>
  );
}
