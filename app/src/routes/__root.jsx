import { createRootRoute, Outlet, useRouterState, useNavigate } from "@tanstack/react-router";
import { DashboardProvider, useDashboard } from "../context/DashboardContext";
import { useSettings, getSettingsList, getSettingValue } from "../hooks";
import { lazy, Suspense, useState, useCallback, useEffect, useMemo, useRef } from "react";
import Header from "../components/Header";
import Fab from "../components/Fab";
import MobileDock from "../components/MobileDock";
import EventsDrawer from "../components/EventsDrawer";
import CreateIssueDrawer from "../components/CreateIssueForm";
import IssueDetailDrawer from "../components/IssueDetailDrawer";
import PwaBanner from "../components/PwaBanner";
import Confetti from "../components/Confetti";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { CheckCircle, AlertTriangle, Info, Music } from "lucide-react";
import OnboardingParticles from "../components/OnboardingParticles";

const KeyboardShortcutsHelp = lazy(() => import("../components/KeyboardShortcutsHelp"));

function ViewTransition({ children }) {
  const routerState = useRouterState();
  const key = routerState.location.pathname;
  return (
    <div key={key} className="flex-1 flex flex-col min-h-0 animate-view-enter">
      {children}
    </div>
  );
}

function RootLayout() {
  const ctx = useDashboard();
  const navigate = useNavigate();
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);

  const closeAllDrawers = useCallback(() => {
    ctx.setIsCreateOpen(false);
    ctx.setIsEventsOpen(false);
    ctx.setSelectedIssue(null);
    setShortcutsHelpOpen(false);
  }, [ctx]);

  const shortcuts = useMemo(() => ({
    n: () => ctx.setIsCreateOpen(true),
    Escape: closeAllDrawers,
    "?": () => setShortcutsHelpOpen((v) => !v),
    k: () => navigate({ to: "/kanban" }),
    i: () => navigate({ to: "/issues" }),
    a: () => navigate({ to: "/agents" }),
    t: () => navigate({ to: "/analytics" }),
    s: () => navigate({ to: "/settings" }),
    1: () => {}, // column nav – wired for future use
    2: () => {},
    3: () => {},
    4: () => {},
    5: () => {},
    6: () => {},
  }), [ctx, navigate, closeAllDrawers]);

  useKeyboardShortcuts(shortcuts);

  if (ctx.runtime.isLoading && !ctx.runtime.data) {
    return (
      <div className="min-h-screen flex flex-col">
        <div className="navbar bg-base-100 shadow-sm px-4">
          <div className="flex-1"><div className="skeleton-line h-6 w-32" /></div>
          <div className="flex gap-2">
            <div className="skeleton-line h-8 w-20 rounded-btn" />
            <div className="skeleton-line h-8 w-20 rounded-btn" />
            <div className="skeleton-line h-8 w-20 rounded-btn" />
          </div>
        </div>
        <div className="container mx-auto px-4 py-6 space-y-4">
          <div className="skeleton-card h-24 w-full" />
          <div className="grid grid-cols-6 gap-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton-card h-64 w-full" style={{ animationDelay: `${i * 100}ms` }} />
            ))}
          </div>
        </div>
      </div>
    );
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
        sourceRepo={ctx.data.sourceRepoUrl}
        updatedAt={ctx.data.updatedAt}
        onToggleEvents={ctx.toggleEvents}
        eventsOpen={ctx.isEventsOpen}
        wsStatus={ctx.wsStatus}
        notifications={ctx.notifications}
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
      <MobileDock onToggleEvents={ctx.toggleEvents} eventsOpen={ctx.isEventsOpen} />
      <EventsDrawer
        open={ctx.isEventsOpen}
        onClose={() => ctx.setIsEventsOpen(false)}
        events={ctx.eventsData}
        kind={ctx.eventKind}
        setKind={ctx.setEventKind}
        issueId={ctx.eventIssueId}
        setIssueId={ctx.setEventIssueId}
        issueOptions={ctx.issueOptions}
        wsStatus={ctx.wsStatus}
      />
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
      />
      {shortcutsHelpOpen && (
        <Suspense fallback={null}>
          <KeyboardShortcutsHelp
            open={shortcutsHelpOpen}
            onClose={() => setShortcutsHelpOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

function LoadingHero() {
  return (
    <div className="fixed inset-0 z-50 bg-base-100 flex flex-col items-center justify-center overflow-hidden">
      <OnboardingParticles />
      <div className="relative z-10 flex flex-col items-center gap-6 animate-fade-in">
        <div className="relative">
          <Music className="size-16 sm:size-20 text-primary animate-bounce-in" />
          <span className="absolute -bottom-1 -right-1 size-5 bg-primary rounded-full animate-ping opacity-50" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
          <span className="text-primary">Fifony</span>
        </h1>
        <div className="flex items-center gap-3 text-base-content/50">
          <span className="loading loading-dots loading-md" />
          <span className="text-sm">Warming up the orchestra...</span>
        </div>
      </div>
    </div>
  );
}

function OnboardingGate({ children }) {
  const settingsQuery = useSettings();

  const settingsList = getSettingsList(settingsQuery.data);
  const completed = getSettingValue(settingsList, "ui.onboarding.completed", null);

  // Still loading settings — show hero
  if (settingsQuery.isLoading) {
    return <LoadingHero />;
  }

  // Onboarding not completed — show inline wizard (no navigation needed)
  if (completed !== true) {
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

  if (isOnboarding) {
    return <Outlet />;
  }

  return (
    <OnboardingGate>
      <DashboardProvider>
        <RootLayout />
      </DashboardProvider>
    </OnboardingGate>
  );
}

export const Route = createRootRoute({
  component: RootComponent,
});
