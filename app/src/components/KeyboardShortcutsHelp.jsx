import { useEffect, useRef } from "react";
import { X, Keyboard } from "lucide-react";

const SHORTCUTS = [
  { key: "n", description: "Open New Issue drawer" },
  { key: "k", description: "Navigate to Kanban" },
  { key: "i", description: "Navigate to Issues" },
  { key: "a", description: "Navigate to Agents" },
  { key: "t", description: "Navigate to Analytics" },
  { key: "s", description: "Navigate to Settings" },
  { key: "1–6", description: "Jump to kanban column by index" },
  { key: "Esc", description: "Close any open drawer / modal" },
  { key: "?", description: "Show this help" },
];

export default function KeyboardShortcutsHelp({ open, onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="modal modal-bottom sm:modal-middle"
      onClose={onClose}
    >
      <div className="modal-box max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg flex items-center gap-2">
            <Keyboard className="size-5 opacity-60" />
            Keyboard Shortcuts
          </h3>
          <button
            className="btn btn-sm btn-ghost btn-circle"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Key</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map((s) => (
                <tr key={s.key}>
                  <td>
                    <kbd className="kbd kbd-sm">{s.key}</kbd>
                  </td>
                  <td>{s.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="modal-action">
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  );
}
