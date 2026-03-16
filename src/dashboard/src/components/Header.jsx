import { Wifi, WifiOff, Sun, Moon, CircleDot, LayoutGrid, Activity, Settings, Cpu } from "lucide-react";
import { timeAgo } from "../utils.js";

const PINNED_THEMES = ["auto", "light", "dark"];
const OTHER_THEMES = ["black", "cupcake", "night", "sunset"].sort((a, b) => a.localeCompare(b));
const THEME_OPTIONS = [...PINNED_THEMES, ...OTHER_THEMES];

const NAV_ITEMS = [
  { id: "issues", label: "Issues", icon: LayoutGrid },
  { id: "providers", label: "Providers", icon: Cpu },
  { id: "runtime", label: "Runtime", icon: Settings },
];

export function Header({ status, wsStatus, theme, onThemeChange, issueCount, sourceRepo, updatedAt, view, setView, onToggleEvents, eventsOpen }) {
  const isWsConnected = wsStatus === "connected";
  const isOk = status === "ok";
  const resolvedTheme = theme === "auto"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
  const isDark = ["dark", "night", "sunset", "black"].includes(resolvedTheme);

  return (
    <div className="navbar bg-base-100 shadow-sm px-4">
      {/* Brand */}
      <div className="flex-1 gap-2">
        <a className="btn btn-ghost text-xl font-bold tracking-tight">Symphifony</a>
        <span className="text-xs opacity-40 hidden lg:inline">{sourceRepo || "local workspace"}</span>
      </div>

      {/* Desktop nav links */}
      <div className="flex-none hidden md:flex">
        <ul className="menu menu-horizontal px-1 gap-1">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <a
                className={view === id ? "active" : ""}
                onClick={() => setView(id)}
              >
                <Icon className="size-4" />
                {label}
                {id === "issues" && issueCount > 0 && (
                  <span className="badge badge-xs badge-primary">{issueCount}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      </div>

      {/* Right side: events toggle + status + theme */}
      <div className="flex-none">
        <ul className="menu menu-horizontal px-1 items-center gap-0">
          <li>
            <button
              className={`tooltip tooltip-bottom py-1 px-2 hidden md:flex ${eventsOpen ? "active" : ""}`}
              data-tip="Events"
              onClick={onToggleEvents}
            >
              <Activity className="size-4" />
            </button>
          </li>
          <li>
            <span className="tooltip tooltip-bottom py-1 px-2" data-tip={`API: ${status}`}>
              <CircleDot className={`size-3.5 ${isOk ? "text-success" : "text-warning"}`} />
            </span>
          </li>
          <li>
            <span className="tooltip tooltip-bottom py-1 px-2" data-tip={`WS: ${wsStatus}`}>
              {isWsConnected
                ? <Wifi className="size-3.5 text-success" />
                : <WifiOff className="size-3.5 text-warning" />
              }
            </span>
          </li>
          <li className="hidden md:flex">
            <span className="text-xs opacity-40 py-1 px-2">{timeAgo(updatedAt)}</span>
          </li>
          <li>
            <details>
              <summary className="py-1 px-2">
                {isDark ? <Moon className="size-4" /> : <Sun className="size-4" />}
              </summary>
              <ul className="bg-base-100 rounded-t-none p-2 right-0 z-50 shadow-lg w-36">
                {THEME_OPTIONS.map((t) => (
                  <li key={t}>
                    <a
                      className={theme === t ? "active" : ""}
                      onClick={() => { onThemeChange(t); document.activeElement?.blur(); }}
                    >
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        </ul>
      </div>
    </div>
  );
}

export { NAV_ITEMS };
export default Header;
