import React, { useState, useEffect, useRef } from "react";
import {
  AlertTriangle, RotateCcw, Zap, Loader, MessageSquare, SlidersHorizontal,
  CheckCircle2, Info, Layers, ListOrdered, Folder, ChevronDown,
} from "lucide-react";
import { api } from "../../../api.js";
import { timeAgo, formatDuration } from "../../../utils.js";
import { Section, ConfigStrip, resolveStageDisplay } from "../shared.jsx";

// ── Constants ────────────────────────────────────────────────────────────────

const COMPLEXITY_COLOR = { trivial: "badge-ghost", low: "badge-success", medium: "badge-warning", high: "badge-error" };

// ── PlanningTab ───────────────────────────────────────────────────────────────

export function PlanningTab({ issue, onStateChange, workflowConfig }) {
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState(null);
  const [localGenerating, setLocalGenerating] = useState(false);
  const [localRefining, setLocalRefining] = useState(false);
  const [localApproving, setLocalApproving] = useState(false);
  const [localReplanning, setLocalReplanning] = useState(false);
  const [showPlanHistory, setShowPlanHistory] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [showAllRefinements, setShowAllRefinements] = useState(false);
  const refineRef = useRef(null);
  const plan = issue.plan;
  const isPlanning = issue.state === "Planning";
  const refinementCount = plan?.refinements?.length || 0;
  const planHistory = Array.isArray(issue.planHistory) ? issue.planHistory : [];
  const planVersion = issue.planVersion ?? 0;
  const FEEDBACK_MAX = 2000;

  // Show server-side planning errors
  const displayError = error || issue.planningError;

  // Server-driven status via WS, with local fallback for optimistic updates
  const isServerGenerating = issue.planningStatus === "planning";
  const isGenerating = isServerGenerating || (localGenerating && !plan);
  const isRefining = (isServerGenerating && localRefining) || localRefining;
  const isBusy = isGenerating || isRefining;
  const isPendingScheduler = isPlanning && !plan && !displayError && !isGenerating;

  // Clear local error when server error changes
  useEffect(() => {
    if (issue.planningError) setError(null);
  }, [issue.planningError]);

  // Auto-clear local generating state when plan appears or error is set
  useEffect(() => {
    if (localGenerating && (plan || issue.planningError)) {
      setLocalGenerating(false);
    }
  }, [localGenerating, plan, issue.planningError]);

  // Auto-clear local refining state when server confirms it's done or errors
  useEffect(() => {
    if (localRefining && (issue.planningStatus !== "planning" || issue.planningError)) {
      setLocalRefining(false);
    }
  }, [localRefining, issue.planningStatus, issue.planningError]);

  // Safety timeout: clear generating after 5 minutes
  useEffect(() => {
    if (!localGenerating) return;
    const timer = setTimeout(() => {
      setLocalGenerating(false);
      setError("Plan generation timed out. The plan may still be generating in the background — check back soon.");
    }, 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [localGenerating]);

  // Track elapsed time while planning/refining
  useEffect(() => {
    if (!isBusy) { setElapsed(0); return; }
    const startedAt = issue.planningStartedAt ? new Date(issue.planningStartedAt).getTime() : Date.now();
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [isBusy, issue.planningStartedAt]);

  // Auto-focus refine textarea when plan loads
  useEffect(() => {
    if (plan && isPlanning && refineRef.current) {
      const t = setTimeout(() => refineRef.current?.focus(), 300);
      return () => clearTimeout(t);
    }
  }, [plan, isPlanning]);

  const handleGenerate = async (fast = false) => {
    setError(null);
    setLocalGenerating(true);
    try {
      const res = await api.post(`/issues/${encodeURIComponent(issue.id)}/plan`, { fast });
      if (!res.ok) throw new Error(res.error || "Plan generation failed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLocalGenerating(false);
    }
  };

  const handleApprove = async () => {
    setLocalApproving(true);
    try {
      await api.post(`/issues/${encodeURIComponent(issue.id)}/approve`);
      // approve already transitions Planning → PendingApproval → Queued (FSM handles execution dispatch)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLocalApproving(false);
    }
  };

  const handleRefine = async () => {
    if (!feedback.trim()) return;
    setError(null);
    setLocalRefining(true);
    try {
      const res = await api.post(`/issues/${encodeURIComponent(issue.id)}/plan/refine`, { feedback: feedback.trim() });
      if (!res.ok) throw new Error(res.error || "Refinement failed.");
      setFeedback("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLocalRefining(false);
    }
  };

  const handleReplan = async () => {
    setError(null);
    setLocalReplanning(true);
    try {
      const res = await api.post(`/issues/${encodeURIComponent(issue.id)}/replan`);
      if (!res.ok) throw new Error(res.error || "Replan failed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocalReplanning(false);
    }
  };

  // No plan yet and not generating
  if (!plan && !isGenerating) {
    if (isPlanning) {
      return (
        <div className="space-y-4 py-4">
          {isPendingScheduler && (
              <div className="flex flex-col items-center justify-center gap-4 py-10">
                <div className="flex items-center gap-2">
                  <span className="loading loading-dots loading-sm text-info" />
                  <span className="text-sm opacity-60">Queued — waiting for the planner worker...</span>
                </div>
                <div className="text-xs opacity-30">The plan will be generated automatically shortly.</div>
                <div className="flex items-center gap-2 mt-2">
                  <button className="btn btn-ghost btn-xs gap-1 opacity-50 hover:opacity-100" onClick={() => handleGenerate(false)}>
                  <Zap className="size-3" /> Generate now
                  </button>
                </div>
              </div>
            )}
            {displayError && (
              <div className="space-y-3">
                <div className="alert alert-error text-sm flex-col items-start gap-1">
                  <div className="font-medium flex items-center gap-1.5"><AlertTriangle className="size-4" /> Plan generation failed</div>
                  <div className="text-xs opacity-80">{displayError}</div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button className="btn btn-primary btn-sm gap-1.5" onClick={() => handleGenerate(false)}>
                  <RotateCcw className="size-3.5" /> Try again
                  </button>
                <button className="btn btn-ghost btn-sm gap-1" onClick={() => handleGenerate(true)}>
                  <Zap className="size-3.5" /> Fast
                </button>
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-4 py-4">
        <div className="space-y-1">
          <div className="text-sm font-medium opacity-70">No plan yet</div>
          <p className="text-xs opacity-40">Generate an AI plan to break this issue into actionable steps.</p>
        </div>
        {displayError && <div className="alert alert-error text-sm">{displayError}</div>}
      </div>
    );
  }

  // Generating (server-driven via WS)
  if (isGenerating && !plan) {
    const elapsedStr = elapsed > 0 ? formatDuration(elapsed * 1000) : "";
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-12">
        <Loader className="size-8 animate-spin text-primary" />
        <div className="text-sm opacity-60">Generating execution plan...</div>
        <div className="text-xs opacity-30">This may take a few minutes</div>
        {elapsedStr && <div className="text-xs font-mono opacity-40">{elapsedStr} elapsed</div>}
      </div>
    );
  }

  // Plan exists — show it
  return (
    <div className="space-y-5">
      {/* Generating/Refining indicator banner */}
      {isBusy && (
        <div className="rounded-box border border-primary/30 bg-primary/5 p-3 flex items-center gap-3">
          <Loader className="size-4 animate-spin text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-sm text-primary font-medium">
              {isGenerating ? "Re-generating plan..." : `Refining to v${refinementCount + 2}...`}
            </span>
            {elapsed > 0 && (
              <span className="text-xs text-primary/60 ml-2 font-mono">{formatDuration(elapsed * 1000)}</span>
            )}
          </div>
        </div>
      )}

      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`badge badge-sm ${COMPLEXITY_COLOR[plan.estimatedComplexity] || "badge-ghost"}`}>
          {plan.estimatedComplexity} complexity
        </span>
        {planVersion > 0 && (
          <span className="badge badge-sm badge-info badge-soft font-mono">
            Plan v{planVersion}
          </span>
        )}
        {refinementCount > 0 && (
          <span className="badge badge-sm badge-secondary gap-1">
            <RotateCcw className="size-2.5" /> Refined &times;{refinementCount}
          </span>
        )}
      </div>

      {/* Plan config + planner tokens */}
      {(() => {
        const stage = resolveStageDisplay({
          phaseTokens: issue.tokensByPhase?.planner,
          tokensByModel: issue.tokensByModel,
          workflowConfig,
          stageName: "plan",
          phaseRan: !!issue.plan,
        });
        return stage ? (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 text-xs opacity-60">
              <SlidersHorizontal className="size-3 shrink-0" />
              <span className="text-[10px] uppercase tracking-wider opacity-60">{stage.label}</span>
              <ConfigStrip config={stage.config} variant={stage.variant} />
            </div>
            {issue.tokensByPhase?.planner?.totalTokens > 0 && (
              <div className="flex items-center gap-1.5 text-xs opacity-50">
                <Zap className="size-3" />
                <span>{issue.tokensByPhase.planner.totalTokens.toLocaleString()} tokens</span>
              </div>
            )}
          </div>
        ) : null;
      })()}

      {/* Last refinement feedback */}
      {refinementCount > 0 && (
        <div className="rounded-box border-l-4 border-secondary bg-secondary/5 px-4 py-3 animate-fade-in">
          <div className="text-[10px] font-semibold uppercase tracking-wider opacity-40 mb-1">Last refinement feedback</div>
          <p className="text-sm leading-relaxed italic opacity-80">
            &ldquo;{plan.refinements[refinementCount - 1].feedback}&rdquo;
          </p>
          <span className="text-[10px] opacity-30 mt-1 block">
            v{plan.refinements[refinementCount - 1].version || refinementCount + 1} &middot; {timeAgo(plan.refinements[refinementCount - 1].at)}
          </span>
        </div>
      )}

      {/* Summary — re-keyed to animate on refinement */}
      <div key={`plan-content-${refinementCount}`} className="space-y-5 animate-fade-in">
        <Section title="Summary" icon={Info}>
          <p className="text-sm leading-relaxed">{plan.summary}</p>
        </Section>

        {/* Phases */}
        {plan.phases?.length > 0 && (
          <Section title={`Phases (${plan.phases.length})`} icon={Layers}>
            <div className="space-y-3">
              {plan.phases.map((phase, pi) => (
                <div key={pi} className="border border-base-300 rounded-box overflow-hidden">
                  <div className="bg-base-200 px-3 py-2 flex items-center gap-2">
                    <div className="flex items-center justify-center size-5 rounded-full bg-primary/15 text-primary text-[10px] font-bold shrink-0">
                      {pi + 1}
                    </div>
                    <span className="text-sm font-semibold">{phase.phaseName}</span>
                    {phase.tasks?.length > 0 && (
                      <span className="badge badge-xs badge-ghost ml-auto">{phase.tasks.length} tasks</span>
                    )}
                  </div>
                  {phase.goal && (
                    <div className="px-3 pt-2 text-xs opacity-60">{phase.goal}</div>
                  )}
                  {phase.tasks?.length > 0 && (
                    <div className="px-3 pb-2 pt-1.5 space-y-1.5">
                      {phase.tasks.map((t, ti) => (
                        <div key={ti} className="flex gap-2 text-xs">
                          <span className="opacity-30 shrink-0 font-mono w-4">{t.step}.</span>
                          <div className="min-w-0">
                            <span className="font-medium">{t.action}</span>
                            {t.details && <span className="opacity-50 ml-1">— {t.details}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {phase.outputs?.length > 0 && (
                    <div className="px-3 pb-2 flex flex-wrap gap-1">
                      {phase.outputs.map((o) => (
                        <span key={o} className="badge badge-xs badge-outline opacity-60">{o}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Steps */}
        <Section title={`Steps (${plan.steps.length})`} icon={ListOrdered}>
          <div className="space-y-2">
            {plan.steps.map((s, i) => (
              <div key={i} className="flex gap-3 p-3 bg-base-200 rounded-box">
                <div className="flex items-center justify-center size-6 rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">
                  {s.step}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{s.action}</div>
                  {s.details && <div className="text-xs opacity-50 mt-0.5">{s.details}</div>}
                  {s.files?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {s.files.map((f) => (
                        <span key={f} className="badge badge-xs badge-ghost font-mono">{f}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* Suggested paths */}
      {plan.suggestedPaths?.length > 0 && (
        <Section title="Suggested Paths" icon={Folder}>
          <div className="flex flex-wrap gap-1">
            {plan.suggestedPaths.map((p) => <span key={p} className="badge badge-sm badge-ghost font-mono">{p}</span>)}
          </div>
        </Section>
      )}

      {/* Refinement timeline */}
      {refinementCount > 0 && (
        <Section title={`Refinements (${refinementCount})`} icon={MessageSquare}>
          <div className="space-y-2">
            {(() => {
              const items = plan.refinements;
              const collapsed = !showAllRefinements && items.length > 2;
              const visible = collapsed ? items.slice(-2) : items;
              return (
                <>
                  {collapsed && (
                    <button
                      className="btn btn-ghost btn-xs w-full gap-1 opacity-50"
                      onClick={() => setShowAllRefinements(true)}
                    >
                      <ChevronDown className="size-3" /> Show {items.length - 2} earlier refinement{items.length - 2 > 1 ? "s" : ""}
                    </button>
                  )}
                  {visible.map((r, i) => {
                    const actualIndex = collapsed ? items.length - 2 + i : i;
                    return (
                      <div key={actualIndex} className="flex gap-3 p-2.5 bg-base-200 rounded-box text-sm animate-fade-in">
                        <div className="flex items-center justify-center size-6 rounded-full bg-secondary/10 text-secondary text-xs font-bold shrink-0">
                          v{r.version || actualIndex + 2}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm leading-relaxed">{r.feedback}</p>
                          <span className="text-[10px] opacity-40 mt-1 block">{timeAgo(r.at)}</span>
                        </div>
                      </div>
                    );
                  })}
                  {showAllRefinements && items.length > 2 && (
                    <button
                      className="btn btn-ghost btn-xs w-full gap-1 opacity-50"
                      onClick={() => setShowAllRefinements(false)}
                    >
                      Show less
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        </Section>
      )}

      {/* Plan History */}
      {planHistory.length > 0 && (
        <div className="border border-base-300 rounded-box overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-3 py-2 bg-base-200 text-sm font-medium hover:bg-base-300 transition-colors"
            onClick={() => setShowPlanHistory((v) => !v)}
          >
            <span className="flex items-center gap-1.5">
              <RotateCcw className="size-3.5 opacity-60" />
              Plan History ({planHistory.length} previous)
            </span>
            <ChevronDown className={`size-3.5 opacity-60 transition-transform ${showPlanHistory ? "rotate-180" : ""}`} />
          </button>
          {showPlanHistory && (
            <div className="divide-y divide-base-300">
              {planHistory.map((hp, idx) => (
                <div key={idx} className="px-3 py-2.5 space-y-1 text-xs">
                  <div className="flex items-center gap-2 opacity-60">
                    <span className="badge badge-xs badge-ghost font-mono">v{idx + 1}</span>
                    <span>{hp.steps?.length ?? 0} steps</span>
                    <span className="badge badge-xs badge-ghost">{hp.estimatedComplexity}</span>
                    <span className="ml-auto">{timeAgo(hp.createdAt)}</span>
                  </div>
                  <p className="opacity-70 leading-relaxed line-clamp-2">{hp.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Refine plan — chat input */}
      {isPlanning && plan && (
        <div className="border-t border-base-300 pt-4 space-y-2">
          <div className="text-xs font-semibold flex items-center gap-1.5 opacity-70">
            <MessageSquare className="size-3.5" />
            Refine Plan
          </div>
          <div className="relative">
            <textarea
              ref={refineRef}
              className="textarea textarea-bordered w-full text-sm pr-16"
              rows={2}
              placeholder="Give feedback to refine the plan... e.g. 'Use React instead of Vue for step 3'"
              value={feedback}
              maxLength={FEEDBACK_MAX}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={isBusy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && feedback.trim()) {
                  e.preventDefault();
                  handleRefine();
                }
              }}
            />
            <span className={`absolute bottom-2 right-3 text-[10px] pointer-events-none ${feedback.length > FEEDBACK_MAX * 0.9 ? "text-error" : "opacity-30"}`}>
              {feedback.length}/{FEEDBACK_MAX}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-secondary btn-sm gap-1.5"
              onClick={handleRefine}
              disabled={isBusy || !feedback.trim()}
            >
              {isRefining ? (
                <><Loader className="size-3.5 animate-spin" /> Generating v{refinementCount + 2}...</>
              ) : (
                <><RotateCcw className="size-3.5" /> Refine Plan</>
              )}
            </button>
            <span className="text-[10px] opacity-30">Ctrl+Enter to send</span>
          </div>
        </div>
      )}

      {displayError && <div className="alert alert-error text-sm">{displayError}</div>}

      {/* Actions */}
      {isPlanning && !isBusy && (
        <div className="flex items-center gap-2 pt-3 border-t border-base-300 max-sm:flex-col">
          <button className="btn btn-primary gap-1.5 max-sm:w-full" onClick={handleApprove} disabled={localApproving || !plan}>
            {localApproving ? <><Loader className="size-4 animate-spin" /> Starting...</> : <><CheckCircle2 className="size-4" /> Approve & Start</>}
          </button>
          {plan && (
            <button
              className="btn btn-ghost btn-sm gap-1 max-sm:w-full"
              onClick={handleReplan}
              disabled={localReplanning || isBusy}
              title="Archive current plan and generate a new one"
            >
              {localReplanning ? <><Loader className="size-3 animate-spin" /> Replanning...</> : <><RotateCcw className="size-3" /> Replan</>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
