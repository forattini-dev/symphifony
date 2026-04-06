import { useRef, useEffect, useState, useLayoutEffect, useCallback } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Kanban, ListTodo, Bot, TrendingUp, Sliders, Server, MessageSquare } from "lucide-react";
import { buildQueueTitle } from "../project-meta.js";

const NAV_ITEMS = [
  { to: "/chat", label: "Chat", icon: MessageSquare },
  { to: "/kanban", label: "Kanban", icon: Kanban },
  { to: "/issues", label: "Issues", icon: ListTodo },
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/services", label: "Services", icon: Server },
  { to: "/analytics", label: "Analytics", icon: TrendingUp },
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

export function Header({ issueCount, sourceRepo, queueTitle, updatedAt, wsStatus, issues }) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const navRef = useRef(null);
  const repoDisplay = displayRepoName(sourceRepo);
  const title = queueTitle || "fifony";
  const repoSubtitle = repoDisplay && title !== buildQueueTitle(repoDisplay) ? repoDisplay : null;

  return (
    <div className="navbar bg-base-100 shadow-sm px-4">
      <div className="flex-1 min-w-0 gap-2">
        <div className="min-w-0">
          <Link
            to="/"
            className="btn btn-ghost px-2 text-lg sm:text-xl font-bold tracking-tight max-w-full"
            title={title}
            style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", letterSpacing: "-0.02em", fontWeight: 800 }}
          >
            <span className="truncate">{title}</span>
          </Link>
          {repoSubtitle && <div className="text-xs opacity-40 hidden lg:block truncate px-2">{repoSubtitle}</div>}
        </div>
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
                    className={`nav-link ${isActive ? "active nav-link-active" : ""}`}
                  >
                    <Icon className="size-4" />
                    {label}
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
          <li className="hidden md:flex">
            <span className="tooltip tooltip-bottom py-1 px-2" data-tip={`Live: ${wsStatus}`}>
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-base-content/10 bg-base-200/70">
                <WsStatusDot status={wsStatus} />
              </span>
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

export { NAV_ITEMS };
export default Header;
