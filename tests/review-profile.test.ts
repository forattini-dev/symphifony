import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveReviewProfile } from "../src/agents/review-profile.ts";
import { compileReview } from "../src/agents/adapters/index.ts";
import type { AgentProviderDefinition, IssueEntry, IssuePlan, RuntimeConfig } from "../src/types.ts";

const BASE_CONFIG: RuntimeConfig = {
  pollIntervalMs: 5000,
  workerConcurrency: 1,
  maxConcurrentByState: {},
  commandTimeoutMs: 60_000,
  maxAttemptsDefault: 3,
  maxTurns: 10,
  retryDelayMs: 1000,
  staleInProgressTimeoutMs: 300_000,
  logLinesTail: 100,
  maxPreviousOutputChars: 4000,
  agentProvider: "claude",
  agentCommand: "",
  defaultEffort: { default: "medium" },
  runMode: "filesystem",
  autoReviewApproval: true,
  afterCreateHook: "",
  beforeRunHook: "",
  afterRunHook: "",
  beforeRemoveHook: "",
  dockerExecution: false,
  dockerImage: "",
};

function makePlan(overrides: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "Review profile fixture",
    estimatedComplexity: "medium",
    harnessMode: "standard",
    steps: [{ step: 1, action: "Implement change" }],
    acceptanceCriteria: [
      {
        id: "AC-1",
        description: "Core behavior works",
        category: "functionality",
        verificationMethod: "code_inspection",
        evidenceExpected: "Implementation traces cleanly",
        blocking: true,
        weight: 3,
      },
    ],
    executionContract: {
      summary: "Fixture contract",
      deliverables: ["working code"],
      requiredChecks: [],
      requiredEvidence: [],
      focusAreas: [],
      checkpointPolicy: "final_only",
    },
    suggestedPaths: ["src/index.ts"],
    suggestedSkills: [],
    suggestedAgents: [],
    suggestedEffort: { default: "medium", reviewer: "medium" },
    provider: "claude",
    createdAt: "2026-03-26T00:00:00.000Z",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  return {
    id: "review-profile-1",
    identifier: "#RP-1",
    title: "Review profile issue",
    description: "General issue",
    state: "Reviewing",
    labels: [],
    blockedBy: [],
    assignedToWorker: true,
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z",
    history: [],
    attempts: 0,
    maxAttempts: 3,
    planVersion: 1,
    executeAttempt: 1,
    reviewAttempt: 0,
    plan: makePlan(),
    ...overrides,
  };
}

function makeReviewer(overrides: Partial<AgentProviderDefinition> = {}): AgentProviderDefinition {
  return {
    provider: "claude",
    role: "reviewer",
    command: "",
    model: "claude-opus-4-6",
    profile: "",
    profilePath: "",
    profileInstructions: "",
    reasoningEffort: "medium",
    ...overrides,
  };
}

describe("deriveReviewProfile", () => {
  it("selects ui-polish for frontend-heavy issues", () => {
    const issue = makeIssue({
      issueType: "feature",
      labels: ["frontend", "ux"],
      title: "Polish onboarding drawer",
      plan: makePlan({
        acceptanceCriteria: [
          {
            id: "AC-1",
            description: "Drawer is responsive and visually coherent",
            category: "design",
            verificationMethod: "ui_walkthrough",
            evidenceExpected: "Drawer works at mobile width",
            blocking: true,
            weight: 3,
          },
        ],
        suggestedPaths: ["app/src/components/OnboardingDrawer.tsx", "app/src/components/OnboardingDrawer.css"],
      }),
    });

    const profile = deriveReviewProfile(issue);
    assert.equal(profile.primary, "ui-polish");
    assert.ok(profile.failureModes.some((entry) => entry.includes("onboarding")));
  });

  it("selects workflow-fsm for orchestration changes", () => {
    const issue = makeIssue({
      title: "Fix checkpoint lifecycle",
      labels: ["workflow", "fsm"],
      plan: makePlan({
        harnessMode: "contractual",
        suggestedPaths: ["src/persistence/plugins/fsm-agent.ts", "src/commands/retry-issue.command.ts"],
      }),
    });

    const profile = deriveReviewProfile(issue);
    assert.equal(profile.primary, "workflow-fsm");
    assert.ok(profile.secondary.includes("integration-safety") || profile.primary === "workflow-fsm");
  });

  it("selects api-contract for route/resource changes", () => {
    const issue = makeIssue({
      title: "Adjust issue state API response",
      labels: ["api", "backend"],
      plan: makePlan({
        acceptanceCriteria: [
          {
            id: "AC-1",
            description: "Response contract remains stable",
            category: "integration",
            verificationMethod: "api_probe",
            evidenceExpected: "API returns expected shape and status",
            blocking: true,
            weight: 3,
          },
        ],
        suggestedPaths: ["src/routes/state.ts", "src/persistence/resources/issues.resource.ts"],
      }),
    });

    const profile = deriveReviewProfile(issue);
    assert.equal(profile.primary, "api-contract");
  });
});

describe("compileReview review profile integration", () => {
  it("embeds the selected review profile in the compiled prompt", async () => {
    const issue = makeIssue({
      title: "Harden merge safety in workspace integration",
      labels: ["integration", "git"],
      plan: makePlan({
        acceptanceCriteria: [
          {
            id: "AC-1",
            description: "Dirty target branches are rejected safely",
            category: "integration",
            verificationMethod: "code_inspection",
            evidenceExpected: "Merge path refuses dirty target branch",
            blocking: true,
            weight: 3,
          },
        ],
        suggestedPaths: ["src/commands/merge-workspace.command.ts", "src/domains/workspace.ts"],
      }),
    });

    const compiled = await compileReview(issue, makeReviewer(), "/tmp/workspace", "merge-workspace.command.ts changed", BASE_CONFIG);

    assert.equal(compiled.meta.scope, "final");
    assert.equal(compiled.meta.reviewProfile.primary, "integration-safety");
    assert.ok(compiled.prompt.includes("Current review scope: **final review** (`final`)"));
    assert.ok(compiled.prompt.includes("Provider: claude / claude-opus-4-6 / effort medium"));
    assert.ok(compiled.prompt.includes("Primary profile: **integration-safety**"));
    assert.ok(compiled.prompt.includes("\"blockingVerdict\": \"FAIL\""));
    assert.ok(compiled.prompt.includes("Failure modes to probe aggressively"));
    assert.ok(compiled.prompt.includes("Git/worktree operations"));
  });

  it("renders checkpoint-specific review instructions", async () => {
    const compiled = await compileReview(
      makeIssue({ plan: makePlan({ harnessMode: "contractual" }) }),
      makeReviewer(),
      "/tmp/workspace",
      "src/persistence/plugins/fsm-agent.ts changed",
      BASE_CONFIG,
      "checkpoint",
    );

    assert.equal(compiled.meta.scope, "checkpoint");
    assert.ok(compiled.prompt.includes("Current review scope: **checkpoint gate** (`checkpoint`)"));
    assert.ok(compiled.prompt.includes("checkpoint gate passes when blockingVerdict is PASS"));
  });
});
