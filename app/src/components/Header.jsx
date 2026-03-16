import { useRef, useEffect, useState, useLayoutEffect, useCallback } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Kanban, ListTodo, Activity, Bot, Sliders } from "lucide-react";
import { timeAgo } from "../utils.js";
import NotificationCenter from "./NotificationCenter.jsx";

const NAV_ITEMS = [
  { to: "/kanban", label: "Kanban", icon: Kanban },
  { to: "/issues", label: "Issues", icon: ListTodo },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/settings", label: "Settings", icon: Sliders },
];

function AnimatedBadge({ count }) {
  const prevRef = useRef(count);
  const [bumping, setBumping] = useState(false);

  useEffect(() => {
    if (prevRef.current !== count) {
      prevRef.current = count;
      setBumping(true);
      const t = setTimeout(() => setBumping(false), 300);
      return () => clearTimeout(t);
    }
  }, [count]);

  return (
    <span className={`badge badge-xs badge-primary ${bumping ? "animate-count-bump" : ""}`}>{count}</span>
  );
}

function WsStatusDot({ status }) {
  if (status === "connected") {
    return (
      <span className="relative flex size-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-50" />
        <span className="relative inline-flex rounded-full size-2 bg-success" />
      </span>
    );
  }
  if (status === "connecting") {
    return (
      <span className="flex items-center gap-0.5 dot-pulse-group">
        <span className="size-1 rounded-full bg-info" />
        <span className="size-1 rounded-full bg-info" />
        <span className="size-1 rounded-full bg-info" />
      </span>
    );
  }
  return <span className="size-2 rounded-full bg-warning animate-pulse-soft" />;
}

function NavIndicator({ navRef, currentPath }) {
  const [style, setStyle] = useState({ left: 0, width: 0, opacity: 0 });

  const update = useCallback(() => {
    if (!navRef.current) return;
    const active = navRef.current.querySelector("a.active");
    if (!active) { setStyle((s) => ({ ...s, opacity: 0 })); return; }
    const navRect = navRef.current.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    setStyle({
      left: activeRect.left - navRect.left,
      width: activeRect.width,
      opacity: 1,
    });
  }, [navRef]);

  useLayoutEffect(update, [currentPath, update]);
  useEffect(() => { window.addEventListener("resize", update); return () => window.removeEventListener("resize", update); }, [update]);

  return <div className="nav-indicator" style={style} />;
}

function displayRepoName(sourceRepo) {
  if (!sourceRepo) return null;
  // Extract basename from filesystem path or URL
  const name = sourceRepo.replace(/\/+$/, "").split("/").pop();
  if (!name || name === sourceRepo) return sourceRepo;
  return name;
}

export function Header({ issueCount, sourceRepo, updatedAt, onToggleEvents, eventsOpen, wsStatus, notifications }) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const navRef = useRef(null);
  const repoDisplay = displayRepoName(sourceRepo);

  return (
    <div className="navbar bg-base-100 shadow-sm px-4">
      <div className="flex-1 gap-2">
        <Link to="/" className="btn btn-ghost text-xl font-bold tracking-tight" style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", letterSpacing: '-0.02em', fontWeight: 800 }}>Fifony</Link>
        {repoDisplay && <span className="text-xs opacity-40 hidden lg:inline">{repoDisplay}</span>}
      </div>

      <div className="flex-none hidden md:flex">
        <div className="relative" ref={navRef}>
          <ul className="menu menu-horizontal px-1 gap-1">
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
              const isActive = currentPath.startsWith(to);
              return (
                <li key={to}>
                  <Link
                    to={to}
                    className={isActive ? "active" : ""}
                    style={isActive ? { color: 'oklch(var(--p))', fontWeight: 600, backgroundColor: 'oklch(var(--p) / 0.08)' } : undefined}
                  >
                    <Icon className="size-4" />
                    {label}
                    {to === "/issues" && issueCount > 0 && (
                      <AnimatedBadge count={issueCount} />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          <NavIndicator navRef={navRef} currentPath={currentPath} />
        </div>
      </div>

      <div className="flex-none">
        <ul className="menu menu-horizontal px-1 items-center gap-0">
          {notifications && (
            <li>
              <span className="py-1 px-2">
                <NotificationCenter
                  notifications={notifications.notifications}
                  unreadCount={notifications.unreadCount}
                  onDismiss={notifications.dismissNotification}
                  onMarkAllRead={notifications.markAllRead}
                />
              </span>
            </li>
          )}
          <li>
            <button
              className={`tooltip tooltip-bottom py-1 px-2 hidden md:flex ${eventsOpen ? "active" : ""}`}
              data-tip="Events"
              onClick={onToggleEvents}
            >
              <Activity className="size-4" />
            </button>
          </li>
          <li className="hidden md:flex">
            <span className="text-xs opacity-40 py-1 px-2 flex items-center gap-1.5">
              <WsStatusDot status={wsStatus} />
              {timeAgo(updatedAt)}
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

export { NAV_ITEMS };
export default Header;
