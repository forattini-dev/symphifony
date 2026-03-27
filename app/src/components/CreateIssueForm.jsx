import { useState, useEffect, useRef, useCallback } from "react";
import { X, Lightbulb, Loader2, Sparkles, FileText, Bug, RefreshCw, BookOpen, Wrench, Paperclip, ImageIcon, Mic, MicOff } from "lucide-react";
import { useSwipeToDismiss } from "../hooks/useSwipeToDismiss.js";
import { api } from "../api.js";
import { useSpeechToText } from "../hooks/useSpeechToText.js";
import { VoiceWaveform } from "./VoiceWaveform.jsx";

const ISSUE_TEMPLATES = [
  { id: "blank",    label: "Blank",         icon: FileText,  activeColor: "border-base-content/30 bg-base-content/5 text-base-content",         title: "",            description: "" },
  { id: "bug",      label: "Bug Fix",        icon: Bug,       activeColor: "border-error/50 bg-error/8 text-error",                               title: "fix: ",       description: "## Problem\n\n## Expected Behavior\n\n## Steps to Reproduce\n\n" },
  { id: "feature",  label: "Feature",        icon: Sparkles,  activeColor: "border-primary/50 bg-primary/8 text-primary",                         title: "feat: ",      description: "## Goal\n\n## Acceptance Criteria\n\n## Notes\n\n" },
  { id: "refactor", label: "Refactor",       icon: RefreshCw, activeColor: "border-warning/50 bg-warning/8 text-warning",                         title: "refactor: ",  description: "## Current State\n\n## Desired State\n\n## Scope\n\n" },
  { id: "docs",     label: "Docs",           icon: BookOpen,  activeColor: "border-info/50 bg-info/8 text-info",                                  title: "docs: ",      description: "## What to Document\n\n## Target Audience\n\n" },
  { id: "chore",    label: "Chore",          icon: Wrench,    activeColor: "border-secondary/50 bg-secondary/8 text-secondary",                   title: "chore: ",     description: "## Task\n\n## Why Now\n\n" },
];

export function CreateIssueDrawer({ open, onClose, onSubmit, isLoading, onToast, defaultValues }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("blank");
  const [enhancing, setEnhancing] = useState({ title: false, description: false });
  const [images, setImages] = useState([]); // [{ name, preview, path }]
  const [uploading, setUploading] = useState(false);
  const [voiceTarget, setVoiceTarget] = useState(null); // "title" | "description" | null
  const titleRef = useRef(null);
  const descRef = useRef(null);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);

  // ── Speech-to-text ──────────────────────────────────────────────────
  const speech = useSpeechToText({ language: "pt-BR" });
  const canUseSpeech = speech.supported;

  // Snapshot: text before/after cursor when recording started
  const voiceInsertRef = useRef({ before: "", after: "" });

  const toggleVoice = useCallback((field) => {
    if (speech.listening && voiceTarget === field) {
      speech.stop();
      setVoiceTarget(null);
      return;
    }
    if (speech.listening) speech.stop();

    // Capture cursor position
    const el = field === "title" ? titleRef.current : descRef.current;
    const value = field === "title" ? title : description;
    const pos = el?.selectionStart ?? value.length;
    voiceInsertRef.current = {
      before: value.slice(0, pos),
      after: value.slice(pos),
    };

    setVoiceTarget(field);
    speech.start();
  }, [speech, voiceTarget, title, description]);

  // Insert transcript at cursor position as it comes in
  useEffect(() => {
    if (!voiceTarget || !speech.transcript) return;
    const { before, after } = voiceInsertRef.current;
    const space = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
    const combined = `${before}${space}${speech.transcript}${after ? (after.startsWith(" ") || after.startsWith("\n") ? "" : " ") + after : ""}`;
    if (voiceTarget === "title") setTitle(combined);
    else setDescription(combined);
  }, [speech.transcript, voiceTarget]);

  // Stop when drawer closes
  useEffect(() => {
    if (!open && speech.listening) {
      speech.stop();
      setVoiceTarget(null);
    }
  }, [open, speech]);

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
      setTitle(defaultValues?.title ?? "");
      setDescription(defaultValues?.description ?? "");
      setSelectedTemplate(defaultValues?.issueType ?? "blank");
      setImages([]);
      setTimeout(() => titleRef.current?.focus(), 100);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const uploadFiles = useCallback(async (files) => {
    if (!files.length) return;
    setUploading(true);
    try {
      const encoded = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, data: reader.result.split(",")[1], type: file.type, preview: reader.result });
        reader.onerror = reject;
        reader.readAsDataURL(file);
      })));
      const res = await api.post("/attachments/upload", { files: encoded.map(({ name, data, type }) => ({ name, data, type })) });
      if (res.ok && res.paths) {
        const newImages = res.paths.map((path, i) => ({ name: files[i]?.name ?? path, preview: encoded[i]?.preview, path }));
        setImages((prev) => [...prev, ...newImages]);
      } else {
        onToast?.(res.error || "Upload failed", "error");
      }
    } catch {
      onToast?.("Upload failed", "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [onToast]);

  useEffect(() => {
    if (!open) return;
    const handlePaste = (e) => {
      const files = Array.from(e.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (files.length) uploadFiles(files);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [open, uploadFiles]);

  const handleFileSelect = (e) => uploadFiles(Array.from(e.target.files ?? []));

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      description: description.trim(),
      issueType: selectedTemplate !== "blank" ? selectedTemplate : undefined,
      images: images.map((img) => img.path),
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
        issueType: selectedTemplate,
        images: images.map((img) => img.path),
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
          <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-base-300 shrink-0">
            <div className="flex items-center gap-2">
              <Lightbulb className="size-5 opacity-60" />
              <h2 className="text-lg font-bold">New Issue</h2>
            </div>
            <button type="button" className="btn btn-sm btn-ghost btn-circle" onClick={onClose}>
              <X className="size-4" />
            </button>
          </div>

          <div ref={scrollRef} className={`flex-1 overflow-y-auto px-4 sm:px-6 py-4 sm:py-6 flex flex-col gap-4 drawer-safe-bottom ${open ? "stagger-children" : ""}`}>
            {/* Templates — compact wrap on mobile, grid on desktop */}
            <div className="flex flex-wrap sm:grid sm:grid-cols-3 gap-1.5">
              {ISSUE_TEMPLATES.map((tpl) => {
                const Icon = tpl.icon;
                const isActive = selectedTemplate === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => applyTemplate(tpl.id)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 sm:py-2 rounded-lg border text-left transition-all duration-150 text-xs sm:text-sm font-medium ${
                      isActive
                        ? tpl.activeColor
                        : "border-base-300 text-base-content/50 hover:border-base-content/20 hover:text-base-content/70 hover:bg-base-200/50"
                    }`}
                  >
                    <Icon className="size-3 sm:size-3.5 shrink-0" />
                    {tpl.label}
                  </button>
                );
              })}
            </div>

            {/* Title field */}
            <div className="form-control">
              <label className="label pb-1">
                <span className="label-text font-medium">What needs to be done?</span>
              </label>
              <input
                ref={titleRef}
                className={`input input-bordered w-full ${speech.listening && voiceTarget === "title" ? "border-error/50 bg-error/5" : ""}`}
                placeholder={speech.listening && voiceTarget === "title" ? "Listening... speak now" : "Fix the login redirect bug"}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
              <div className="flex items-center gap-1 mt-1.5">
                {canUseSpeech && (
                  <button
                    type="button"
                    className={`btn btn-xs gap-1 ${speech.listening && voiceTarget === "title" ? "btn-error" : "btn-ghost opacity-50 hover:opacity-100"}`}
                    onClick={() => toggleVoice("title")}
                  >
                    {speech.listening && voiceTarget === "title" ? <MicOff className="size-3" /> : <Mic className="size-3" />}
                    {speech.listening && voiceTarget === "title" ? "Stop" : "Dictate"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-xs btn-soft btn-secondary gap-1"
                  onClick={() => handleEnhance("title")}
                  disabled={enhancing.title || isLoading || !title.trim()}
                >
                  {enhancing.title ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                  Enhance
                </button>
              </div>
              <VoiceWaveform active={speech.listening && voiceTarget === "title"} onStop={() => toggleVoice("title")} />
            </div>

            {/* Description field */}
            <div className="form-control">
              <label className="label pb-1">
                <span className="label-text font-medium">Context & details</span>
              </label>
              <textarea
                ref={descRef}
                className={`textarea textarea-bordered w-full min-h-32 sm:min-h-40 resize-none ${speech.listening && voiceTarget === "description" ? "border-error/50 bg-error/5" : ""}`}
                placeholder={speech.listening && voiceTarget === "description" ? "Listening... speak now" : "Describe the problem, expected behavior, acceptance criteria..."}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <div className="flex items-center gap-1 mt-1.5">
                {canUseSpeech && (
                  <button
                    type="button"
                    className={`btn btn-xs gap-1 ${speech.listening && voiceTarget === "description" ? "btn-error" : "btn-ghost opacity-50 hover:opacity-100"}`}
                    onClick={() => toggleVoice("description")}
                  >
                    {speech.listening && voiceTarget === "description" ? <MicOff className="size-3" /> : <Mic className="size-3" />}
                    {speech.listening && voiceTarget === "description" ? "Stop" : "Dictate"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-xs btn-soft btn-secondary gap-1"
                  onClick={() => handleEnhance("description")}
                  disabled={enhancing.description || isLoading || !title.trim()}
                >
                  {enhancing.description ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                  Enhance
                </button>
              </div>
              <VoiceWaveform active={speech.listening && voiceTarget === "description"} onStop={() => toggleVoice("description")} />
            </div>

            <div className="form-control">
              <label className="label justify-between gap-2">
                <span className="label-text font-medium">Screenshots & Evidence</span>
                <button
                  type="button"
                  className="btn btn-xs btn-soft btn-ghost gap-1"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? <Loader2 className="size-3 animate-spin" /> : <Paperclip className="size-3" />}
                  Attach
                </button>
              </label>
              <input ref={fileInputRef} type="file" multiple accept="image/*" className="hidden" onChange={handleFileSelect} />
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {images.map((img, i) => (
                    <div key={i} className="relative group">
                      {img.preview
                        ? <img src={img.preview} alt={img.name} className="size-16 object-cover rounded-lg border border-base-300" />
                        : <div className="size-16 rounded-lg border border-base-300 bg-base-200 flex items-center justify-center"><ImageIcon className="size-5 opacity-40" /></div>
                      }
                      <button
                        type="button"
                        className="absolute -top-1.5 -right-1.5 size-4 rounded-full bg-error text-error-content flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                      >
                        <X className="size-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-base-200 rounded-box p-3 text-xs opacity-60 space-y-1">
              <p>The issue will be created in <strong>Planning</strong> state.</p>
              <p>Open it to generate an AI plan, review it, then approve to start execution.</p>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-4 sm:px-6 py-3 sm:py-4 border-t border-base-300 shrink-0 max-sm:flex-col-reverse" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)" }}>
            <button type="button" className="btn btn-ghost btn-sm sm:btn-md max-sm:w-full" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary btn-sm sm:btn-md gap-1.5 max-sm:w-full" disabled={isLoading || !title.trim()}>
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
