import { useEffect, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";
import { safeJson } from "./utils.js";

// ── Delta-merge helpers ─────────────────────────────────────────────────────

function mergeIssueLists(base, delta = [], removed = []) {
  const byId = new Map(base.map((i) => [i.id, i]));
  for (const id of removed) byId.delete(id);
  for (const issue of delta) {
    if (!issue?.id) continue;
    byId.set(issue.id, issue);
  }
  return [...byId.values()];
}

function applyWsPayload(current, payload) {
  const merged = current && typeof current === "object" ? { ...current } : {};
  const next = { ...merged, ...payload };

  if (Array.isArray(payload.issues)) {
    next.issues = payload.issues;
  } else if (Array.isArray(payload.issuesDelta)) {
    const base = Array.isArray(merged.issues) ? merged.issues : [];
    next.issues = mergeIssueLists(base, payload.issuesDelta, payload.issuesRemoved || []);
  }

  if (Array.isArray(payload.events)) {
    next.events = payload.events;
  }

  return next;
}

// ── Hooks ───────────────────────────────────────────────────────────────────

/**
 * Connects to the runtime WebSocket on the same host.
 * Merges incoming delta/full payloads into the ["runtime-state"] query cache.
 * Returns connection status: "connected" | "connecting" | "disconnected" | "error".
 */
export function useRuntimeWebSocket(onMessage) {
  const [status, setStatus] = useState("disconnected");
  const qc = useQueryClient();

  useEffect(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    let ws = null;
    let timer = null;
    let alive = true;

    const connect = () => {
      try {
        ws = new WebSocket(url);
      } catch {
        setStatus("error");
        timer = setTimeout(connect, 2000);
        return;
      }

      setStatus("connecting");

      ws.onopen = () => {
        setStatus("connected");
      };

      ws.onmessage = (e) => {
        const msg = safeJson(e.data);
        if (!msg) return;
        const cur = qc.getQueryData(["runtime-state"]) || {};
        qc.setQueryData(["runtime-state"], applyWsPayload(cur, msg));
        if (onMessage) onMessage(msg);
      };

      ws.onclose = () => {
        setStatus("disconnected");
        if (alive) timer = setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        setStatus("error");
      };
    };

    connect();

    return () => {
      alive = false;
      clearTimeout(timer);
      ws?.close();
    };
  }, [qc, onMessage]);

  return status;
}

/** Fetch runtime state with polling. showAll=true bypasses the recent-only filter. */
export function useRuntimeState({ pollInterval = 3000, showAll = false } = {}) {
  return useQuery({
    queryKey: ["runtime-state", showAll],
    queryFn: () => api.get(showAll ? "/state?all=1" : "/state"),
    refetchInterval: pollInterval,
  });
}

/** Fetch filtered event feed. */
export function useRuntimeEvents(kind, issueId, pollInterval = 2500) {
  const params = new URLSearchParams();
  if (kind && kind !== "all") params.set("kind", kind);
  if (issueId && issueId !== "all") params.set("issueId", issueId);

  return useQuery({
    queryKey: ["runtime-events", kind, issueId],
    queryFn: () => api.get(`/events/feed${params.size ? `?${params}` : ""}`),
    refetchInterval: pollInterval,
  });
}

/** Fetch available providers. */
export function useProviders() {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get("/providers"),
    refetchInterval: 15000,
  });
}

/** Fetch parallelism analysis. */
export function useParallelism() {
  return useQuery({
    queryKey: ["parallelism"],
    queryFn: () => api.get("/parallelism"),
    refetchInterval: 15000,
  });
}

/** Fetch providers usage data. */
export function useProvidersUsage() {
  return useQuery({
    queryKey: ["providers-usage"],
    queryFn: () => api.get("/providers/usage"),
    refetchInterval: 30000,
  });
}

// ── Theme ───────────────────────────────────────────────────────────────────

const PINNED_THEMES = ["auto", "light", "dark"];
const ALL_DAISYUI_THEMES = [
  "cupcake", "bumblebee", "emerald", "corporate", "synthwave", "retro",
  "cyberpunk", "valentine", "halloween", "garden", "forest", "aqua",
  "lofi", "pastel", "fantasy", "wireframe", "black", "luxury", "dracula",
  "cmyk", "autumn", "business", "acid", "lemonade", "night", "coffee",
  "winter", "dim", "nord", "sunset", "caramellatte", "abyss", "silk",
];
const THEME_OPTIONS = [...PINNED_THEMES, ...ALL_DAISYUI_THEMES];
export const SETTINGS_QUERY_KEY = ["settings"];
export const SETTING_ID_UI_THEME = "ui.theme";
export const SETTING_ID_UI_NOTIFICATIONS_ENABLED = "ui.notifications.enabled";
export const SETTING_ID_UI_ISSUES_STATE_FILTER = "ui.issues.stateFilter";
export const SETTING_ID_UI_ISSUES_CATEGORY_FILTER = "ui.issues.categoryFilter";
export const SETTING_ID_UI_ISSUES_COMPLETION_FILTER = "ui.issues.completionFilter";
export const SETTING_ID_UI_EVENTS_KIND = "ui.events.kind";
export const SETTING_ID_UI_EVENTS_ISSUE_ID = "ui.events.issueId";
const SYSTEM_DARK_QUERY = window.matchMedia("(prefers-color-scheme: dark)");

function resolveTheme(value) {
  return value === "auto"
    ? SYSTEM_DARK_QUERY.matches ? "dark" : "light"
    : value;
}

function normalizeTheme(value) {
  return THEME_OPTIONS.includes(value) ? value : "auto";
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

export function getSettingsList(payload) {
  return Array.isArray(payload?.settings) ? payload.settings : [];
}

export function getSettingValue(settings, settingId, fallback) {
  const entry = Array.isArray(settings) ? settings.find((setting) => setting?.id === settingId) : null;
  return entry?.value ?? fallback;
}

export function upsertSettingPayload(current, setting) {
  const payload = current && typeof current === "object" ? current : {};
  const settings = getSettingsList(payload).filter((entry) => entry?.id !== setting.id);
  return { ...payload, settings: [...settings, setting] };
}

export function useSettings() {
  return useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => api.get("/settings"),
    staleTime: 30_000,
  });
}

export function useUiSetting(settingId, fallbackValue, options = {}) {
  const qc = useQueryClient();
  const settingsQuery = useSettings();
  const normalize = typeof options.normalize === "function" ? options.normalize : (value) => value;
  const persistedValue = normalize(
    getSettingValue(getSettingsList(settingsQuery.data), settingId, fallbackValue),
  );
  const [value, setValueRaw] = useState(persistedValue);

  const setValue = useCallback((nextValue) => {
    const normalized = normalize(nextValue);
    setValueRaw(normalized);
    const optimisticSetting = {
      id: settingId,
      scope: "ui",
      value: normalized,
      source: "user",
      updatedAt: new Date().toISOString(),
    };
    // Cancel in-flight settings fetches so stale server data cannot overwrite our optimistic update
    qc.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
    qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, optimisticSetting));
    void api.post(`/settings/${encodeURIComponent(settingId)}`, {
      scope: "ui",
      value: normalized,
      source: "user",
    }).then((response) => {
      if (response?.setting) {
        qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, response.setting));
      }
    }).catch(() => {
      qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    });
  }, [normalize, qc, settingId]);

  useEffect(() => {
    setValueRaw((current) => Object.is(current, persistedValue) ? current : persistedValue);
  }, [persistedValue]);

  return [value, setValue];
}

/**
 * Manages the DaisyUI theme.
 * Persists preference in s3db; "auto" resolves based on prefers-color-scheme.
 * Returns [currentThemeName, setTheme].
 */
export function useTheme() {
  const qc = useQueryClient();
  const settingsQuery = useSettings();
  const persistedTheme = normalizeTheme(
    getSettingValue(getSettingsList(settingsQuery.data), SETTING_ID_UI_THEME, "auto"),
  );
  const [theme, setThemeRaw] = useState(persistedTheme);

  const setTheme = useCallback((value) => {
    const normalized = normalizeTheme(value);
    setThemeRaw(normalized);
    const optimisticSetting = {
      id: SETTING_ID_UI_THEME,
      scope: "ui",
      value: normalized,
      source: "user",
      updatedAt: new Date().toISOString(),
    };
    // Cancel in-flight settings fetches so stale server data cannot overwrite our optimistic update
    qc.cancelQueries({ queryKey: SETTINGS_QUERY_KEY });
    qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, optimisticSetting));
    void api.post(`/settings/${encodeURIComponent(SETTING_ID_UI_THEME)}`, {
      scope: "ui",
      value: normalized,
      source: "user",
    }).then((response) => {
      if (response?.setting) {
        qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, response.setting));
      }
    }).catch(() => {
      qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
    });
  }, [qc]);

  useEffect(() => {
    setThemeRaw((current) => current === persistedTheme ? current : persistedTheme);
  }, [persistedTheme]);

  // Apply resolved theme to <html> and react to system preference changes
  useEffect(() => {
    const apply = () => {
      const el = document.documentElement;
      el.classList.add("theme-transitioning");
      el.setAttribute("data-theme", resolveTheme(theme));
      const t = setTimeout(() => el.classList.remove("theme-transitioning"), 350);
      return t;
    };
    const t = apply();

    if (theme === "auto") {
      const handler = () => apply();
      SYSTEM_DARK_QUERY.addEventListener("change", handler);
      return () => { clearTimeout(t); SYSTEM_DARK_QUERY.removeEventListener("change", handler); };
    }
    return () => clearTimeout(t);
  }, [theme]);

  return [theme, setTheme];
}

export function useUiNotificationsSetting() {
  return useUiSetting(
    SETTING_ID_UI_NOTIFICATIONS_ENABLED,
    false,
    { normalize: (value) => normalizeBoolean(value, false) },
  );
}

export function usePwa() {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [canInstall, setCanInstall] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isInstalled, setIsInstalled] = useState(() =>
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true,
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
      setCanInstall(true);
    };
    const onAppInstalled = () => {
      setInstallPrompt(null);
      setCanInstall(false);
      setIsInstalled(true);
    };
    const onDisplayModeChange = () => {
      setIsInstalled(displayMode.matches || window.navigator.standalone === true);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    displayMode.addEventListener("change", onDisplayModeChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
      displayMode.removeEventListener("change", onDisplayModeChange);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;

    let refreshing = false;

    const bindRegistration = (registration) => {
      if (!registration) return;

      if (registration.waiting && navigator.serviceWorker.controller) {
        setUpdateAvailable(true);
      }

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            setUpdateAvailable(true);
          }
        });
      });
    };

    const onControllerChange = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker.getRegistration().then(bindRegistration).catch(() => {});

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  const installApp = useCallback(async () => {
    if (!installPrompt) return false;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice?.outcome !== "accepted") {
      return false;
    }
    setInstallPrompt(null);
    setCanInstall(false);
    return true;
  }, [installPrompt]);

  const applyUpdate = useCallback(async () => {
    if (!("serviceWorker" in navigator)) return false;
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration?.waiting) return false;
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
    return true;
  }, []);

  return {
    isOnline,
    canInstall: canInstall && !isInstalled,
    isInstalled,
    updateAvailable,
    serviceWorkerSupported: "serviceWorker" in navigator,
    installApp,
    applyUpdate,
  };
}
