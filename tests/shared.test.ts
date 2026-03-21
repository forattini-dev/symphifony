/**
 * Tests for src/agent/adapters/shared.ts — plan rendering and payload building.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPlanContextSection,
  buildStepsSection,
  buildRiskSection,
  buildValidationSection,
  buildToolingSection,
  buildStrategySection,
  buildFullPlanPrompt,
  resolveEffortForProvider,
  extractValidationCommands,
  buildExecutionPayload,
} from "../src/agents/adapters/shared.ts";
import type { IssuePlan, IssueEntry, AgentProviderDefinition } from "../src/types.ts";

// ── Shared fixtures ───────────────────────────────────────────────────────────

function makePlan(overrides: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "Implement JWT authentication",
    estimatedComplexity: "medium",
    steps: [
      { step: 1, action: "Create auth middleware", files: ["src/auth.ts"], ownerType: "agent", doneWhen: "middleware returns 401 for invalid tokens" },
      { step: 2, action: "Add JWT validation", files: ["src/middleware.ts"] },
    ],
    suggestedPaths: ["src/auth.ts", "src/middleware.ts"],
    suggestedLabels: ["auth", "backend"],
    suggestedEffort: { executor: "medium" },
    provider: "claude",
    createdAt: "2026-03-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  return {
    id: "test-123",
    identifier: "TST-1",
    title: "Add JWT authentication",
    description: "Implement JWT-based auth in the API",
    state: "PendingApproval",
    labels: ["auth", "backend"],
    paths: ["src/auth.ts"],
    blockedBy: [],
    assignedToWorker: false,
    createdAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:00:00.000Z",
    history: [],
    attempts: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

function makeProvider(overrides: Partial<AgentProviderDefinition> = {}): AgentProviderDefinition {
  return {
    provider: "claude",
    role: "executor",
    command: "",
    model: "claude-sonnet-4-6",
    profile: "",
    profilePath: "",
    profileInstructions: "",
    reasoningEffort: "medium",
    ...overrides,
  };
}

// ── buildPlanContextSection() ─────────────────────────────────────────────────

describe("buildPlanContextSection", () => {
  it("includes the summary", () => {
    const result = buildPlanContextSection(makePlan());
    assert.ok(result.includes("Implement JWT authentication"), "has summary");
  });

  it("includes the Plan Context header", () => {
    const result = buildPlanContextSection(makePlan());
    assert.ok(result.includes("## Plan Context"), "has header");
  });

  it("renders assumptions when present", () => {
    const plan = makePlan({ assumptions: ["Token expiry is 1h", "RS256 algorithm"] });
    const result = buildPlanContextSection(plan);
    assert.ok(result.includes("**Assumptions:**"), "has assumptions header");
    assert.ok(result.includes("Token expiry is 1h"), "has first assumption");
    assert.ok(result.includes("RS256 algorithm"), "has second assumption");
  });

  it("renders constraints when present", () => {
    const plan = makePlan({ constraints: ["No breaking API changes"] });
    const result = buildPlanContextSection(plan);
    assert.ok(result.includes("**Constraints:**"), "has constraints header");
    assert.ok(result.includes("No breaking API changes"), "has constraint");
  });

  it("renders unknowns with details", () => {
    const plan = makePlan({
      unknowns: [{ question: "Which JWT library?", whyItMatters: "Performance", howToResolve: "Benchmark" }],
    });
    const result = buildPlanContextSection(plan);
    assert.ok(result.includes("Which JWT library?"), "has question");
    assert.ok(result.includes("Performance"), "has whyItMatters");
    assert.ok(result.includes("Benchmark"), "has howToResolve");
  });

  it("omits sections when not present", () => {
    const plan = makePlan({ assumptions: undefined, constraints: undefined });
    const result = buildPlanContextSection(plan);
    assert.ok(!result.includes("**Assumptions:**"), "no assumptions header");
    assert.ok(!result.includes("**Constraints:**"), "no constraints header");
  });
});

// ── buildStepsSection() ───────────────────────────────────────────────────────

describe("buildStepsSection", () => {
  it("includes Execution Steps header", () => {
    const result = buildStepsSection(makePlan());
    assert.ok(result.includes("## Execution Steps"), "has header");
  });

  it("renders flat steps correctly", () => {
    const result = buildStepsSection(makePlan());
    assert.ok(result.includes("1. **Create auth middleware**"), "has step 1");
    assert.ok(result.includes("2. **Add JWT validation**"), "has step 2");
  });

  it("renders ownerType when present", () => {
    const result = buildStepsSection(makePlan());
    assert.ok(result.includes("[agent]"), "has ownerType");
  });

  it("renders doneWhen when present", () => {
    const result = buildStepsSection(makePlan());
    assert.ok(result.includes("middleware returns 401 for invalid tokens"), "has doneWhen");
  });

  it("renders files when present", () => {
    const result = buildStepsSection(makePlan());
    assert.ok(result.includes("src/auth.ts"), "has file from step 1");
  });

  it("ends with follow-this-plan instruction", () => {
    const result = buildStepsSection(makePlan());
    assert.ok(result.includes("Follow this plan"), "has follow instruction");
  });

  it("renders phases when present (ignores flat steps)", () => {
    const plan = makePlan({
      phases: [{
        phaseName: "Setup",
        goal: "Initialize auth infrastructure",
        tasks: [{ step: 1, action: "Install jsonwebtoken", ownerType: "agent" }],
        outputs: ["package.json updated"],
      }],
    });
    const result = buildStepsSection(plan);
    assert.ok(result.includes("### Phase: Setup"), "has phase header");
    assert.ok(result.includes("Initialize auth infrastructure"), "has phase goal");
    assert.ok(result.includes("Install jsonwebtoken"), "has task");
    assert.ok(result.includes("package.json updated"), "has outputs");
  });

  it("renders phase dependencies when present", () => {
    const plan = makePlan({
      phases: [{
        phaseName: "Implementation",
        goal: "Write code",
        tasks: [{ step: 1, action: "Write middleware" }],
        dependencies: ["Setup"],
      }],
    });
    const result = buildStepsSection(plan);
    assert.ok(result.includes("Dependencies: Setup"), "has dependency");
  });
});

// ── buildRiskSection() ────────────────────────────────────────────────────────

describe("buildRiskSection", () => {
  it("returns empty string when no risks", () => {
    assert.equal(buildRiskSection(makePlan()), "");
  });

  it("renders risks with impact and mitigation", () => {
    const plan = makePlan({
      risks: [{ risk: "Token leakage", impact: "high", mitigation: "Use HTTPS only" }],
    });
    const result = buildRiskSection(plan);
    assert.ok(result.includes("## Risks"), "has header");
    assert.ok(result.includes("Token leakage"), "has risk");
    assert.ok(result.includes("high"), "has impact");
    assert.ok(result.includes("Use HTTPS only"), "has mitigation");
  });
});

// ── buildValidationSection() ──────────────────────────────────────────────────

describe("buildValidationSection", () => {
  it("returns empty string when nothing to validate", () => {
    assert.equal(buildValidationSection(makePlan()), "");
  });

  it("renders success criteria", () => {
    const plan = makePlan({ successCriteria: ["All tokens validate correctly"] });
    const result = buildValidationSection(plan);
    assert.ok(result.includes("## Success Criteria"), "has header");
    assert.ok(result.includes("All tokens validate correctly"), "has criterion");
  });

  it("renders validation checks", () => {
    const plan = makePlan({ validation: ["pnpm test", "pnpm typecheck"] });
    const result = buildValidationSection(plan);
    assert.ok(result.includes("## Validation Checks"), "has header");
    assert.ok(result.includes("pnpm test"), "has test command");
  });

  it("renders deliverables", () => {
    const plan = makePlan({ deliverables: ["auth.ts implemented and tested"] });
    const result = buildValidationSection(plan);
    assert.ok(result.includes("## Deliverables"), "has header");
    assert.ok(result.includes("auth.ts implemented and tested"), "has deliverable");
  });
});

// ── buildToolingSection() ─────────────────────────────────────────────────────

describe("buildToolingSection", () => {
  it("returns empty string when no toolingDecision", () => {
    assert.equal(buildToolingSection(makePlan()), "");
  });

  it("renders skills when shouldUseSkills is true", () => {
    const plan = makePlan({
      toolingDecision: {
        shouldUseSkills: true,
        skillsToUse: [{ name: "testing", why: "Ensure coverage" }],
        shouldUseSubagents: false,
        subagentsToUse: [],
        decisionSummary: "Use testing skill for this task.",
      },
    });
    const result = buildToolingSection(plan);
    assert.ok(result.includes("## Tooling"), "has header");
    assert.ok(result.includes("testing"), "has skill name");
    assert.ok(result.includes("Ensure coverage"), "has why");
  });

  it("renders subagents when shouldUseSubagents is true", () => {
    const plan = makePlan({
      toolingDecision: {
        shouldUseSkills: false,
        skillsToUse: [],
        shouldUseSubagents: true,
        subagentsToUse: [{ name: "code-reviewer", role: "reviewer", why: "Critical review" }],
        decisionSummary: "Delegate review.",
      },
    });
    const result = buildToolingSection(plan);
    assert.ok(result.includes("code-reviewer"), "has subagent name");
    assert.ok(result.includes("reviewer"), "has role");
  });
});

// ── buildStrategySection() ────────────────────────────────────────────────────

describe("buildStrategySection", () => {
  it("returns empty string when no executionStrategy", () => {
    assert.equal(buildStrategySection(makePlan()), "");
  });

  it("renders approach and rationale", () => {
    const plan = makePlan({
      executionStrategy: {
        approach: "Incremental implementation",
        whyThisApproach: "Reduces risk of breaking changes",
        alternativesConsidered: ["Big bang rewrite"],
      },
    });
    const result = buildStrategySection(plan);
    assert.ok(result.includes("## Execution Strategy"), "has header");
    assert.ok(result.includes("Incremental implementation"), "has approach");
    assert.ok(result.includes("Reduces risk"), "has rationale");
    assert.ok(result.includes("Big bang rewrite"), "has alternative");
  });
});

// ── buildFullPlanPrompt() ─────────────────────────────────────────────────────

describe("buildFullPlanPrompt", () => {
  it("combines all sections into one string", () => {
    const plan = makePlan({
      assumptions: ["Token expiry 1h"],
      risks: [{ risk: "Leak", impact: "high", mitigation: "HTTPS" }],
      successCriteria: ["Tests pass"],
    });
    const result = buildFullPlanPrompt(plan);
    assert.ok(result.includes("## Plan Context"), "has context");
    assert.ok(result.includes("## Execution Steps"), "has steps");
    assert.ok(result.includes("## Risks"), "has risks");
    assert.ok(result.includes("## Success Criteria"), "has validation");
  });

  it("omits empty sections (no double blank lines for missing sections)", () => {
    const result = buildFullPlanPrompt(makePlan());
    // No risks section since makePlan has no risks
    assert.ok(!result.includes("## Risks"), "no risks section");
  });

  it("is non-empty for a minimal plan", () => {
    const result = buildFullPlanPrompt(makePlan());
    assert.ok(result.length > 50, "has substantial content");
  });
});

// ── resolveEffortForProvider() ────────────────────────────────────────────────

describe("resolveEffortForProvider", () => {
  it("returns plan role-specific effort when set", () => {
    const plan = makePlan({ suggestedEffort: { executor: "high", default: "low" } });
    assert.equal(resolveEffortForProvider(plan, "executor"), "high");
  });

  it("falls back to plan default effort when role not set", () => {
    const plan = makePlan({ suggestedEffort: { default: "medium" } });
    assert.equal(resolveEffortForProvider(plan, "executor"), "medium");
  });

  it("uses globalEffort role-specific when plan has no suggestion", () => {
    const plan = makePlan({ suggestedEffort: {} });
    assert.equal(resolveEffortForProvider(plan, "executor", { executor: "low" }), "low");
  });

  it("uses globalEffort default as last fallback", () => {
    const plan = makePlan({ suggestedEffort: {} });
    assert.equal(resolveEffortForProvider(plan, "executor", { default: "medium" }), "medium");
  });

  it("returns undefined when nothing is configured", () => {
    const plan = makePlan({ suggestedEffort: {} });
    assert.equal(resolveEffortForProvider(plan, "executor"), undefined);
  });

  it("handles undefined plan gracefully", () => {
    assert.equal(resolveEffortForProvider(undefined, "executor", { default: "low" }), "low");
  });

  it("plan effort takes priority over globalEffort", () => {
    const plan = makePlan({ suggestedEffort: { executor: "high" } });
    assert.equal(resolveEffortForProvider(plan, "executor", { executor: "low" }), "high");
  });
});

// ── extractValidationCommands() ───────────────────────────────────────────────

describe("extractValidationCommands", () => {
  it("returns empty pre/post for empty validation", () => {
    const result = extractValidationCommands(makePlan({ validation: [] }));
    assert.deepEqual(result.pre, []);
    assert.deepEqual(result.post, []);
  });

  it("adds lint command to post hooks when validation mentions lint", () => {
    const result = extractValidationCommands(makePlan({ validation: ["run pnpm lint"] }));
    assert.ok(result.post.some((cmd) => cmd.includes("lint")), "has lint in post");
    assert.deepEqual(result.pre, []);
  });

  it("adds typecheck command to post hooks", () => {
    const result = extractValidationCommands(makePlan({ validation: ["run typecheck"] }));
    assert.ok(result.post.some((cmd) => cmd.includes("tsc")), "has tsc in post");
  });

  it("adds tsc keyword trigger", () => {
    const result = extractValidationCommands(makePlan({ validation: ["tsc --noEmit"] }));
    assert.ok(result.post.some((cmd) => cmd.includes("tsc")), "has tsc in post");
  });

  it("adds test command to post hooks", () => {
    const result = extractValidationCommands(makePlan({ validation: ["run the test suite"] }));
    assert.ok(result.post.some((cmd) => cmd.includes("test")), "has test in post");
  });

  it("deduplicates identical commands", () => {
    const result = extractValidationCommands(makePlan({
      validation: ["run typecheck", "run tsc check"],
    }));
    const tscCmds = result.post.filter((cmd) => cmd.includes("tsc"));
    assert.equal(tscCmds.length, 1, "deduplicated");
  });

  it("multiple keywords produce multiple distinct commands", () => {
    const result = extractValidationCommands(makePlan({
      validation: ["run lint and test"],
    }));
    assert.ok(result.post.length >= 2, "both lint and test commands");
  });
});

// ── buildExecutionPayload() ───────────────────────────────────────────────────

describe("buildExecutionPayload", () => {
  it("returns version 1 payload", () => {
    const payload = buildExecutionPayload(makeIssue(), makeProvider(), makePlan(), "/workspace");
    assert.equal(payload.version, 1);
  });

  it("populates issue fields correctly", () => {
    const payload = buildExecutionPayload(makeIssue(), makeProvider(), makePlan(), "/workspace");
    assert.equal(payload.issue.id, "test-123");
    assert.equal(payload.issue.identifier, "TST-1");
    assert.equal(payload.issue.title, "Add JWT authentication");
  });

  it("populates provider fields correctly", () => {
    const provider = makeProvider({ provider: "codex", role: "executor", model: "o4-mini", reasoningEffort: "high" });
    const payload = buildExecutionPayload(makeIssue(), provider, makePlan(), "/workspace");
    assert.equal(payload.provider.name, "codex");
    assert.equal(payload.provider.role, "executor");
    assert.equal(payload.provider.model, "o4-mini");
    assert.equal(payload.provider.effort, "high");
  });

  it("sets workPattern to sequential for flat steps", () => {
    const payload = buildExecutionPayload(makeIssue(), makeProvider(), makePlan(), "/workspace");
    assert.equal(payload.executionIntent.workPattern, "sequential");
  });

  it("sets workPattern to phased when plan has phases", () => {
    const plan = makePlan({
      phases: [{ phaseName: "P1", goal: "G1", tasks: [{ step: 1, action: "A1" }] }],
    });
    const payload = buildExecutionPayload(makeIssue(), makeProvider(), plan, "/workspace");
    assert.equal(payload.executionIntent.workPattern, "phased");
  });

  it("sets workPattern to parallel_subtasks when using subagents (no phases)", () => {
    const plan = makePlan({
      toolingDecision: {
        shouldUseSkills: false,
        skillsToUse: [],
        shouldUseSubagents: true,
        subagentsToUse: [{ name: "sub", role: "executor", why: "parallel" }],
        decisionSummary: "Use subagents",
      },
    });
    const payload = buildExecutionPayload(makeIssue(), makeProvider(), plan, "/workspace");
    assert.equal(payload.executionIntent.workPattern, "parallel_subtasks");
  });

  it("maps plan steps into payload", () => {
    const payload = buildExecutionPayload(makeIssue(), makeProvider(), makePlan(), "/workspace");
    assert.equal(payload.plan.steps.length, 2);
    assert.equal(payload.plan.steps[0].action, "Create auth middleware");
    assert.deepEqual(payload.plan.steps[0].files, ["src/auth.ts"]);
  });

  it("maps plan phases into payload", () => {
    const plan = makePlan({
      phases: [{
        phaseName: "Setup",
        goal: "Initialize",
        tasks: [{ step: 1, action: "Install deps" }],
        dependencies: ["nothing"],
        outputs: ["package.json"],
      }],
    });
    const payload = buildExecutionPayload(makeIssue(), makeProvider(), plan, "/workspace");
    assert.equal(payload.plan.phases.length, 1);
    assert.equal(payload.plan.phases[0].name, "Setup");
    assert.deepEqual(payload.plan.phases[0].dependencies, ["nothing"]);
  });

  it("populates constraints, successCriteria, validation", () => {
    const plan = makePlan({
      constraints: ["No breaking changes"],
      successCriteria: ["Tests pass"],
      validation: ["pnpm test"],
    });
    const payload = buildExecutionPayload(makeIssue(), makeProvider(), plan, "/workspace");
    assert.deepEqual(payload.constraints, ["No breaking changes"]);
    assert.deepEqual(payload.successCriteria, ["Tests pass"]);
    assert.deepEqual(payload.validation, ["pnpm test"]);
  });

  it("sets workspacePath correctly", () => {
    const payload = buildExecutionPayload(makeIssue(), makeProvider(), makePlan(), "/my/workspace");
    assert.equal(payload.workspacePath, "/my/workspace");
  });

  it("has a valid createdAt ISO timestamp", () => {
    const payload = buildExecutionPayload(makeIssue(), makeProvider(), makePlan(), "/workspace");
    assert.ok(!Number.isNaN(Date.parse(payload.createdAt)), "valid ISO date");
  });

  it("uses 'medium' as default effort when provider has none", () => {
    const provider = makeProvider({ reasoningEffort: undefined });
    const payload = buildExecutionPayload(makeIssue(), provider, makePlan(), "/workspace");
    assert.equal(payload.provider.effort, "medium");
  });

  it("uses 'default' as model when provider has no model", () => {
    const provider = makeProvider({ model: undefined });
    const payload = buildExecutionPayload(makeIssue(), provider, makePlan(), "/workspace");
    assert.equal(payload.provider.model, "default");
  });
});
