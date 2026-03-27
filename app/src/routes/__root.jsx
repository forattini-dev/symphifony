import { createRootRoute, Outlet, useRouterState, useNavigate } from "@tanstack/react-router";
import mascotUrl from "/dinofffaur.webp?url";
import { DashboardProvider, useDashboard } from "../context/DashboardContext";
import { useSettings, getSettingsList } from "../hooks";
import { hasCompletedOnboarding } from "../onboarding-state.js";
import { lazy, Suspense, useState, useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Header from "../components/Header";
import Fab from "../components/Fab";
import MobileDock from "../components/MobileDock";
import CreateIssueDrawer from "../components/CreateIssueForm";
import IssueDetailDrawer from "../components/IssueDetailDrawer";
import PwaBanner from "../components/PwaBanner";
import Confetti from "../components/Confetti";
import { ISSUE_DRAWER_TABS } from "../components/IssueDetailDrawer/constants.js";
import { CheckCircle, AlertTriangle, Info, RotateCcw, ChevronDown } from "lucide-react";
import { useHotkeys } from "react-hotkeys-hook";
import { HotkeysProvider } from "react-hotkeys-hook";

const KeyboardShortcutsHelp = lazy(() => import("../components/KeyboardShortcutsHelp"));
const CommandPalette = lazy(() => import("../components/CommandPalette"));

function ViewTransition({ children }) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const containerRef = useRef(null);
  const prevPathRef = useRef(pathname);

  useEffect(() => {
    if (prevPathRef.current === pathname) return;
    prevPathRef.current = pathname;
    const el = containerRef.current;
    if (!el) return;

    // Native View Transitions API (Chrome 111+)
    if (document.startViewTransition) {
      document.startViewTransition(() => {
        el.style.opacity = "1";
      });
      return;
    }

    // Fallback: quick CSS fade
    el.style.opacity = "0";
    el.style.transform = "translateY(4px)";
    requestAnimationFrame(() => {
      el.style.transition = "opacity 0.15s ease-out, transform 0.15s ease-out";
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
      const cleanup = () => { el.style.transition = ""; };
      el.addEventListener("transitionend", cleanup, { once: true });
    });
  }, [pathname]);

  return (
    <div ref={containerRef} className="flex-1 flex flex-col min-h-0">
      {children}
    </div>
  );
}

function RootLayout() {
  const ctx = useDashboard();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Drawer tab state — lifted here so keyboard shortcuts can switch tabs
  const drawerTabRef = useRef(null);
  const [, forceDrawerTab] = useState(0); // trigger for tab change from shortcut

  useEffect(() => {
    document.title = ctx.queueTitle || "fifony";
  }, [ctx.queueTitle]);

  const hasDrawer = !!ctx.selectedIssue;
  const hasCreate = ctx.isCreateOpen;
  const hasPalette = commandPaletteOpen;
  const hasHelp = shortcutsHelpOpen;

  const closeTopmost = useCallback(() => {
    if (hasPalette) { setCommandPaletteOpen(false); return; }
    if (hasHelp) { setShortcutsHelpOpen(false); return; }
    if (hasCreate) { ctx.setIsCreateOpen(false); return; }
    if (hasDrawer) { ctx.setSelectedIssue(null); return; }
  }, [hasPalette, hasHelp, hasCreate, hasDrawer, ctx]);

  // Navigate to next/prev issue while drawer is open
  const navigateIssue = useCallback((direction) => {
    if (!ctx.selectedIssue) return;
    const list = ctx.issues;
    const idx = list.findIndex((i) => i.id === ctx.selectedIssue.id);
    if (idx < 0) return;
    const next = idx + direction;
    if (next >= 0 && next < list.length) {
      ctx.setSelectedIssue(list[next]);
    }
  }, [ctx]);

  // Switch drawer tab
  const switchDrawerTab = useCallback((direction) => {
    if (!drawerTabRef.current) return;
    const tabs = ISSUE_DRAWER_TABS.map((t) => t.id);
    const curIdx = tabs.indexOf(drawerTabRef.current.get());
    if (curIdx < 0) return;
    const next = curIdx + direction;
    if (next >= 0 && next < tabs.length) {
      drawerTabRef.current.set(tabs[next]);
      forceDrawerTab((v) => v + 1);
    }
  }, []);

  // Primary action: Execute / Approve / Merge depending on issue state
  const primaryAction = useCallback(() => {
    const issue = ctx.selectedIssue;
    if (!issue) return;
    const s = issue.state;
    if (s === "PendingApproval") {
      // Execute
      import("../api.js").then(({ api }) => api.post(`/issues/${encodeURIComponent(issue.id)}/execute`))
        .then(() => qc.invalidateQueries({ queryKey: ["runtime-state"] }));
    } else if (s === "PendingDecision") {
      // Approve & Merge (only after review is complete)
      import("../api.js").then(({ api }) => api.post(`/issues/${encodeURIComponent(issue.id)}/approve-and-merge`))
        .then(() => qc.invalidateQueries({ queryKey: ["runtime-state"] }));
    } else if (s === "Approved" && !issue.mergedAt) {
      // Merge
      import("../api.js").then(({ api }) => api.post(`/issues/${encodeURIComponent(issue.id)}/merge`))
        .then(() => qc.invalidateQueries({ queryKey: ["runtime-state"] }));
    }
  }, [ctx, qc]);

  const noDrawer = !hasDrawer;
  const issueState = ctx.selectedIssue?.state;
  const canApproveOnly = issueState === "PendingDecision";
  const canRework = issueState === "Reviewing" || issueState === "PendingDecision";
  const canMerge = issueState === "Approved" && !ctx.selectedIssue?.mergedAt;
  const canReplan = !!ctx.selectedIssue?.plan && !["Running", "Reviewing", "Queued", "Planning"].includes(issueState);

  // ── Global ──────────────────────────────────────────────────────────
  useHotkeys("escape", closeTopmost, { description: "Close drawer / modal", metadata: { group: "global" } }, [closeTopmost]);
  useHotkeys("shift+/", () => setShortcutsHelpOpen((v) => !v), { description: "Keyboard shortcuts help", metadata: { group: "global" } });
  useHotkeys("mod+k", () => setCommandPaletteOpen((v) => !v), { preventDefault: true, enableOnFormTags: true, description: "Command palette", metadata: { group: "palette" } });
  useHotkeys("r", () => ctx.refresh(), { enabled: noDrawer, description: "Refresh", metadata: { group: "global" } }, [ctx, noDrawer]);

  // ── Navigation ──────────────────────────────────────────────────────
  useHotkeys("n", () => ctx.setIsCreateOpen(true), { enabled: noDrawer, description: "New issue", metadata: { group: "navigation" } }, [ctx, noDrawer]);
  useHotkeys("k", () => navigate({ to: "/kanban" }), { enabled: noDrawer && pathname !== "/kanban", description: "Go to Kanban", metadata: { group: "navigation" } }, [navigate, noDrawer, pathname]);
  useHotkeys("i", () => navigate({ to: "/issues" }), { enabled: noDrawer && pathname !== "/issues", description: "Go to Issues", metadata: { group: "navigation" } }, [navigate, noDrawer, pathname]);
  useHotkeys("a", () => navigate({ to: "/agents" }), { enabled: noDrawer, description: "Go to Agents", metadata: { group: "navigation" } }, [navigate, noDrawer]);
  useHotkeys("t", () => navigate({ to: "/analytics" }), { enabled: noDrawer, description: "Go to Analytics", metadata: { group: "navigation" } }, [navigate, noDrawer]);
  useHotkeys("s", () => navigate({ to: "/settings" }), { enabled: noDrawer, description: "Go to Settings", metadata: { group: "navigation" } }, [navigate, noDrawer]);
  useHotkeys("w", () => navigate({ to: "/services" }), { enabled: noDrawer, description: "Go to Services", metadata: { group: "navigation" } }, [navigate, noDrawer]);

  // ── Drawer ──────────────────────────────────────────────────────────
  useHotkeys("]", () => switchDrawerTab(1), { enabled: hasDrawer, description: "Next tab", metadata: { group: "drawer" } }, [switchDrawerTab, hasDrawer]);
  useHotkeys("[", () => switchDrawerTab(-1), { enabled: hasDrawer, description: "Previous tab", metadata: { group: "drawer" } }, [switchDrawerTab, hasDrawer]);
  useHotkeys("j", () => navigateIssue(1), { enabled: hasDrawer, description: "Next issue", metadata: { group: "drawer" } }, [navigateIssue, hasDrawer]);
  useHotkeys("k", () => navigateIssue(-1), { enabled: hasDrawer, description: "Previous issue", metadata: { group: "drawer" } }, [navigateIssue, hasDrawer]);
  useHotkeys("mod+enter", primaryAction, { enabled: hasDrawer, enableOnFormTags: true, preventDefault: true, description: "Primary action (Execute / Approve / Merge)", metadata: { group: "drawer" } }, [primaryAction, hasDrawer]);
  useHotkeys("mod+a", () => ctx.updateState(ctx.selectedIssue.id, "Approved"), { enabled: canApproveOnly, enableOnFormTags: true, preventDefault: true, description: "Approve issue", metadata: { group: "drawer" } }, [ctx, canApproveOnly]);
  useHotkeys("mod+m", () => import("../api.js").then(({ api }) => api.post(`/issues/${encodeURIComponent(ctx.selectedIssue.id)}/merge`)), { enabled: canMerge, enableOnFormTags: true, preventDefault: true, description: "Merge issue", metadata: { group: "drawer" } }, [ctx, canMerge]);
  useHotkeys("mod+w", () => ctx.retryIssue(ctx.selectedIssue.id), { enabled: canRework, enableOnFormTags: true, preventDefault: true, description: "Rework issue", metadata: { group: "drawer" } }, [ctx, canRework]);
  useHotkeys("mod+p", () => import("../api.js").then(({ api }) => api.post(`/issues/${encodeURIComponent(ctx.selectedIssue.id)}/replan`)), { enabled: canReplan, enableOnFormTags: true, preventDefault: true, description: "Replan issue", metadata: { group: "drawer" } }, [ctx, canReplan]);

  // Splash screen with minimum duration so it doesn't flash
  const [splashDone, setSplashDone] = useState(false);
  const [splashFading, setSplashFading] = useState(false);
  const splashTimerRef = useRef(null);
  const isFirstLoad = ctx.runtime.isLoading && !ctx.runtime.data && !ctx.runtime.isError;

  useEffect(() => {
    if (!splashDone && !splashTimerRef.current) {
      splashTimerRef.current = setTimeout(() => {
        setSplashFading(true);
        setTimeout(() => setSplashDone(true), 400); // fade-out duration
      }, 1000); // minimum splash duration
    }
    return () => {};
  }, [splashDone]);

  if (!splashDone && isFirstLoad) {
    return <LoadingHero />;
  }
  if (!splashDone && splashFading) {
    return <LoadingHero fadeOut />;
  }
  if (!splashDone && !isFirstLoad) {
    // Data arrived but timer hasn't finished — show splash until timer completes
    return <LoadingHero />;
  }

  const toastType = ctx.toast?.type || "info";
  const toastMessage = typeof ctx.toast === "string" ? ctx.toast : ctx.toast?.message;

  return (
      <div className="min-h-screen flex flex-col">
        {ctx.toast && (
          <div className="toast toast-end toast-top z-50">
            <div className={`alert text-sm shadow-lg ${toastType === "success" ? "alert-success" : toastType === "error" ? "alert-error" : "alert-info"} ${ctx.toastExiting ? "animate-toast-out" : "animate-toast-in"}`}>
              {toastType === "success" ? <CheckCircle className="size-4" /> : toastType === "error" ? <AlertTriangle className="size-4" /> : <Info className="size-4" />}
              <span>{toastMessage}</span>
              <div className="toast-progress" />
            </div>
          </div>
        )}
        {ctx.confetti && (
          <Confetti x={ctx.confetti.x} y={ctx.confetti.y} count={ctx.confetti.count} active onDone={() => ctx.clearConfetti?.()} />
        )}

        <Header
          issueCount={ctx.issues.length}
          queueTitle={ctx.queueTitle}
          sourceRepo={ctx.data.sourceRepoUrl}
          updatedAt={ctx.data.updatedAt}
          wsStatus={ctx.wsStatus}
          issues={ctx.issues}
        />
        <PwaBanner pwa={ctx.pwa} />

        <div className="flex-1 flex flex-col min-h-0">
          <ViewTransition>
            <Outlet />
          </ViewTransition>

          {ctx.runtime.isError && (
            <div className="px-4 pb-4">
              <div className="alert alert-error">{String(ctx.runtime.error?.message || "Runtime unavailable")}</div>
            </div>
          )}
        </div>

        <Fab onClick={() => ctx.setIsCreateOpen(true)} />
        <MobileDock />
        <CreateIssueDrawer
          open={ctx.isCreateOpen}
          onClose={() => ctx.setIsCreateOpen(false)}
          onSubmit={(p) => ctx.createIssue.mutate(p)}
          isLoading={ctx.createIssue.isPending}
          onToast={ctx.showToast}
        />
        <IssueDetailDrawer
          issue={ctx.selectedIssue}
          onClose={() => ctx.setSelectedIssue(null)}
          onStateChange={ctx.updateState}
          onRetry={ctx.retryIssue}
          onCancel={ctx.cancelIssue}
          onDelete={ctx.deleteIssue}
          events={ctx.eventsData}
          mergeMode={ctx.data?.config?.mergeMode ?? "local"}
          tabRef={drawerTabRef}
        />
        {shortcutsHelpOpen && (
          <Suspense fallback={null}>
            <KeyboardShortcutsHelp
              open={shortcutsHelpOpen}
              onClose={() => setShortcutsHelpOpen(false)}
            />
          </Suspense>
        )}
        {commandPaletteOpen && (
          <Suspense fallback={null}>
            <CommandPalette
              issues={ctx.issues}
              onSelect={(issue) => { ctx.setSelectedIssue(issue); setCommandPaletteOpen(false); }}
              onNavigate={(to) => { navigate({ to }); setCommandPaletteOpen(false); }}
              onAction={(fn) => { fn(); setCommandPaletteOpen(false); }}
              onClose={() => setCommandPaletteOpen(false)}
            />
          </Suspense>
        )}
      </div>
  );
}

function LoadingHero({ fadeOut = false }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-base-100 flex flex-col items-center justify-center overflow-hidden"
      style={{
        opacity: fadeOut ? 0 : 1,
        transition: "opacity 0.4s ease-out",
      }}
    >
      <div className="relative z-10 flex flex-col items-center gap-5">
        <div className="flex items-end gap-4">
          <img
            src={mascotUrl}
            alt=""
            className="h-20 sm:h-28 object-contain select-none pointer-events-none"
            style={{
              filter: "drop-shadow(0 6px 20px rgba(128, 0, 255, 0.25))",
              animation: "splash-dino 0.6s cubic-bezier(0.22, 1, 0.36, 1) both",
            }}
          />
          <h1
            className="text-4xl sm:text-5xl font-bold tracking-tight leading-none pb-1"
            style={{
              fontFamily: "'Space Grotesk', system-ui, sans-serif",
              animation: "splash-title 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.15s both",
            }}
          >
            <span className="text-primary">fifony</span>
          </h1>
        </div>
        <div
          className="flex items-center gap-3 text-base-content/40"
          style={{ animation: "splash-subtitle 0.4s ease-out 0.4s both" }}
        >
          <span className="loading loading-dots loading-sm" />
          <span className="text-sm">Warming up the orchestra...</span>
        </div>
      </div>
    </div>
  );
}

function OnboardingGate({ children }) {
  const settingsQuery = useSettings();

  const settingsList = getSettingsList(settingsQuery.data);
  const completed = hasCompletedOnboarding(settingsList);

  // Still loading settings (first fetch) — show hero briefly
  if (settingsQuery.isLoading && !settingsQuery.data) {
    return <LoadingHero />;
  }

  // If settings failed to load (backend down), skip the gate — don't block the app
  if (settingsQuery.isError) {
    return children;
  }

  // Wait for any in-flight settings fetch before deciding to redirect.
  // Prevents false redirect when the optimistic update is in cache but a background
  // refetch (triggered right after handleLaunch saves) hasn't returned yet.
  if (!completed && settingsQuery.isFetching) {
    return <LoadingHero />;
  }

  // Onboarding not completed — redirect to /onboarding
  if (!completed) {
    return (
      <Suspense fallback={<LoadingHero />}>
        <OnboardingRedirect />
      </Suspense>
    );
  }

  return children;
}

function OnboardingRedirect() {
  const navigate = useNavigate();
  const didRedirect = useRef(false);

  useEffect(() => {
    if (!didRedirect.current) {
      didRedirect.current = true;
      navigate({ to: "/onboarding", replace: true });
    }
  }, [navigate]);

  return <LoadingHero />;
}

function RootComponent() {
  const routerState = useRouterState();
  const isOnboarding = routerState.location.pathname === "/onboarding";

  return (
    <HotkeysProvider>
      <DashboardProvider>
        {isOnboarding ? (
          <Outlet />
        ) : (
          <OnboardingGate>
            <RootLayout />
          </OnboardingGate>
        )}
      </DashboardProvider>
    </HotkeysProvider>
  );
}

// Parse a stack trace into structured frames for display
function parseStack(stack) {
  if (!stack) return [];
  return stack
    .split("\n")
    .slice(1) // skip the first line (it's the error message repeated)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .map((line) => {
      // "at Component (http://localhost:5173/src/foo.jsx:12:34)"
      // "at http://localhost:5173/src/foo.jsx:12:34"
      const namedMatch = line.match(/^at (.+?) \((.+):(\d+):(\d+)\)$/);
      const anonMatch = line.match(/^at (.+):(\d+):(\d+)$/);
      if (namedMatch) {
        return { fn: namedMatch[1], file: namedMatch[2], line: namedMatch[3], col: namedMatch[4] };
      }
      if (anonMatch) {
        return { fn: null, file: anonMatch[1], line: anonMatch[2], col: anonMatch[3] };
      }
      return { fn: null, file: line, line: null, col: null };
    });
}

function shortenPath(file) {
  if (!file) return file;
  // Strip origin (http://localhost:5173) and keep path
  try {
    const url = new URL(file);
    return url.pathname + (url.searchParams.toString() ? "?" + url.searchParams : "");
  } catch {
    return file;
  }
}

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`btn btn-xs btn-ghost gap-1 font-mono ${copied ? "text-success" : "opacity-50 hover:opacity-100"}`}
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? "✓ copied" : "copy"}
    </button>
  );
}

function RootErrorComponent({ error, reset }) {
  const [showStack, setShowStack] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  const name = error?.name || "Error";
  const message = error?.message || String(error) || "An unexpected error occurred.";
  const stack = error?.stack || "";
  const frames = parseStack(stack);
  const route = window.location.pathname;
  const ts = new Date().toLocaleTimeString();
  const userAgent = navigator.userAgent;

  const fullReport = `${name}: ${message}\n\nRoute: ${route}\nTime: ${new Date().toISOString()}\n\n${stack}`;

  // Find the first app frame (not vendor/node_modules)
  const appFrames = frames.filter(
    (f) => f.file && !f.file.includes("node_modules") && !f.file.includes("chunk-") && !f.file.includes("vendor-"),
  );
  const firstAppFrame = appFrames[0] || frames[0];

  return (
    <div className="min-h-screen bg-base-200 flex flex-col">
      {/* Top bar */}
      <div className="bg-error text-error-content px-4 py-2.5 flex items-center gap-3 shrink-0">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="font-mono text-sm font-semibold flex-1 truncate">{name}: {message}</span>
        <span className="text-xs opacity-60 shrink-0">{ts}</span>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row gap-0 min-h-0 overflow-auto">
        {/* Left: main error info */}
        <div className="flex-1 p-6 space-y-5 min-w-0">

          {/* Error card */}
          <div className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden">
            <div className="px-5 py-3 border-b border-base-300 flex items-center justify-between gap-3">
              <span className="text-xs font-semibold uppercase tracking-wider opacity-40">Error</span>
              <CopyBtn text={fullReport} />
            </div>
            <div className="p-5 space-y-3">
              <div className="flex items-start gap-3">
                <span className="badge badge-error badge-sm mt-0.5 shrink-0 font-mono">{name}</span>
                <p className="font-mono text-sm text-error leading-relaxed break-all">{message}</p>
              </div>

              {firstAppFrame && (
                <div className="flex items-center gap-2 text-xs text-base-content/50">
                  <span className="opacity-40">at</span>
                  <span className="font-mono font-semibold text-base-content/70">{firstAppFrame.fn || "<anonymous>"}</span>
                  <span className="opacity-30">—</span>
                  <span className="font-mono">{shortenPath(firstAppFrame.file)}</span>
                  {firstAppFrame.line && (
                    <span className="badge badge-xs badge-ghost font-mono">:{firstAppFrame.line}:{firstAppFrame.col}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Context */}
          <div className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden">
            <div className="px-5 py-3 border-b border-base-300">
              <span className="text-xs font-semibold uppercase tracking-wider opacity-40">Context</span>
            </div>
            <div className="divide-y divide-base-200">
              {[
                { label: "Route", value: route },
                { label: "Time", value: new Date().toISOString() },
                { label: "User Agent", value: userAgent },
              ].map(({ label, value }) => (
                <div key={label} className="px-5 py-2.5 flex items-start gap-4">
                  <span className="text-xs font-semibold opacity-40 w-24 shrink-0 pt-0.5">{label}</span>
                  <span className="font-mono text-xs break-all text-base-content/70">{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Stack trace */}
          {frames.length > 0 && (
            <div className="bg-base-100 rounded-2xl border border-base-300 overflow-hidden">
              <div className="px-5 py-3 border-b border-base-300 flex items-center justify-between gap-3">
                <button
                  className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider opacity-40 hover:opacity-70 transition-opacity"
                  onClick={() => setShowStack((v) => !v)}
                >
                  <ChevronDown className={`size-3.5 transition-transform ${showStack ? "rotate-180" : ""}`} />
                  Stack trace
                  <span className="badge badge-xs badge-ghost normal-case tracking-normal font-mono">{frames.length} frames</span>
                </button>
                <div className="flex items-center gap-1">
                  <button
                    className={`btn btn-xs btn-ghost opacity-50 hover:opacity-100 ${showRaw ? "btn-active" : ""}`}
                    onClick={() => setShowRaw((v) => !v)}
                  >
                    raw
                  </button>
                  <CopyBtn text={stack} />
                </div>
              </div>

              {showStack && (
                showRaw ? (
                  <pre className="px-5 py-4 text-[11px] font-mono leading-relaxed text-base-content/60 overflow-x-auto whitespace-pre-wrap">
                    {stack}
                  </pre>
                ) : (
                  <div className="divide-y divide-base-200">
                    {frames.map((frame, i) => {
                      const isApp = frame.file && !frame.file.includes("node_modules") && !frame.file.includes("chunk-") && !frame.file.includes("vendor-");
                      const shortFile = shortenPath(frame.file);
                      return (
                        <div
                          key={i}
                          className={`px-5 py-2 flex items-start gap-3 ${isApp ? "bg-warning/5" : "opacity-40"}`}
                        >
                          <span className="font-mono text-[10px] opacity-30 w-5 shrink-0 text-right pt-0.5">{i}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              {frame.fn && (
                                <span className={`font-mono text-xs font-semibold ${isApp ? "text-warning" : "text-base-content/60"}`}>
                                  {frame.fn}
                                </span>
                              )}
                              {isApp && <span className="badge badge-xs badge-warning badge-soft">app</span>}
                            </div>
                            <div className="font-mono text-[10px] text-base-content/40 truncate">
                              {shortFile}
                              {frame.line && <span className="text-base-content/60 ml-0.5">:{frame.line}:{frame.col}</span>}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {/* Right: actions sidebar */}
        <div className="lg:w-64 p-6 space-y-4 shrink-0">
          <div className="space-y-2">
            <button
              className="btn btn-primary w-full gap-2"
              onClick={() => window.location.reload()}
            >
              <RotateCcw className="size-4" /> Reload page
            </button>
            {reset && (
              <button
                className="btn btn-ghost w-full gap-2"
                onClick={reset}
              >
                Try to recover
              </button>
            )}
            <button
              className="btn btn-ghost w-full gap-2"
              onClick={() => { window.location.href = "/"; }}
            >
              Go home
            </button>
          </div>

          <div className="divider text-xs opacity-30">about</div>

          <div className="space-y-1 text-xs text-base-content/40">
            <p>This error was caught by the app's error boundary. The details above will help you identify the root cause.</p>
            <p className="mt-2">App frames are <span className="text-warning font-semibold">highlighted</span>.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
  errorComponent: RootErrorComponent,
});
