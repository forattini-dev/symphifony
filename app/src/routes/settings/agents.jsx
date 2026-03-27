import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, Zap, Search, Loader2, Check, CheckCircle, RefreshCw,
  ChevronLeft, ChevronRight, X, Download,
} from "lucide-react";
import { api } from "../../api";

export const Route = createFileRoute("/settings/agents")({
  component: AssetsSettings,
});

const PER_PAGE = 25;

// ── Sources (reference repositories) ─────────────────────────────────────────

function SourcesSection({ onCatalogRefresh }) {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [syncingRepos, setSyncingRepos] = useState(() => new Set());
  const [repoMessages, setRepoMessages] = useState({});
  const didFetch = useRef(false);

  const loadRepos = useCallback(() => {
    setError("");
    setLoading(true);
    return api.get("/reference-repositories")
      .then((data) => setRepos(data?.repositories || []))
      .catch((err) => {
        const msg = err?.message || "Failed to load.";
        setError(msg.toLowerCase().includes("route not found")
          ? "Backend route not loaded. Start with --dev or run pnpm build:server."
          : msg);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (didFetch.current) return;
    didFetch.current = true;
    loadRepos();
  }, [loadRepos]);

  const syncAndImport = useCallback(async (repoId) => {
    setSyncingRepos((prev) => new Set([...prev, repoId]));
    setRepoMessages((prev) => ({ ...prev, [repoId]: "" }));
    try {
      const syncResult = await api.post("/reference-repositories/sync", { repository: repoId });
      const item = (syncResult?.results || []).find((r) => r.id === repoId);
      if (item?.action === "failed") {
        setRepoMessages((prev) => ({ ...prev, [repoId]: item.message || "Sync failed." }));
        return;
      }
      await api.post("/reference-repositories/import", { repository: repoId, kind: "all", global: false });
      await loadRepos();
      setRepoMessages((prev) => ({ ...prev, [repoId]: "Synced." }));
      onCatalogRefresh?.();
    } catch (err) {
      setRepoMessages((prev) => ({ ...prev, [repoId]: err?.message || "Failed." }));
    } finally {
      setSyncingRepos((prev) => { const n = new Set(prev); n.delete(repoId); return n; });
    }
  }, [loadRepos, onCatalogRefresh]);

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-3 p-4">
        <h3 className="font-semibold text-sm">Asset Sources</h3>
        {error && <div className="alert alert-warning text-xs py-1">{error}</div>}
        {loading ? (
          <div className="flex items-center gap-2 text-xs opacity-60">
            <Loader2 className="size-3 animate-spin" /> Loading...
          </div>
        ) : (
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
            {repos.map((repo) => {
              const syncing = syncingRepos.has(repo.id);
              const counts = repo?.artifactCounts ?? null;
              const isSynced = repo?.present && repo?.synced;
              return (
                <div key={repo.id} className="rounded-lg border border-base-300/70 bg-base-100 p-2 flex flex-col gap-1">
                  <div className="font-medium text-xs truncate">{repo.name}</div>
                  {isSynced && counts ? (
                    <div className="text-[11px] opacity-60">
                      {counts.agents} agents · {counts.skills} skills
                    </div>
                  ) : (
                    <span className="badge badge-xs badge-warning">Not synced</span>
                  )}
                  {repoMessages[repo.id] && (
                    <p className="text-[11px] opacity-60 truncate">{repoMessages[repo.id]}</p>
                  )}
                  <button
                    className="btn btn-xs btn-outline gap-1 mt-auto"
                    onClick={() => syncAndImport(repo.id)}
                    disabled={syncing}
                  >
                    {syncing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                    {syncing ? "Syncing…" : isSynced ? "Re-sync" : "Sync"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Catalog browser ──────────────────────────────────────────────────────────

function CatalogBrowser() {
  const [agents, setAgents] = useState([]);
  const [skills, setSkills] = useState([]);
  const [loading, setLoading] = useState(true);

  const [activeTab, setActiveTab] = useState("agents");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [detailName, setDetailName] = useState(null);

  const [selectedAgents, setSelectedAgents] = useState([]);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState("");
  const [installError, setInstallError] = useState("");

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const [agentRes, skillRes] = await Promise.allSettled([
        api.get("/catalog/agents"),
        api.get("/catalog/skills"),
      ]);
      setAgents(agentRes.status === "fulfilled" ? agentRes.value?.agents || [] : []);
      setSkills(skillRes.status === "fulfilled" ? skillRes.value?.skills || [] : []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  const items = activeTab === "agents" ? agents : skills;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const hay = [item.name, item.displayName, item.description].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);
  const rangeStart = filtered.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1;
  const rangeEnd = Math.min(safePage * PER_PAGE, filtered.length);

  // Reset page on tab/search change
  useEffect(() => { setPage(1); }, [activeTab, query]);
  // Clear detail when switching tabs
  useEffect(() => { setDetailName(null); }, [activeTab]);

  const selected = activeTab === "agents" ? selectedAgents : selectedSkills;
  const setSelected = activeTab === "agents" ? setSelectedAgents : setSelectedSkills;
  const totalSelected = selectedAgents.length + selectedSkills.length;

  const detailItem = useMemo(() => {
    if (!detailName) return null;
    return items.find((i) => i.name === detailName) || null;
  }, [detailName, items]);

  const toggleItem = useCallback((name) => {
    setSelected((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  }, [setSelected]);

  const selectAll = useCallback(() => {
    setSelected(filtered.map((i) => i.name));
  }, [filtered, setSelected]);

  const selectNone = useCallback(() => {
    setSelected([]);
  }, [setSelected]);

  const installSelected = useCallback(async () => {
    if (selectedAgents.length === 0 && selectedSkills.length === 0) return;
    setInstalling(true);
    setInstallMsg("");
    setInstallError("");

    const tasks = [];
    if (selectedAgents.length > 0) tasks.push({ label: "Assets", run: () => api.post("/install/agents", { agents: selectedAgents }) });
    if (selectedSkills.length > 0) tasks.push({ label: "Skills", run: () => api.post("/install/skills", { skills: selectedSkills }) });

    try {
      const results = await Promise.allSettled(tasks.map((t) => t.run()));
      const parts = [];
      const failures = [];
      for (let i = 0; i < tasks.length; i++) {
        const r = results[i];
        if (r.status === "rejected") { failures.push(`${tasks[i].label}: ${r.reason?.message || "Failed"}`); continue; }
        const p = r.value || {};
        if (p.ok === false) { failures.push(`${tasks[i].label}: ${p.error || "Failed"}`); continue; }
        const seg = [`${tasks[i].label}: ${p.installed?.length || 0} installed`];
        if (p.skipped?.length) seg.push(`${p.skipped.length} skipped`);
        if (p.errors?.length) seg.push(`${p.errors.length} errors`);
        parts.push(seg.join(", "));
      }
      if (failures.length > 0) { setInstallError(failures.join(" | ")); }
      else { setInstallMsg(parts.join(" | ")); setSelectedAgents([]); setSelectedSkills([]); }
      await loadCatalog();
    } catch (err) {
      setInstallError(err?.message || "Install failed.");
    } finally {
      setInstalling(false);
    }
  }, [selectedAgents, selectedSkills, loadCatalog]);

  const installSingle = useCallback(async (item) => {
    const isAgent = activeTab === "agents";
    setInstalling(true);
    setInstallMsg("");
    setInstallError("");
    try {
      const res = isAgent
        ? await api.post("/install/agents", { agents: [item.name] })
        : await api.post("/install/skills", { skills: [item.name] });
      if (res.ok === false) { setInstallError(res.error || "Failed"); }
      else { setInstallMsg(`${item.displayName || item.name} installed.`); }
      await loadCatalog();
    } catch (err) {
      setInstallError(err?.message || "Failed.");
    } finally {
      setInstalling(false);
    }
  }, [activeTab, loadCatalog]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin opacity-30" />
      </div>
    );
  }

  return (
    <div className="card bg-base-200">
      <div className="card-body gap-0 p-0">
        {/* Header */}
        <div className="flex flex-col gap-3 p-4 pb-3">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Tabs */}
            <div className="flex bg-base-300 rounded-lg p-0.5 text-xs font-medium">
              <button
                className={`px-3 py-1 rounded-md transition-colors ${activeTab === "agents" ? "bg-base-100 shadow-sm" : "opacity-60 hover:opacity-100"}`}
                onClick={() => setActiveTab("agents")}
              >
                <Bot className="size-3 inline mr-1 -mt-0.5" />
                Assets ({agents.length})
              </button>
              <button
                className={`px-3 py-1 rounded-md transition-colors ${activeTab === "skills" ? "bg-base-100 shadow-sm" : "opacity-60 hover:opacity-100"}`}
                onClick={() => setActiveTab("skills")}
              >
                <Zap className="size-3 inline mr-1 -mt-0.5" />
                Skills ({skills.length})
              </button>
            </div>

            {/* Search */}
            <label className="input input-bordered input-sm flex items-center gap-2 flex-1 min-w-[180px]">
              <Search className="size-3.5 opacity-60" />
              <input
                type="text"
                className="grow"
                placeholder={`Search ${activeTab}...`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button className="btn btn-ghost btn-xs btn-circle" onClick={() => setQuery("")}>
                  <X className="size-3" />
                </button>
              )}
            </label>

            {/* Bulk actions */}
            <div className="flex gap-1 text-xs">
              <button className="btn btn-xs btn-ghost" onClick={selectAll} disabled={filtered.length === 0}>All</button>
              <button className="btn btn-xs btn-ghost" onClick={selectNone} disabled={selected.length === 0}>None</button>
            </div>
          </div>

          {/* Page indicator */}
          {filtered.length > 0 && (
            <div className="flex items-center justify-between text-[11px] opacity-50">
              <span>{rangeStart}–{rangeEnd} of {filtered.length}</span>
              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    className="btn btn-ghost btn-xs btn-square"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="size-3" />
                  </button>
                  <span>{safePage}/{totalPages}</span>
                  <button
                    className="btn btn-ghost btn-xs btn-square"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    <ChevronRight className="size-3" />
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Master-detail */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1.2fr] min-h-[320px] border-t border-base-300/50">
          {/* Left: compact list */}
          <div className="border-r border-base-300/50 overflow-y-auto max-h-[480px]">
            {pageItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-xs opacity-50">
                {items.length === 0
                  ? <><p>No {activeTab} in catalog.</p><p className="mt-1">Sync a source above.</p></>
                  : <p>No matches for "{query}"</p>
                }
              </div>
            ) : (
              pageItems.map((item) => {
                const isSelected = selected.includes(item.name);
                const isDetail = detailName === item.name;
                return (
                  <button
                    key={item.name}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors border-b border-base-300/30 last:border-b-0
                      ${isDetail ? "bg-primary/10" : "hover:bg-base-100/60"}
                    `}
                    onClick={() => setDetailName(item.name)}
                  >
                    <input
                      type="checkbox"
                      className="checkbox checkbox-xs checkbox-primary shrink-0"
                      checked={isSelected}
                      onChange={(e) => { e.stopPropagation(); toggleItem(item.name); }}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="shrink-0">{item.emoji || (activeTab === "agents" ? "\u{1F916}" : "\u26A1")}</span>
                    <span className="truncate font-medium flex-1">{item.displayName || item.name}</span>
                    {item.source && <span className="badge badge-ghost badge-xs shrink-0 opacity-60">{item.source}</span>}
                  </button>
                );
              })
            )}
          </div>

          {/* Right: detail panel */}
          <div className="p-4 overflow-y-auto max-h-[480px]">
            {detailItem ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <span className="text-2xl">{detailItem.emoji || (activeTab === "agents" ? "\u{1F916}" : "\u26A1")}</span>
                  <div className="flex-1 min-w-0">
                    <h4 className="font-semibold text-sm">{detailItem.displayName || detailItem.name}</h4>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[11px] opacity-50 font-mono">{detailItem.name}</span>
                      {detailItem.source && <span className="badge badge-ghost badge-xs">{detailItem.source}</span>}
                    </div>
                  </div>
                </div>

                {detailItem.description && (
                  <p className="text-xs opacity-70 leading-relaxed">{detailItem.description}</p>
                )}

                {detailItem.domains?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {detailItem.domains.map((d) => (
                      <span key={d} className="badge badge-xs badge-outline">{d}</span>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  {selected.includes(detailItem.name) ? (
                    <button
                      className="btn btn-xs btn-outline gap-1"
                      onClick={() => toggleItem(detailItem.name)}
                    >
                      <Check className="size-3" /> Selected
                    </button>
                  ) : (
                    <button
                      className="btn btn-xs btn-primary gap-1"
                      onClick={() => toggleItem(detailItem.name)}
                    >
                      Add to selection
                    </button>
                  )}
                  <button
                    className="btn btn-xs btn-ghost gap-1"
                    onClick={() => installSingle(detailItem)}
                    disabled={installing}
                  >
                    <Download className="size-3" />
                    Install now
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-xs opacity-40">
                <p>Select an item to view details</p>
              </div>
            )}
          </div>
        </div>

        {/* Bottom pagination (repeated for convenience) */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 p-2 border-t border-base-300/50 text-xs">
            <button
              className="btn btn-ghost btn-xs gap-1"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="size-3" /> Prev
            </button>
            <span className="opacity-50">{safePage} of {totalPages}</span>
            <button
              className="btn btn-ghost btn-xs gap-1"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next <ChevronRight className="size-3" />
            </button>
          </div>
        )}

        {/* Status messages */}
        {(installMsg || installError) && (
          <div className="px-4 pb-3">
            {installMsg && <p className="text-xs text-success">{installMsg}</p>}
            {installError && <p className="text-xs text-error">{installError}</p>}
          </div>
        )}
      </div>

      {/* Sticky install bar */}
      {totalSelected > 0 && (
        <div className="sticky bottom-0 bg-base-300 border-t border-base-content/10 px-4 py-2 flex items-center justify-between rounded-b-2xl">
          <span className="text-xs opacity-70">
            {selectedAgents.length > 0 && `${selectedAgents.length} agent${selectedAgents.length > 1 ? "s" : ""}`}
            {selectedAgents.length > 0 && selectedSkills.length > 0 && ", "}
            {selectedSkills.length > 0 && `${selectedSkills.length} skill${selectedSkills.length > 1 ? "s" : ""}`}
            {" "}selected
          </span>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-xs btn-ghost"
              onClick={() => { setSelectedAgents([]); setSelectedSkills([]); }}
            >
              Clear
            </button>
            <button
              className="btn btn-xs btn-primary gap-1"
              onClick={installSelected}
              disabled={installing}
            >
              {installing ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle className="size-3" />}
              {installing ? "Installing…" : "Install selected"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

function AssetsSettings() {
  const [catalogVersion, setCatalogVersion] = useState(0);

  return (
    <div className="space-y-4">
      <SourcesSection onCatalogRefresh={() => setCatalogVersion((v) => v + 1)} />
      <CatalogBrowser key={catalogVersion} />
    </div>
  );
}
