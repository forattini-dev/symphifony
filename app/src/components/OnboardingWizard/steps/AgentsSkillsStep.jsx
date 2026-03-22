import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Bot, Loader2, Check, RefreshCw, Search } from "lucide-react";
import { api } from "../../../api";

function AgentsSkillsStep({
  selectedAgents, setSelectedAgents,
  existingAgents,
  autoSelectAgents = true,
}) {
  const [catalogAgents, setCatalogAgents] = useState([]);
  const [loading, setLoading] = useState(false);
  const didFetch = useRef(false);

  const [referenceRepositories, setReferenceRepositories] = useState([]);
  const [referencesLoading, setReferencesLoading] = useState(false);
  const [referenceError, setReferenceError] = useState("");
  const [syncingRepos, setSyncingRepos] = useState(() => new Set());
  const [repoMessages, setRepoMessages] = useState({});
  const didFetchReferenceRepos = useRef(false);

  const [agentSearchQuery, setAgentSearchQuery] = useState("");

  const loadCatalog = useCallback(() => {
    return api.get("/catalog/agents").catch(() => ({ agents: [] }))
      .then((data) => {
        const agents = data?.agents || [];
        setCatalogAgents(agents);
        return agents;
      });
  }, []);

  useEffect(() => {
    if (didFetch.current) return;
    didFetch.current = true;
    setLoading(true);
    loadCatalog().then((agents) => {
      const existingNames = new Set((existingAgents || []).map((a) => a.name));
      const autoAgents = agents.filter((a) => !existingNames.has(a.name)).map((a) => a.name);
      if (autoSelectAgents && autoAgents.length > 0 && selectedAgents.length === 0) {
        setSelectedAgents(autoAgents);
      }
    }).finally(() => setLoading(false));
  }, []);

  const loadReferenceRepositories = useCallback(() => {
    setReferenceError("");
    setReferencesLoading(true);
    return api.get("/reference-repositories")
      .then((data) => {
        setReferenceRepositories(data?.repositories || []);
      })
      .catch((error) => {
        const message = error?.message || "Failed to load reference repositories.";
        if (message.toLowerCase().includes("route not found")) {
          setReferenceError("Backend route not loaded. Start Fifony with --dev (or run pnpm build:server) and retry.");
        } else {
          setReferenceError(message);
        }
      })
      .finally(() => setReferencesLoading(false));
  }, []);

  useEffect(() => {
    if (didFetchReferenceRepos.current) return;
    didFetchReferenceRepos.current = true;
    loadReferenceRepositories();
  }, [loadReferenceRepositories]);

  const existingAgentNames = useMemo(() => new Set((existingAgents || []).map((a) => a.name)), [existingAgents]);

  const filteredAgents = useMemo(() => {
    const query = agentSearchQuery.trim().toLowerCase();
    if (!query) return catalogAgents;
    return catalogAgents.filter((item) => {
      const haystack = [item?.name, item?.displayName, item?.description].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }, [agentSearchQuery, catalogAgents]);

  const toggleAgent = useCallback((name) => {
    setSelectedAgents((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  }, [setSelectedAgents]);

  const selectAllAgents = useCallback(() => {
    setSelectedAgents(catalogAgents.filter((a) => !existingAgentNames.has(a.name)).map((a) => a.name));
  }, [catalogAgents, existingAgentNames, setSelectedAgents]);

  const selectNoneAgents = useCallback(() => setSelectedAgents([]), [setSelectedAgents]);

  const syncAndImport = useCallback(async (repositoryId) => {
    setSyncingRepos((prev) => new Set([...prev, repositoryId]));
    setRepoMessages((prev) => ({ ...prev, [repositoryId]: "" }));
    try {
      const syncResult = await api.post("/reference-repositories/sync", { repository: repositoryId });
      const resultItem = (syncResult?.results || []).find((item) => item.id === repositoryId);
      if (resultItem?.action === "failed") {
        setRepoMessages((prev) => ({ ...prev, [repositoryId]: resultItem.message || "Sync failed." }));
        return;
      }

      await api.post("/reference-repositories/import", {
        repository: repositoryId,
        kind: "agents",
        global: false,
      });

      await Promise.all([loadReferenceRepositories(), loadCatalog()]);
      setRepoMessages((prev) => ({ ...prev, [repositoryId]: "Synced & imported." }));
    } catch (error) {
      setRepoMessages((prev) => ({ ...prev, [repositoryId]: error?.message || "Failed." }));
    } finally {
      setSyncingRepos((prev) => {
        const next = new Set(prev);
        next.delete(repositoryId);
        return next;
      });
    }
  }, [loadReferenceRepositories, loadCatalog]);

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-12">
        <Loader2 className="size-8 text-primary animate-spin" />
        <p className="text-sm text-base-content/50">Loading catalog...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 stagger-children">
      <div className="text-center">
        <Bot className="size-10 text-primary mx-auto mb-3" />
        <h2 className="text-2xl font-bold">Agents</h2>
        <p className="text-base-content/60 mt-1">Choose which agents to install</p>
      </div>

      {/* Sources */}
      <div className="card bg-base-200">
        <div className="card-body gap-3 p-4">
          <h3 className="font-semibold text-sm">Sources</h3>
          {referenceError && <div className="alert alert-warning text-xs">{referenceError}</div>}
          {referencesLoading ? (
            <div className="flex items-center gap-2 text-xs text-base-content/60">
              <Loader2 className="size-3 animate-spin" /> Loading...
            </div>
          ) : (
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
              {referenceRepositories.map((repo) => {
                const syncing = syncingRepos.has(repo.id);
                const counts = repo?.artifactCounts ?? null;
                const isSynced = repo?.present && repo?.synced;
                return (
                  <div key={repo.id} className="rounded-lg border border-base-300/70 bg-base-100 p-2 flex flex-col gap-1.5">
                    <div className="font-medium text-xs truncate">{repo.name}</div>
                    {isSynced && counts ? (
                      <div className="text-[11px] text-base-content/60">
                        {counts.agents} agents
                      </div>
                    ) : (
                      <span className="badge badge-xs badge-warning">Not synced</span>
                    )}
                    {repoMessages[repo.id] && (
                      <p className="text-[11px] text-base-content/60 truncate">{repoMessages[repo.id]}</p>
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

      {/* Agents */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Bot className="size-4 opacity-50" />
            Agents ({catalogAgents.length})
          </h3>
          <div className="flex gap-1">
            <button className="btn btn-xs btn-ghost" onClick={selectAllAgents}>Select All</button>
            <button className="btn btn-xs btn-ghost" onClick={selectNoneAgents}>None</button>
          </div>
        </div>

        <label className="input input-bordered input-sm flex items-center gap-2">
          <Search className="size-4 opacity-60" />
          <input
            type="text"
            className="grow"
            placeholder="Search agents..."
            value={agentSearchQuery}
            onChange={(e) => setAgentSearchQuery(e.target.value)}
          />
        </label>

        {filteredAgents.length === 0 && catalogAgents.length > 0 && (
          <div className="text-sm text-base-content/60">No agents match your search.</div>
        )}

        <div className="space-y-1 pt-1">
          {filteredAgents.map((agent) => {
            const installed = existingAgentNames.has(agent.name);
            const isSelected = installed || selectedAgents.includes(agent.name);
            return (
              <button
                key={agent.name}
                className={`w-full rounded-md border border-transparent px-2 py-2 text-left transition-all ${
                  installed ? "opacity-70 bg-base-100/40" : "hover:bg-base-100"
                } ${isSelected && !installed ? "ring-1 ring-primary ring-offset-1 ring-offset-base-200" : ""}`}
                onClick={() => !installed && toggleAgent(agent.name)}
                disabled={installed}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 text-base">{agent.emoji || "\u{1F916}"}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">
                        {agent.displayName || agent.name}
                      </span>
                      {agent.source && (
                        <span className="badge badge-xs badge-ghost shrink-0">{agent.source}</span>
                      )}
                      {installed ? (
                        <span className="badge badge-xs badge-success gap-1 shrink-0">
                          <Check className="size-3" /> Installed
                        </span>
                      ) : (
                        <input
                          type="checkbox"
                          className="checkbox checkbox-primary checkbox-sm self-start mt-0.5 shrink-0"
                          checked={isSelected}
                          readOnly
                          tabIndex={-1}
                        />
                      )}
                    </div>
                    {agent.description && (
                      <p className="text-xs text-base-content/60 mt-1 truncate">{agent.description}</p>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {catalogAgents.length === 0 && (
        <div className="alert alert-info text-sm">
          No agents found in the catalog. Sync a source above or add them later from the settings page.
        </div>
      )}
    </div>
  );
}

export default AgentsSkillsStep;
