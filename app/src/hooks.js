import { useEffect, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.js";
import { getSettingsList, getSettingValue, upsertSettingPayload } from "./settings-payload.js";
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
// ── Module-level WS send (set by the singleton WebSocket connection) ─────────

let _activeSend = null;

/** Send a message on the shared runtime WebSocket. No-op if not connected. */
export function sendWsMessage(msg) {
  if (_activeSend) {
    try { _activeSend(JSON.stringify(msg)); } catch {}
  }
}

// ── Analytics WS room subscriptions ──────────────────────────────────────────
// Reference-counted so multiple hook instances share one WS subscription.

const _analyticsRefCounts = new Map(); // topic → subscriber count

function subscribeAnalyticsTopic(topic) {
  const prev = _analyticsRefCounts.get(topic) ?? 0;
  _analyticsRefCounts.set(topic, prev + 1);
  if (prev === 0 && _activeSend) {
    try { _activeSend(JSON.stringify({ type: "analytics:subscribe", topic })); } catch {}
  }
}

function unsubscribeAnalyticsTopic(topic) {
  const prev = _analyticsRefCounts.get(topic) ?? 0;
  const next = Math.max(prev - 1, 0);
  _analyticsRefCounts.set(topic, next);
  if (next === 0 && _activeSend) {
    try { _activeSend(JSON.stringify({ type: "analytics:unsubscribe", topic })); } catch {}
  }
}

export function useRuntimeWebSocket(onMessage) {
  const [status, setStatus] = useState("disconnected");
  const qc = useQueryClient();

  useEffect(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    let ws = null;
    let timer = null;
    let alive = true;
    let backoff = 2000; // Start at 2s, double each failure, cap at 30s
    const MAX_BACKOFF = 30000;

    const connect = () => {
      try {
        ws = new WebSocket(url);
      } catch {
        setStatus("error");
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF);
        return;
      }

      setStatus("connecting");

      ws.onopen = () => {
        setStatus("connected");
        _activeSend = (data) => ws.send(data);
        backoff = 2000; // Reset backoff on successful connection
        // Re-subscribe all analytics topics after reconnect
        for (const [topic, count] of _analyticsRefCounts) {
          if (count > 0) {
            try { ws.send(JSON.stringify({ type: "analytics:subscribe", topic })); } catch {}
          }
        }
      };

      ws.onmessage = (e) => {
        const msg = safeJson(e.data);
        if (!msg) return;
        // Route analytics updates to their corresponding query cache keys
        if (msg.type === "analytics:update" && msg.topic && msg.data) {
          const topicKeyMap = {
            "analytics:tokens": ["token-analytics"],
            "analytics:lines": ["analytics-lines"],
            "analytics:kpis": ["analytics-kpis"],
            "analytics:hourly": ["hourly-analytics"],
          };
          const qk = topicKeyMap[msg.topic];
          if (qk) qc.setQueriesData({ queryKey: qk }, msg.data);
          return;
        }
        // Update ALL runtime-state query variants (e.g. ["runtime-state", false], ["runtime-state", true])
        qc.setQueriesData({ queryKey: ["runtime-state"] }, (cur) => applyWsPayload(cur || {}, msg));
        if (onMessage) onMessage(msg);
      };

      ws.onclose = () => {
        setStatus("disconnected");
        _activeSend = null;
        if (alive) {
          timer = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, MAX_BACKOFF);
        }
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
    refetchOnWindowFocus: true,
  });
}

export function useRuntimeStatus({ pollInterval = 10000 } = {}) {
  return useQuery({
    queryKey: ["runtime-status"],
    queryFn: () => api.get("/runtime/status"),
    refetchInterval: pollInterval,
  });
}

export function useRuntimeProbe({ pollInterval = 10000 } = {}) {
  return useQuery({
    queryKey: ["runtime-probe"],
    queryFn: () => api.get("/runtime/probe"),
    refetchInterval: pollInterval,
  });
}

export function useRuntimeDoctor({ pollInterval = 15000 } = {}) {
  return useQuery({
    queryKey: ["runtime-doctor"],
    queryFn: () => api.get("/runtime/doctor"),
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
export function useProviders({ pollInterval = 15000 } = {}) {
  return useQuery({
    queryKey: ["providers"],
    queryFn: () => api.get("/providers"),
    refetchInterval: pollInterval,
  });
}

/** Fetch parallelism analysis. */
export function useParallelism({ pollInterval = 15000 } = {}) {
  return useQuery({
    queryKey: ["parallelism"],
    queryFn: () => api.get("/parallelism"),
    refetchInterval: pollInterval,
  });
}

const PROVIDER_USAGE_PROVIDERS = ["claude", "codex", "gemini"];

function normalizeProvidersUsageResponse(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (!Array.isArray(payload.providers)) return null;
  const collectedAt = typeof payload.collectedAt === "string" ? payload.collectedAt : null;
  return { providers: payload.providers, collectedAt };
}

/** Fetch providers usage data. */
export function useProvidersUsage() {
  return useQuery({
    queryKey: ["providers-usage"],
    queryFn: async () => {
      const responses = await Promise.allSettled(
        PROVIDER_USAGE_PROVIDERS.map((provider) => api.get(`/providers/${provider}/usage`)),
      );
      let providers = [];
      const collectedAt = [];

      for (const response of responses) {
        if (response.status !== "fulfilled") continue;
        const normalized = normalizeProvidersUsageResponse(response.value);
        if (!normalized) continue;
        providers.push(...normalized.providers);
        if (normalized.collectedAt) collectedAt.push(normalized.collectedAt);
      }

      if (providers.length > 0) {
        const latestCollectedAt = collectedAt
          .map((value) => new Date(value).getTime())
          .filter((ts) => Number.isFinite(ts))
          .reduce((maxTs, ts) => Math.max(maxTs, ts), 0);

        return {
          providers,
          collectedAt: latestCollectedAt ? new Date(latestCollectedAt).toISOString() : new Date().toISOString(),
        };
      }

      // Backward-compatible fallback: if every provider endpoint failed, use the
      // aggregate endpoint once to avoid a blank "No providers detected" screen.
      try {
        const fallbackPayload = await api.get("/providers/usage");
        const fallback = normalizeProvidersUsageResponse(fallbackPayload);
        if (fallback) {
          providers = fallback.providers;
          if (fallback.collectedAt) collectedAt.push(fallback.collectedAt);
        }
      } catch {
        // Ignore fallback failures to avoid blocking the settings page.
      }

      const latestCollectedAt = collectedAt
        .map((value) => new Date(value).getTime())
        .filter((ts) => Number.isFinite(ts))
        .reduce((maxTs, ts) => Math.max(maxTs, ts), 0);

      return {
        providers,
        collectedAt: latestCollectedAt ? new Date(latestCollectedAt).toISOString() : new Date().toISOString(),
      };
    },
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
const SETTING_ID_UI_THEME = "ui.theme";
const SETTING_ID_UI_NOTIFICATIONS_ENABLED = "ui.notifications.enabled";
export const SETTING_ID_UI_ISSUES_STATE_FILTER = "ui.issues.stateFilter";
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

export { getSettingsList, getSettingValue, upsertSettingPayload } from "./settings-payload.js";

export async function persistUiSetting(settingId, value) {
  return api.post(`/settings/${encodeURIComponent(settingId)}`, {
    scope: "ui",
    value,
    source: "user",
  });
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

/** Token analytics — initial fetch + WS push (no polling). */
export function useTokenAnalytics() {
  useEffect(() => {
    subscribeAnalyticsTopic("analytics:tokens");
    return () => unsubscribeAnalyticsTopic("analytics:tokens");
  }, []);
  return useQuery({
    queryKey: ["token-analytics"],
    queryFn: () => api.get("/analytics/tokens"),
    staleTime: 60_000,
  });
}

export function useCodeChurnAnalytics() {
  useEffect(() => {
    subscribeAnalyticsTopic("analytics:lines");
    return () => unsubscribeAnalyticsTopic("analytics:lines");
  }, []);
  return useQuery({
    queryKey: ["analytics-lines"],
    queryFn: () => api.get("/analytics/lines"),
    staleTime: 60_000,
  });
}

export function useKpiAnalytics() {
  useEffect(() => {
    subscribeAnalyticsTopic("analytics:kpis");
    return () => unsubscribeAnalyticsTopic("analytics:kpis");
  }, []);
  return useQuery({
    queryKey: ["analytics-kpis"],
    queryFn: () => api.get("/analytics/kpis"),
    staleTime: 60_000,
  });
}

/** Hourly sparkline data (tokens/hour + events/hour) — initial fetch + WS push. */
export function useHourlyAnalytics(hours = 24) {
  useEffect(() => {
    subscribeAnalyticsTopic("analytics:hourly");
    return () => unsubscribeAnalyticsTopic("analytics:hourly");
  }, []);
  return useQuery({
    queryKey: ["hourly-analytics", hours],
    queryFn: () => api.get(`/analytics/hourly?hours=${hours}`),
    staleTime: 60_000,
  });
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

    // Check if prompt was captured before React mounted (in main.jsx)
    if (window.__fifonyInstallPrompt) {
      setInstallPrompt(window.__fifonyInstallPrompt);
      setCanInstall(true);
      window.__fifonyInstallPrompt = null;
    }

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
