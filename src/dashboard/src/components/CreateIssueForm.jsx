import { useState, useEffect, useRef } from "react";
import {
  X, Loader2, WandSparkles, Lightbulb, CheckCircle2, FileCode, Tag,
  Gauge, ArrowRight, Zap,
} from "lucide-react";
import { api } from "../api";

function normalizeCsv(str) {
  return typeof str === "string" ? str.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

const COMPLEXITY_COLOR = {
  trivial: "badge-ghost",
  low: "badge-success",
  medium: "badge-warning",
  high: "badge-error",
};

export function CreateIssueDrawer({ open, onClose, onSubmit, isLoading, onToast }) {
  const [step, setStep] = useState("input"); // "input" | "planning" | "review"
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState(null);
  const titleRef = useRef(null);

  useEffect(() => {
    if (open) {
      setStep("input");
      setTitle("");
      setDescription("");
      setPlan(null);
      setPlanError(null);
      setTimeout(() => titleRef.current?.focus(), 100);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const handlePlan = async () => {
    if (!title.trim()) return;
    setStep("planning");
    setPlanError(null);
    try {
      const res = await api.post("/issues/plan", {
        title: title.trim(),
        description: description.trim(),
      });
      if (!res.ok || !res.plan) throw new Error(res.error || "Plan generation failed.");
      setPlan(res.plan);
      setStep("review");
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : String(error));
      setStep("input");
    }
  };

  const handleCreate = () => {
    if (!title.trim()) return;
    const payload = {
      title: title.trim(),
      description: description.trim(),
      labels: plan?.suggestedLabels || [],
      paths: plan?.suggestedPaths || [],
      effort: plan?.suggestedEffort || undefined,
      plan: plan || undefined,
    };
    onSubmit(payload);
  };

  const handleSkipPlan = () => {
    onSubmit({
      title: title.trim(),
      description: description.trim(),
    });
  };

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/30 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />

      <div
        className={`fixed top-0 right-0 h-full z-50 bg-base-100 shadow-2xl transition-transform duration-300 ease-out
          w-full md:w-[520px] lg:w-[600px] ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-base-300">
            <div className="flex items-center gap-2">
              <Lightbulb className="size-5 opacity-60" />
              <h2 className="text-lg font-bold">
                {step === "review" ? "Review Plan" : "New Issue"}
              </h2>
            </div>
            <button type="button" className="btn btn-sm btn-ghost btn-circle" onClick={onClose}>
              <X className="size-4" />
            </button>
          </div>

          {/* Step: Input */}
          {step === "input" && (
            <>
              <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
                <div className="form-control">
                  <label className="label"><span className="label-text font-medium">What needs to be done?</span></label>
                  <input
                    ref={titleRef}
                    className="input input-bordered w-full"
                    placeholder="Fix the login redirect bug"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>

                <div className="form-control">
                  <label className="label"><span className="label-text font-medium">Context & details</span></label>
                  <textarea
                    className="textarea textarea-bordered w-full min-h-32"
                    placeholder="Describe the problem, expected behavior, acceptance criteria..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>

                {planError && (
                  <div className="alert alert-error text-sm">{planError}</div>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-base-300">
                <button type="button" className="btn btn-ghost btn-sm" onClick={handleSkipPlan} disabled={!title.trim() || isLoading}>
                  Skip plan & create
                </button>
                <button
                  type="button"
                  className="btn btn-primary gap-1.5"
                  onClick={handlePlan}
                  disabled={!title.trim() || isLoading}
                >
                  <Lightbulb className="size-4" />
                  Generate Plan
                </button>
              </div>
            </>
          )}

          {/* Step: Planning (loading) */}
          {step === "planning" && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4">
              <Loader2 className="size-8 animate-spin text-primary" />
              <div className="text-sm opacity-60">Generating execution plan...</div>
              <div className="text-xs opacity-30">This may take a few minutes</div>
            </div>
          )}

          {/* Step: Review */}
          {step === "review" && plan && (
            <>
              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                {/* Issue summary */}
                <div>
                  <h3 className="font-semibold text-base">{title}</h3>
                  {description && <p className="text-sm opacity-60 mt-1">{description}</p>}
                </div>

                {/* Complexity + provider */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`badge badge-sm ${COMPLEXITY_COLOR[plan.estimatedComplexity] || "badge-ghost"}`}>
                    <Gauge className="size-3 mr-1" />
                    {plan.estimatedComplexity} complexity
                  </span>
                  <span className="badge badge-sm badge-ghost">
                    <Zap className="size-3 mr-1" />
                    via {plan.provider}
                  </span>
                  {plan.suggestedEffort?.default && (
                    <span className="badge badge-sm badge-outline">
                      effort: {plan.suggestedEffort.default}
                    </span>
                  )}
                </div>

                {/* Plan summary */}
                <div className="bg-base-200 rounded-box p-4">
                  <div className="text-xs font-semibold opacity-50 mb-2">Plan Summary</div>
                  <p className="text-sm leading-relaxed">{plan.summary}</p>
                </div>

                {/* Steps */}
                <div>
                  <div className="text-xs font-semibold opacity-50 mb-2">
                    Execution Steps ({plan.steps.length})
                  </div>
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
                                <span key={f} className="badge badge-xs badge-ghost font-mono">
                                  <FileCode className="size-2.5 mr-0.5" />{f}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Suggested paths */}
                {plan.suggestedPaths?.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold opacity-50 mb-1.5">
                      <FileCode className="size-3 inline mr-1" />
                      Suggested Paths
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {plan.suggestedPaths.map((p) => (
                        <span key={p} className="badge badge-sm badge-ghost font-mono">{p}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Suggested labels */}
                {plan.suggestedLabels?.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold opacity-50 mb-1.5">
                      <Tag className="size-3 inline mr-1" />
                      Suggested Labels
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {plan.suggestedLabels.map((l) => (
                        <span key={l} className="badge badge-sm badge-outline">{l}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-base-300">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep("input")}>
                  <ArrowRight className="size-3 rotate-180" />
                  Edit
                </button>
                <div className="flex items-center gap-2">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPlan(null); handlePlan(); }}>
                    Re-plan
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary gap-1.5"
                    onClick={handleCreate}
                    disabled={isLoading}
                  >
                    {isLoading ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                    {isLoading ? "Creating..." : "Approve & Create"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export default CreateIssueDrawer;
