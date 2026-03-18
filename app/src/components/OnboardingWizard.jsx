import { useState, useEffect, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useSettings, getSettingsList, getSettingValue, SETTINGS_QUERY_KEY, upsertSettingPayload } from "../hooks";
import Confetti from "./Confetti";
import OnboardingParticles from "./OnboardingParticles";
import {
  Rocket, ChevronRight, ChevronLeft, Search, Zap, Gauge, Brain, Flame,
  Users, Palette, Check, Sparkles, CircleCheck, CircleX, Loader2, Music,
  FolderSearch, Globe, Bot, FileText, Boxes, ShieldCheck, GitBranch, Eye,
} from "lucide-react";
import { DiscoveredIssuesOnboarding } from "./DiscoveredIssuesView";

// ── Constants ───────────────────────────────────────────────────────────────

const BASE_STEP_LABELS = [
  "Welcome", "Providers", "Scan Project", "Domains",
  "Agents & Skills", "Effort", "Workers & Theme", "Launch",
];

// When discovery is enabled, an extra step is inserted after "Scan Project" (index 3)
function getStepLabels(wantsDiscovery) {
  if (!wantsDiscovery) return BASE_STEP_LABELS;
  return [
    ...BASE_STEP_LABELS.slice(0, 3),
    "Discover Issues",
    ...BASE_STEP_LABELS.slice(3),
  ];
}

function getStepCount(wantsDiscovery) {
  return wantsDiscovery ? 9 : 8;
}

const EFFORT_OPTIONS = [
  { value: "low", label: "Low", icon: Zap, description: "Quick and light -- fast responses, less thorough", color: "text-info" },
  { value: "medium", label: "Medium", icon: Gauge, description: "Balanced -- good mix of speed and quality", color: "text-success" },
  { value: "high", label: "High", icon: Brain, description: "Thorough -- deeper analysis, takes more time", color: "text-warning" },
  { value: "extra-high", label: "Extra High", icon: Flame, description: "Maximum depth -- most thorough, slowest", color: "text-error" },
];
// Effort availability depends on the CLI: codex supports extra-high, claude does not
const PROVIDER_EFFORT_SUPPORT = {
  codex: EFFORT_OPTIONS,
  claude: EFFORT_OPTIONS.filter((option) => option.value !== "extra-high"),
};

function getEffortOptionsForRole(role, pipeline) {
  const provider = pipeline?.[role] || "claude";
  return PROVIDER_EFFORT_SUPPORT[provider] || EFFORT_OPTIONS;
}

const DOMAIN_GROUPS = [
  {
    label: "Technical",
    domains: [
      { value: "frontend", label: "Frontend", emoji: "\u{1F3A8}" },
      { value: "backend", label: "Backend", emoji: "\u2699\uFE0F" },
      { value: "mobile", label: "Mobile", emoji: "\u{1F4F1}" },
      { value: "devops", label: "DevOps / Infra", emoji: "\u{1F680}" },
      { value: "database", label: "Database", emoji: "\u{1F5C4}\uFE0F" },
      { value: "ai-ml", label: "AI / ML", emoji: "\u{1F916}" },
      { value: "security", label: "Security", emoji: "\u{1F512}" },
      { value: "testing", label: "Testing / QA", emoji: "\u{1F9EA}" },
      { value: "embedded", label: "Embedded / IoT", emoji: "\u{1F50C}" },
    ],
  },
  {
    label: "Industry",
    domains: [
      { value: "games", label: "Games", emoji: "\u{1F3AE}" },
      { value: "ecommerce", label: "E-commerce", emoji: "\u{1F6D2}" },
      { value: "saas", label: "SaaS", emoji: "\u2601\uFE0F" },
      { value: "fintech", label: "Fintech", emoji: "\u{1F4B0}" },
      { value: "healthcare", label: "Healthcare", emoji: "\u{1F3E5}" },
      { value: "education", label: "Education", emoji: "\u{1F4DA}" },
      { value: "blockchain", label: "Blockchain", emoji: "\u26D3\uFE0F" },
      { value: "spatial-computing", label: "Spatial / XR", emoji: "\u{1F97D}" },
    ],
  },
  {
    label: "Role",
    domains: [
      { value: "design", label: "Design / UX", emoji: "\u270F\uFE0F" },
      { value: "product", label: "Product", emoji: "\u{1F4CB}" },
      { value: "marketing", label: "Marketing", emoji: "\u{1F4E2}" },
      { value: "data-engineering", label: "Data Engineering", emoji: "\u{1F4CA}" },
    ],
  },
];

const THEMES = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "black", label: "Black" },
  { value: "cupcake", label: "Cupcake" },
  { value: "night", label: "Night" },
  { value: "sunset", label: "Sunset" },
];

// ── Helper: save a setting ──────────────────────────────────────────────────

async function saveSetting(id, value, scope = "ui") {
  return api.post(`/settings/${encodeURIComponent(id)}`, { value, scope, source: "user" });
}

function normalizeEffortValue(value, fallback = "medium") {
  return EFFORT_OPTIONS.some((option) => option.value === value) ? value : fallback;
}

function normalizeRoleEfforts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { planner: "medium", executor: "medium", reviewer: "medium" };
  }

  return {
    planner: normalizeEffortValue(value.planner ?? value.default, "medium"),
    executor: normalizeEffortValue(value.executor ?? value.default, "medium"),
    reviewer: normalizeEffortValue(value.reviewer ?? value.default, "medium"),
  };
}

/**
 * Build a WorkflowConfig object from wizard pipeline + efforts + models state.
 * This is the format expected by `runtime.workflowConfig` (plan/execute/review stages).
 */
function buildWorkflowConfig(pipeline, efforts, models = {}) {
  return {
    plan: { provider: pipeline.planner || "claude", model: models.plan || pipeline.planner || "claude", effort: efforts.planner || "medium" },
    execute: { provider: pipeline.executor || "codex", model: models.execute || pipeline.executor || "codex", effort: efforts.executor || "medium" },
    review: { provider: pipeline.reviewer || "claude", model: models.review || pipeline.reviewer || "claude", effort: efforts.reviewer || "medium" },
  };
}

// ── Step indicator ──────────────────────────────────────────────────────────

const BASE_STEPPER_LABELS = [
  "Pipeline", "Scan", "Domains", "Agents",
  "Effort", "Workers & Theme", "Launch",
];

function getStepperLabels(wantsDiscovery) {
  if (!wantsDiscovery) return BASE_STEPPER_LABELS;
  return [
    ...BASE_STEPPER_LABELS.slice(0, 2),
    "Discover",
    ...BASE_STEPPER_LABELS.slice(2),
  ];
}

function StepIndicator({ current, wantsDiscovery }) {
  const labels = getStepperLabels(wantsDiscovery);
  // current is 1-based from the wizard (step 1 = Providers = stepper index 0)
  const stepperIndex = current - 1;
  return (
    <ul className="steps steps-horizontal w-full max-w-2xl text-xs">
      {labels.map((label, i) => {
        const done = i < stepperIndex;
        const active = i === stepperIndex;
        return (
          <li
            key={label}
            data-content={done ? "✓" : i + 1}
            className={`step ${done || active ? "step-primary" : ""}`}
            style={{ transition: "color 0.3s ease" }}
          >
            {label}
          </li>
        );
      })}
    </ul>
  );
}

// ── Step wrapper with slide animation ───────────────────────────────────────

function StepContent({ direction, stepKey, center, children }) {
  const animClass = direction === "forward" ? "animate-slide-in-right" : "animate-slide-in-left";
  return (
    <div key={stepKey} className={`${animClass} w-full max-w-2xl mx-auto ${center ? "my-auto" : ""}`}>
      {children}
    </div>
  );
}

// ── Step 1: Welcome ─────────────────────────────────────────────────────────

function GitignoreBanner() {
  const [status, setStatus] = useState(null); // null = loading, { exists, hasFifony }
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  useEffect(() => {
    api.get("/gitignore/status").then(setStatus).catch(() => setStatus({ exists: false, hasFifony: false }));
  }, []);

  if (status === null || status.hasFifony || added) {
    if (added) {
      return (
        <div className="alert alert-success text-sm max-w-md animate-fade-in">
          <ShieldCheck className="size-4 shrink-0" />
          <span><code>.fifony/</code> added to <code>.gitignore</code></span>
        </div>
      );
    }
    return null;
  }

  const handleAdd = async () => {
    setAdding(true);
    try {
      await api.post("/gitignore/add");
      setAdded(true);
    } catch {
      // silently fail — not critical
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="alert alert-warning text-sm max-w-md">
      <GitBranch className="size-4 shrink-0" />
      <div className="flex-1">
        <span><code>.fifony/</code> is not in your <code>.gitignore</code>.</span>
        <span className="text-base-content/50 block text-xs mt-0.5">fifo stores local state there — it shouldn't be committed.</span>
      </div>
      <button
        className="btn btn-xs btn-warning"
        onClick={handleAdd}
        disabled={adding}
      >
        {adding ? <Loader2 className="size-3 animate-spin" /> : "Add it"}
      </button>
    </div>
  );
}

function WelcomeStep({ workspacePath, onGetStarted }) {
  return (
    <div className="flex flex-col items-center text-center gap-6 stagger-children py-4">
      <div className="text-6xl sm:text-7xl animate-bounce-in">
        <Music className="size-16 sm:size-20 text-primary mx-auto" />
      </div>
      <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
        Welcome to <span className="text-primary">fifo</span>
      </h1>
      <p className="text-base-content/60 text-lg max-w-md">
        Let's set up your AI orchestration workspace in just a few steps.
      </p>
      {workspacePath && (
        <div className="badge badge-lg badge-soft badge-primary gap-2">
          <Sparkles className="size-3.5" />
          {workspacePath}
        </div>
      )}
      <button
        className="btn btn-primary btn-lg gap-2 mt-2"
        onClick={onGetStarted}
      >
        Get Started <ChevronRight className="size-5" />
      </button>
    </div>
  );
}

// ── Step 1: Pipeline ─────────────────────────────────────────────────────────

const PIPELINE_ROLES = [
  {
    role: "planner",
    label: "Planner",
    description: "Scopes the issue, breaks it into steps, and decides the approach",
    icon: Brain,
    color: "text-info",
  },
  {
    role: "executor",
    label: "Executor",
    description: "Implements the plan — writes code, edits files, runs commands",
    icon: Zap,
    color: "text-primary",
  },
  {
    role: "reviewer",
    label: "Reviewer",
    description: "Validates the result — checks correctness, scope, and quality",
    icon: Search,
    color: "text-secondary",
  },
];

function PipelineStep({ providers, providersLoading, pipeline, setPipeline }) {
  const providerList = Array.isArray(providers) ? providers : [];
  const availableProviders = providerList.filter((p) => p.available !== false);

  return (
    <div className="flex flex-col gap-6 stagger-children">
      <div className="text-center">
        <Rocket className="size-10 text-primary mx-auto mb-3" />
        <h2 className="text-2xl font-bold">Agent Pipeline</h2>
        <p className="text-base-content/60 mt-1">Choose which CLI runs each stage of the pipeline</p>
      </div>

      {providersLoading ? (
        <div className="flex flex-col items-center gap-3 py-8">
          <Loader2 className="size-8 text-primary animate-spin" />
          <p className="text-sm text-base-content/50">Detecting available CLIs...</p>
        </div>
      ) : availableProviders.length === 0 ? (
        <div className="alert alert-warning text-sm">
          No providers detected. Make sure claude or codex CLI is installed.
        </div>
      ) : (
        <>
          {/* Provider status */}
          <div className="flex flex-wrap gap-2 justify-center">
            {providerList.map((prov) => {
              const name = prov.id || prov.name || prov;
              const available = prov.available !== false;
              return (
                <span key={name} className={`badge badge-lg gap-2 ${available ? "badge-success" : "badge-ghost opacity-50"}`}>
                  {available ? <CircleCheck className="size-3.5" /> : <CircleX className="size-3.5" />}
                  {name}
                  {prov.path && <span className="font-mono text-[10px] opacity-60 hidden sm:inline">{prov.path}</span>}
                </span>
              );
            })}
          </div>

          {/* Pipeline flow */}
          <div className="flex flex-col items-center gap-2">
            {PIPELINE_ROLES.map((r, i) => {
              const Icon = r.icon;
              const selected = pipeline[r.role] || availableProviders[0]?.name || "";
              return (
                <div key={r.role} className="w-full">
                  {i > 0 && (
                    <div className="flex justify-center py-1">
                      <ChevronRight className="size-5 rotate-90 opacity-30" />
                    </div>
                  )}
                  <div className="card bg-base-200">
                    <div className="card-body p-4 flex-row items-center gap-4">
                      <div className={`size-10 rounded-full flex items-center justify-center bg-base-300 ${r.color}`}>
                        <Icon className="size-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold">{r.label}</div>
                        <p className="text-xs text-base-content/50">{r.description}</p>
                      </div>
                      <select
                        className="select select-bordered select-sm w-32"
                        value={selected}
                        onChange={(e) => setPipeline((prev) => ({ ...prev, [r.role]: e.target.value }))}
                      >
                        {availableProviders.map((p) => {
                          const name = p.id || p.name || p;
                          return <option key={name} value={name}>{name}</option>;
                        })}
                      </select>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-base-content/40 text-center max-w-md mx-auto">
            Each stage can use a different CLI. The pipeline flows top to bottom: plan, then execute, then review.
          </p>
        </>
      )}
    </div>
  );
}

// ── Step 2: Scan Project ────────────────────────────────────────────────────

function ScanProjectStep({
  scanResult, setScanResult,
  projectDescription, setProjectDescription,
  analysisResult, setAnalysisResult,
  selectedProvider, analyzing, setAnalyzing,
}) {
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [analyzeError, setAnalyzeError] = useState(null);
  const didScan = useRef(false);

  // Auto-trigger filesystem scan on mount, then auto-analyze with AI
  useEffect(() => {
    if (didScan.current || scanResult) return;
    didScan.current = true;
    setScanLoading(true);
    setScanError(null);
    api.get("/scan/project")
      .then((data) => {
        setScanResult(data);
        if (!projectDescription) {
          const desc = data?.packageDescription || data?.packageInfo?.description || data?.readmeExcerpt || "";
          if (desc) setProjectDescription(desc);
        }
        // Auto-trigger AI analysis if a provider is available
        if (selectedProvider && !analysisResult) {
          setAnalyzing(true);
          api.post("/scan/analyze", { provider: selectedProvider })
            .then((analysis) => {
              setAnalysisResult(analysis);
              if (analysis.description) setProjectDescription(analysis.description);
            })
            .catch(() => { /* AI analysis is optional, ignore errors */ })
            .finally(() => setAnalyzing(false));
        }
      })
      .catch((err) => setScanError(err.message || "Failed to scan project"))
      .finally(() => setScanLoading(false));
  }, []);

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const data = await api.post("/scan/analyze", { provider: selectedProvider || "claude" });
      setAnalysisResult(data);
      if (data.description) setProjectDescription(data.description);
    } catch (err) {
      setAnalyzeError(err.message || "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }, [selectedProvider, setAnalyzing, setAnalysisResult, setProjectDescription]);

  // Convert backend files object → array for display
  const FILE_LABELS = {
    claudeMd: "CLAUDE.md", claudeDir: ".claude/", codexDir: ".codex/",
    readmeMd: "README.md", packageJson: "package.json",
    cargoToml: "Cargo.toml", pyprojectToml: "pyproject.toml",
    goMod: "go.mod", buildGradle: "build.gradle", gemfile: "Gemfile",
    dockerfile: "Dockerfile", workflowMd: "WORKFLOW.md",
    agentsMd: "AGENTS.md", claudeAgentsDir: ".claude/agents/", claudeSkillsDir: ".claude/skills/",
    codexAgentsDir: ".codex/agents/", codexSkillsDir: ".codex/skills/",
  };
  const scanFiles = scanResult?.files || {};
  const foundFiles = Object.entries(scanFiles).map(([key, exists]) => ({
    path: FILE_LABELS[key] || key,
    exists: Boolean(exists),
  }));
  const existingAgents = (scanResult?.existingAgents || []).map((a) => typeof a === "string" ? { name: a } : a);
  const existingSkills = (scanResult?.existingSkills || []).map((s) => typeof s === "string" ? { name: s } : s);
  const detectedStack = analysisResult?.stack || [];

  return (
    <div className="flex flex-col gap-6 stagger-children">
      <div className="text-center">
        <FolderSearch className="size-10 text-primary mx-auto mb-3" />
        <h2 className="text-2xl font-bold">Scan Project</h2>
        <p className="text-base-content/60 mt-1">We'll analyze your workspace to suggest the best setup</p>
      </div>

      {scanLoading && (
        <div className="flex flex-col items-center gap-3 py-6">
          <Loader2 className="size-8 text-primary animate-spin" />
          <p className="text-sm text-base-content/50">Scanning project files...</p>
        </div>
      )}

      {scanError && (
        <div className="alert alert-warning text-sm">{scanError}</div>
      )}

      {scanResult && !scanLoading && (
        <div className="card bg-base-200">
          <div className="card-body p-4 gap-3">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <FileText className="size-4 opacity-50" />
              Project Files
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              {foundFiles.map((f) => (
                <div key={f.path} className="flex items-center gap-2 text-sm">
                  {f.exists ? (
                    <CircleCheck className="size-4 text-success shrink-0" />
                  ) : (
                    <CircleX className="size-4 text-base-content/30 shrink-0" />
                  )}
                  <span className={`font-mono text-xs truncate ${f.exists ? "" : "text-base-content/40"}`}>
                    {f.path}
                  </span>
                </div>
              ))}
            </div>

            {(existingAgents.length > 0 || existingSkills.length > 0) && (
              <>
                <div className="divider my-0" />
                <div className="flex flex-wrap gap-2">
                  {existingAgents.length > 0 && (
                    <span className="badge badge-sm badge-info gap-1">
                      <Bot className="size-3" />
                      {existingAgents.length} agent{existingAgents.length !== 1 ? "s" : ""} found
                    </span>
                  )}
                  {existingSkills.length > 0 && (
                    <span className="badge badge-sm badge-secondary gap-1">
                      <Boxes className="size-3" />
                      {existingSkills.length} skill{existingSkills.length !== 1 ? "s" : ""} found
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {!analyzing && !analysisResult && (
        <button
          className="btn btn-primary btn-lg gap-2 mx-auto"
          onClick={handleAnalyze}
          disabled={scanLoading}
        >
          <Sparkles className="size-5" />
          Analyze with AI
        </button>
      )}

      {analyzing && (
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className="size-8 text-primary animate-spin" />
          <p className="text-sm text-base-content/50">AI is analyzing your project...</p>
        </div>
      )}

      {analyzeError && (
        <div className="alert alert-warning text-sm">
          Analysis failed. You can describe your project manually below.
        </div>
      )}

      {detectedStack.length > 0 && (
        <div className="flex flex-wrap gap-2 justify-center">
          {detectedStack.map((tech) => (
            <span key={tech} className="badge badge-sm badge-soft badge-primary">{tech}</span>
          ))}
        </div>
      )}

      {(scanResult || analysisResult || analyzeError) && !scanLoading && !analyzing && (
        <div>
          <label className="label text-sm font-medium">Project Description</label>
          <textarea
            className="textarea textarea-bordered w-full h-24 text-sm"
            placeholder="Describe your project so we can suggest the right agents and domains..."
            value={projectDescription}
            onChange={(e) => setProjectDescription(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

// ── Step 3: Domains ─────────────────────────────────────────────────────────

function DomainsStep({ selectedDomains, setSelectedDomains, analysisResult }) {
  const didPreselect = useRef(false);

  useEffect(() => {
    if (didPreselect.current || !analysisResult?.domains?.length) return;
    if (selectedDomains.length > 0) return;
    didPreselect.current = true;
    setSelectedDomains(analysisResult.domains);
  }, [analysisResult]);

  const toggleDomain = useCallback((value) => {
    setSelectedDomains((prev) =>
      prev.includes(value) ? prev.filter((d) => d !== value) : [...prev, value]
    );
  }, [setSelectedDomains]);

  return (
    <div className="flex flex-col gap-6 stagger-children">
      <div className="text-center">
        <Globe className="size-10 text-primary mx-auto mb-3" />
        <h2 className="text-2xl font-bold">Domains</h2>
        <p className="text-base-content/60 mt-1">Select the domains relevant to your project</p>
      </div>

      {DOMAIN_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
            {group.label}
          </div>
          <div className="flex flex-wrap gap-2">
            {group.domains.map((d) => {
              const isSelected = selectedDomains.includes(d.value);
              return (
                <button
                  key={d.value}
                  className={`btn btn-sm gap-1.5 ${isSelected ? "btn-primary" : "btn-soft"}`}
                  onClick={() => toggleDomain(d.value)}
                >
                  <span>{d.emoji}</span>
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Step 4: Agents & Skills ─────────────────────────────────────────────────

function AgentsSkillsStep({
  selectedDomains, selectedAgents, setSelectedAgents,
  selectedSkills, setSelectedSkills, existingAgents, existingSkills,
}) {
  const [catalogAgents, setCatalogAgents] = useState([]);
  const [catalogSkills, setCatalogSkills] = useState([]);
  const [loading, setLoading] = useState(false);
  const didFetch = useRef(false);

  useEffect(() => {
    if (didFetch.current) return;
    didFetch.current = true;
    setLoading(true);

    const domainQuery = selectedDomains.length > 0 ? `?domains=${selectedDomains.join(",")}` : "";
    Promise.all([
      api.get(`/catalog/agents${domainQuery}`).catch(() => ({ agents: [] })),
      api.get("/catalog/skills").catch(() => ({ skills: [] })),
    ]).then(([agentsData, skillsData]) => {
      const agents = agentsData?.agents || [];
      const skills = skillsData?.skills || [];
      setCatalogAgents(agents);
      setCatalogSkills(skills);

      const existingNames = new Set((existingAgents || []).map((a) => a.name));
      const autoAgents = agents.filter((a) => !existingNames.has(a.name)).map((a) => a.name);
      if (autoAgents.length > 0 && selectedAgents.length === 0) {
        setSelectedAgents(autoAgents);
      }

      const existingSkillNames = new Set((existingSkills || []).map((s) => s.name));
      const autoSkills = skills.filter((s) => !existingSkillNames.has(s.name)).map((s) => s.name);
      if (autoSkills.length > 0 && selectedSkills.length === 0) {
        setSelectedSkills(autoSkills);
      }
    }).finally(() => setLoading(false));
  }, []);

  const existingAgentNames = new Set((existingAgents || []).map((a) => a.name));
  const existingSkillNames = new Set((existingSkills || []).map((s) => s.name));

  const toggleAgent = useCallback((name) => {
    setSelectedAgents((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  }, [setSelectedAgents]);

  const toggleSkill = useCallback((name) => {
    setSelectedSkills((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  }, [setSelectedSkills]);

  const selectAllAgents = useCallback(() => {
    const names = catalogAgents.filter((a) => !existingAgentNames.has(a.name)).map((a) => a.name);
    setSelectedAgents(names);
  }, [catalogAgents, existingAgentNames, setSelectedAgents]);

  const selectNoneAgents = useCallback(() => setSelectedAgents([]), [setSelectedAgents]);

  const selectAllSkills = useCallback(() => {
    const names = catalogSkills.filter((s) => !existingSkillNames.has(s.name)).map((s) => s.name);
    setSelectedSkills(names);
  }, [catalogSkills, existingSkillNames, setSelectedSkills]);

  const selectNoneSkills = useCallback(() => setSelectedSkills([]), [setSelectedSkills]);

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
        <h2 className="text-2xl font-bold">Agents & Skills</h2>
        <p className="text-base-content/60 mt-1">Choose which agents and skills to install</p>
      </div>

      {catalogAgents.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Bot className="size-4 opacity-50" />
              Agents ({catalogAgents.length})
            </h3>
            <div className="flex gap-1">
              <button className="btn btn-xs btn-ghost" onClick={selectAllAgents}>Select All</button>
              <button className="btn btn-xs btn-ghost" onClick={selectNoneAgents}>None</button>
            </div>
          </div>
          <div className="grid gap-2">
            {catalogAgents.map((agent) => {
              const installed = existingAgentNames.has(agent.name);
              const isSelected = installed || selectedAgents.includes(agent.name);
              return (
                <button
                  key={agent.name}
                  className={`card bg-base-200 cursor-pointer transition-all text-left ${
                    isSelected ? "ring-2 ring-primary ring-offset-1 ring-offset-base-100" : ""
                  } ${installed ? "opacity-60" : ""}`}
                  onClick={() => !installed && toggleAgent(agent.name)}
                  disabled={installed}
                >
                  <div className="card-body p-3 flex-row items-center gap-3">
                    <div className="text-xl shrink-0">{agent.emoji || "\u{1F916}"}</div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm truncate">
                        {agent.displayName || agent.name}
                      </div>
                      {agent.description && (
                        <p className="text-xs text-base-content/50 truncate">{agent.description}</p>
                      )}
                    </div>
                    {installed ? (
                      <span className="badge badge-sm badge-success gap-1">
                        <Check className="size-3" /> Installed
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        className="checkbox checkbox-primary checkbox-sm"
                        checked={isSelected}
                        readOnly
                        tabIndex={-1}
                      />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {catalogSkills.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Boxes className="size-4 opacity-50" />
              Skills ({catalogSkills.length})
            </h3>
            <div className="flex gap-1">
              <button className="btn btn-xs btn-ghost" onClick={selectAllSkills}>Select All</button>
              <button className="btn btn-xs btn-ghost" onClick={selectNoneSkills}>None</button>
            </div>
          </div>
          <div className="grid gap-2">
            {catalogSkills.map((skill) => {
              const installed = existingSkillNames.has(skill.name);
              const isSelected = installed || selectedSkills.includes(skill.name);
              return (
                <button
                  key={skill.name}
                  className={`card bg-base-200 cursor-pointer transition-all text-left ${
                    isSelected ? "ring-2 ring-primary ring-offset-1 ring-offset-base-100" : ""
                  } ${installed ? "opacity-60" : ""}`}
                  onClick={() => !installed && toggleSkill(skill.name)}
                  disabled={installed}
                >
                  <div className="card-body p-3 flex-row items-center gap-3">
                    <div className="text-xl shrink-0">{skill.emoji || "\u{1F9E9}"}</div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm truncate">
                        {skill.displayName || skill.name}
                      </div>
                      {skill.description && (
                        <p className="text-xs text-base-content/50 truncate">{skill.description}</p>
                      )}
                    </div>
                    {installed ? (
                      <span className="badge badge-sm badge-success gap-1">
                        <Check className="size-3" /> Installed
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        className="checkbox checkbox-primary checkbox-sm"
                        checked={isSelected}
                        readOnly
                        tabIndex={-1}
                      />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {catalogAgents.length === 0 && catalogSkills.length === 0 && (
        <div className="alert alert-info text-sm">
          No agents or skills found in the catalog. You can add them later from the settings page.
        </div>
      )}
    </div>
  );
}

// ── Step 5: Configure Effort ────────────────────────────────────────────────

function RoleEffortSelector({ role, title, description, providerName, value, onChange, options, model, onModelChange, availableModels }) {
  const currentIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[currentIndex] || options[0];
  const Icon = current.icon;

  return (
    <div className="card bg-base-200">
      <div className="card-body p-5 gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">{title}</h3>
            <p className="text-xs text-base-content/60 mt-0.5">{description}</p>
          </div>
          {providerName && (
            <span className="badge badge-sm badge-soft badge-primary capitalize">{providerName}</span>
          )}
        </div>

        {/* Model selector */}
        {availableModels && availableModels.length > 0 && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-base-content/50">Model</label>
            <select
              className="select select-sm select-bordered w-full"
              value={model || ""}
              onChange={(e) => onModelChange?.(e.target.value)}
            >
              {availableModels.map((m) => (
                <option key={m.id} value={m.id}>{m.label || m.id}</option>
              ))}
            </select>
          </div>
        )}

        {/* Current value display */}
        <div className="flex flex-col items-center gap-2 py-2">
          <div className={`flex items-center gap-2 text-lg font-bold ${current.color}`}>
            <Icon className="size-6" />
            {current.label}
          </div>
          <p className="text-xs text-base-content/50 text-center max-w-xs">{current.description}</p>
        </div>

        {/* Slider */}
        <div className="px-1">
          <input
            type="range"
            min={0}
            max={options.length - 1}
            value={currentIndex}
            onChange={(e) => onChange(options[Number(e.target.value)].value)}
            className="range range-primary range-sm w-full"
            step={1}
          />
          <div className="flex justify-between mt-1 px-0.5">
            {options.map((opt) => (
              <span
                key={`${role}-tick-${opt.value}`}
                className={`text-[10px] ${opt.value === current.value ? current.color + " font-semibold" : "text-base-content/30"}`}
              >
                {opt.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EffortStep({ efforts, setEfforts, pipeline, models, setModels, modelsByProvider }) {
  // Auto-clamp effort if user changed pipeline and current effort is unsupported
  useEffect(() => {
    for (const role of ["planner", "executor", "reviewer"]) {
      const options = getEffortOptionsForRole(role, pipeline);
      const currentValue = efforts[role];
      if (currentValue && !options.some((o) => o.value === currentValue)) {
        setEfforts((prev) => ({ ...prev, [role]: "high" })); // downgrade to max supported
      }
    }
  }, [pipeline, efforts, setEfforts]);

  const plannerModels = modelsByProvider?.[pipeline?.planner] || [];
  const executorModels = modelsByProvider?.[pipeline?.executor] || [];
  const reviewerModels = modelsByProvider?.[pipeline?.reviewer] || [];

  return (
    <div className="flex flex-col gap-6 stagger-children">
      <div className="text-center">
        <Gauge className="size-10 text-primary mx-auto mb-3" />
        <h2 className="text-2xl font-bold">Models & Reasoning Effort</h2>
        <p className="text-base-content/60 mt-1">Choose the model and reasoning depth for each pipeline stage.</p>
      </div>

      <RoleEffortSelector
        role="planner"
        title="Planning"
        description="Scopes the issue and decides the overall approach."
        providerName={pipeline?.planner}
        value={efforts.planner}
        onChange={(value) => setEfforts((current) => ({ ...current, planner: value }))}
        options={getEffortOptionsForRole("planner", pipeline)}
        model={models?.plan}
        onModelChange={(m) => setModels((prev) => ({ ...prev, plan: m }))}
        availableModels={plannerModels}
      />
      <RoleEffortSelector
        role="executor"
        title="Execution"
        description="Implements the plan — writes code, edits files."
        providerName={pipeline?.executor}
        value={efforts.executor}
        onChange={(value) => setEfforts((current) => ({ ...current, executor: value }))}
        options={getEffortOptionsForRole("executor", pipeline)}
        model={models?.execute}
        onModelChange={(m) => setModels((prev) => ({ ...prev, execute: m }))}
        availableModels={executorModels}
      />
      <RoleEffortSelector
        role="reviewer"
        title="Review"
        description="Validates the result before approving."
        providerName={pipeline?.reviewer}
        value={efforts.reviewer}
        onChange={(value) => setEfforts((current) => ({ ...current, reviewer: value }))}
        options={getEffortOptionsForRole("reviewer", pipeline)}
        model={models?.review}
        onModelChange={(m) => setModels((prev) => ({ ...prev, review: m }))}
        availableModels={reviewerModels}
      />
    </div>
  );
}

// ── Step 4: Workers & Theme ─────────────────────────────────────────────────

function WorkersThemeStep({ concurrency, setConcurrency, selectedTheme, setSelectedTheme }) {
  return (
    <div className="flex flex-col gap-6 stagger-children">
      {/* Concurrency */}
      <div>
        <div className="text-center mb-4">
          <Users className="size-10 text-primary mx-auto mb-3" />
          <h2 className="text-2xl font-bold">Workers & Theme</h2>
          <p className="text-base-content/60 mt-1">Configure parallel workers and visual theme</p>
        </div>

        <div className="card bg-base-200">
          <div className="card-body p-5 gap-3">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Users className="size-4 opacity-50" />
              Worker Concurrency
            </h3>
            <p className="text-xs text-base-content/60">
              How many agents can work in parallel ({concurrency} worker{concurrency !== 1 ? "s" : ""})
            </p>
            <input
              type="range"
              min={1}
              max={16}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="range range-primary range-sm"
            />
            <div className="flex justify-between text-xs text-base-content/40 px-1">
              <span>1</span>
              <span>4</span>
              <span>8</span>
              <span>12</span>
              <span>16</span>
            </div>
          </div>
        </div>
      </div>

      {/* Theme */}
      <div className="card bg-base-200">
        <div className="card-body p-5 gap-3">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Palette className="size-4 opacity-50" />
            Theme
          </h3>
          <div className="flex flex-wrap gap-2">
            {THEMES.map((t) => (
              <button
                key={t.value}
                className={`btn btn-sm ${selectedTheme === t.value ? "btn-primary" : "btn-soft"}`}
                onClick={() => setSelectedTheme(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Step 5: Complete ────────────────────────────────────────────────────────

function CompleteStep({ config, launching }) {
  return (
    <div className="flex flex-col items-center text-center gap-6 stagger-children py-4">
      <div className="animate-bounce-in">
        <Rocket className="size-16 sm:size-20 text-primary mx-auto" />
      </div>
      <h2 className="text-2xl sm:text-3xl font-bold">You're All Set!</h2>
      <p className="text-base-content/60 max-w-md">
        Here's a summary of your configuration. Hit launch when you're ready.
      </p>

      <div className="card bg-base-200 w-full max-w-sm">
        <div className="card-body p-4 gap-2 text-sm text-left">
          <div className="flex justify-between">
            <span className="text-base-content/60">Pipeline</span>
            <span className="font-semibold capitalize text-xs font-mono">
              {config.pipeline?.planner || "?"} → {config.pipeline?.executor || "?"} → {config.pipeline?.reviewer || "?"}
            </span>
          </div>
          <div className="divider my-0" />
          <div className="flex justify-between">
            <span className="text-base-content/60">Domains</span>
            <span className="font-semibold">
              {config.domains?.length > 0 ? config.domains.length + " selected" : "none"}
            </span>
          </div>
          <div className="divider my-0" />
          <div className="flex justify-between">
            <span className="text-base-content/60">Agents</span>
            <span className="font-semibold">{config.agents?.length || 0} to install</span>
          </div>
          <div className="divider my-0" />
          <div className="flex justify-between">
            <span className="text-base-content/60">Skills</span>
            <span className="font-semibold">{config.skills?.length || 0} to install</span>
          </div>
          <div className="divider my-0" />
          <div className="flex justify-between">
            <span className="text-base-content/60">Plan</span>
            <span className="font-semibold capitalize">{config.efforts.planner}</span>
          </div>
          <div className="divider my-0" />
          <div className="flex justify-between">
            <span className="text-base-content/60">Execute</span>
            <span className="font-semibold capitalize">{config.efforts.executor}</span>
          </div>
          <div className="divider my-0" />
          <div className="flex justify-between">
            <span className="text-base-content/60">Review</span>
            <span className="font-semibold capitalize">{config.efforts.reviewer}</span>
          </div>
          <div className="divider my-0" />
          <div className="flex justify-between">
            <span className="text-base-content/60">Workers</span>
            <span className="font-semibold">{config.concurrency}</span>
          </div>
          <div className="divider my-0" />
          <div className="flex justify-between">
            <span className="text-base-content/60">Theme</span>
            <span className="font-semibold capitalize">{config.theme}</span>
          </div>
        </div>
      </div>

      {launching && (
        <div className="flex items-center gap-2 text-sm text-base-content/50">
          <Loader2 className="size-4 animate-spin" />
          Saving configuration & installing agents...
        </div>
      )}
    </div>
  );
}

// ── Main Wizard Component ───────────────────────────────────────────────────

export default function OnboardingWizard({ onComplete }) {
  const qc = useQueryClient();
  const settingsQuery = useSettings();
  const settings = getSettingsList(settingsQuery.data);

  // Wizard state
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState("forward");
  const [launching, setLaunching] = useState(false);
  const [confetti, setConfetti] = useState(null);
  const hydratedRef = useRef(false);

  // Config state
  const [selectedProvider, setSelectedProvider] = useState(""); // legacy, kept for scan/analyze
  const [pipeline, setPipeline] = useState({ planner: "", executor: "", reviewer: "" });
  const [efforts, setEfforts] = useState(() => normalizeRoleEfforts(null));
  const [concurrency, setConcurrency] = useState(2);
  const [selectedTheme, setSelectedTheme] = useState("auto");

  // New step state
  const [scanResult, setScanResult] = useState(null);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [projectDescription, setProjectDescription] = useState("");
  const [selectedDomains, setSelectedDomains] = useState([]);
  const [selectedAgents, setSelectedAgents] = useState([]);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [wantsDiscovery, setWantsDiscovery] = useState(false);

  const STEP_COUNT = getStepCount(wantsDiscovery);
  const STEP_LABELS = getStepLabels(wantsDiscovery);

  // Map logical step index to step name (handles the optional discovery step)
  const stepName = STEP_LABELS[step] || "";

  // Provider detection
  const [providers, setProviders] = useState(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [modelsByProvider, setModelsByProvider] = useState({});
  const [models, setModels] = useState({ plan: "", execute: "", review: "" });

  // Workspace path from runtime state
  const [workspacePath, setWorkspacePath] = useState("");

  // Load workspace path on mount
  useEffect(() => {
    api.get("/state").then((data) => {
      const path = data?.sourceRepoUrl || data?.config?.sourceRepo || "";
      setWorkspacePath(path);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (hydratedRef.current || settingsQuery.isLoading) return;
    hydratedRef.current = true;

    const savedProvider = getSettingValue(settings, "runtime.agentProvider", "");
    const savedEfforts = getSettingValue(settings, "runtime.defaultEffort", null);
    const savedTheme = getSettingValue(settings, "ui.theme", "auto");
    const savedConcurrency = getSettingValue(settings, "runtime.workerConcurrency", 2);

    if (typeof savedProvider === "string" && savedProvider.trim()) {
      setSelectedProvider(savedProvider);
    }
    setEfforts(normalizeRoleEfforts(savedEfforts));
    if (typeof savedTheme === "string" && savedTheme.trim()) {
      setSelectedTheme(savedTheme);
    }

    const parsedConcurrency = Number.parseInt(String(savedConcurrency ?? 2), 10);
    if (Number.isFinite(parsedConcurrency)) {
      setConcurrency(Math.min(16, Math.max(1, parsedConcurrency)));
    }
  }, [settings, settingsQuery.isLoading]);

  // Fetch providers (and models) when reaching step 1
  useEffect(() => {
    if (step === 1 && providers === null) {
      setProvidersLoading(true);
      Promise.all([
        api.get("/providers"),
        api.get("/config/workflow?details=1").catch(() => null),
      ]).then(([provData, workflowData]) => {
        const list = Array.isArray(provData) ? provData : provData?.providers || [];
        setProviders(list);

        // Models from workflow endpoint
        const fetchedModels = workflowData?.models || {};
        setModelsByProvider(fetchedModels);

        // Auto-select first available + set default pipeline
        const available = list.filter((p) => p.available !== false);
        const firstName = available[0]?.id || available[0]?.name || "";
        if (firstName && !selectedProvider) setSelectedProvider(firstName);

        // Default pipeline: claude plans + reviews, first available executes
        const claudeAvailable = available.find((p) => (p.id || p.name) === "claude");
        const defaultCli = firstName;
        const planReviewCli = claudeAvailable ? "claude" : defaultCli;
        const newPipeline = {
          planner: planReviewCli,
          executor: defaultCli,
          reviewer: planReviewCli,
        };
        setPipeline((prev) => ({
          planner: prev.planner || newPipeline.planner,
          executor: prev.executor || newPipeline.executor,
          reviewer: prev.reviewer || newPipeline.reviewer,
        }));

        // Auto-select first model per stage
        setModels((prev) => ({
          plan: prev.plan || fetchedModels[planReviewCli]?.[0]?.id || "",
          execute: prev.execute || fetchedModels[defaultCli]?.[0]?.id || "",
          review: prev.review || fetchedModels[planReviewCli]?.[0]?.id || "",
        }));
      }).catch(() => {
        setProviders([]);
      }).finally(() => {
        setProvidersLoading(false);
      });
    }
  }, [step]);

  // Apply theme preview immediately
  useEffect(() => {
    const resolved = selectedTheme === "auto"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : selectedTheme;
    document.documentElement.setAttribute("data-theme", resolved);
  }, [selectedTheme]);

  // Derive selectedProvider from pipeline (executor is the "main" provider)
  useEffect(() => {
    if (pipeline.executor && pipeline.executor !== selectedProvider) {
      setSelectedProvider(pipeline.executor);
    }
  }, [pipeline.executor]);

  // Save settings progressively as user advances
  const saveStepSettings = useCallback((currentStepName) => {
    if (currentStepName === "Providers") {
      // Save pipeline as providers array + primary provider
      const pipelineProviders = [
        { provider: pipeline.planner, role: "planner" },
        { provider: pipeline.executor, role: "executor" },
        { provider: pipeline.reviewer, role: "reviewer" },
      ];
      saveSetting("runtime.agentProvider", pipeline.executor, "runtime").catch(() => {});
      saveSetting("runtime.pipeline", pipelineProviders, "runtime").catch(() => {});
      // Also save as WorkflowConfig so planner/executor/reviewer use correct providers
      saveSetting("runtime.workflowConfig", buildWorkflowConfig(pipeline, efforts, models), "runtime").catch(() => {});
    } else if (currentStepName === "Effort") {
      saveSetting("runtime.defaultEffort", efforts, "runtime").catch(() => {});
      // Update WorkflowConfig with latest efforts + models
      saveSetting("runtime.workflowConfig", buildWorkflowConfig(pipeline, efforts, models), "runtime").catch(() => {});
    } else if (currentStepName === "Workers & Theme") {
      saveSetting("ui.theme", selectedTheme, "ui").catch(() => {});
      api.post("/config/concurrency", { concurrency }).catch(() => {});
    }
  }, [pipeline, efforts, models, concurrency, selectedTheme]);

  const goNext = useCallback(() => {
    if (step < STEP_COUNT - 1) {
      saveStepSettings(stepName);
      setDirection("forward");
      setStep((s) => s + 1);
    }
  }, [step, STEP_COUNT, stepName, saveStepSettings]);

  const goBack = useCallback(() => {
    if (step > 0) {
      setDirection("backward");
      setStep((s) => s - 1);
    }
  }, [step]);

  const handleLaunch = useCallback(async () => {
    setLaunching(true);
    try {
      // Save all settings in parallel
      const saves = [
        saveSetting("ui.theme", selectedTheme, "ui"),
        saveSetting("ui.onboarding.completed", true, "ui"),
      ];

      // Save pipeline configuration
      const pipelineProviders = [
        { provider: pipeline.planner, role: "planner" },
        { provider: pipeline.executor, role: "executor" },
        { provider: pipeline.reviewer, role: "reviewer" },
      ];
      saves.push(saveSetting("runtime.agentProvider", pipeline.executor, "runtime"));
      saves.push(saveSetting("runtime.pipeline", pipelineProviders, "runtime"));

      // Save as WorkflowConfig (the format read by planner, executor, reviewer stages)
      saves.push(saveSetting("runtime.workflowConfig", buildWorkflowConfig(pipeline, efforts), "runtime"));

      saves.push(saveSetting("runtime.defaultEffort", efforts, "runtime"));
      saves.push(saveSetting("runtime.workflowConfig", buildWorkflowConfig(pipeline, efforts, models), "runtime"));
      saves.push(api.post("/config/concurrency", { concurrency }));

      // Install selected agents and skills
      if (selectedAgents.length > 0) {
        saves.push(api.post("/install/agents", { agents: selectedAgents }));
      }
      if (selectedSkills.length > 0) {
        saves.push(api.post("/install/skills", { skills: selectedSkills }));
      }

      await Promise.allSettled(saves);

      // Optimistically update settings cache so OnboardingGate immediately sees completed=true
      qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, {
        id: "ui.onboarding.completed",
        scope: "ui",
        value: true,
        source: "user",
        updatedAt: new Date().toISOString(),
      }));

      // Show confetti, then navigate
      setConfetti({ x: window.innerWidth / 2, y: window.innerHeight / 3 });
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
        onComplete?.();
      }, 1200);
    } catch {
      // Even on error, mark as done so user isn't stuck
      qc.setQueryData(SETTINGS_QUERY_KEY, (current) => upsertSettingPayload(current, {
        id: "ui.onboarding.completed",
        scope: "ui",
        value: true,
        source: "user",
        updatedAt: new Date().toISOString(),
      }));
      await saveSetting("ui.onboarding.completed", true, "ui").catch(() => {});
      qc.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY });
      onComplete?.();
    }
  }, [pipeline, selectedProvider, efforts, models, concurrency, selectedTheme, selectedAgents, selectedSkills, qc, onComplete]);

  // Can proceed from step
  const canProceed =
    stepName === "Welcome" ||
    (stepName === "Providers" && (pipeline.executor || providersLoading)) ||
    stepName === "Scan Project" ||
    stepName === "Discover Issues" ||
    stepName === "Domains" ||
    stepName === "Agents & Skills" ||
    stepName === "Effort" ||
    stepName === "Workers & Theme" ||
    stepName === "Launch";

  const existingAgents = (scanResult?.existingAgents || []).map((a) => typeof a === "string" ? { name: a } : a);
  const existingSkills = (scanResult?.existingSkills || []).map((s) => typeof s === "string" ? { name: s } : s);

  const config = {
    pipeline,
    efforts,
    concurrency,
    theme: selectedTheme,
    domains: selectedDomains,
    agents: selectedAgents,
    skills: selectedSkills,
  };

  return (
    <div className="fixed inset-0 z-50 bg-base-100 flex flex-col overflow-hidden">
      <OnboardingParticles />

      {confetti && (
        <Confetti x={confetti.x} y={confetti.y} active onDone={() => setConfetti(null)} />
      )}

      {/* Header with step indicator — hidden on welcome screen */}
      {step > 0 && (
        <div className="relative z-10 pt-6 pb-2 px-4 flex justify-center">
          <StepIndicator current={step} wantsDiscovery={wantsDiscovery} />
        </div>
      )}

      {/* Step content area */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-start px-4 py-6 overflow-y-auto">
        <StepContent direction={direction} stepKey={step} center={stepName === "Welcome" || stepName === "Providers" || stepName === "Launch"}>
          {stepName === "Welcome" && <WelcomeStep workspacePath={workspacePath} onGetStarted={goNext} />}
          {stepName === "Providers" && (
            <PipelineStep
              providers={providers || []}
              providersLoading={providersLoading}
              pipeline={pipeline}
              setPipeline={setPipeline}
            />
          )}
          {stepName === "Scan Project" && (
            <>
              <ScanProjectStep
                scanResult={scanResult}
                setScanResult={setScanResult}
                projectDescription={projectDescription}
                setProjectDescription={setProjectDescription}
                analysisResult={analysisResult}
                setAnalysisResult={setAnalysisResult}
                selectedProvider={selectedProvider}
                analyzing={analyzing}
                setAnalyzing={setAnalyzing}
              />
              {/* Discovery opt-in toggle */}
              <div className="mt-4 w-full max-w-lg">
                <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg bg-base-200/50 border border-base-300/50 hover:border-primary/30 transition-colors">
                  <input
                    type="checkbox"
                    className="toggle toggle-primary toggle-sm"
                    checked={wantsDiscovery}
                    onChange={(e) => setWantsDiscovery(e.target.checked)}
                  />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Eye className="size-4 text-primary" />
                      <span className="text-sm font-medium">Discover existing issues</span>
                    </div>
                    <p className="text-xs text-base-content/50 mt-0.5">
                      Scan for TODOs, FIXMEs, and GitHub issues to import
                    </p>
                  </div>
                </label>
              </div>
              <div className="mt-3 w-full max-w-lg">
                <GitignoreBanner />
              </div>
            </>
          )}
          {stepName === "Discover Issues" && (
            <DiscoveredIssuesOnboarding />
          )}
          {stepName === "Domains" && (
            <DomainsStep
              selectedDomains={selectedDomains}
              setSelectedDomains={setSelectedDomains}
              analysisResult={analysisResult}
            />
          )}
          {stepName === "Agents & Skills" && (
            <AgentsSkillsStep
              selectedDomains={selectedDomains}
              selectedAgents={selectedAgents}
              setSelectedAgents={setSelectedAgents}
              selectedSkills={selectedSkills}
              setSelectedSkills={setSelectedSkills}
              existingAgents={existingAgents}
              existingSkills={existingSkills}
            />
          )}
          {stepName === "Effort" && <EffortStep efforts={efforts} setEfforts={setEfforts} pipeline={pipeline} models={models} setModels={setModels} modelsByProvider={modelsByProvider} />}
          {stepName === "Workers & Theme" && (
            <WorkersThemeStep
              concurrency={concurrency}
              setConcurrency={setConcurrency}
              selectedTheme={selectedTheme}
              setSelectedTheme={setSelectedTheme}
            />
          )}
          {stepName === "Launch" && <CompleteStep config={config} launching={launching} />}
        </StepContent>
      </div>

      {/* Navigation footer — hidden on welcome (button is inline) */}
      {step > 0 && <div className="relative z-10 p-4 pb-6 flex items-center max-w-2xl mx-auto w-full justify-between">
        {step > 0 && (
          <button
            className="btn btn-ghost gap-1"
            onClick={goBack}
            disabled={launching}
          >
            <ChevronLeft className="size-4" /> Back
          </button>
        )}

        {step < STEP_COUNT - 1 ? (
          <button
            className="btn btn-primary gap-1"
            onClick={goNext}
            disabled={!canProceed}
          >
            {stepName === "Discover Issues" ? "Continue" : "Next"} <ChevronRight className="size-4" />
          </button>
        ) : (
          <button
            className="btn btn-primary btn-lg gap-2 animate-pulse-soft"
            onClick={handleLaunch}
            disabled={launching}
          >
            {launching ? (
              <>
                <Loader2 className="size-5 animate-spin" /> Launching...
              </>
            ) : (
              <>
                <Rocket className="size-5" /> Launch fifo
              </>
            )}
          </button>
        )}
      </div>}
    </div>
  );
}
