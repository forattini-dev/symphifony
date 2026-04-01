import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Search, ArrowRight, FileText, Navigation, Zap, CornerDownLeft } from "lucide-react";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD_LABEL = isMac ? "\u2318" : "Ctrl";

const NAV_COMMANDS = [
  { id: "nav-kanban", label: "Go to Kanban", hint: "K", to: "/kanban", icon: Navigation },
  { id: "nav-issues", label: "Go to Issues", hint: "I", to: "/issues", icon: Navigation },
  { id: "nav-agents", label: "Go to Agents", hint: "A", to: "/agents", icon: Navigation },
  { id: "nav-analytics", label: "Go to Analytics", hint: "T", to: "/analytics", icon: Navigation },
  { id: "nav-settings", label: "Go to Settings", hint: "S", to: "/settings", icon: Navigation },
];

const ACTION_COMMANDS = [
  { id: "act-create", label: "New Issue", hint: "N", actionKey: "create", icon: Zap },
  { id: "act-refresh", label: "Refresh", hint: "R", actionKey: "refresh", icon: Zap },
];

/**
 * Simple fuzzy score: substring match with bonus for prefix & word boundary.
 */
function score(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx < 0) return 0;
  let s = 1;
  if (idx === 0) s += 3; // prefix bonus
  if (idx > 0 && (t[idx - 1] === " " || t[idx - 1] === "-" || t[idx - 1] === "/")) s += 2; // word boundary
  return s;
}

export default function CommandPalette({ issues, onSelect, onNavigate, onAction, onClose }) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const items = [];

    // Issues
    for (const issue of issues) {
      const text = `${issue.identifier} ${issue.title} ${issue.description || ""}`;
      const s = score(query, text);
      if (s > 0) {
        items.push({ type: "issue", issue, label: `${issue.identifier} — ${issue.title}`, score: s, state: issue.state });
      }
    }

    // Navigation
    for (const cmd of NAV_COMMANDS) {
      const s = score(query, cmd.label);
      if (s > 0) items.push({ type: "nav", ...cmd, score: s });
    }

    // Actions
    for (const cmd of ACTION_COMMANDS) {
      const s = score(query, cmd.label);
      if (s > 0) items.push({ type: "action", ...cmd, score: s });
    }

    items.sort((a, b) => b.score - a.score);
    return items.slice(0, 12);
  }, [query, issues]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const execute = useCallback((item) => {
    if (!item) return;
    if (item.type === "issue") {
      onSelect(item.issue);
    } else if (item.type === "nav") {
      onNavigate(item.to);
    } else if (item.type === "action") {
      onAction(() => {
        // Resolve action by key
      });
    }
  }, [onSelect, onNavigate, onAction]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || (e.key === "j" && e.ctrlKey)) {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp" || (e.key === "k" && e.ctrlKey)) {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      execute(results[selectedIndex]);
    }
  }, [results, selectedIndex, execute, onClose]);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex];
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-50 animate-fade-in" onClick={onClose} />
      <div
        className="fixed top-[15%] left-1/2 -translate-x-1/2 z-50 w-[calc(100vw-1.5rem)] max-w-lg bg-base-100 rounded-2xl shadow-2xl border border-base-300 overflow-hidden animate-fade-in-up"
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-base-300">
          <Search className="size-4 opacity-40 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 bg-transparent outline-none text-sm placeholder:opacity-40"
            placeholder="Search issues, navigate, run actions..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="kbd kbd-xs opacity-40">Esc</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm opacity-40">
              No results found
            </div>
          )}
          {results.map((item, i) => {
            const isActive = i === selectedIndex;
            const Icon = item.icon || FileText;
            return (
              <button
                key={item.id || item.issue?.id || i}
                className={`flex items-center gap-3 w-full px-4 py-2.5 text-left text-sm transition-colors ${isActive ? "bg-primary/10 text-primary" : "hover:bg-base-200"}`}
                onClick={() => execute(item)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                {item.type === "issue" ? (
                  <FileText className="size-4 opacity-40 shrink-0" />
                ) : (
                  <Icon className="size-4 opacity-40 shrink-0" />
                )}
                <span className="flex-1 truncate">
                  {item.label}
                </span>
                {item.state && (
                  <span className="badge badge-xs badge-ghost opacity-60">{item.state}</span>
                )}
                {item.hint && (
                  <kbd className="kbd kbd-xs opacity-30">{item.hint}</kbd>
                )}
                {isActive && (
                  <CornerDownLeft className="size-3 opacity-30 shrink-0" />
                )}
              </button>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-base-300 flex items-center gap-4 text-[10px] opacity-40">
          <span className="flex items-center gap-1"><kbd className="kbd kbd-xs">&uarr;</kbd><kbd className="kbd kbd-xs">&darr;</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd className="kbd kbd-xs">&crarr;</kbd> select</span>
          <span className="flex items-center gap-1"><kbd className="kbd kbd-xs">Esc</kbd> close</span>
          <span className="ml-auto">{MOD_LABEL}+K</span>
        </div>
      </div>
    </>
  );
}
