import { createFileRoute, Outlet, Link, useRouterState } from "@tanstack/react-router";
import { Palette, Cpu, Bell, GitBranch } from "lucide-react";

const TABS = [
  { to: "/settings/general", label: "General", icon: Palette },
  { to: "/settings/workflow", label: "Workflow", icon: GitBranch },
  { to: "/settings/notifications", label: "Notifications", icon: Bell },
  { to: "/settings/providers", label: "Providers", icon: Cpu },
];

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 pb-4 pt-3">
      <div className="max-w-5xl w-full mx-auto flex-1 flex flex-col min-h-0 gap-5">
        <div role="tablist" className="tabs tabs-lift">
          {TABS.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              role="tab"
              className={`tab gap-1.5 ${currentPath.startsWith(to) ? "tab-active" : ""}`}
            >
              <Icon className="size-3.5" />
              {label}
            </Link>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
