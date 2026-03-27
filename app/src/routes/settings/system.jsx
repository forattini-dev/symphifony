import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, useCallback, useEffect } from "react";
import { useHotkeysContext } from "react-hotkeys-hook";
import { useDashboard } from "../../context/DashboardContext";
import { ConnectionSection, PwaSection, SetupWizardSection, ThemeSection } from "../../components/SettingsView";
import { Keyboard, Command, Globe, PanelRight, Columns3, List, FlaskConical, Trash2, Loader2 } from "lucide-react";
import { api } from "../../api.js";
import { useRuntimeDoctor, useRuntimeProbe, useRuntimeStatus } from "../../hooks.js";

export const Route = createFileRoute("/settings/system")({
  component: SystemSettings,
});

// ── Hotkeys reference (inline) ────────────────────────────────────────────────

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const GROUP_ORDER = ["palette", "navigation", "global", "drawer", "kanban", "issues"];
const GROUP_CONFIG = {
  palette:    { label: "Command Palette", icon: Command,    color: "text-primary",   badge: "badge-primary" },
  navigation: { label: "Navigation",      icon: Globe,      color: "text-info",      badge: "badge-info" },
  global:     { label: "Global",          icon: Keyboard,   color: "text-secondary", badge: "badge-secondary" },
  drawer:     { label: "Issue Detail",    icon: PanelRight, color: "text-success",   badge: "badge-success" },
  kanban:     { label: "Kanban Board",    icon: Columns3,   color: "text-warning",   badge: "badge-warning" },
  issues:     { label: "Issues List",     icon: List,       color: "text-error",     badge: "badge-error" },
};

function formatHotkey(hotkey) {
  return (hotkey || "")
    .replace(/mod/gi, isMac ? "\u2318" : "Ctrl")
    .replace(/ctrl/gi, "Ctrl")
    .replace(/alt/gi, "Alt")
    .replace(/shift/gi, "Shift")
    .replace(/enter/gi, "\u21B5 Enter")
    .replace(/escape/gi, "Esc")
    .replace(/slash/gi, "/")
    .split("+");
}

function HotkeysReference() {
  const { hotkeys } = useHotkeysContext();

  const groups = useMemo(() => {
    const map = new Map();
    const seen = new Set();
    for (const hk of hotkeys) {
      const desc = hk.description;
      const group = hk.metadata?.group;
      if (!desc || !group) continue;
      const dedup = `${group}:${desc}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      if (!map.has(group)) map.set(group, []);
      map.get(group).push(hk);
    }
    const result = [];
    for (const g of GROUP_ORDER) {
      if (map.has(g)) result.push({ group: g, ...GROUP_CONFIG[g], shortcuts: map.get(g) });
    }
    return result;
  }, [hotkeys]);

  const totalCount = groups.reduce((sum, g) => sum + g.shortcuts.length, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Keyboard className="size-4 opacity-50" />
            Keyboard Shortcuts
          </h3>
          <p className="text-xs opacity-50 mt-0.5">
            {totalCount} shortcuts across {groups.length} contexts.
            Press <kbd className="kbd kbd-xs">Shift</kbd>+<kbd className="kbd kbd-xs">/</kbd> anywhere to see them.
            <span className="ml-2 badge badge-ghost badge-xs font-mono">{isMac ? "macOS" : "Linux / Windows"}</span>
          </p>
        </div>
      </div>

      {groups.map(({ group, label, icon: Icon, color, badge, shortcuts }) => (
        <div key={group} className="bg-base-300 rounded-box overflow-hidden">
          <div className="px-4 py-2.5 flex items-center gap-2 border-b border-base-content/10">
            <Icon className={`size-3.5 ${color}`} />
            <span className="text-xs font-semibold">{label}</span>
            <span className={`badge badge-xs ${badge}`}>{shortcuts.length}</span>
          </div>
          <div className="divide-y divide-base-content/5">
            {shortcuts.map((s, i) => {
              const keys = formatHotkey(s.hotkey);
              return (
                <div key={i} className="flex items-center justify-between px-4 py-2 hover:bg-base-100/30 transition-colors">
                  <span className="text-xs">{s.description}</span>
                  <div className="flex items-center gap-1">
                    {keys.map((k, j) => (
                      <span key={j} className="flex items-center">
                        {j > 0 && <span className="text-xs opacity-20 mx-0.5">+</span>}
                        <kbd className="kbd kbd-xs font-mono">{k.trim()}</kbd>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <p className="text-xs opacity-40">
        Shortcuts are context-aware. <strong>Drawer</strong> shortcuts only work when an issue detail is open.
        <strong> Kanban</strong> and <strong>Issues</strong> shortcuts work on their respective pages.
      </p>
    </div>
  );
}

// ── Dev profile ───────────────────────────────────────────────────────────────

function useDevProfile() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await api.get("/dev-profile");
      setProfile(response?.profile ?? null);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  const runAction = useCallback(async (path) => {
    setBusyAction(path);
    try {
      const response = await api.post(path, {});
      setProfile(response?.profile ?? null);
      setError("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusyAction("");
    }
  }, []);

  return {
    profile, loading, error, busyAction, refresh,
    bootstrap: () => runAction("/dev-profile/bootstrap"),
    reset: () => runAction("/dev-profile/reset"),
  };
}

function DevProfileCard() {
  const { profile, loading, error, busyAction, bootstrap, reset } = useDevProfile();

  return (
    <div className="card bg-base-200 border border-base-300">
      <div className="card-body p-4 gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider opacity-60">Dev profile</div>
            <p className="mt-1 text-xs opacity-50">Isolated worktree + separate Fifony state for local harness experimentation.</p>
          </div>
          {loading ? <Loader2 className="size-4 animate-spin opacity-40" /> : null}
        </div>

        {profile ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider opacity-45">Bootstrapped</div>
                <div className="mt-1 text-sm font-medium">{profile.bootstrapped ? "yes" : "no"}</div>
                <div className="text-xs opacity-50">{profile.worktreeAttached ? "worktree attached" : "worktree missing"}</div>
              </div>
              <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider opacity-45">Workspace</div>
                <div className="mt-1 text-sm font-medium">{profile.workspaceExists ? "present" : "missing"}</div>
                <div className="text-xs opacity-50 break-all">{profile.workspaceRoot}</div>
              </div>
              <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider opacity-45">State</div>
                <div className="mt-1 text-sm font-medium">{profile.persistenceExists ? "present" : "empty"}</div>
                <div className="text-xs opacity-50 break-all">{profile.persistenceRoot}</div>
              </div>
              <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider opacity-45">Runbooks</div>
                <div className="mt-1 text-sm font-medium">{profile.bootstrapFiles?.runbooks?.length || 0}</div>
                <div className="text-xs opacity-50">{profile.trashEntries?.length || 0} reset snapshot(s)</div>
              </div>
            </div>
            <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
              <div className="text-[10px] uppercase tracking-wider opacity-45">Launch command</div>
              <div className="mt-1 font-mono text-xs break-all opacity-75">{profile.launchCommand}</div>
            </div>
          </>
        ) : (
          <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5 text-xs opacity-50">
            Dev profile data is not available yet.
          </div>
        )}

        {error ? (
          <div className="rounded-xl border border-error/20 bg-error/5 px-3 py-2.5 text-xs text-error">{error}</div>
        ) : null}

        <div className="flex items-center gap-2 flex-wrap">
          <button className="btn btn-xs btn-primary gap-1" onClick={bootstrap} disabled={busyAction !== ""}>
            {busyAction === "/dev-profile/bootstrap" ? <Loader2 className="size-3 animate-spin" /> : <FlaskConical className="size-3" />}
            Bootstrap
          </button>
          <button className="btn btn-xs btn-ghost text-error gap-1" onClick={reset} disabled={busyAction !== ""}>
            {busyAction === "/dev-profile/reset" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
            Reset to trash
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Runtime health ────────────────────────────────────────────────────────────

function RuntimeHealthCard() {
  const statusQuery = useRuntimeStatus();
  const probeQuery = useRuntimeProbe();
  const doctorQuery = useRuntimeDoctor();

  const snapshot = statusQuery.data?.snapshot ?? null;
  const probe = probeQuery.data ?? null;
  const checks = Array.isArray(doctorQuery.data?.checks) ? doctorQuery.data.checks : [];
  const failingChecks = checks.filter((check) => check.status === "fail").length;
  const warningChecks = checks.filter((check) => check.status === "warn").length;

  if (statusQuery.isLoading && doctorQuery.isLoading) {
    return (
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        {[0, 1].map((index) => (
          <div key={index} className="card bg-base-200 border border-base-300 animate-pulse">
            <div className="card-body p-4 gap-3">
              <div className="h-4 w-40 rounded bg-base-300" />
              <div className="h-3 w-full rounded bg-base-300" />
              <div className="h-3 w-3/4 rounded bg-base-300" />
              <div className="h-20 rounded bg-base-300" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="card bg-base-200 border border-base-300">
        <div className="card-body p-4 gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider opacity-60">Runtime health</div>
              <p className="mt-1 text-xs opacity-50">Operational snapshot for provider, agents, services, and memory flushes.</p>
            </div>
            <div className={`badge badge-sm ${snapshot?.ok ? "badge-success" : "badge-warning"}`}>
              {snapshot?.ok ? "healthy" : "attention"}
            </div>
          </div>

          {snapshot ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider opacity-45">Provider</div>
                <div className="mt-1 text-sm font-medium">{snapshot.providers.configuredProvider}</div>
                <div className="text-xs opacity-50">{snapshot.providers.available.filter((p) => p.available).length} detected</div>
              </div>
              <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider opacity-45">Issues</div>
                <div className="mt-1 text-sm font-medium">{snapshot.issues.running} running · {snapshot.issues.reviewing} reviewing</div>
                <div className="text-xs opacity-50">{snapshot.issues.total} total issues</div>
              </div>
              <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider opacity-45">Services</div>
                <div className="mt-1 text-sm font-medium">{snapshot.services.running}/{snapshot.services.total} running</div>
                <div className="text-xs opacity-50">{snapshot.services.crashed} crashed · {snapshot.services.starting} starting</div>
              </div>
              <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider opacity-45">Agents</div>
                <div className="mt-1 text-sm font-medium">{snapshot.agents.active} active</div>
                <div className="text-xs opacity-50">{snapshot.agents.crashed} crashed · {snapshot.agents.idle} idle</div>
              </div>
              <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider opacity-45">Memory</div>
                <div className="mt-1 text-sm font-medium">{snapshot.memory.totalFlushes} flushes</div>
                <div className="text-xs opacity-50">{snapshot.memory.issuesWithFlushes} issue workspaces seeded</div>
              </div>
              <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5">
                <div className="text-[10px] uppercase tracking-wider opacity-45">Probe</div>
                <div className="mt-1 text-sm font-medium">{probe?.ok ? "passing" : "degraded"}</div>
                <div className="text-xs opacity-50">{failingChecks} fail · {warningChecks} warn</div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-warning/20 bg-warning/5 px-3 py-2.5 text-xs text-warning">
              Runtime health data is not available right now.
            </div>
          )}
        </div>
      </div>

      <div className="card bg-base-200 border border-base-300">
        <div className="card-body p-4 gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wider opacity-60">Doctor</div>
              <p className="mt-1 text-xs opacity-50">Detailed checks for workspace git, providers, services, agents, and memory.</p>
            </div>
            {doctorQuery.isFetching ? <Loader2 className="size-3.5 animate-spin opacity-40" /> : null}
          </div>

          {checks.length > 0 ? (
            <div className="space-y-2">
              {checks.map((check) => {
                const tone = check.status === "fail"
                  ? "border-error/20 bg-error/5 text-error"
                  : check.status === "warn"
                    ? "border-warning/20 bg-warning/5 text-warning"
                    : "border-success/20 bg-success/5 text-success";
                return (
                  <div key={check.id} className={`rounded-xl border px-3 py-2.5 ${tone}`}>
                    <div className="flex items-start gap-2">
                      <div className="mt-1 size-2.5 shrink-0 rounded-full bg-current" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold uppercase tracking-wider">{check.title}</div>
                        <p className="mt-1 text-xs leading-relaxed text-base-content/70">{check.summary}</p>
                        {check.suggestedAction ? (
                          <p className="mt-1 text-[11px] text-base-content/55">Action: {check.suggestedAction}</p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-base-300 bg-base-100/70 px-3 py-2.5 text-xs opacity-50">
              No doctor checks available yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

function SystemSettings() {
  const ctx = useDashboard();

  return (
    <div className="space-y-5">
      <ConnectionSection status={ctx.status} wsStatus={ctx.wsStatus} />
      <PwaSection pwa={ctx.pwa} />
      <SetupWizardSection />

      <div className="card bg-base-200">
        <div className="card-body p-4 gap-4">
          <HotkeysReference />
        </div>
      </div>

      <DevProfileCard />
      <RuntimeHealthCard />
      <ThemeSection theme={ctx.theme} onThemeChange={ctx.setTheme} />
    </div>
  );
}
