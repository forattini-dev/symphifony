import { Zap, Gauge, Brain, Flame, Search } from "lucide-react";

// ── Step labels ───────────────────────────────────────────────────────────────

export const BASE_STEP_LABELS = [
  "Welcome", "Setup", "Pipeline", "Analyze", "Agents & Skills", "Preferences", "Launch",
];

export function getStepLabels(wantsDiscovery) {
  if (!wantsDiscovery) return BASE_STEP_LABELS;
  return [
    ...BASE_STEP_LABELS.slice(0, 4), // Welcome, Setup, Pipeline, Analyze
    "Discover Issues",
    ...BASE_STEP_LABELS.slice(4),    // Agents & Skills, Preferences, Launch
  ];
}

export function getStepCount(wantsDiscovery) {
  return wantsDiscovery ? 8 : 7;
}

// ── Stepper labels ────────────────────────────────────────────────────────────

export const BASE_STEPPER_LABELS = [
  "Setup", "Pipeline", "Analyze", "Agents", "Preferences", "Launch",
];

export function getStepperLabels(wantsDiscovery) {
  if (!wantsDiscovery) return BASE_STEPPER_LABELS;
  return [
    ...BASE_STEPPER_LABELS.slice(0, 3), // Setup, Pipeline, Analyze
    "Discover",
    ...BASE_STEPPER_LABELS.slice(3),    // Agents, Preferences, Launch
  ];
}

// ── Effort options ────────────────────────────────────────────────────────────

export const EFFORT_OPTIONS = [
  { value: "low", label: "Low", icon: Zap, description: "Quick and light -- fast responses, less thorough", color: "text-info" },
  { value: "medium", label: "Medium", icon: Gauge, description: "Balanced -- good mix of speed and quality", color: "text-success" },
  { value: "high", label: "High", icon: Brain, description: "Thorough -- deeper analysis, takes more time", color: "text-warning" },
  { value: "extra-high", label: "Extra High", icon: Flame, description: "Maximum depth -- most thorough, slowest", color: "text-error" },
];

// Effort availability depends on the CLI: codex supports extra-high, claude/gemini do not
export const PROVIDER_EFFORT_SUPPORT = {
  codex: EFFORT_OPTIONS,
  claude: EFFORT_OPTIONS.filter((option) => option.value !== "extra-high"),
  gemini: EFFORT_OPTIONS.filter((option) => option.value !== "extra-high"),
};

export function getEffortOptionsForRole(role, pipeline) {
  const provider = pipeline?.[role] || "codex";
  return PROVIDER_EFFORT_SUPPORT[provider] || EFFORT_OPTIONS;
}

// ── Domain groups ─────────────────────────────────────────────────────────────

export const DOMAIN_GROUPS = [
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

// ── Themes ────────────────────────────────────────────────────────────────────

export const THEMES = [
  { value: "auto", label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "black", label: "Black" },
  { value: "cupcake", label: "Cupcake" },
  { value: "night", label: "Night" },
  { value: "sunset", label: "Sunset" },
];

// ── Pipeline roles ────────────────────────────────────────────────────────────

export const PIPELINE_ROLES = [
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
