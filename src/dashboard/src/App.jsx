import { useMemo, useCallback, useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useRuntimeState, useRuntimeEvents, useProviders, useParallelism, useProvidersUsage, useRuntimeWebSocket, useTheme } from "./hooks";
import Header from "./components/Header";
import StatsBar from "./components/StatsBar";
import BoardView from "./components/BoardView";
import ListView from "./components/ListView";
import EventsDrawer from "./components/EventsDrawer";
import RuntimeView from "./components/RuntimeView";
import ProvidersView from "./components/ProvidersView";
import CreateIssueDrawer from "./components/CreateIssueForm";
import IssueDetailDrawer from "./components/IssueDetailDrawer";
import Filters from "./components/Filters";
import Fab from "./components/Fab";
import MobileDock from "./components/MobileDock";
import { LayoutGrid, Settings, Cpu } from "lucide-react";

const ISSUE_VIEWS = [
  { id: "kanban", label: "Kanban" },
  { id: "list", label: "List" },
];

const VIEWS = [
  { id: "issues", label: "Issues", icon: LayoutGrid },
  { id: "providers", label: "Providers", icon: Cpu },
  { id: "runtime", label: "Runtime Monitor", icon: Settings },
];

const VIEW_IDS = new Set(VIEWS.map((v) => v.id));
const ISSUE_VIEW_IDS = new Set(ISSUE_VIEWS.map((v) => v.id));

function readViewFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("view");
  const normalized = raw === "board" || raw === "list" ? "issues" : raw;
  return VIEW_IDS.has(normalized) ? normalized : "issues";
}

function writeViewToLocation(view) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  window.history.replaceState({}, "", url.toString());
}

function readIssueViewFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("issuesView");
  return ISSUE_VIEW_IDS.has(raw) ? raw : "kanban";
}

function writeIssueViewToLocation(mode) {
  const url = new URL(window.location.href);
  url.searchParams.set("issuesView", mode);
  window.history.replaceState({}, "", url.toString());
}

function IssueTabs({ issueView, setIssueView }) {
  return (
    <div role="tablist" className="tabs tabs-sm">
      {ISSUE_VIEWS.map(({ id, label }) => (
        <button
          key={id}
          role="tab"
          className={`tab ${issueView === id ? "tab-active" : ""}`}
          onClick={() => setIssueView(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useTheme();
  const [view, setViewState] = useState(() => readViewFromLocation());
  const [issueView, setIssueViewState] = useState(() => readIssueViewFromLocation());
  const [stateFilter, setStateFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [eventKind, setEventKind] = useState("all");
  const [eventIssueId, setEventIssueId] = useState("all");
  const [concurrency, setConcurrency] = useState("2");
  const [toast, setToast] = useState(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const [isEventsOpen, setIsEventsOpen] = useState(false);
  const [eventSnapshot, setEventSnapshot] = useState([]);

  const qc = useQueryClient();
  const handleRuntimeSocketMessage = useCallback((msg) => {
    if (Array.isArray(msg?.events)) {
      setEventSnapshot(msg.events);
    }
  }, []);

  const wsStatus = useRuntimeWebSocket(handleRuntimeSocketMessage);
  const liveMode = wsStatus === "connected";

  const runtime = useRuntimeState({ pollInterval: liveMode ? 10000 : 3000 });
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

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const createIssue = useMutation({
    mutationFn: (p) => api.post("/issues/create", p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["runtime-state"] }); setIsCreateOpen(false); showToast("Issue created"); },
    onError: (e) => showToast(e.message),
  });

  const updateState = useMutation({
    mutationFn: ({ id, state }) => api.post(`/issues/${encodeURIComponent(id)}/state`, { state }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runtime-state"] }),
    onError: (e) => showToast(e.message),
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["runtime-state"] });
      showToast("Concurrency updated");
    },
    onError: (e) => showToast(e.message),
  });

  useEffect(() => {
    if (data.config?.workerConcurrency) {
      setConcurrency(String(data.config.workerConcurrency));
    }
  }, [data.config?.workerConcurrency]);

  useEffect(() => {
    const onPop = () => {
      const next = readViewFromLocation();
      const nextIssueView = readIssueViewFromLocation();
      setViewState((current) => (current === next ? current : next));
      setIssueViewState((current) => (current === nextIssueView ? current : nextIssueView));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const setView = useCallback((nextView) => {
    if (!VIEW_IDS.has(nextView)) return;
    writeViewToLocation(nextView);
    setViewState(nextView);
  }, []);

  const setIssueView = useCallback((nextMode) => {
    if (!ISSUE_VIEW_IDS.has(nextMode)) return;
    writeIssueViewToLocation(nextMode);
    setIssueViewState(nextMode);
  }, []);

  const toggleEvents = useCallback(() => setIsEventsOpen((prev) => !prev), []);

  if (runtime.isLoading && !runtime.data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="loading loading-spinner loading-lg"></span>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {toast && (
        <div className="toast toast-end toast-top z-50">
          <div className="alert alert-info text-sm">{toast}</div>
        </div>
      )}

      <Header
        status={status}
        wsStatus={wsStatus}
        theme={theme}
        onThemeChange={setTheme}
        issueCount={issues.length}
        sourceRepo={data.sourceRepoUrl}
        updatedAt={data.updatedAt}
        view={view}
        setView={setView}
        onToggleEvents={toggleEvents}
        eventsOpen={isEventsOpen}
      />

      <div className="container mx-auto px-4 pb-8 flex-1 flex flex-col gap-4">
        <StatsBar metrics={metrics} total={issues.length} />


        {view === "issues" && (
          <div className="space-y-2">
            <IssueTabs issueView={issueView} setIssueView={setIssueView} />
            <Filters
              query={query}
              setQuery={setQuery}
              stateFilter={stateFilter}
              setStateFilter={setStateFilter}
              categoryFilter={categoryFilter}
              setCategoryFilter={setCategoryFilter}
              categoryOptions={categoryOptions}
            />
          </div>
        )}

        <div className="flex-1 flex flex-col min-h-0">
          {view === "issues" ? (
            issueView === "list" ? (
              <ListView
                issues={filtered}
                onStateChange={(id, nextState) => updateState.mutate({ id, state: nextState })}
                onRetry={(id) => retryMut.mutate(id)}
                onCancel={(id) => cancelMut.mutate(id)}
                onSelect={setSelectedIssue}
              />
            ) : (
              <BoardView
                issues={filtered}
                onStateChange={(id, nextState) => updateState.mutate({ id, state: nextState })}
                onRetry={(id) => retryMut.mutate(id)}
                onCancel={(id) => cancelMut.mutate(id)}
                onSelect={setSelectedIssue}
              />
            )
          ) : (
            <RuntimeView
              state={data}
              providers={providers.data || {}}
              parallelism={parallelism.data || {}}
              onRefresh={() => refreshMut.mutate()}
              concurrency={concurrency}
              setConcurrency={setConcurrency}
              saveConcurrency={() => saveConcMut.mutate()}
            />
          )}
        </div>

        {runtime.isError && (
          <div className="alert alert-error">{String(runtime.error?.message || "Runtime unavailable")}</div>
        )}
      </div>

      <Fab onClick={() => setIsCreateOpen(true)} />
      <MobileDock view={view} setView={setView} onToggleEvents={toggleEvents} eventsOpen={isEventsOpen} />
      <EventsDrawer
        open={isEventsOpen}
        onClose={() => setIsEventsOpen(false)}
        events={eventsData}
        kind={eventKind}
        setKind={setEventKind}
        issueId={eventIssueId}
        setIssueId={setEventIssueId}
        issueOptions={issueOptions}
      />
      <CreateIssueDrawer
        open={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSubmit={(p) => createIssue.mutate(p)}
        isLoading={createIssue.isPending}
        onToast={showToast}
      />
      <IssueDetailDrawer
        issue={selectedIssue}
        onClose={() => setSelectedIssue(null)}
        onStateChange={(id, nextState) => updateState.mutate({ id, state: nextState })}
        onRetry={(id) => retryMut.mutate(id)}
        onCancel={(id) => cancelMut.mutate(id)}
      />
    </div>
  );
}
