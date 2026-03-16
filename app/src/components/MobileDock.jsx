import { Link, useRouterState } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { NAV_ITEMS } from "./Header.jsx";

export function MobileDock({ onToggleEvents, eventsOpen }) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <div className="dock md:hidden">
      {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
        const isActive = currentPath.startsWith(to);
        return (
          <Link
            key={to}
            to={to}
            className={isActive ? "dock-active" : undefined}
          >
            <Icon className={`size-[1.2em] transition-transform duration-200 ${isActive ? "scale-110" : ""}`} />
            <span className="dock-label">{label}</span>
          </Link>
        );
      })}
      <button
        className={eventsOpen ? "dock-active" : undefined}
        onClick={onToggleEvents}
      >
        <Activity className={`size-[1.2em] transition-transform duration-200 ${eventsOpen ? "scale-110" : ""}`} />
        <span className="dock-label">Events</span>
      </button>
    </div>
  );
}

export default MobileDock;
