import React from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

const { useEffect, useMemo, useState, useCallback } = React;
const h = React.createElement;

const STATES = ["Todo", "In Progress", "In Review", "Blocked", "Done", "Cancelled"];
const ISSUE_VIEWS = ["kanban", "list"];
const EVENT_KINDS = ["all", "info", "state", "progress", "error", "manual", "runner"];
const PINNED_THEMES = ["auto", "light", "dark"];
const OTHER_THEMES = ["black", "cupcake", "night", "sunset"].sort((a, b) => a.localeCompare(b));
const THEME_OPTIONS = [...PINNED_THEMES, ...OTHER_THEMES];
const VIEW_ITEMS = [
  { id: "issues", label: "Issues", icon: "inbox" },
  { id: "events", label: "Events", icon: "settings" },
  { id: "runtime", label: "Runtime Monitor", icon: "runtime" },
];
const VIEW_IDS = new Set(VIEW_ITEMS.map((item) => item.id));
const SYSTEM_THEME_QUERY = window.matchMedia("(prefers-color-scheme: dark)");
const STATE_BADGE = { Todo: "badge-warning", "In Progress": "badge-primary", "In Review": "badge-secondary", Blocked: "badge-error", Done: "badge-success", Cancelled: "badge-neutral" };
const ISSUE_STATE_MACHINE = {
  Todo: ["In Progress", "Cancelled"],
  "In Progress": ["In Review", "Blocked", "Cancelled"],
  "In Review": ["In Progress", "Done", "Blocked", "Cancelled"],
  Blocked: ["In Review", "In Progress", "Cancelled"],
  Done: ["Cancelled", "Todo"],
  Cancelled: ["Todo", "In Progress"],
};

function getIssueTransitions(state) {
  if (!Array.isArray(ISSUE_STATE_MACHINE[state])) return STATES;
  const next = ISSUE_STATE_MACHINE[state];
  return [state, ...next.filter((s) => s !== state)];
}

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 2_000, retry: 1 }, mutations: { retry: 1 } } });

function readViewFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("view");
  const normalized = fromUrl === "board" || fromUrl === "list" ? "issues" : fromUrl;
  return VIEW_IDS.has(normalized) ? normalized : "issues";
}

function writeViewToLocation(view) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", view);
  window.history.replaceState({}, "", url.toString());
}

function readIssueLayoutFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("issuesView");
  return ISSUE_VIEWS.includes(mode) ? mode : "kanban";
}

function writeIssueLayoutToLocation(mode) {
  const url = new URL(window.location.href);
  url.searchParams.set("issuesView", mode);
  window.history.replaceState({}, "", url.toString());
}

function resolveTheme(v) { return v === "auto" ? (SYSTEM_THEME_QUERY.matches ? "dark" : "light") : v; }
function normalizeTheme(v) { return THEME_OPTIONS.includes(v) ? v : "auto"; }
function safeJson(v) { try { return JSON.parse(v); } catch { return null; } }
function normalizeCsv(v) { return typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []; }
function formatDate(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString(); }
function timeAgo(v) { const d = new Date(v); if (Number.isNaN(d.getTime())) return "-"; const ms = Date.now() - d.getTime(); if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`; if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`; if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`; return `${Math.floor(ms / 86_400_000)}d ago`; }
function mergeIssueLists(baseIssues, deltaIssues = [], removedIds = []) {
  const byId = new Map(baseIssues.map((i) => [i.id, i]));
  for (const id of removedIds) byId.delete(id);
  for (const issue of deltaIssues) {
    if (!issue?.id) continue;
    byId.set(issue.id, issue);
  }
  return [...byId.values()];
}
function applyWsPayloadToState(currentState, payload) {
  const merged = currentState && typeof currentState === "object" ? { ...currentState } : {};
  const next = { ...merged, ...payload };
  if (Array.isArray(payload.issues)) {
    next.issues = payload.issues;
  } else if (Array.isArray(payload.issuesDelta)) {
    const baseIssues = Array.isArray(merged.issues) ? merged.issues : [];
    next.issues = mergeIssueLists(baseIssues, payload.issuesDelta, payload.issuesRemoved || []);
  }
  if (Array.isArray(payload.events)) {
    next.events = payload.events;
  }
  return next;
}

const api = {
  get: async (path) => { const r = await fetch(path, { headers: { Accept: "application/json" } }); const t = await r.text(); const d = t ? safeJson(t) : null; if (!r.ok) throw new Error(d?.error || `${r.status}`); return d || { ok: true }; },
  post: async (path, payload) => { const r = await fetch(path, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(payload) }); const t = await r.text(); const d = t ? safeJson(t) : null; if (!r.ok) throw new Error(d?.error || `${r.status}`); return d || { ok: true }; },
};

function useRuntimeWebSocket(onMessage) {
  const [status, setStatus] = useState("disconnected");
  const qc = useQueryClient();
  useEffect(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    let ws = null, timer = null, alive = true;
    const connect = () => {
      try { ws = new WebSocket(url); } catch { setStatus("error"); timer = setTimeout(connect, 3000); return; }
      setStatus("connecting");
      ws.onopen = () => {
        setStatus("connected");
        console.debug("WS connected", url);
      };
      ws.onmessage = (e) => {
        const msg = safeJson(e.data); if (!msg) return;
        if (msg && typeof msg === "object" && msg.type) {
          console.debug("WS payload", msg.type, msg.seq || "-");
        }
        const cur = qc.getQueryData(["runtime-state"]) || {};
        qc.setQueryData(["runtime-state"], applyWsPayloadToState(cur, msg));
        if (onMessage) onMessage(msg);
      };
      ws.onclose = () => { setStatus("disconnected"); console.debug("WS closed", url); if (alive) timer = setTimeout(connect, 2000); };
      ws.onerror = () => { setStatus("error"); console.warn("WS error", url); };
    };
    connect();
    return () => { alive = false; clearTimeout(timer); ws?.close(); };
  }, [qc]);
  return status;
}

function useRuntimeState({ enabledPoll, onSuccess }) {
  return useQuery({
    queryKey: ["runtime-state"],
    queryFn: () => api.get("/state"),
    refetchInterval: enabledPoll ? 3000 : false,
    onSuccess,
  });
}
function useRuntimeEvents(kind, issueId, enabledPoll, onSuccess) {
  const p = new URLSearchParams(); if (kind && kind !== "all") p.set("kind", kind); if (issueId && issueId !== "all") p.set("issueId", issueId);
  return useQuery({
    queryKey: ["runtime-events", kind, issueId],
    queryFn: () => api.get(`/events/feed${p.size ? `?${p}` : ""}`),
    enabled: enabledPoll,
    refetchInterval: enabledPoll ? 2500 : false,
    onSuccess,
  });
}
function useRuntimeStatus(enabledPoll) {
  return useQuery({
    queryKey: ["runtime-status"],
    queryFn: async () => {
      try { return await api.get("/status"); } catch (error) { return { status: "offline", error: error.message }; }
    },
    enabled: enabledPoll,
    refetchInterval: enabledPoll ? 5000 : false,
  });
}
function useProviders(enabledPoll) { return useQuery({ queryKey: ["providers"], queryFn: () => api.get("/providers"), enabled: enabledPoll, refetchInterval: enabledPoll ? 15000 : false }); }
function useParallelism(enabledPoll) { return useQuery({ queryKey: ["parallelism"], queryFn: () => api.get("/parallelism"), enabled: enabledPoll, refetchInterval: enabledPoll ? 15000 : false }); }

function Header({ status, wsStatus, theme, onThemeChange, issueCount, sourceRepo, updatedAt }) {
  return h("div", { className: "navbar bg-base-200 rounded-box mb-4 px-4 gap-2" }, [
    h("div", { className: "flex-1" }, [
      h("span", { className: "text-lg font-bold" }, "Fifony"),
      h("span", { className: "text-xs opacity-60 ml-2 hidden sm:inline" }, sourceRepo || "local"),
    ]),
    h("div", { className: "flex items-center gap-2 flex-wrap" }, [
      h("span", { className: `badge badge-sm ${status === "ok" ? "badge-success" : "badge-warning"}` }, status),
      h("span", { className: `badge badge-sm ${wsStatus === "connected" ? "badge-success" : "badge-warning"}` }, `ws: ${wsStatus}`),
      h("span", { className: "badge badge-sm badge-ghost" }, `${issueCount} issues`),
      h("span", { className: "text-xs opacity-50 hidden md:inline" }, timeAgo(updatedAt)),
      h("select", { className: "select select-bordered select-xs", value: theme, onChange: (e) => onThemeChange(e.target.value) },
        THEME_OPTIONS.map((t) => h("option", { key: t, value: t }, t))),
    ]),
  ]);
}

function StatIcon({ className, path }) {
  return h("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    fill: "none",
    viewBox: "0 0 24 24",
    className: `inline-block h-8 w-8 stroke-current ${className}`,
  }, h("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 2, d: path }));
}

function StatsBar({ metrics }) {
  const total = metrics.total || 0;
  const queued = metrics.queued || 0;
  const running = metrics.inProgress || 0;
  const blocked = metrics.blocked || 0;
  const done = metrics.done || 0;

  return h("div", { className: "stats stats-horizontal bg-base-200 rounded-box w-full mb-4 overflow-x-auto" }, [
    h("div", { className: "stat" }, [
      h("div", { className: "stat-figure text-secondary" }, h(StatIcon, { className: "text-secondary", path: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" })),
      h("div", { className: "stat-title" }, "Total"),
      h("div", { className: "stat-value" }, String(total)),
      h("div", { className: "stat-desc" }, `Current run: ${running + blocked}`),
    ]),
    h("div", { className: "stat" }, [
      h("div", { className: "stat-figure text-secondary" }, h(StatIcon, { className: "text-primary", path: "M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" })),
      h("div", { className: "stat-title" }, "Running"),
      h("div", { className: "stat-value text-primary" }, String(running)),
      h("div", { className: "stat-desc" }, queued ? `Queued: ${queued}` : "Queue is clear"),
    ]),
    h("div", { className: "stat" }, [
      h("div", { className: "stat-figure text-secondary" }, h(StatIcon, { className: "text-success", path: "M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" })),
      h("div", { className: "stat-title" }, "Done"),
      h("div", { className: "stat-value text-success" }, String(done)),
      h("div", { className: "stat-desc" }, blocked ? `Blocked: ${blocked}` : "No blocked issues"),
    ]),
  ]);
}

function NavIcon({ icon, className = "size-[1.2em]" }) {
  const map = {
    home: [
      { element: "polyline", attrs: { points: "1 11 12 2 23 11" } },
      { element: "path", attrs: { d: "M5 13v7c0 1.105.895 2 2 2h10c1.105 0 2-.895 2-2v-7" } },
      { element: "line", attrs: { x1: 12, y1: 22, x2: 12, y2: 18 } },
    ],
    inbox: [
      { element: "path", attrs: { d: "M3 14h6v3h6v-3h6" } },
      { element: "rect", attrs: { x: 3, y: 3, width: 18, height: 18, rx: 2, ry: 2 } },
    ],
    settings: [
      { element: "path", attrs: { d: "M12 20V10" } },
      { element: "path", attrs: { d: "M18 20V14" } },
      { element: "path", attrs: { d: "M6 20V16" } },
      { element: "path", attrs: { d: "M3 4h18" } },
    ],
    runtime: [
      { element: "path", attrs: { d: "M20.2 7.1 20 6a2 2 0 0 0-2-2h-4.3c-.4-1.2-1.4-2.1-2.7-2.1h-.4c-1.2 0-2.3.8-2.7 2.1H4a2 2 0 0 0-2 2l-.2 1.1c-.9.4-1.5 1.3-1.5 2.3v.2c0 .7.3 1.4.8 1.9l-.3 1.2c-.9.4-1.5 1.3-1.5 2.3v.6c0 1 .6 1.9 1.5 2.3l.3 1.2c-.5.5-.8 1.2-.8 1.9v.2c0 1.6 1.3 3 2.9 3h12.2c1.6 0 2.9-1.4 2.9-3v-.2c0-.7-.3-1.4-.8-1.9l.3-1.2c.9-.4 1.5-1.3 1.5-2.3v-.6c0-1-.6-1.9-1.5-2.3l-.3-1.2c.5-.5.8-1.2.8-1.9V7.1" } },
    ],
    add: [
      { element: "path", attrs: { d: "M8 0.75C4.548 0.75 1.75 3.548 1.75 7s2.798 6.25 6.25 6.25S14.25 10.452 14.25 7 11.452 0.75 8 0.75z" } },
      { element: "path", attrs: { d: "M8 4.75a.75.75 0 0 1 .75.75v1.75h1.75a.75.75 0 1 1 0 1.5H8.75v1.75a.75.75 0 1 1-1.5 0V7h-1.75a.75.75 0 1 1 0-1.5h1.75V4.75a.75.75 0 0 1 .75-.75Z", fill: "none" } },
    ],
    issue: [
      { element: "path", attrs: { d: "M8.5 2h-3A1.5 1.5 0 004 3.5v9a1.5 1.5 0 001.5 1.5h7A1.5 1.5 0 0014 12.5v-7a1.5 1.5 0 00-.439-1.061L11.561 2.44A1.5 1.5 0 0010.5 2h-2Z", fill: "none" } },
      { element: "path", attrs: { d: "M9.5 2h-.5V4a.5.5 0 00.5.5h2v-.5A1 1 0 0011 2h-1.5Z", fill: "none" } },
    ],
  };
  const parts = map[icon] || map.home;
  return h("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    className,
  }, h("g", { fill: "currentColor", strokeLinejoin: "miter", strokeLinecap: "butt" }, [
    ...parts.map((part) => h(part.element, { fill: "none", stroke: "currentColor", strokeWidth: 2, "stroke-miterlimit": 10, ...part.attrs })),
  ]));
}

function ViewTabs({ view, setView }) {
  return h("div", { role: "tablist", className: "tabs tabs-box tabs-sm" }, VIEW_ITEMS.map((item) =>
    h("button", {
      key: item.id,
      role: "tab",
      className: `tab ${view === item.id ? "tab-active" : ""}`,
      onClick: () => setView(item.id),
    }, item.label)));
}

function IssueViewTabs({ issueView, setIssueView }) {
  return h("div", { role: "tablist", className: "tabs tabs-sm" }, [
    h("button", { key: "kanban", role: "tab", className: `tab ${issueView === "kanban" ? "tab-active" : ""}`, onClick: () => setIssueView("kanban") }, "Kanban"),
    h("button", { key: "list", role: "tab", className: `tab ${issueView === "list" ? "tab-active" : ""}`, onClick: () => setIssueView("list") }, "Lista"),
  ]);
}

function MobileDock({ view, setView }) {
  return h("div", { className: "dock dock-md" }, [
    ...VIEW_ITEMS.map((item) => h("button", {
      key: item.id,
      className: item.id === view ? "dock-active" : undefined,
      onClick: () => setView(item.id),
    }, [h(NavIcon, { icon: item.icon }), h("span", { className: "dock-label" }, item.label)])),
  ]);
}

function IssueCard({ issue, onStateChange, onRetry, onCancel, onSelect }) {
  const transitions = getIssueTransitions(issue.state);
  return h("div", {
    className: "card card-compact bg-base-100 border border-base-300 cursor-pointer hover:shadow-md",
    role: "button",
    tabIndex: 0,
    onClick: () => onSelect?.(issue),
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect?.(issue);
      }
    },
  },
    h("div", { className: "card-body gap-2" }, [
      h("div", { className: "flex items-start justify-between gap-2" }, [
        h("div", { className: "min-w-0" }, [
          h("h3", { className: "font-semibold text-sm truncate" }, `${issue.identifier} -- ${issue.title}`),
          issue.description ? h("p", { className: "text-xs opacity-60 truncate" }, issue.description) : null,
        ]),
        h("span", { className: `badge badge-sm ${STATE_BADGE[issue.state] || "badge-ghost"} shrink-0` }, issue.state),
      ]),
      h("div", { className: "flex flex-wrap gap-1" }, [
        h("span", { className: "badge badge-xs badge-outline" }, `P${issue.priority}`),
        h("span", { className: "badge badge-xs badge-outline" }, `${issue.attempts}/${issue.maxAttempts}`),
        issue.capabilityCategory ? h("span", { className: "badge badge-xs badge-outline" }, issue.capabilityCategory) : null,
        h("span", { className: "badge badge-xs badge-ghost" }, timeAgo(issue.updatedAt)),
      ]),
      issue.lastError ? h("p", { className: "text-xs text-error truncate" }, issue.lastError) : null,
      h("div", { className: "card-actions justify-end" }, [
        h("select", { className: "select select-bordered select-xs", value: issue.state, onClick: (e) => e.stopPropagation(), onChange: (e) => { e.stopPropagation(); onStateChange(issue.id, e.target.value); } },
          transitions.map((s) => h("option", { key: s, value: s }, s))),
        h("button", { className: "btn btn-xs btn-soft", onClick: (e) => { e.stopPropagation(); onRetry(issue.id); }, disabled: issue.state === "In Progress" || issue.state === "In Review" }, "Retry"),
        h("button", { className: "btn btn-xs btn-ghost", onClick: (e) => { e.stopPropagation(); onCancel(issue.id); }, disabled: issue.state === "Done" || issue.state === "Cancelled" }, "Cancel"),
      ]),
    ]));
}

function BoardView({ issues, onStateChange, onRetry, onCancel, onSelect }) {
  const grouped = useMemo(() => {
    const b = Object.fromEntries(STATES.map((s) => [s, []]));
    for (const i of issues) (b[i.state] || b.Todo).push(i);
    for (const s of STATES) b[s].sort((a, c) => a.priority - c.priority);
    return b;
  }, [issues]);
  return h("div", { className: "board-grid" }, STATES.map((state) =>
    h("div", { key: state, className: "board-col bg-base-200 rounded-box p-3" }, [
      h("h3", { className: "text-xs font-bold uppercase tracking-wide opacity-70 mb-2" }, `${state} (${grouped[state].length})`),
      h("div", { className: "board-col-cards" },
        grouped[state].length === 0
          ? h("p", { className: "text-xs opacity-40 text-center py-4" }, "No issues")
          : grouped[state].map((i) => h(IssueCard, { key: i.id, issue: i, onStateChange, onRetry, onCancel, onSelect }))),
    ])));
}

function ListView({ issues, onStateChange, onRetry, onCancel, onSelect }) {
  return h("div", { className: "space-y-2" }, issues.length === 0
    ? h("p", { className: "text-sm opacity-50 text-center py-8" }, "No issues match filters")
    : issues.map((i) => h(IssueCard, { key: i.id, issue: i, onStateChange, onRetry, onCancel, onSelect })));
}

function IssueDetailDrawer({ issue, onClose }) {
  if (!issue) return null;
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  const paths = Array.isArray(issue.paths) ? issue.paths : [];
  const rows = [
    { label: "Identifier", value: issue.identifier || "-" },
    { label: "Title", value: issue.title || "-" },
    { label: "State", value: issue.state || "-" },
    { label: "Priority", value: String(issue.priority ?? "-") },
    { label: "Attempts", value: `${issue.attempts ?? 0}/${issue.maxAttempts ?? 0}` },
    { label: "Updated", value: timeAgo(issue.updatedAt) },
    { label: "Category", value: issue.capabilityCategory || "default" },
    { label: "Provider", value: issue.provider || "-" },
  ];
  return h("div", {
    className: "fixed inset-0 z-50 flex justify-end bg-base-content/25",
    onClick: onClose,
    "aria-hidden": true,
  }, [
    h("div", { className: "w-full max-w-md bg-base-100 h-full p-4 overflow-y-auto shadow-xl", onClick: (e) => e.stopPropagation() }, [
      h("div", { className: "flex items-start justify-between gap-2 mb-4" }, [
        h("h2", { className: "text-lg font-bold" }, `${issue.identifier} — ${issue.title || "Issue"}`),
        h("button", { className: "btn btn-xs btn-circle btn-ghost", onClick: onClose, "aria-label": "Close issue details" }, "✕"),
      ]),
      h("p", { className: "text-sm opacity-70 mb-4" }, issue.description || "No description"),
      h("div", { className: "space-y-2" }, rows.map((row) => h("div", { key: row.label, className: "flex justify-between text-sm" }, [
        h("span", { className: "opacity-60" }, row.label),
        h("span", { className: "font-medium" }, row.value),
      ]))),
      h("div", { className: "mt-4" }, [
        h("p", { className: "text-xs font-semibold mb-1 uppercase" }, "Labels"),
        labels.length ? h("div", { className: "flex flex-wrap gap-1" }, labels.map((label) => h("span", { key: `${label}`, className: "badge badge-sm badge-outline" }, label))) : h("p", { className: "text-xs opacity-50" }, "No labels"),
      ]),
      h("div", { className: "mt-3" }, [
        h("p", { className: "text-xs font-semibold mb-1 uppercase" }, "Paths"),
        paths.length ? h("div", { className: "flex flex-col gap-1 text-xs" }, paths.map((path) => h("span", { key: `${path}` }, path))) : h("p", { className: "text-xs opacity-50" }, "No paths"),
      ]),
      h("div", { className: "mt-4 pt-4 border-t border-base-300 flex justify-end" }, [
        h("button", { className: "btn btn-sm btn-soft", onClick: onClose }, "Fechar"),
      ]),
    ]),
  ]);
}

function EventsView({ events, kind, setKind, issueId, setIssueId, issueOptions }) {
  const rows = Array.isArray(events) ? events : [];
  return h("div", { className: "space-y-3" }, [
    h("div", { className: "flex flex-wrap gap-2 items-center" }, [
      h("select", { className: "select select-bordered select-sm", value: kind, onChange: (e) => setKind(e.target.value) },
        EVENT_KINDS.map((k) => h("option", { key: k, value: k }, k === "all" ? "All kinds" : k))),
      h("select", { className: "select select-bordered select-sm", value: issueId, onChange: (e) => setIssueId(e.target.value) },
        [h("option", { value: "all" }, "All issues"), ...issueOptions.map((id) => h("option", { key: id, value: id }, id))]),
    ]),
    rows.length === 0
      ? h("p", { className: "text-sm opacity-50 text-center py-8" }, "No events yet")
      : h("div", { className: "events-list" }, rows.slice(0, 100).map((ev, i) =>
          h("div", { key: `${ev.at}-${i}`, className: "bg-base-200 rounded-box px-3 py-2" }, [
            h("div", { className: "text-xs opacity-50" }, `${ev.at ? formatDate(ev.at) : "-"} -- ${ev.issueId || "system"} -- ${ev.kind || "info"}`),
            h("div", { className: "text-sm mt-0.5" }, ev.message || ""),
          ]))),
  ]);
}

function RuntimeView({ state, providers, parallelism, onRefresh, concurrency, setConcurrency, saveConcurrency }) {
  return h("div", { className: "space-y-4" }, [
    h("div", { className: "bg-base-200 rounded-box p-4 space-y-2" }, [
      h("h3", { className: "font-bold text-sm" }, "Runtime"),
      h("div", { className: "text-sm space-y-1" }, [h("p", {}, `Source: ${state.sourceRepoUrl || "local"}`), h("p", {}, `Tracker: ${state.trackerKind || "filesystem"}`), h("p", {}, `Agent: ${state.config?.agentProvider || "auto"}`), h("p", {}, `Started: ${formatDate(state.startedAt)}`)]),
      h("div", { className: "flex items-center gap-2 mt-2" }, [
        h("button", { className: "btn btn-sm btn-soft", onClick: onRefresh }, "Refresh"),
        h("label", { className: "text-xs" }, "Concurrency:"),
        h("input", { className: "input input-bordered input-sm w-20", type: "number", min: 1, max: 16, value: concurrency, onChange: (e) => setConcurrency(e.target.value) }),
        h("button", { className: "btn btn-sm btn-primary", onClick: saveConcurrency }, "Set"),
      ]),
    ]),
    h("div", { className: "grid gap-4 md:grid-cols-2" }, [
      h("div", { className: "bg-base-200 rounded-box p-4" }, [h("h3", { className: "font-bold text-sm mb-2" }, "Providers"), h("div", { className: "flex flex-wrap gap-2" }, providers?.providers?.length ? providers.providers.map((p) => h("span", { key: p.name, className: `badge badge-sm ${p.available ? "badge-success" : "badge-warning"}` }, p.name)) : h("span", { className: "text-sm opacity-50" }, "None"))]),
      h("div", { className: "bg-base-200 rounded-box p-4" }, [h("h3", { className: "font-bold text-sm mb-2" }, "Parallelism"), h("p", { className: "text-sm" }, typeof parallelism?.maxSafeParallelism === "number" ? `Max safe: ${parallelism.maxSafeParallelism}` : "No data"), parallelism?.reason ? h("p", { className: "text-xs opacity-60" }, parallelism.reason) : null]),
    ]),
  ]);
}

function CreateIssueForm({ onSubmit, isLoading, onCancel }) {
  const [form, setForm] = useState({ title: "", description: "", priority: "1", maxAttempts: "3", labels: "", paths: "" });
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));
  const submit = (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    onSubmit({ title: form.title.trim(), description: form.description.trim(), priority: parseInt(form.priority, 10) || 1, maxAttempts: parseInt(form.maxAttempts, 10) || 3, labels: normalizeCsv(form.labels), paths: normalizeCsv(form.paths) });
    setForm({ title: "", description: "", priority: "1", maxAttempts: "3", labels: "", paths: "" });
  };
  return h("form", { className: "bg-base-200 rounded-box p-4 space-y-2", onSubmit: submit }, [
    h("div", { className: "grid gap-2 md:grid-cols-2" }, [
      h("input", { className: "input input-bordered input-sm col-span-2", placeholder: "Title", value: form.title, onChange: set("title"), autoFocus: true }),
      h("input", { className: "input input-bordered input-sm col-span-2", placeholder: "Description", value: form.description, onChange: set("description") }),
      h("input", { className: "input input-bordered input-sm", type: "number", min: 1, max: 10, placeholder: "Priority", value: form.priority, onChange: set("priority") }),
      h("input", { className: "input input-bordered input-sm", type: "number", min: 1, max: 10, placeholder: "Max attempts", value: form.maxAttempts, onChange: set("maxAttempts") }),
      h("input", { className: "input input-bordered input-sm", placeholder: "Labels (comma-separated)", value: form.labels, onChange: set("labels") }),
      h("input", { className: "input input-bordered input-sm", placeholder: "Paths (comma-separated)", value: form.paths, onChange: set("paths") }),
    ]),
    h("div", { className: "flex justify-end gap-2" }, [
    h("button", { type: "button", className: "btn btn-sm btn-ghost", onClick: onCancel }, "Cancel"),
      h("button", { type: "submit", className: "btn btn-sm btn-primary", disabled: isLoading }, isLoading ? "Creating..." : "Create"),
    ]),
  ]);
}

function IssueFab({ onCreateIssue, isLoading }) {
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  const close = () => setOpen(false);
  const actionItems = [
    {
      id: "new-issue",
      label: "Nova issue",
      action: () => {
        close();
        onCreateIssue();
      },
      icon: "issue",
      style: "btn-secondary",
    },
  ];

  const handleKeyDown = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };

  return h("div", { className: "fab fixed bottom-4 right-4 z-50 md:bottom-6 md:right-6" }, [
    open ? null : h("div", {
      tabIndex: 0,
      role: "button",
      className: "btn btn-lg btn-circle btn-primary",
      onClick: toggle,
      onKeyDown: handleKeyDown,
      "aria-label": "Ações rápidas",
      "aria-expanded": String(open),
      "aria-controls": "issue-fab-actions",
      "data-state": open ? "open" : "closed",
    }, h(NavIcon, { icon: "add", className: "size-6" })),
    open ? h("div", { className: "fab-main-action" }, [
      h("span", { className: "text-xs opacity-80 font-medium" }, "Ação principal"),
      h("button", {
        type: "button",
        className: "btn btn-circle btn-secondary btn-lg",
        onClick: () => {
          close();
          onCreateIssue();
        },
        disabled: isLoading,
        "aria-label": "Abrir nova issue",
      }, isLoading ? h("span", { className: "loading loading-spinner loading-md" }) : h(NavIcon, { icon: "issue", className: "size-6" })),
    ]) : null,
    h("div", { id: "issue-fab-actions", className: open ? "" : "hidden" }, actionItems.map((item) =>
      h("div", { key: item.id, className: "flex items-center gap-2" }, [
        h("span", { className: "text-xs opacity-80 font-medium" }, item.label),
        h("button", {
          type: "button",
          className: `btn btn-lg btn-circle ${item.style}`,
          onClick: item.action,
          disabled: isLoading,
          "aria-label": item.label,
        }, isLoading ? h("span", { className: "loading loading-spinner loading-md" }) : h(NavIcon, { icon: item.icon, className: "size-6" })),
      ]),
    )),
  ]);
}

function Filters({ query, setQuery, stateFilter, setStateFilter, categoryFilter, setCategoryFilter, categoryOptions }) {
  return h("div", { className: "flex flex-wrap gap-2 items-center" }, [
    h("input", { className: "input input-bordered input-sm grow", placeholder: "Search issues...", value: query, onChange: (e) => setQuery(e.target.value) }),
    h("select", { className: "select select-bordered select-sm", value: stateFilter, onChange: (e) => setStateFilter(e.target.value) },
      [h("option", { value: "all" }, "All states"), ...STATES.map((s) => h("option", { key: s, value: s }, s))]),
    h("select", { className: "select select-bordered select-sm", value: categoryFilter, onChange: (e) => setCategoryFilter(e.target.value) },
      categoryOptions.map((c) => h("option", { key: c, value: c }, c === "all" ? "All capabilities" : c))),
  ]);
}

function AppShell() {
  const [theme, setTheme] = useState(() => normalizeTheme(localStorage.getItem("fifony-theme") || "auto"));
  const [view, setViewState] = useState(() => readViewFromLocation());
  const [issueView, setIssueViewState] = useState(() => readIssueLayoutFromLocation());
  const [stateFilter, setStateFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [eventKind, setEventKind] = useState("all");
  const [eventIssueId, setEventIssueId] = useState("all");
  const [concurrency, setConcurrency] = useState("2");
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [selectedIssue, setSelectedIssue] = useState(null);
  const qc = useQueryClient();
  const syncFromWs = useCallback((msg) => {
    if (!msg || typeof msg !== "object") return;
    setRuntimeSnapshot((current) => applyWsPayloadToState(current, msg));
    if (Array.isArray(msg.events)) setEventSnapshot(msg.events);
  }, []);
  const wsStatus = useRuntimeWebSocket(syncFromWs);
  const liveMode = wsStatus === "connected";

  const [runtimeSnapshot, setRuntimeSnapshot] = useState(null);
  const [eventSnapshot, setEventSnapshot] = useState([]);
  const runtime = useRuntimeState({
    enabledPoll: !liveMode,
    onSuccess: (data) => {
      setRuntimeSnapshot((prev) => (liveMode ? prev : data));
      setConcurrency(data?.config?.workerConcurrency ? String(data.config.workerConcurrency) : concurrency);
      if (!liveMode && Array.isArray(data?.events)) setEventSnapshot(data.events);
    },
  });
  const events = useRuntimeEvents(eventKind, eventIssueId, !liveMode, (data) => {
    setEventSnapshot(Array.isArray(data?.events) ? data.events : []);
  });
  const providers = useProviders(!liveMode);
  const parallelism = useParallelism(!liveMode);
  const runtimeStatus = useRuntimeStatus(!liveMode);
  const data = runtimeSnapshot || runtime.data || {};
  const issues = Array.isArray(data.issues) ? data.issues : [];
  const metrics = data.metrics || {};
  const status = liveMode ? "ok" : runtimeStatus.data?.status || (data.config ? "ok" : "offline");
  const filtered = useMemo(() => { const q = query.toLowerCase(); return issues.filter((i) => { if (stateFilter !== "all" && i.state !== stateFilter) return false; if (categoryFilter !== "all" && (i.capabilityCategory || "default") !== categoryFilter) return false; if (q && !`${i.identifier} ${i.title} ${i.description || ""}`.toLowerCase().includes(q)) return false; return true; }); }, [issues, stateFilter, categoryFilter, query]);
  const categoryOptions = useMemo(() => { const c = new Set(issues.map((i) => i.capabilityCategory).filter(Boolean)); return ["all", ...[...c].sort()]; }, [issues]);
  const issueOptions = useMemo(() => [...new Set(issues.map((i) => i.id))].sort(), [issues]);
  const showToast = useCallback((msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); }, []);

  const createIssue = useMutation({ mutationFn: (p) => api.post("/issues/create", p), onSuccess: () => { qc.invalidateQueries({ queryKey: ["runtime-state"] }); setIsCreateFormOpen(false); showToast("Issue created"); }, onError: (e) => showToast(e.message) });
  const updateState = useMutation({ mutationFn: ({ id, state }) => api.post(`/issues/${encodeURIComponent(id)}/state`, { state }), onSuccess: () => qc.invalidateQueries({ queryKey: ["runtime-state"] }), onError: (e) => showToast(e.message) });
  const retryMut = useMutation({ mutationFn: (id) => api.post(`/issues/${encodeURIComponent(id)}/retry`), onSuccess: () => qc.invalidateQueries({ queryKey: ["runtime-state"] }), onError: (e) => showToast(e.message) });
  const cancelMut = useMutation({ mutationFn: (id) => api.post(`/issues/${encodeURIComponent(id)}/cancel`), onSuccess: () => qc.invalidateQueries({ queryKey: ["runtime-state"] }), onError: (e) => showToast(e.message) });
  const refreshMut = useMutation({ mutationFn: () => api.post("/refresh", {}), onSuccess: () => qc.invalidateQueries(), onError: (e) => showToast(e.message) });
  const saveConcMut = useMutation({ mutationFn: () => api.post("/config/concurrency", { concurrency: parseInt(concurrency, 10) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["runtime-state"] }); showToast("Updated"); }, onError: (e) => showToast(e.message) });

  useEffect(() => { document.documentElement.setAttribute("data-theme", resolveTheme(theme)); localStorage.setItem("fifony-theme", theme); }, [theme]);
  useEffect(() => { const fn = () => { if (theme === "auto") setTheme("auto"); }; SYSTEM_THEME_QUERY.addEventListener?.("change", fn); return () => SYSTEM_THEME_QUERY.removeEventListener?.("change", fn); }, [theme]);
  useEffect(() => { navigator?.serviceWorker?.register?.("/service-worker.js").catch(() => {}); }, []);
  useEffect(() => { if (data.config?.workerConcurrency) setConcurrency(String(data.config.workerConcurrency)); }, [data.config?.workerConcurrency]);
  useEffect(() => {
    const onPop = () => {
      const next = readViewFromLocation();
      const nextIssueView = readIssueLayoutFromLocation();
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
    if (!ISSUE_VIEWS.includes(nextMode)) return;
    writeIssueLayoutToLocation(nextMode);
    setIssueViewState(nextMode);
  }, []);

  if (runtime.isLoading && !runtime.data && !runtimeSnapshot) return h("div", { className: "app-loader" }, h("span", { className: "loading loading-spinner loading-lg" }));

  return h("div", { className: "app-shell container mx-auto p-4" }, [
    toast ? h("div", { className: "toast-fixed" }, h("div", { className: "alert alert-info text-sm" }, toast)) : null,
    h(Header, { status, wsStatus, theme, onThemeChange: setTheme, issueCount: issues.length, sourceRepo: data.sourceRepoUrl, updatedAt: data.updatedAt }),
    h(StatsBar, { metrics }),
    h("div", { className: "flex items-center justify-between gap-3 mb-4 flex-wrap" }, [
      h("div", { className: "hidden md:flex" }, h(ViewTabs, { view, setView })),
      h("div", { className: "md:hidden w-full" }, h(MobileDock, { view, setView })),
    ]),
    isCreateFormOpen ? h("div", { className: "fixed inset-0 z-40 flex items-start justify-center bg-base-content/25 p-4 pt-16", onClick: (e) => { if (e.target === e.currentTarget) setIsCreateFormOpen(false); } }, [
      h("div", { className: "w-full max-w-xl", onClick: (e) => e.stopPropagation() }, h(CreateIssueForm, {
        onSubmit: (p) => createIssue.mutate(p),
        isLoading: createIssue.isPending,
        onCancel: () => setIsCreateFormOpen(false),
      })),
    ]) : null,
    view === "issues" ? h("div", { className: "mb-4 space-y-2" }, [
      h(IssueViewTabs, { issueView, setIssueView }),
      h(Filters, { query, setQuery, stateFilter, setStateFilter, categoryFilter, setCategoryFilter, categoryOptions }),
    ]) : null,
    h("div", { className: "tab-content" }, (() => {
      if (view === "issues") {
        if (issueView === "list") return h(ListView, { issues: filtered, onStateChange: (id, s) => updateState.mutate({ id, state: s }), onRetry: (id) => retryMut.mutate(id), onCancel: (id) => cancelMut.mutate(id), onSelect: setSelectedIssue });
        return h(BoardView, { issues: filtered, onStateChange: (id, s) => updateState.mutate({ id, state: s }), onRetry: (id) => retryMut.mutate(id), onCancel: (id) => cancelMut.mutate(id), onSelect: setSelectedIssue });
      }
      if (view === "events") {
        const wsEvents = liveMode ? eventSnapshot : events.data?.events || [];
        const filteredEvents = liveMode
          ? wsEvents.filter((entry) => (eventKind === "all" || entry.kind === eventKind) && (eventIssueId === "all" || entry.issueId === eventIssueId))
          : wsEvents;
        return h(EventsView, { events: filteredEvents, kind: eventKind, setKind: setEventKind, issueId: eventIssueId, setIssueId: setEventIssueId, issueOptions });
      }
      return h(RuntimeView, { state: data, providers: providers.data || {}, parallelism: parallelism.data || {}, onRefresh: () => refreshMut.mutate(), concurrency, setConcurrency, saveConcurrency: () => saveConcMut.mutate() });
    })()),
    runtime.isError ? h("div", { className: "alert alert-error mt-4" }, String(runtime.error?.message || "Runtime unavailable")) : null,
    view !== "events" && view !== "runtime" ? h(IssueFab, { onCreateIssue: () => setIsCreateFormOpen(true), isLoading: createIssue.isPending }) : null,
    h(IssueDetailDrawer, { issue: selectedIssue, onClose: () => setSelectedIssue(null) }),
  ]);
}

const root = document.getElementById("root");
if (root) createRoot(root).render(h(React.StrictMode, null, h(QueryClientProvider, { client: queryClient }, h(AppShell))));
