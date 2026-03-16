import { createContext, useContext, useMemo, useCallback, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import {
  useRuntimeState,
  useRuntimeEvents,
  useProviders,
  useParallelism,
  useProvidersUsage,
  useRuntimeWebSocket,
  useTheme,
  usePwa,
  useUiSetting,
  SETTING_ID_UI_ISSUES_STATE_FILTER,
  SETTING_ID_UI_ISSUES_CATEGORY_FILTER,
  SETTING_ID_UI_ISSUES_COMPLETION_FILTER,
  SETTING_ID_UI_EVENTS_KIND,
  SETTING_ID_UI_EVENTS_ISSUE_ID,
} from "../hooks";
import { useNotifications } from "../hooks/useNotifications";
import { STATES } from "../utils";

const DashboardContext = createContext(null);
const EVENT_KINDS = ["all", "info", "state", "progress", "error", "manual", "runner"];
const COMPLETION_FILTERS = new Set(["recent", "all"]);

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard must be used within DashboardProvider");
  return ctx;
}

export function DashboardProvider({ children }) {
  const [theme, setTheme] = useTheme();
  const [stateFilter, setStateFilter] = useUiSetting(
    SETTING_ID_UI_ISSUES_STATE_FILTER,
    "all",
    { normalize: (value) => (value === "all" || STATES.includes(value) ? value : "all") },
  );
  const [categoryFilter, setCategoryFilter] = useUiSetting(
    SETTING_ID_UI_ISSUES_CATEGORY_FILTER,
    "all",
    { normalize: (value) => (typeof value === "string" && value.trim() ? value : "all") },
  );
  const [completionFilter, setCompletionFilter] = useUiSetting(
    SETTING_ID_UI_ISSUES_COMPLETION_FILTER,
    "recent",
    { normalize: (value) => (COMPLETION_FILTERS.has(value) ? value : "recent") },
  );
  const [query, setQuery] = useState("");
  const [eventKind, setEventKind] = useUiSetting(
    SETTING_ID_UI_EVENTS_KIND,
    "all",
    { normalize: (value) => (EVENT_KINDS.includes(value) ? value : "all") },
  );
  const [eventIssueId, setEventIssueId] = useUiSetting(
    SETTING_ID_UI_EVENTS_ISSUE_ID,
    "all",
    { normalize: (value) => (typeof value === "string" && value.trim() ? value : "all") },
  );
  const [concurrency, setConcurrency] = useState("2");
  const [toast, setToast] = useState(null);
  const [toastExiting, setToastExiting] = useState(false);
  const [confetti, setConfetti] = useState(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [isEventsOpen, setIsEventsOpen] = useState(false);
  const [eventSnapshot, setEventSnapshot] = useState([]);
  const pwa = usePwa();

  const qc = useQueryClient();
  const handleRuntimeSocketMessage = useCallback((msg) => {
    if (Array.isArray(msg?.events)) {
      setEventSnapshot(msg.events);
    }
  }, []);

  const wsStatus = useRuntimeWebSocket(handleRuntimeSocketMessage);
  const liveMode = wsStatus === "connected";

  const runtime = useRuntimeState({ pollInterval: liveMode ? 10000 : 3000, showAll: completionFilter === "all" });
  const events = useRuntimeEvents(eventKind, eventIssueId, liveMode ? 10000 : 2500);
  const providers = useProviders();
  const parallelism = useParallelism();
  const providersUsage = useProvidersUsage();

  const data = runtime.data || {};
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const metrics = data.metrics || {};
  const status = liveMode ? "ok" : data.config ? "ok" : "offline";
  const eventsData = liveMode ? eventSnapshot : events.data?.events || [];

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return issues.filter((i) => {
      if (stateFilter !== "all" && i.state !== stateFilter) return false;
      if (categoryFilter !== "all" && (i.capabilityCategory || "default") !== categoryFilter) return false;
      if (q && !`${i.identifier} ${i.title} ${i.description || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [issues, stateFilter, categoryFilter, query]);

  const categoryOptions = useMemo(() => {
    const cats = new Set(issues.map((i) => i.capabilityCategory).filter(Boolean));
    return ["all", ...[...cats].sort()];
  }, [issues]);

  const issueOptions = useMemo(() => [...new Set(issues.map((i) => i.id))].sort(), [issues]);

  useEffect(() => {
    if (categoryFilter !== "all" && !categoryOptions.includes(categoryFilter)) {
      setCategoryFilter("all");
    }
  }, [categoryFilter, categoryOptions, setCategoryFilter]);

  useEffect(() => {
    if (eventIssueId !== "all" && !issueOptions.includes(eventIssueId)) {
      setEventIssueId("all");
    }
  }, [eventIssueId, issueOptions, setEventIssueId]);

  const showToast = useCallback((msg, type = "info") => {
    setToastExiting(false);
    setToast({ message: typeof msg === "string" ? msg : String(msg), type });
    setTimeout(() => {
      setToastExiting(true);
      setTimeout(() => { setToast(null); setToastExiting(false); }, 250);
    }, 3000);
  }, []);

  const showConfetti = useCallback(() => {
    setConfetti({ x: window.innerWidth / 2, y: window.innerHeight / 3 });
  }, []);
  const clearConfetti = useCallback(() => setConfetti(null), []);

  const createIssue = useMutation({
    mutationFn: (p) => api.post("/issues/create", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["runtime-state"] }); setIsCreateOpen(false); showToast("Issue created", "success"); showConfetti(); },
    onError: (e) => showToast(e.message, "error"),
  });

  const updateState = useMutation({
    mutationFn: ({ id, state }) => api.post(`/issues/${encodeURIComponent(id)}/state`, { state }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["runtime-state"] }); showToast("State updated", "success"); },
    onError: (e) => showToast(e.message, "error"),
  });

  const retryMut = useMutation({
    mutationFn: (id) => api.post(`/issues/${encodeURIComponent(id)}/retry`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runtime-state"] }),
    onError: (e) => showToast(e.message),
  });

  const cancelMut = useMutation({
    mutationFn: (id) => api.post(`/issues/${encodeURIComponent(id)}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runtime-state"] }),
    onError: (e) => showToast(e.message),
  });

  const refreshMut = useMutation({
    mutationFn: () => api.post("/refresh", {}),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e) => showToast(e.message),
  });

  const saveConcMut = useMutation({
    mutationFn: () => api.post("/config/concurrency", { concurrency: parseInt(concurrency, 10) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["runtime-state"] }); showToast("Concurrency updated", "success"); },
    onError: (e) => showToast(e.message, "error"),
  });

  useEffect(() => {
    if (data.config?.workerConcurrency) {
      setConcurrency(String(data.config.workerConcurrency));
    }
  }, [data.config?.workerConcurrency]);

  const toggleEvents = useCallback(() => setIsEventsOpen((prev) => !prev), []);
  const notifications = useNotifications(issues);

  const value = useMemo(() => ({
    // Theme
    theme, setTheme,
    // Connection
    status, wsStatus, liveMode,
    // Data
    data, issues, filtered, metrics, eventsData, providers, parallelism, providersUsage,
    categoryOptions, issueOptions,
    runtime,
    // Filters
    query, setQuery,
    stateFilter, setStateFilter,
    categoryFilter, setCategoryFilter,
    completionFilter, setCompletionFilter,
    // Events drawer
    isEventsOpen, toggleEvents, setIsEventsOpen,
    eventKind, setEventKind,
    eventIssueId, setEventIssueId,
    // Create drawer
    isCreateOpen, setIsCreateOpen,
    createIssue,
    // Issue detail
    selectedIssue, setSelectedIssue,
    // Mutations
    updateState: (id, state) => updateState.mutate({ id, state }),
    retryIssue: (id) => retryMut.mutate(id),
    cancelIssue: (id) => cancelMut.mutate(id),
    refresh: () => refreshMut.mutate(),
    // Settings
    concurrency, setConcurrency,
    saveConcurrency: () => saveConcMut.mutate(),
    saveConcPending: saveConcMut.isPending,
    pwa,
    notifications,
    // Toast
    toast, toastExiting, showToast,
    // Confetti
    confetti, showConfetti, clearConfetti,
  }), [
    theme, status, wsStatus, liveMode, data, issues, filtered, metrics, eventsData,
    providers, parallelism, providersUsage, categoryOptions, issueOptions, runtime,
    query, stateFilter, categoryFilter, completionFilter,
    isEventsOpen, eventKind, eventIssueId,
    isCreateOpen, selectedIssue, concurrency, toast, toastExiting, confetti, pwa, notifications,
    setTheme, setQuery, setStateFilter, setCategoryFilter, setCompletionFilter,
    toggleEvents, setIsEventsOpen, setEventKind, setEventIssueId,
    setIsCreateOpen, setSelectedIssue, setConcurrency,
    showToast, showConfetti, clearConfetti, createIssue, updateState, retryMut, cancelMut, refreshMut, saveConcMut,
  ]);

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}
