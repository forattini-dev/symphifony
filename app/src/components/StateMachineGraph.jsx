import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api.js";
import { X, Loader, GitBranch, Download } from "lucide-react";

/**
 * Fetches the state machine DOT from the API and renders it as SVG
 * using @viz-js/viz (WASM-based GraphViz in the browser).
 */
export function StateMachineGraph({ open, onClose, issueState }) {
  const [svg, setSvg] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) { setSvg(null); return; }
    let alive = true;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const res = await api.get("/state-machine/visualize");
        if (!alive || !res.dot) return;

        // Highlight the current issue state in the DOT source
        let dot = res.dot;
        if (issueState) {
          dot = dot.replace(
            new RegExp(`(${issueState}\\s*\\[)([^\\]]*)(\\])`, "g"),
            `$1$2, color=red, penwidth=3$3`,
          );
        }

        const { instance } = await import("@viz-js/viz");
        const viz = await instance();
        const rendered = viz.renderString(dot, { format: "svg", engine: "dot" });
        if (alive) setSvg(rendered);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => { alive = false; };
  }, [open, issueState]);

  const handleDownload = useCallback(() => {
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "state-machine.svg";
    a.click();
    URL.revokeObjectURL(url);
  }, [svg]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-50 animate-fade-in"
        onClick={onClose}
      />
      {/* Modal */}
      <div className="fixed inset-4 md:inset-12 lg:inset-20 z-50 flex items-center justify-center">
        <div
          className="bg-base-100 rounded-xl shadow-2xl w-full h-full flex flex-col overflow-hidden animate-scale-in"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-base-300 shrink-0">
            <div className="flex items-center gap-2">
              <GitBranch className="size-4 opacity-40" />
              <span className="text-sm font-semibold">Issue State Machine</span>
              {issueState && (
                <span className="badge badge-sm badge-primary">{issueState}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {svg && (
                <button
                  className="btn btn-ghost btn-sm btn-square opacity-50 hover:opacity-100"
                  onClick={handleDownload}
                  title="Download SVG"
                >
                  <Download className="size-3.5" />
                </button>
              )}
              <button
                className="btn btn-ghost btn-sm btn-square"
                onClick={onClose}
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div
            ref={containerRef}
            className="flex-1 overflow-auto flex items-center justify-center p-4 bg-base-200/30"
          >
            {loading && (
              <div className="flex items-center gap-2 opacity-40">
                <Loader className="size-4 animate-spin" />
                <span className="text-sm">Rendering graph...</span>
              </div>
            )}
            {error && (
              <div className="text-sm text-error/70 text-center">
                <p>Failed to render state machine</p>
                <p className="text-xs opacity-50 mt-1">{error}</p>
              </div>
            )}
            {svg && (
              <div
                className="max-w-full max-h-full [&_svg]:max-w-full [&_svg]:max-h-full [&_svg]:w-auto [&_svg]:h-auto"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
