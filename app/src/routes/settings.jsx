import { createFileRoute, Outlet, Link, useRouterState } from "@tanstack/react-router";
import {
  FolderRoot,
  Workflow,
  Bell,
  Users,
  SlidersHorizontal,
  Cpu,
  Settings,
} from "lucide-react";

const TABS = [
  { to: "/settings/project", label: "Project", icon: FolderRoot },
  { to: "/settings/workflow", label: "Execution", icon: Workflow },
  { to: "/settings/agents", label: "Agents", icon: Users },
  { to: "/settings/preferences", label: "Preferences", icon: Cpu },
  { to: "/settings/general", label: "System", icon: Settings },
  { to: "/settings/notifications", label: "Notifications", icon: Bell },
  { to: "/settings/providers", label: "Providers", icon: SlidersHorizontal },
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
        <div role="tablist" className="tabs tabs-lift overflow-x-auto flex-nowrap scrollbar-none" style={{ scrollbarWidth: "none" }}>
          {TABS.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              role="tab"
              className={`tab gap-1.5 whitespace-nowrap ${currentPath.startsWith(to) ? "tab-active" : ""}`}
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
