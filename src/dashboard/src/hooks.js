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

/** Fetch full runtime state with polling. */
export function useRuntimeState({ pollInterval = 3000 } = {}) {
  return useQuery({
    queryKey: ["runtime-state"],
    queryFn: () => api.get("/state"),
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
const OTHER_THEMES = ["black", "cupcake", "night", "sunset"].sort((a, b) => a.localeCompare(b));
const THEME_OPTIONS = [...PINNED_THEMES, ...OTHER_THEMES];
const THEME_STORAGE_KEY = "symphifony-theme";
const SYSTEM_DARK_QUERY = window.matchMedia("(prefers-color-scheme: dark)");

function resolveTheme(value) {
  return value === "auto"
    ? SYSTEM_DARK_QUERY.matches ? "dark" : "light"
    : value;
}

function normalizeTheme(value) {
  return THEME_OPTIONS.includes(value) ? value : "auto";
}

/**
 * Manages the DaisyUI theme.
 * Persists preference in localStorage; "auto" resolves based on prefers-color-scheme.
 * Returns [currentThemeName, setTheme].
 */
export function useTheme() {
  const [theme, setThemeRaw] = useState(() =>
    normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY)),
  );

  const setTheme = useCallback((value) => {
    const normalized = normalizeTheme(value);
    localStorage.setItem(THEME_STORAGE_KEY, normalized);
    setThemeRaw(normalized);
  }, []);

  // Apply resolved theme to <html> and react to system preference changes
  useEffect(() => {
    const apply = () => {
      document.documentElement.setAttribute("data-theme", resolveTheme(theme));
    };
    apply();

    if (theme === "auto") {
      SYSTEM_DARK_QUERY.addEventListener("change", apply);
      return () => SYSTEM_DARK_QUERY.removeEventListener("change", apply);
    }
  }, [theme]);

  return [theme, setTheme];
}
