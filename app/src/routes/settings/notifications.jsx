import { createFileRoute } from "@tanstack/react-router";
import { useDashboard } from "../../context/DashboardContext";
import { NotificationsSection } from "../../components/SettingsView";
import { usePushSubscription } from "../../hooks/usePushSubscription";
import { Bell, BellOff, Loader2 } from "lucide-react";

export const Route = createFileRoute("/settings/notifications")({
  component: NotificationSettings,
});

function NotificationSettings() {
  const ctx = useDashboard();
  const push = usePushSubscription();

  return (
    <div className="space-y-5">
      <NotificationsSection notifications={ctx.notifications} />

      {/* Web Push Subscription */}
      {push.supported && (
        <div className="bg-base-200 rounded-box p-5">
          <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
            <Bell className="size-4 text-primary" />
            Background Push Notifications
          </h3>
          <p className="text-xs opacity-60 mb-3">
            Receive notifications even when the browser tab is closed. Requires notification permission.
          </p>

          {push.error && (
            <div className="alert alert-error text-xs py-2 mb-3">
              {push.error}
            </div>
          )}

          <div className="flex items-center gap-3">
            {push.subscribed ? (
              <button
                className="btn btn-sm btn-warning btn-outline gap-1.5"
                onClick={push.unsubscribe}
                disabled={push.subscribing}
              >
                {push.subscribing ? <Loader2 className="size-3.5 animate-spin" /> : <BellOff className="size-3.5" />}
                Unsubscribe from push
              </button>
            ) : (
              <button
                className="btn btn-sm btn-primary gap-1.5"
                onClick={push.subscribe}
                disabled={push.subscribing}
              >
                {push.subscribing ? <Loader2 className="size-3.5 animate-spin" /> : <Bell className="size-3.5" />}
                Enable push notifications
              </button>
            )}
            <span className="text-xs opacity-40">
              {push.subscribed ? "Active — you'll receive push notifications" : "Not subscribed"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
