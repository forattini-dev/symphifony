import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, CheckCircle, Loader2, Search, Zap, Sparkles, Package } from "lucide-react";
import { api } from "../../api";
import AgentsSkillsStep from "../../components/OnboardingWizard/steps/AgentsSkillsStep";

export const Route = createFileRoute("/settings/agents")({
  component: AgentsSettings,
});

function AgentsSettings() {
  const [selectedAgents, setSelectedAgents] = useState([]);
  const [selectedSkills, setSelectedSkills] = useState([]);

  const [catalogSkills, setCatalogSkills] = useState([]);
  const [skillsQuery, setSkillsQuery] = useState("");
  const [loadingSkills, setLoadingSkills] = useState(false);

  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadSkillsCatalog = useCallback(() => {
    setLoadingSkills(true);
    return api.get("/catalog/skills")
      .then((data) => {
        const skills = data?.skills || [];
        setCatalogSkills(skills);
      })
      .catch(() => setCatalogSkills([]))
      .finally(() => setLoadingSkills(false));
  }, []);

  useEffect(() => {
    loadSkillsCatalog();
  }, [loadSkillsCatalog]);

  const filteredSkills = useMemo(() => {
    const query = skillsQuery.trim().toLowerCase();
    if (!query) return catalogSkills;
    return catalogSkills.filter((item) => {
      const haystack = [item?.name, item?.displayName, item?.description]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [catalogSkills, skillsQuery]);

  const toggleSkill = useCallback((skillName) => {
    setSelectedSkills((prev) =>
      prev.includes(skillName) ? prev.filter((name) => name !== skillName) : [...prev, skillName]
    );
  }, []);

  const selectAllSkills = useCallback(() => {
    setSelectedSkills(filteredSkills.map((skill) => skill.name));
  }, [filteredSkills]);

  const selectNoSkills = useCallback(() => setSelectedSkills([]), []);

  const installCatalogArtifacts = useCallback(async () => {
    if (selectedAgents.length === 0 && selectedSkills.length === 0) {
      setMessage("Select at least one agent or one skill.");
      return;
    }

    setSaving(true);
    setMessage("");
    setError("");

    const tasks = [];
    if (selectedAgents.length > 0) {
      tasks.push({
        label: "Agents",
        run: () => api.post("/install/agents", { agents: selectedAgents }),
      });
    }
    if (selectedSkills.length > 0) {
      tasks.push({
        label: "Skills",
        run: () => api.post("/install/skills", { skills: selectedSkills }),
      });
    }

    try {
      const results = await Promise.allSettled(tasks.map((task) => task.run()));
      const summaryParts = [];
      const failures = [];

      for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index];
        const result = results[index];

        if (result.status === "rejected") {
          failures.push(`${task.label}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
          continue;
        }

        const payload = result.value || {};
        if (payload.ok === false) {
          failures.push(`${task.label}: ${payload.error || "Request failed."}`);
          continue;
        }

        const installed = payload.installed?.length || 0;
        const skipped = payload.skipped?.length || 0;
        const errors = payload.errors?.length || 0;
        const segments = [`${task.label}: ${installed} installed`];
        if (skipped) segments.push(`${skipped} skipped`);
        if (errors) segments.push(`${errors} errors`);
        summaryParts.push(segments.join(", "));
      }

      if (failures.length > 0) {
        setError(failures.join(" | "));
        return;
      }

      const finalMessage = summaryParts.length > 0
        ? `Catalog install: ${summaryParts.join(" | ")}`
        : "No catalog items were updated.";
      setMessage(finalMessage);
      setSelectedAgents([]);
      setSelectedSkills([]);
      setSkillsQuery("");
      await loadSkillsCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [selectedAgents, selectedSkills, loadSkillsCatalog]);

  return (
    <div className="space-y-4">
      <div className="card bg-base-200">
        <div className="card-body gap-4 p-6">
          <div className="flex items-center gap-2">
            <Bot className="size-4 opacity-50" />
            <h2 className="card-title text-sm">Agents & skills</h2>
          </div>
          <p className="text-xs opacity-50">Install agents and skills from catalog references.</p>

          <AgentsSkillsStep
            selectedAgents={selectedAgents}
            setSelectedAgents={setSelectedAgents}
            existingAgents={[]}
            autoSelectAgents={false}
          />

          <div className="divider opacity-30" />

          <div className="flex items-center gap-2">
            <Zap className="size-4 opacity-50" />
            <h3 className="font-semibold text-sm">Skills catalog</h3>
          </div>

          {loadingSkills ? (
            <div className="flex items-center gap-2 text-xs opacity-70">
              <Loader2 className="size-3 animate-spin" />
              Loading skills catalog...
            </div>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                <label className="input input-bordered input-sm flex items-center gap-2">
                  <Search className="size-3.5 opacity-60" />
                  <input
                    type="text"
                    className="grow"
                    placeholder="Search skills..."
                    value={skillsQuery}
                    onChange={(e) => setSkillsQuery(e.target.value)}
                  />
                </label>
                <div className="text-xs opacity-50">Loaded: {catalogSkills.length}</div>
              </div>

              <div className="flex items-center gap-2">
                <button className="btn btn-xs btn-ghost" onClick={selectAllSkills} disabled={filteredSkills.length === 0}>
                  Select All
                </button>
                <button className="btn btn-xs btn-ghost" onClick={selectNoSkills}>
                  None
                </button>
              </div>

              <div className="space-y-2">
                {filteredSkills.length === 0 && (
                  <div className="text-xs opacity-60">
                    {catalogSkills.length === 0
                      ? "No skills found in catalog."
                      : "No skills match your search."
                    }
                  </div>
                )}

                {filteredSkills.map((skill) => {
                  const isSelected = selectedSkills.includes(skill.name);
                  return (
                    <label
                      key={skill.name}
                      className="rounded-md border border-base-300 bg-base-100 px-3 py-2 flex items-start gap-2 cursor-pointer hover:border-base-content/30"
                    >
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm checkbox-primary mt-0.5"
                        checked={isSelected}
                        onChange={() => toggleSkill(skill.name)}
                      />
                      <div className="text-sm">
                        <div className="font-medium flex items-center gap-2">
                          <span>{skill.displayName || skill.name}</span>
                          {skill.source ? <span className="badge badge-ghost badge-xs">{skill.source}</span> : null}
                        </div>
                        {skill.description ? <p className="text-xs opacity-60 mt-1">{skill.description}</p> : null}
                      </div>
                    </label>
                  );
                })}
              </div>
            </>
          )}

          <div className="flex flex-wrap gap-2 items-center">
            <button
              className="btn btn-sm btn-primary gap-2"
              onClick={installCatalogArtifacts}
              disabled={saving || (selectedAgents.length === 0 && selectedSkills.length === 0)}
            >
              {saving ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle className="size-3" />}
              {saving ? "Installing..." : "Install selected items"}
            </button>
            <button
              className="btn btn-sm btn-ghost gap-2"
              onClick={() => {
                loadSkillsCatalog();
              }}
              disabled={saving || loadingSkills}
            >
              <Package className="size-3" />
              {loadingSkills ? "Refreshing..." : "Refresh skills"}
            </button>
            {message && <span className="text-xs text-success">{message}</span>}
          </div>

          {error && <p className="text-xs text-error">{error}</p>}
        </div>
      </div>

      <div className="card bg-base-200">
        <div className="card-body gap-2 p-5">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 opacity-50" />
            <span className="text-xs uppercase tracking-[0.2em] opacity-50">Revisiting onboarding</span>
          </div>
          <p className="text-xs opacity-50">
            Settings keeps onboarding capabilities available: install agents and skills without running onboarding again.
          </p>
        </div>
      </div>
    </div>
  );
}
