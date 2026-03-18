import { useState, useEffect, useRef, useCallback } from "react";
import { X, Lightbulb, Loader2, Sparkles, FileText, Bug, RefreshCw, BookOpen, Wrench } from "lucide-react";
import { useSwipeToDismiss } from "../hooks/useSwipeToDismiss.js";
import { api } from "../api.js";

const ISSUE_TEMPLATES = [
  { id: "blank", label: "Blank", icon: FileText, title: "", description: "" },
  { id: "bug", label: "Bug Fix", icon: Bug, title: "fix: ", description: "## Problem\n\n## Expected Behavior\n\n## Steps to Reproduce\n\n" },
  { id: "feature", label: "Feature", icon: Sparkles, title: "feat: ", description: "## Goal\n\n## Acceptance Criteria\n\n## Notes\n\n" },
  { id: "refactor", label: "Refactor", icon: RefreshCw, title: "refactor: ", description: "## Current State\n\n## Desired State\n\n## Scope\n\n" },
  { id: "docs", label: "Documentation", icon: BookOpen, title: "docs: ", description: "## What to Document\n\n## Target Audience\n\n" },
  { id: "chore", label: "Chore", icon: Wrench, title: "chore: ", description: "## Task\n\n## Why Now\n\n" },
];

export function CreateIssueDrawer({ open, onClose, onSubmit, isLoading, onToast }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("blank");
  const [enhancing, setEnhancing] = useState({ title: false, description: false });
  const titleRef = useRef(null);
  const scrollRef = useRef(null);

  const applyTemplate = useCallback((templateId) => {
    const tpl = ISSUE_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    setSelectedTemplate(templateId);
    setTitle(tpl.title);
    setDescription(tpl.description);
    setTimeout(() => titleRef.current?.focus(), 50);
  }, []);

  const onDismiss = useCallback(() => onClose(), [onClose]);
  const { ref: swipeRef, handlers: swipeHandlers } = useSwipeToDismiss({ onDismiss, direction: "right" });

  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setSelectedTemplate("blank");
      setTimeout(() => titleRef.current?.focus(), 100);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);


  const handleSubmit = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      description: description.trim(),
    });
  };

  const handleEnhance = async (field) => {
    if (!title.trim() && field === "description") return;
    setEnhancing((prev) => ({ ...prev, [field]: true }));
    try {
      const res = await api.post("/issues/enhance", {
        field,
        title: title.trim(),
        description: description.trim(),
      });
      if (res.ok && typeof res.value === "string" && res.value.trim()) {
        if (field === "title") setTitle(res.value.trim());
        else setDescription(res.value.trim());
        onToast?.(`Enhanced ${field}`, "success");
      } else {
        throw new Error(res.error || "No enhanced value returned.");
      }
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : "Enhance failed", "error");
    } finally {
      setEnhancing((prev) => ({ ...prev, [field]: false }));
    }
  };

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/30 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />

      <div
        ref={swipeRef}
        className={`fixed top-0 right-0 h-full z-50 bg-base-100 shadow-2xl transition-transform duration-300 ease-out
          w-full md:w-[480px] ${open ? "translate-x-0" : "translate-x-full"}`}
        {...swipeHandlers}
      >
        <form onSubmit={handleSubmit} className="flex flex-col h-full">
          <div className="flex items-center justify-between px-6 py-4 border-b border-base-300">
            <div className="flex items-center gap-2">
              <Lightbulb className="size-5 opacity-60" />
              <h2 className="text-lg font-bold">New Issue</h2>
            </div>
            <button type="button" className="btn btn-sm btn-ghost btn-circle" onClick={onClose}>
              <X className="size-4" />
            </button>
          </div>

          <div ref={scrollRef} className={`flex-1 overflow-y-auto px-6 py-6 space-y-4 drawer-safe-bottom ${open ? "stagger-children" : ""}`}>
            <div className="flex flex-wrap gap-1.5">
              {ISSUE_TEMPLATES.map((tpl) => {
                const Icon = tpl.icon;
                const isActive = selectedTemplate === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    className={`btn btn-xs gap-1 ${isActive ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => applyTemplate(tpl.id)}
                  >
                    <Icon className="size-3" />
                    {tpl.label}
                  </button>
                );
              })}
            </div>

            <div className="form-control">
              <label className="label justify-between gap-2">
                <span className="label-text font-medium">What needs to be done?</span>
                <button
                  type="button"
                  className="btn btn-xs btn-soft btn-secondary gap-1"
                  onClick={() => handleEnhance("title")}
                  disabled={enhancing.title || isLoading || !title.trim()}
                >
                  {enhancing.title ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                  Enhance
                </button>
              </label>
              <input
                ref={titleRef}
                className="input input-bordered w-full"
                placeholder="Fix the login redirect bug"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="form-control">
              <label className="label justify-between gap-2">
                <span className="label-text font-medium">Context & details</span>
                <button
                  type="button"
                  className="btn btn-xs btn-soft btn-secondary gap-1"
                  onClick={() => handleEnhance("description")}
                  disabled={enhancing.description || isLoading || !title.trim()}
                >
                  {enhancing.description ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                  Enhance
                </button>
              </label>
              <textarea
                className="textarea textarea-bordered w-full min-h-32"
                placeholder="Describe the problem, expected behavior, acceptance criteria..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="bg-base-200 rounded-box p-3 text-xs opacity-60 space-y-1">
              <p>The issue will be created in <strong>Planning</strong> state.</p>
              <p>Open it to generate an AI plan, review it, then approve to start execution.</p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-base-300 max-sm:flex-col-reverse" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }}>
            <button type="button" className="btn btn-ghost max-sm:w-full" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary gap-1.5 max-sm:w-full" disabled={isLoading || !title.trim()}>
              {isLoading ? <Loader2 className="size-4 animate-spin" /> : <Lightbulb className="size-4" />}
              {isLoading ? "Creating..." : "Create Issue"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

export default CreateIssueDrawer;
