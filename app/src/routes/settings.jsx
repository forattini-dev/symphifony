import { createFileRoute, Outlet, Link, useRouterState } from "@tanstack/react-router";
import {
  FolderRoot,
  ListOrdered,
  Cpu,
  Bell,
  Users,
  SlidersHorizontal,
  Settings,
  Server,
} from "lucide-react";

const TABS = [
  { to: "/settings/project",       label: "Project",       icon: FolderRoot },
  { to: "/settings/pipeline",      label: "Pipeline",      icon: ListOrdered },
  { to: "/settings/execution",     label: "Execution",     icon: Cpu },
  { to: "/settings/agents",        label: "Assets",        icon: Users },
  { to: "/settings/services",      label: "Services",      icon: Server },
  { to: "/settings/notifications", label: "Notifications", icon: Bell },
  { to: "/settings/providers",     label: "Providers",     icon: SlidersHorizontal },
  { to: "/settings/system",        label: "System",        icon: Settings },
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
