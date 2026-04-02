import type {
  AcceptanceCriterion,
  IssueEntry,
  ReviewProfile,
  ReviewProfileName,
} from "../types.ts";

type ProfileScore = {
  name: ReviewProfileName;
  score: number;
  rationale: string[];
};

const UI_EXTENSIONS = [".jsx", ".tsx", ".css", ".scss", ".vue", ".svelte", ".html"];

function collectCandidatePaths(issue: IssueEntry): string[] {
  const planPaths = issue.plan?.suggestedPaths ?? [];
  const issuePaths = issue.paths ?? [];
  const contractAreas = issue.plan?.executionContract?.focusAreas ?? [];
  return [...new Set([...issuePaths, ...planPaths, ...contractAreas])];
}

function collectCandidateText(issue: IssueEntry): string {
  return [
    issue.title,
    issue.description,
    issue.issueType,
    ...(issue.labels ?? []),
    ...(issue.plan?.suggestedPaths ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function hasPath(paths: string[], pattern: RegExp): boolean {
  return paths.some((path) => pattern.test(path));
}

function hasCategory(criteria: AcceptanceCriterion[], category: AcceptanceCriterion["category"]): boolean {
  return criteria.some((criterion) => criterion.category === category);
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function buildFocusAreas(paths: string[], fallback: string[]): string[] {
  const combined = [...paths, ...fallback].filter(Boolean);
  return [...new Set(combined)].slice(0, 6);
}

export function deriveReviewProfile(issue: IssueEntry): ReviewProfile {
  const paths = collectCandidatePaths(issue);
  const text = collectCandidateText(issue);
  const criteria = issue.plan?.acceptanceCriteria ?? [];
  const complexity = issue.plan?.estimatedComplexity;
  const lowScope = complexity === "trivial" || complexity === "low";

  const scores: ProfileScore[] = [
    { name: "general-quality", score: 1, rationale: ["Fallback profile for broad correctness, regression risk, and code quality review."] },
    { name: "ui-polish", score: 0, rationale: [] },
    { name: "workflow-fsm", score: 0, rationale: [] },
    { name: "integration-safety", score: 0, rationale: [] },
    { name: "api-contract", score: 0, rationale: [] },
    { name: "security-hardening", score: 0, rationale: [] },
  ];

  // For trivial/low complexity, dampen keyword/path signals — a file path containing
  // "auth" shouldn't trigger security-hardening when the task is just installing a
  // dependency. Only explicit AC categories still count at full weight.
  const pathWeight = lowScope ? 1 : 5;
  const keywordWeight = lowScope ? 1 : 3;
  const broadKeywordWeight = lowScope ? 0 : 2;

  const uiScore = scores.find((entry) => entry.name === "ui-polish")!;
  if (paths.some((path) => UI_EXTENSIONS.some((ext) => path.endsWith(ext)))) {
    uiScore.score += lowScope ? 2 : 4;
    uiScore.rationale.push("Touched frontend files that can regress visual polish, interaction flow, or responsiveness.");
  }
  if (hasCategory(criteria, "design") || includesAny(text, ["frontend", "ui", "ux", "drawer", "onboarding", "layout", "mobile"])) {
    uiScore.score += keywordWeight;
    uiScore.rationale.push("Issue signals UI/UX work that needs stronger product-behavior and visual scrutiny.");
  }

  const workflowScore = scores.find((entry) => entry.name === "workflow-fsm")!;
  if (hasPath(paths, /src\/persistence\/plugins\/fsm-|src\/commands\/|src\/domains\/issues\.ts|src\/agents\//)) {
    workflowScore.score += pathWeight;
    workflowScore.rationale.push("Touched workflow/FSM/orchestration code where lifecycle invariants and retry semantics are fragile.");
  }
  if (includesAny(text, ["fsm", "workflow", "queue", "review gate", "lifecycle", "orchestration", "agent"])) {
    workflowScore.score += keywordWeight;
    workflowScore.rationale.push("Issue description or labels indicate orchestration semantics rather than isolated implementation.");
  }

  const integrationScore = scores.find((entry) => entry.name === "integration-safety")!;
  if (hasPath(paths, /workspace|merge|push|rebase|git|dirty-tracker|services?|store\.ts/)) {
    integrationScore.score += pathWeight;
    integrationScore.rationale.push("Touched integration or git/workspace code where destructive behavior and state drift must be caught.");
  }
  if (hasCategory(criteria, "integration") || hasCategory(criteria, "regression")) {
    integrationScore.score += broadKeywordWeight;
    integrationScore.rationale.push("Acceptance criteria explicitly call out integration or regression guarantees.");
  }

  const apiScore = scores.find((entry) => entry.name === "api-contract")!;
  if (hasPath(paths, /src\/routes\/|src\/persistence\/resources\/|src\/mcp\//)) {
    apiScore.score += lowScope ? 2 : 4;
    apiScore.rationale.push("Touched API/resource surface that can drift from contract or persistence schema.");
  }
  if (includesAny(text, ["api", "route", "http", "endpoint", "resource", "schema"])) {
    apiScore.score += broadKeywordWeight;
    apiScore.rationale.push("Issue language implies request/response or schema contract changes.");
  }

  const securityScore = scores.find((entry) => entry.name === "security-hardening")!;
  // For security: only full-weight if there's an explicit security AC, not just because
  // the word "auth" appears in the title or a file path contains "auth".
  if (hasCategory(criteria, "security")) {
    securityScore.score += 5;
    securityScore.rationale.push("Security-sensitive acceptance criteria are present and should be treated as blocking by default.");
  } else if (includesAny(text, ["auth", "security", "token", "permission", "secret"])) {
    securityScore.score += lowScope ? 1 : 4;
    securityScore.rationale.push("Issue language hints at security-sensitive work.");
  }
  if (hasPath(paths, /auth|permission|secret|credential|shell|command-executor/)) {
    securityScore.score += lowScope ? 1 : 3;
    securityScore.rationale.push("Touched code paths that can introduce auth, privilege, or command-execution risk.");
  }

  const ranked = [...scores].sort((a, b) => b.score - a.score);
  const primary = ranked[0]!;
  const secondary = ranked
    .filter((entry) => entry.name !== primary.name && entry.score >= 3)
    .slice(0, 2)
    .map((entry) => entry.name);

  const byName: Record<ReviewProfileName, Omit<ReviewProfile, "primary" | "secondary" | "rationale">> = {
    "general-quality": {
      focusAreas: buildFocusAreas(paths, ["Correctness under real usage", "Regression risk", "Code quality and maintainability"]),
      failureModes: [
        "Partial implementations that look complete but leave core behavior stubbed",
        "Missing validation, tests, or evidence for blocking criteria",
        "Code that technically works but introduces obvious maintainability debt",
      ],
      evidencePriorities: [
        "Run or inspect the most relevant validation commands",
        "Trace the dominant code path end to end",
        "Call out unverified assumptions explicitly instead of hand-waving them",
      ],
      severityBias: "Bias toward FAIL when behavior is only implied rather than demonstrated.",
    },
    "ui-polish": {
      focusAreas: buildFocusAreas(paths, ["Primary interaction flow", "Responsive layout", "Accessibility and clarity of actions"]),
      failureModes: [
        "Broken or unintuitive interaction flow, especially onboarding, drawers, and primary actions",
        "Visual regressions, overflow, spacing collapse, or inaccessible controls",
        "Interfaces that technically render but feel unfinished or confusing in use",
      ],
      evidencePriorities: [
        "Navigate the affected UI and describe what users can and cannot do",
        "Verify mobile-width and edge-state behavior, not just the happy path",
      ],
      severityBias: "Treat usability breaks and visually misleading states as blocking defects, not polish nits.",
    },
    "workflow-fsm": {
      focusAreas: buildFocusAreas(paths, ["State transitions", "Retry semantics", "Lifecycle invariants", "Counter reset behavior"]),
      failureModes: [
        "Illegal transitions that bypass approval, review, or terminal-state rules",
        "Retry and checkpoint flows that jump to the wrong phase or double-increment counters",
        "State cleanup/reset bugs that leave stale error, checkpoint, or lifecycle metadata behind",
      ],
      evidencePriorities: [
        "Trace the exact state path for the critical scenario, including failure paths",
        "Verify counters and lifecycle fields are reset or preserved intentionally",
        "Treat ambiguous transition behavior as a defect until proven safe",
      ],
      severityBias: "Any lifecycle inconsistency that can misroute an issue or bypass a gate is blocking.",
    },
    "integration-safety": {
      focusAreas: buildFocusAreas(paths, ["Git/worktree operations", "Persistence side effects", "Idempotency and cleanup"]),
      failureModes: [
        "Destructive workspace behavior that can delete user work or dirty target branches",
        "Cross-system drift between runtime state, resources, and filesystem artifacts",
        "Merge/push/service-management flows that work only in the happy path and break under dirty state",
      ],
      evidencePriorities: [
        "Verify failure handling, not just success path behavior",
        "Check idempotency and cleanup paths explicitly",
        "Call out any command or filesystem side effect that is not safely guarded",
      ],
      severityBias: "Prefer FAIL when integration code assumes a clean environment or safe side effects without enforcing them.",
    },
    "api-contract": {
      focusAreas: buildFocusAreas(paths, ["Route handlers", "Resource schema", "Input/output contract"]),
      failureModes: [
        "HTTP/API behavior that no longer matches route or resource contract",
        "Schema drift between persisted fields, normalization, and route responses",
        "Missing validation or status-code mismatches that break downstream callers",
      ],
      evidencePriorities: [
        "Read the route/resource code and trace request-to-response behavior",
        "Verify persisted fields, normalization, and response shape stay aligned",
        "Treat silent contract drift as blocking even if the implementation compiles",
      ],
      severityBias: "Contract drift is blocking because it breaks automation and downstream clients silently.",
    },
    "security-hardening": {
      focusAreas: buildFocusAreas(paths, ["Authorization boundaries", "Secret handling", "Shell/command safety"]),
      failureModes: [
        "Authorization bypass, over-broad permissions, or unsafe defaults",
        "Leaked secrets, credentials, or unsafe command composition",
        "Security-sensitive criteria marked as effectively optional or unverified",
      ],
      evidencePriorities: [
        "Look for privilege escalation and shell/filepath injection opportunities",
        "Verify security checks with concrete evidence, not inference alone",
        "Escalate uncertainty instead of allowing a soft PASS on security-sensitive paths",
      ],
      severityBias: "Security uncertainty should fail closed; do not grant benefit of the doubt.",
    },
  };

  return {
    primary: primary.name,
    secondary,
    rationale: primary.rationale.length ? primary.rationale : ["Selected as the highest-risk profile based on touched code and acceptance criteria."],
    ...byName[primary.name],
  };
}
