import { Link, useRouterState } from "@tanstack/react-router";
import { NAV_ITEMS } from "./Header.jsx";

export function MobileDock() {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const dockItems = NAV_ITEMS.filter((item) => !item.dockHidden);

  return (
    <div className="dock md:hidden">
      {dockItems.map(({ to, label, icon: Icon }) => {
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
    </div>
  );
}

export default MobileDock;
