import { lazy, Suspense, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { SETTINGS_QUERY_KEY, upsertSettingPayload } from "../hooks";

const OnboardingWizard = lazy(() => import("./OnboardingWizard"));
import { Sun, Moon, Wifi, WifiOff, CircleDot, Palette, Cpu, Radio, Download, RefreshCw, Smartphone, Bell, BellOff, Wand2, Volume2, VolumeX } from "lucide-react";
import { NOTIFICATION_GROUPS } from "../lib/notification-catalog.js";

const PINNED_THEMES = ["auto", "light", "dark"];
const ALL_DAISYUI_THEMES = [
  "cupcake", "bumblebee", "emerald", "corporate", "synthwave", "retro",
  "cyberpunk", "valentine", "halloween", "garden", "forest", "aqua",
  "lofi", "pastel", "fantasy", "wireframe", "black", "luxury", "dracula",
  "cmyk", "autumn", "business", "acid", "lemonade", "night", "coffee",
  "winter", "dim", "nord", "sunset", "caramellatte", "abyss", "silk",
];
const THEME_OPTIONS = [...PINNED_THEMES, ...ALL_DAISYUI_THEMES];

function resolveTheme(value) {
  return value === "auto"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : value;
}

function ThemeSection({ theme, onThemeChange }) {
  const resolved = resolveTheme(theme);
  const isDark = ["dark", "night", "sunset", "black", "synthwave", "halloween", "forest", "luxury", "dracula", "business", "coffee", "dim", "abyss"].includes(resolved);

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-4 p-6">
        <h3 className="card-title text-sm flex items-center gap-2">
          <Palette className="size-4 opacity-50" />
          Theme
        </h3>
        <p className="text-xs opacity-50">
          Current: <span className="font-semibold">{theme}</span>
          {theme === "auto" && <span> (resolved to {resolved})</span>}
          {isDark ? <Moon className="inline size-3 ml-1" /> : <Sun className="inline size-3 ml-1" />}
        </p>
        <div className="flex flex-wrap gap-2">
          {THEME_OPTIONS.map((t) => (
            <button
              key={t}
              className={`btn btn-sm ${theme === t ? "btn-primary" : "btn-soft"}`}
              onClick={() => onThemeChange(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConcurrencySection({ concurrency, setConcurrency, saveConcurrency, savePending }) {
  return (
    <div className="card bg-base-200">
      <div className="card-body gap-4 p-6">
        <h3 className="card-title text-sm flex items-center gap-2">
          <Cpu className="size-4 opacity-50" />
          Worker Concurrency
        </h3>
        <p className="text-xs opacity-50">
          Number of parallel workers executing issues simultaneously (1–16).
        </p>
        <div className="flex items-center gap-2">
          <input
            className="input input-bordered input-sm w-20"
            type="number"
            min={1}
            max={16}
            value={concurrency}
            onChange={(e) => setConcurrency(e.target.value)}
          />
          <button
            className="btn btn-sm btn-primary"
            onClick={saveConcurrency}
            disabled={savePending}
          >
            {savePending ? <span className="loading loading-spinner loading-xs" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectionSection({ status, wsStatus }) {
  const isOk = status === "ok";
  const isWsConnected = wsStatus === "connected";

  const apiColor = isOk ? "text-success" : "text-warning";
  const apiLabel = isOk ? "Connected" : status === "offline" ? "Offline" : "Degraded";

  const wsColorMap = {
    connected: "text-success",
    connecting: "text-info",
    disconnected: "text-warning",
    error: "text-error",
  };
  const wsColor = wsColorMap[wsStatus] || "text-warning";
  const wsLabel = wsStatus.charAt(0).toUpperCase() + wsStatus.slice(1);

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-4 p-6">
        <h3 className="card-title text-sm flex items-center gap-2">
          <Radio className="size-4 opacity-50" />
          Connection Status
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-3 p-3 rounded-box bg-base-300">
            <span className="relative flex size-5 items-center justify-center">
              {isOk && <span className="animate-ping absolute inline-flex size-3 rounded-full bg-success opacity-30" />}
              <CircleDot className={`size-5 ${apiColor} relative`} />
            </span>
            <div>
              <div className="text-sm font-medium">API</div>
              <div className={`text-xs ${apiColor}`}>{apiLabel}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 p-3 rounded-box bg-base-300">
            <span className="relative flex size-5 items-center justify-center">
              {isWsConnected && <span className="animate-ping absolute inline-flex size-3 rounded-full bg-success opacity-30" />}
              {isWsConnected
                ? <Wifi className={`size-5 ${wsColor} relative`} />
                : <WifiOff className={`size-5 ${wsColor} relative`} />
              }
            </span>
            <div>
              <div className="text-sm font-medium">WebSocket</div>
              <div className={`text-xs ${wsColor}`}>{wsLabel}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PwaSection({ pwa }) {
  const installLabel = pwa?.isInstalled ? "Installed" : pwa?.canInstall ? "Installable" : "Browser-managed";

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-4 p-6">
        <h3 className="card-title text-sm flex items-center gap-2">
          <Smartphone className="size-4 opacity-50" />
          Progressive Web App
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-box bg-base-300 p-3">
            <div className="text-xs opacity-50">Service worker</div>
            <div className="text-sm font-medium mt-1">
              {pwa?.serviceWorkerSupported ? "Supported" : "Unavailable"}
            </div>
          </div>
          <div className="rounded-box bg-base-300 p-3">
            <div className="text-xs opacity-50">Install status</div>
            <div className="text-sm font-medium mt-1">{installLabel}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-sm btn-primary gap-1"
            onClick={() => pwa.installApp()}
            disabled={!pwa?.canInstall}
          >
            <Download className="size-3.5" /> Install
          </button>
          <button
            className="btn btn-sm btn-soft gap-1"
            onClick={() => pwa.applyUpdate()}
            disabled={!pwa?.updateAvailable}
          >
            <RefreshCw className="size-3.5" /> Apply update
          </button>
        </div>
      </div>
    </div>
  );
}

function NotificationsSection({ notifications }) {
  if (!notifications?.supported) {
    return (
      <div className="card bg-base-200">
        <div className="card-body gap-4 p-6">
          <h3 className="card-title text-sm flex items-center gap-2">
            <BellOff className="size-4 opacity-50" />
            Notifications
          </h3>
          <p className="text-xs opacity-50">Desktop notifications are not supported in this browser.</p>
        </div>
      </div>
    );
  }

  const isDenied = notifications.permission === "denied";
  const isGranted = notifications.permission === "granted";
  const eventSettings = notifications.eventSettings || [];

  return (
    <div className="space-y-4">
      {/* Master toggle */}
      <div className="card bg-base-200">
        <div className="card-body gap-4 p-6">
          <h3 className="card-title text-sm flex items-center gap-2">
            <Bell className="size-4 opacity-50" />
            Desktop Notifications
          </h3>
          <p className="text-xs opacity-50">
            Get notified when issues change state — reviews needed, agents blocked, work completed.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-box bg-base-300 p-3">
              <div className="text-xs opacity-50">Permission</div>
              <div className={`text-sm font-medium mt-1 ${isGranted ? "text-success" : isDenied ? "text-error" : "text-warning"}`}>
                {notifications.permission === "default" ? "Not asked yet" : notifications.permission}
              </div>
            </div>
            <div className="rounded-box bg-base-300 p-3">
              <div className="text-xs opacity-50">Status</div>
              <div className={`text-sm font-medium mt-1 ${notifications.enabled ? "text-success" : ""}`}>
                {notifications.enabled ? "Enabled" : "Disabled"}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {!isGranted && !isDenied && (
              <button className="btn btn-sm btn-primary gap-1" onClick={notifications.requestPermission}>
                <Bell className="size-3.5" /> Enable notifications
              </button>
            )}
            {isGranted && (
              <label className="label cursor-pointer gap-2">
                <span className="text-sm">Notify on state changes</span>
                <input
                  type="checkbox"
                  className="toggle toggle-sm toggle-primary"
                  checked={notifications.enabled}
                  onChange={(e) => notifications.setEnabled(e.target.checked)}
                />
              </label>
            )}
            {isDenied && (
              <p className="text-xs text-error">
                Notifications were denied. Reset permission in your browser settings to re-enable.
              </p>
            )}
            {isGranted && notifications.enabled && (
              <button
                className="btn btn-xs btn-ghost"
                onClick={() => new Notification("fifony", { body: "Notifications are working!", icon: "/icon.svg" })}
              >
                Send test
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Per-event toggles */}
      {isGranted && notifications.enabled && eventSettings.length > 0 && (
        <div className="card bg-base-200">
          <div className="card-body gap-4 p-6">
            <h3 className="card-title text-sm flex items-center gap-2">
              <Wand2 className="size-4 opacity-50" />
              Event Types
            </h3>
            <p className="text-xs opacity-50">
              Choose which events trigger notifications.
            </p>

            {NOTIFICATION_GROUPS.map((group) => {
              const groupEvents = eventSettings.filter((e) => e.group === group.id);
              if (groupEvents.length === 0) return null;
              return (
                <div key={group.id} className="space-y-1">
                  <div className="text-xs font-semibold opacity-40 uppercase tracking-wider">{group.label}</div>
                  {groupEvents.map((event) => (
                    <label key={event.id} className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-base-300 transition-colors cursor-pointer">
                      <input
                        type="checkbox"
                        className="toggle toggle-xs toggle-primary"
                        checked={event.enabled}
                        onChange={(e) => notifications.setEventEnabled(event.id, e.target.checked)}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium flex items-center gap-2">
                          {event.label}
                          {event.sound && <Volume2 className="size-3 opacity-30" title="Plays sound" />}
                        </div>
                        <div className="text-xs opacity-40">{event.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SetupWizardSection() {
  const [showWizard, setShowWizard] = useState(false);
  const qc = useQueryClient();

  const handleRerun = async () => {
    // Clear onboarding.completed so the wizard appears
    try {
      await api.post(`/settings/${encodeURIComponent("ui.onboarding.completed")}`, {
        scope: "ui",
        value: false,
        source: "user",
      });
      qc.setQueryData(SETTINGS_QUERY_KEY, (current) =>
        upsertSettingPayload(current, {
          id: "ui.onboarding.completed",
          scope: "ui",
          value: false,
          source: "user",
          updatedAt: new Date().toISOString(),
        })
      );
    } catch {
      // ignore
    }
    setShowWizard(true);
  };

  if (showWizard) {
    return (
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center">
            <span className="loading loading-spinner loading-lg" />
          </div>
        }
      >
        <OnboardingWizard
          onComplete={() => {
            setShowWizard(false);
            qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
          }}
        />
      </Suspense>
    );
  }

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-4 p-6">
        <h3 className="card-title text-sm flex items-center gap-2">
          <Wand2 className="size-4 opacity-50" />
          Setup Wizard
        </h3>
        <p className="text-xs opacity-50">
          Re-run the initial setup wizard to reconfigure providers, effort level, concurrency, and theme.
        </p>
        <button className="btn btn-sm btn-primary gap-1 w-fit" onClick={handleRerun}>
          <Wand2 className="size-3.5" /> Re-run Setup Wizard
        </button>
      </div>
    </div>
  );
}

// Export individual sections for use in tabbed layout
export { ThemeSection, ConcurrencySection, ConnectionSection, PwaSection, NotificationsSection, SetupWizardSection };

