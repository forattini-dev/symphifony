import React, { useState, useCallback } from "react";
import { Copy, Check, Terminal } from "lucide-react";

// ── Section ──────────────────────────────────────────────────────────────────

export function Section({ title, icon: Icon, children, badge }) {
  return (
    <div className="space-y-2">
      <div className="font-semibold text-sm flex items-center gap-1.5">
        {Icon && <Icon className="size-4 opacity-50" />}
        {title}
        {badge != null && <span className="badge badge-xs badge-ghost ml-auto">{badge}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

// ── Field ────────────────────────────────────────────────────────────────────

export function Field({ label, value, mono }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="flex justify-between items-baseline gap-4 py-0.5">
      <span className="text-xs opacity-50 shrink-0">{label}</span>
      <span className={`text-sm text-right truncate ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

// ── CopyButton ───────────────────────────────────────────────────────────────

export function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);
  return (
    <button className={`btn btn-xs btn-ghost gap-1 ${copied ? "text-success" : ""}`} onClick={copy} title="Copy to clipboard">
      {copied ? <Check className="size-3 animate-bounce-in" /> : <Copy className="size-3" />}
      {copied ? <span className="animate-fade-in">Copied</span> : "Copy"}
    </button>
  );
}

// ── ConfigStrip ──────────────────────────────────────────────────────────────

export function ConfigStrip({ config, variant }) {
  if (!config) return null;
  const { provider, model, effort } = config;
  if (!provider && !model && !effort) return null;
  const isHistorical = variant === "historical";
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {provider && (
        <span className={`badge badge-xs font-mono gap-1 ${isHistorical ? "badge-primary/50" : "badge-ghost"}`}>
          <Terminal className="size-2.5" />{provider}
        </span>
      )}
      {model && <span className={`badge badge-xs font-mono ${isHistorical ? "badge-primary/50" : "badge-ghost"}`}>{model}</span>}
      {effort && <span className={`badge badge-xs ${isHistorical ? "badge-primary badge-outline" : "badge-outline"}`}>{effort}</span>}
    </div>
  );
}

/**
 * Infer provider from model name.
 */
function inferProvider(model) {
  if (!model) return undefined;
  if (model.startsWith("claude")) return "claude";
  if (model.startsWith("gpt") || model.startsWith("codex") || model.startsWith("o")) return "codex";
  if (model.startsWith("gemini")) return "gemini";
  return undefined;
}

/**
 * Resolves what to show for a pipeline stage: historical (what ran) vs configured (what will run).
 * Returns { config, label, variant } where variant is "historical" | "configured".
 */
export function resolveStageDisplay({ phaseTokens, tokensByModel, workflowConfig, stageName, phaseRan }) {
  const hasTokens = phaseTokens?.totalTokens > 0;
  const hasRun = phaseRan ?? hasTokens;
  const stageConfig = workflowConfig?.workflow?.[stageName];

  if (hasRun) {
    // Phase already ran — prefer actual model from token data
    let model = phaseTokens?.model;

    // Fallback: if no model on phase, try to infer from tokensByModel
    if (!model && tokensByModel) {
      const models = Object.keys(tokensByModel).filter((m) => tokensByModel[m]?.totalTokens > 0);
      if (models.length === 1) model = models[0];
    }

    if (model) {
      return {
        config: { provider: inferProvider(model), model, effort: undefined },
        label: "Ran with",
        variant: "historical",
      };
    }

    // Ran but can't determine exact model — show config as best-effort with "Ran with" label
    if (stageConfig) {
      return {
        config: stageConfig,
        label: "Ran with",
        variant: "historical",
      };
    }
  }

  // Phase hasn't run — show configured
  if (stageConfig) {
    return {
      config: stageConfig,
      label: "Configured",
      variant: "configured",
    };
  }

  return null;
}

// ── TokenPhaseBreakdown ───────────────────────────────────────────────────────

const PHASE_LABELS = { planner: "Plan", executor: "Execute", reviewer: "Review" };
const PHASE_COLORS = { planner: "text-info", executor: "text-primary", reviewer: "text-secondary" };

export function TokenPhaseBreakdown({ tokensByPhase, tokensByModel }) {
  const phases = tokensByPhase ? Object.entries(tokensByPhase).filter(([, v]) => v?.totalTokens > 0) : [];
  const models = tokensByModel ? Object.entries(tokensByModel).filter(([, v]) => v?.totalTokens > 0) : [];
  if (phases.length === 0 && models.length === 0) return null;

  const fmt = (n) => (n ?? 0).toLocaleString();

  return (
    <div className="space-y-3">
      {phases.length > 0 && (
        <div className="space-y-1">
          {phases.map(([phase, usage]) => (
            <div key={phase} className="flex items-center gap-2 text-xs">
              <span className={`w-14 shrink-0 font-medium ${PHASE_COLORS[phase] || "text-base-content"}`}>
                {PHASE_LABELS[phase] || phase}
              </span>
              <span className="opacity-50">{fmt(usage.totalTokens)} total</span>
              <span className="opacity-30 text-[10px]">{fmt(usage.inputTokens)}↑ {fmt(usage.outputTokens)}↓</span>
              {usage.model && <span className="badge badge-xs badge-ghost font-mono ml-auto">{usage.model}</span>}
            </div>
          ))}
          {phases.length > 1 && (
            <div className="flex items-center gap-2 text-xs border-t border-base-300 pt-1 mt-1">
              <span className="w-14 shrink-0 font-semibold opacity-60">Total</span>
              <span className="font-semibold">
                {fmt(phases.reduce((s, [, v]) => s + (v.totalTokens ?? 0), 0))}
              </span>
            </div>
          )}
        </div>
      )}
      {models.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wider opacity-40 mb-1">by model</div>
          {models.map(([model, usage]) => (
            <div key={model} className="flex items-center gap-2 text-xs">
              <span className="font-mono opacity-70 truncate flex-1">{model}</span>
              <span className="opacity-50 shrink-0">{fmt(usage.totalTokens)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
