import { useState, useEffect, useRef } from "react";
import { X, Lightbulb, Loader2 } from "lucide-react";

export function CreateIssueDrawer({ open, onClose, onSubmit, isLoading }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const titleRef = useRef(null);

  useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
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

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/30 z-40 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        onClick={onClose}
      />

      <div
        className={`fixed top-0 right-0 h-full z-50 bg-base-100 shadow-2xl transition-transform duration-300 ease-out
          w-full md:w-[480px] ${open ? "translate-x-0" : "translate-x-full"}`}
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

          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
            <div className="form-control">
              <label className="label"><span className="label-text font-medium">What needs to be done?</span></label>
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
              <label className="label"><span className="label-text font-medium">Context & details</span></label>
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

          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-base-300">
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary gap-1.5" disabled={isLoading || !title.trim()}>
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
