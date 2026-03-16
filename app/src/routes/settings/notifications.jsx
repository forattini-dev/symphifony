import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../../context/DashboardContext";
import { NotificationsSection } from "../../components/SettingsView";

export const Route = createFileRoute("/settings/notifications")({
  component: NotificationSettings,
});

function NotificationSettings() {
  const ctx = useDashboard();
  return (
    <div className="space-y-5">
      <NotificationsSection notifications={ctx.notifications} />
    </div>
  );
}
