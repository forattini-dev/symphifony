import { useState } from "react";
import { Cpu, Zap, Clock, Hash, ChevronDown, ChevronUp, CircleDot, RefreshCw, ArrowDown, ArrowUp, CalendarClock } from "lucide-react";

function formatTokens(count) {
  if (!count || count === 0) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function formatRelativeTime(isoDate) {
  if (!isoDate) return "";
  const target = new Date(isoDate);
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) return "now";
  const diffH = Math.floor(diffMs / (1000 * 60 * 60));
  const diffD = Math.floor(diffH / 24);
  if (diffD > 0) return `${diffD}d ${diffH % 24}h`;
  const diffM = Math.floor((diffMs / (1000 * 60)) % 60);
  if (diffH > 0) return `${diffH}h ${diffM}m`;
  return `${diffM}m`;
}

function UsageMeter({ label, period, icon: Icon }) {
  const hasBreakdown = period.inputTokens > 0 && period.outputTokens > 0;
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-base-100">
      <div className="p-2 rounded-lg bg-base-300">
        <Icon className="size-4 opacity-70" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs opacity-60">{label}</div>
        <div className="font-mono font-semibold text-sm">{formatTokens(period.tokensUsed)} tokens</div>
        {hasBreakdown && (
          <div className="flex gap-3 mt-0.5">
            <span className="text-[10px] opacity-50 flex items-center gap-0.5">
              <ArrowDown className="size-2.5" /> {formatTokens(period.inputTokens)}
            </span>
            <span className="text-[10px] opacity-50 flex items-center gap-0.5">
              <ArrowUp className="size-2.5" /> {formatTokens(period.outputTokens)}
            </span>
          </div>
        )}
      </div>
      <div className="text-right">
        <div className="text-xs opacity-60">sessions</div>
        <div className="font-mono text-sm">{period.sessions}</div>
      </div>
    </div>
  );
}

function WeeklyProgressBar({ percentUsed, weeklyLimit, weeklyUsed }) {
  if (percentUsed == null) return null;

  const progressClass =
    percentUsed >= 90 ? "progress-error" :
    percentUsed >= 70 ? "progress-warning" :
    "progress-primary";

  const available = Math.max(0, 100 - percentUsed);

  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="opacity-60">Weekly quota</span>
        <span className="font-mono">
          {formatTokens(weeklyUsed)} / {formatTokens(weeklyLimit)}
        </span>
      </div>
      <progress
        className={`progress ${progressClass} w-full`}
        value={percentUsed}
        max={100}
      />
      <div className="flex justify-between text-[10px] mt-1">
        <span className="opacity-50">{percentUsed}% used</span>
        <span className={`font-semibold ${available <= 10 ? "text-error" : available <= 30 ? "text-warning" : "text-success"}`}>
          {available}% available
        </span>
      </div>
    </div>
  );
}

function ResetCountdown({ nextResetAt, resetInfo }) {
  const relative = formatRelativeTime(nextResetAt);
  const resetDate = nextResetAt ? new Date(nextResetAt) : null;
  const formatted = resetDate
    ? resetDate.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
    : "";

  return (
    <div className="flex items-center gap-2 text-xs bg-base-100 rounded-lg px-3 py-2">
      <CalendarClock className="size-3.5 opacity-50 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="opacity-50">{resetInfo}</div>
        {nextResetAt && (
          <div className="font-mono font-medium mt-0.5">
            Resets in <span className="text-primary">{relative}</span>
            <span className="opacity-40"> — {formatted}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ModelsList({ models, currentModel }) {
  const [expanded, setExpanded] = useState(false);
  const visibleModels = expanded ? models : models.slice(0, 4);

  return (
    <div>
      <div className="space-y-1">
        {visibleModels.map((m) => (
          <div
            key={m.slug}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
              m.slug === currentModel ? "bg-primary/10 border border-primary/30" : "bg-base-100"
            }`}
          >
            <CircleDot className={`size-3 ${m.slug === currentModel ? "text-primary" : "opacity-30"}`} />
            <span className="font-mono text-xs flex-1 truncate">{m.displayName || m.slug}</span>
            {m.slug === currentModel && (
              <span className="badge badge-xs badge-primary">active</span>
            )}
          </div>
        ))}
      </div>
      {models.length > 4 && (
        <button
          className="btn btn-xs btn-ghost mt-1 w-full gap-1"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          {expanded ? "Show less" : `+${models.length - 4} more`}
        </button>
      )}
    </div>
  );
}

function ProviderCard({ provider }) {
  const { name, available, models, currentModel, usage, resetInfo, nextResetAt, weeklyLimitEstimate, percentUsed } = provider;

  const displayName = name === "claude" ? "Claude Code" : name === "codex" ? "Codex CLI" : name;
  const brandColor = name === "claude" ? "text-warning" : "text-info";

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className={`size-5 ${brandColor}`} />
            <h3 className="card-title text-sm">{displayName}</h3>
          </div>
          <span className={`badge badge-sm ${available ? "badge-success" : "badge-error"}`}>
            {available ? "available" : "not found"}
          </span>
        </div>

        {/* Current model */}
        {currentModel && (
          <div className="text-xs opacity-60">
            Active model: <span className="font-mono font-medium opacity-100">{currentModel}</span>
          </div>
        )}

        {/* Weekly quota progress */}
        <WeeklyProgressBar
          percentUsed={percentUsed}
          weeklyLimit={weeklyLimitEstimate}
          weeklyUsed={usage.thisWeek.tokensUsed}
        />

        {/* Usage stats */}
        <div className="space-y-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide opacity-50">Token usage</h4>
          <UsageMeter label="Today" period={usage.today} icon={Zap} />
          <UsageMeter label="This week" period={usage.thisWeek} icon={Hash} />
          <UsageMeter label="All time" period={usage.allTime} icon={Clock} />
        </div>

        {/* Reset countdown */}
        <ResetCountdown nextResetAt={nextResetAt} resetInfo={resetInfo} />

        {/* Models */}
        {models.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide opacity-50 mb-2">
              Available Models ({models.length})
            </h4>
            <ModelsList models={models} currentModel={currentModel} />
          </div>
        )}
      </div>
    </div>
  );
}

export function ProvidersView({ providersUsage }) {
  const data = providersUsage?.data;
  const providers = data?.providers || [];
  const isLoading = providersUsage?.isLoading;

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="loading loading-spinner loading-md"></span>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2 opacity-50">
        <Cpu className="size-8" />
        <p className="text-sm">No providers detected</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        {providers.map((p) => (
          <ProviderCard key={p.name} provider={p} />
        ))}
      </div>

      {data?.collectedAt && (
        <p className="text-xs opacity-40 text-center">
          Last collected: {new Date(data.collectedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

export default ProvidersView;
