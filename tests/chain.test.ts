/**
 * Full compilation chain tests — NO API calls, NO CLI execution.
 *
 * Tests the end-to-end compilation pipeline:
 *   title + description
 *     → enhance (capability resolution)
 *     → plan (mocked IssuePlan object)
 *     → compile execution (prompt + command string)
 *     → compile review (prompt + command string)
 *
 * Claude and Codex chains are tested independently to ensure
 * each provider gets the correct flags and prompt structure.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTaskCapabilities } from "../src/routing/capability-resolver.ts";
import { compileExecution, compileReview } from "../src/agents/adapters/index.ts";
import type {
  IssueEntry,
  IssuePlan,
  AgentProviderDefinition,
  RuntimeConfig,
} from "../src/types.ts";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const WORKSPACE = "/tmp/test-workspace";

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
  agentProvider: "claude",
  agentCommand: "",
  defaultEffort: { default: "medium" },
  runMode: "filesystem",
};

function makeIssue(title: string, description: string, extra: Partial<IssueEntry> = {}): IssueEntry {
  return {
    id: "chain-test-001",
    identifier: "CT-1",
    title,
    description,
    state: "PendingApproval",
    labels: [],
    paths: [],
    blockedBy: [],
    assignedToWorker: false,
    createdAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:00:00.000Z",
    history: [],
    attempts: 0,
    maxAttempts: 3,
    ...extra,
  };
}

function makePlan(overrides: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "Test plan summary",
    estimatedComplexity: "medium",
    steps: [
      { step: 1, action: "Analyze requirements", files: ["src/index.ts"], ownerType: "agent" },
      { step: 2, action: "Implement changes", files: ["src/core.ts"], ownerType: "agent" },
      { step: 3, action: "Write tests", files: ["tests/core.test.ts"], ownerType: "agent" },
    ],
    successCriteria: ["All tests pass", "No TypeScript errors"],
    validation: ["pnpm typecheck", "pnpm test"],
    suggestedPaths: ["src/index.ts", "src/core.ts"],
    suggestedLabels: ["backend"],
    suggestedEffort: { executor: "medium", reviewer: "low" },
    provider: "claude",
    createdAt: "2026-03-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeProvider(overrides: Partial<AgentProviderDefinition>): AgentProviderDefinition {
  return {
    provider: "claude",
    role: "executor",
    command: "",
    model: undefined,
    profile: "",
    profilePath: "",
    profileInstructions: "",
    ...overrides,
  };
}

// ── Claude chain ──────────────────────────────────────────────────────────────

describe("claude chain", () => {
  const title = "Add JWT authentication to the REST API";
  const description = "Implement JWT token validation middleware for all protected endpoints";

  it("step 1 — enhance: resolves to 'security' category", () => {
    const issue = makeIssue(title, description);
    const resolution = resolveTaskCapabilities(issue);

    assert.equal(resolution.category, "security", "JWT auth maps to security category");
    assert.ok(resolution.providers.length > 0, "has provider suggestions");
    assert.ok(resolution.overlays.includes("security-review"), "has security overlay");
  });

  it("step 1 — enhance: recommends claude as planner", () => {
    const issue = makeIssue(title, description);
    const resolution = resolveTaskCapabilities(issue);
    const planner = resolution.providers.find((p) => p.role === "planner");
    assert.equal(planner?.provider, "claude", "claude is planner for security tasks");
  });

  it("step 1 — enhance: recommends codex as executor", () => {
    const issue = makeIssue(title, description);
    const resolution = resolveTaskCapabilities(issue);
    const executor = resolution.providers.find((p) => p.role === "executor");
    assert.equal(executor?.provider, "codex", "codex is executor for security tasks");
  });

  it("step 2 — plan: IssuePlan contains required fields", () => {
    const plan = makePlan({
      summary: "Implement JWT auth middleware with RS256 validation",
      estimatedComplexity: "medium",
      assumptions: ["RS256 keys are managed externally"],
      constraints: ["No breaking API changes"],
      successCriteria: ["All protected endpoints return 401 for invalid tokens"],
      validation: ["pnpm typecheck", "pnpm test"],
    });

    assert.ok(plan.summary.length > 0, "has summary");
    assert.equal(plan.steps.length, 3, "has 3 steps");
    assert.ok(plan.successCriteria?.length, "has success criteria");
    assert.ok(plan.validation?.length, "has validation commands");
  });

  it("step 3 — compile execution for claude: produces valid command", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({
      provider: "claude",
      role: "executor",
      model: "claude-sonnet-4-6",
    });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(result!.command.startsWith("claude "), "command starts with 'claude'");
    assert.ok(result!.command.includes("--print"), "has --print flag");
    assert.ok(result!.command.includes("--output-format json"), "has json output flag");
    assert.ok(result!.command.includes("--dangerously-skip-permissions"), "has tool-access flag");
    assert.ok(result!.command.includes("--no-session-persistence"), "has session flag");
  });

  it("step 3 — compile execution for claude: model is injected into command", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({
      provider: "claude",
      role: "executor",
      model: "claude-opus-4-6",
    });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(result!.command.includes("claude-opus-4-6"), "model in command");
  });

  it("step 3 — compile execution for claude: model is NOT present when not configured", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({
      provider: "claude",
      role: "executor",
      model: undefined,
    });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(!result!.command.includes("--model"), "no --model flag when not configured");
  });

  it("step 3 — compile execution for claude: adapter meta is correct", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({ provider: "claude", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.equal(result!.meta.adapter, "claude", "adapter is claude");
    assert.ok(result!.meta.phasesCount === 0, "no phases in flat plan");
  });

  it("step 3 — compile execution for claude: prompt references the issue title", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({ provider: "claude", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(result!.prompt.includes(title), "prompt contains issue title");
  });

  it("step 3 — compile execution for claude: payload is populated", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({ provider: "claude", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(result!.payload !== null, "has execution payload");
    assert.equal(result!.payload!.version, 1, "payload version is 1");
    assert.equal(result!.payload!.issue.identifier, "CT-1", "payload has issue identifier");
  });

  it("step 4 — compile review for claude: produces valid command", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const reviewer = makeProvider({
      provider: "claude",
      role: "reviewer",
      model: "claude-opus-4-6",
    });

    const result = await compileReview(issue, reviewer, WORKSPACE, "diff --git a/src/auth.ts ...");

    assert.ok(result.command.startsWith("claude "), "review command starts with 'claude'");
    assert.ok(result.command.includes("--print"), "has --print");
    assert.ok(result.command.includes("--json-schema"), "has json schema for structured output");
  });

  it("step 4 — compile review for claude: prompt includes diff summary", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const reviewer = makeProvider({ provider: "claude", role: "reviewer" });
    const diffSummary = "Modified src/auth.ts: added validateJwt() function";

    const result = await compileReview(issue, reviewer, WORKSPACE, diffSummary);

    assert.ok(result.prompt.includes(diffSummary), "review prompt includes diff summary");
  });

  it("full chain: compile execution then review for claude", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });

    const executor = makeProvider({ provider: "claude", role: "executor", model: "claude-sonnet-4-6" });
    const reviewer = makeProvider({ provider: "claude", role: "reviewer", model: "claude-opus-4-6" });

    const execResult = await compileExecution(issue, executor, BASE_CONFIG, WORKSPACE, "");
    const reviewResult = await compileReview(issue, reviewer, WORKSPACE, "3 files changed");

    assert.ok(execResult !== null, "execution compiled");
    assert.ok(execResult!.command.includes("claude-sonnet-4-6"), "executor uses sonnet");
    assert.ok(reviewResult.command.includes("claude-opus-4-6"), "reviewer uses opus");

    // Both should be valid claude commands
    assert.ok(execResult!.command.startsWith("claude "), "executor is claude");
    assert.ok(reviewResult.command.startsWith("claude "), "reviewer is claude");
  });
});

// ── Codex chain ───────────────────────────────────────────────────────────────

describe("codex chain", () => {
  const title = "Build a React dashboard for real-time metrics";
  const description = "Create a responsive dashboard with charts and live WebSocket data using React and Tailwind";

  it("step 1 — enhance: resolves to 'frontend-ui' category", () => {
    const issue = makeIssue(title, description);
    const resolution = resolveTaskCapabilities(issue);

    assert.equal(resolution.category, "frontend-ui", "React dashboard maps to frontend-ui");
    assert.ok(resolution.overlays.includes("impeccable"), "has impeccable overlay");
    assert.ok(resolution.overlays.includes("frontend-design"), "has frontend-design overlay");
  });

  it("step 1 — enhance: recommends codex as executor for frontend tasks", () => {
    const issue = makeIssue(title, description);
    const resolution = resolveTaskCapabilities(issue);
    const executor = resolution.providers.find((p) => p.role === "executor");
    assert.equal(executor?.provider, "codex", "codex executes frontend tasks");
  });

  it("step 2 — plan: IssuePlan with frontend paths", () => {
    const plan = makePlan({
      suggestedPaths: ["app/src/components/Dashboard.tsx", "app/src/hooks/useMetrics.ts"],
      suggestedEffort: { executor: "high" },
    });

    assert.ok(plan.suggestedPaths.some((p) => p.endsWith(".tsx")), "has TSX paths");
    assert.equal(plan.suggestedEffort.executor, "high", "high effort for complex UI");
  });

  it("step 3 — compile execution for codex: produces valid command", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({
      provider: "codex",
      role: "executor",
      model: "o4-mini",
      reasoningEffort: "high",
    });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(result!.command.startsWith("codex exec"), "command starts with 'codex exec'");
    assert.ok(result!.command.includes("--skip-git-repo-check"), "has skip-git-repo-check");
  });

  it("step 3 — compile execution for codex: effort priority 1 — plan.suggestedEffort", async () => {
    const plan = makePlan({ suggestedEffort: { executor: "high" } });
    const issue = makeIssue(title, description, { plan });
    const provider = makeProvider({ provider: "codex", role: "executor", model: "o4-mini", reasoningEffort: "low" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    // plan.suggestedEffort wins over provider.reasoningEffort and config.defaultEffort
    assert.ok(result!.command.includes(`reasoning_effort="high"`), "plan effort wins");
  });

  it("step 3 — compile execution for codex: effort priority 2 — config.defaultEffort", async () => {
    const plan = makePlan({ suggestedEffort: {} }); // no plan effort
    const issue = makeIssue(title, description, { plan });
    const provider = makeProvider({ provider: "codex", role: "executor", model: "o4-mini" });
    // BASE_CONFIG.defaultEffort = { default: "medium" } → wins over undefined provider.reasoningEffort

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(result!.command.includes(`reasoning_effort="medium"`), "config.defaultEffort wins");
  });

  it("step 3 — compile execution for codex: effort priority 3 — provider.reasoningEffort as final fallback", async () => {
    // After the fix: provider.reasoningEffort (WorkflowConfig.execute.effort) is the last resort
    const noEffortConfig = { ...BASE_CONFIG, defaultEffort: {} };
    const plan = makePlan({ suggestedEffort: {} });
    const issue = makeIssue(title, description, { plan });
    const provider = makeProvider({ provider: "codex", role: "executor", reasoningEffort: "high" });

    const result = await compileExecution(issue, provider, noEffortConfig, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    // provider.reasoningEffort = WorkflowConfig.execute.effort is now the final fallback
    assert.ok(result!.command.includes(`reasoning_effort="high"`), "WorkflowConfig effort reaches command");
  });

  it("step 3 — compile execution for codex: --reasoning-effort absent when nothing anywhere", async () => {
    const noEffortConfig = { ...BASE_CONFIG, defaultEffort: {} };
    const plan = makePlan({ suggestedEffort: {} });
    const issue = makeIssue(title, description, { plan });
    const provider = makeProvider({ provider: "codex", role: "executor", reasoningEffort: undefined });

    const result = await compileExecution(issue, provider, noEffortConfig, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(!result!.command.includes("reasoning_effort="), "no effort flag when truly nothing configured");
  });

  it("step 3 — compile execution for codex: --model is injected", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({
      provider: "codex",
      role: "executor",
      model: "o3-mini",
    });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(result!.command.includes("--model o3-mini"), "--model in command");
  });

  it("step 3 — compile execution for codex: --add-dir from suggestedPaths", async () => {
    const plan = makePlan({
      suggestedPaths: ["app/src/components/Dashboard.tsx", "app/src/hooks/useMetrics.ts"],
    });
    const issue = makeIssue(title, description, { plan });
    const provider = makeProvider({ provider: "codex", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(result!.command.includes("--add-dir"), "has --add-dir flags for suggested paths");
  });

  it("step 3 — compile execution for codex: adapter meta is correct", async () => {
    // meta.reasoningEffort reflects what resolveEffortForProvider returned (from plan/config),
    // not provider.reasoningEffort directly.
    const plan = makePlan({ suggestedEffort: { executor: "medium" } });
    const issue = makeIssue(title, description, { plan });
    const provider = makeProvider({ provider: "codex", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.equal(result!.meta.adapter, "codex", "adapter is codex");
    assert.equal(result!.meta.reasoningEffort, "medium", "effort in meta from plan");
  });

  it("step 3 — compile execution for codex: prompt references the issue title", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({ provider: "codex", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(result!.prompt.includes(title), "prompt contains issue title");
  });

  it("step 4 — compile review for codex: produces valid command with --reasoning-effort", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const reviewer = makeProvider({
      provider: "codex",
      role: "reviewer",
      model: "o4-mini",
      reasoningEffort: "medium",
    });

    const result = await compileReview(issue, reviewer, WORKSPACE, "5 files changed");

    assert.ok(result.command.startsWith("codex exec"), "review command is codex");
    assert.ok(result.command.includes(`reasoning_effort="medium"`), "has reasoning effort");
  });

  it("step 4 — compile review for codex: model in review command", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const reviewer = makeProvider({
      provider: "codex",
      role: "reviewer",
      model: "o3-mini",
      reasoningEffort: "low",
    });

    const result = await compileReview(issue, reviewer, WORKSPACE, "2 files changed");

    assert.ok(result.command.includes("--model o3-mini"), "model in review command");
  });

  it("step 4 — compile review for codex: prompt includes diff summary", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const reviewer = makeProvider({ provider: "codex", role: "reviewer" });
    const diffSummary = "Added Dashboard.tsx with recharts integration";

    const result = await compileReview(issue, reviewer, WORKSPACE, diffSummary);

    assert.ok(result.prompt.includes(diffSummary), "review prompt includes diff summary");
  });

  it("full chain: compile execution then review for codex", async () => {
    // Effort is resolved from plan.suggestedEffort, not provider.reasoningEffort.
    const plan = makePlan({ suggestedEffort: { executor: "high", reviewer: "low" } });
    const issue = makeIssue(title, description, { plan });

    const executor = makeProvider({ provider: "codex", role: "executor", model: "o4-mini" });
    const reviewer = makeProvider({ provider: "codex", role: "reviewer", model: "o3-mini", reasoningEffort: "low" });

    const execResult = await compileExecution(issue, executor, BASE_CONFIG, WORKSPACE, "");
    const reviewResult = await compileReview(issue, reviewer, WORKSPACE, "10 files changed");

    assert.ok(execResult !== null, "execution compiled");
    assert.ok(execResult!.command.includes(`reasoning_effort="high"`), "executor uses high effort from plan");
    assert.ok(reviewResult.command.includes("o3-mini"), "reviewer uses o3-mini");

    // Both should be valid codex commands
    assert.ok(execResult!.command.startsWith("codex exec"), "executor is codex");
    assert.ok(reviewResult.command.startsWith("codex exec"), "reviewer is codex");
  });
});

// ── Mixed chain: Claude planner → Codex executor → Claude reviewer ────────────

describe("mixed chain: claude-planner + codex-executor + claude-reviewer", () => {
  const title = "Refactor database query layer to use connection pooling";
  const description = "Replace direct DB calls with pooled connections for better performance";

  it("enhance: resolves to 'backend' category", () => {
    const issue = makeIssue(title, description);
    const resolution = resolveTaskCapabilities(issue);
    assert.equal(resolution.category, "backend", "DB refactor maps to backend");
  });

  it("compile execution for codex executor with backend plan", async () => {
    const plan = makePlan({
      suggestedPaths: ["src/db/pool.ts", "src/db/queries.ts"],
      suggestedEffort: { executor: "medium" },
    });
    const issue = makeIssue(title, description, { plan });
    const executor = makeProvider({
      provider: "codex",
      role: "executor",
      model: "o4-mini",
      reasoningEffort: "medium",
    });

    const result = await compileExecution(issue, executor, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compiled");
    assert.ok(result!.command.includes(`reasoning_effort="medium"`), "has effort");
    assert.ok(result!.command.includes("--add-dir"), "has add-dir for db paths");
  });

  it("compile review for claude reviewer after codex execution", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const reviewer = makeProvider({
      provider: "claude",
      role: "reviewer",
      model: "claude-opus-4-6",
    });

    const result = await compileReview(issue, reviewer, WORKSPACE, "src/db/pool.ts modified");

    assert.ok(result.command.startsWith("claude "), "reviewer uses claude");
    assert.ok(result.command.includes("claude-opus-4-6"), "uses opus model");
    assert.ok(!result.command.includes("reasoning_effort="), "no effort flag for claude");
  });

  it("execution and review commands are for different providers", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const executor = makeProvider({ provider: "codex", role: "executor", reasoningEffort: "medium" });
    const reviewer = makeProvider({ provider: "claude", role: "reviewer" });

    const execResult = await compileExecution(issue, executor, BASE_CONFIG, WORKSPACE, "");
    const reviewResult = await compileReview(issue, reviewer, WORKSPACE, "diff");

    assert.ok(execResult!.command.startsWith("codex exec"), "executor is codex");
    assert.ok(reviewResult.command.startsWith("claude "), "reviewer is claude");
  });
});


// ── Gemini chain ──────────────────────────────────────────────────────────────

describe("gemini chain", () => {
  const title = "Optimize database queries for the analytics dashboard";
  const description = "Profile and optimize slow queries in the PostgreSQL analytics pipeline";

  it("compile execution for gemini: produces valid command", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({
      provider: "gemini",
      role: "executor",
      model: "gemini-2.5-pro",
    });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result !== null, "compilation succeeded");
    assert.ok(result!.command.startsWith("gemini"), "command starts with 'gemini'");
    assert.ok(result!.command.includes("--yolo"), "has --yolo flag");
    assert.ok(result!.command.includes('-p ""'), "has headless -p flag");
  });

  it("compile execution for gemini: model is injected", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({ provider: "gemini", role: "executor", model: "gemini-2.5-pro" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result!.command.includes("--model gemini-2.5-pro"), "model in command");
  });

  it("compile execution for gemini: model is omitted when not configured", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({ provider: "gemini", role: "executor", model: undefined });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(!result!.command.includes("--model"), "no model flag");
  });

  it("compile execution for gemini: uses --include-directories (not --add-dir)", async () => {
    const plan = makePlan({ suggestedPaths: ["src/db/queries.ts"] });
    const issue = makeIssue(title, description, { plan });
    const provider = makeProvider({ provider: "gemini", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result!.command.includes("--include-directories"), "gemini uses --include-directories");
    assert.ok(!result!.command.includes("--add-dir"), "gemini does NOT use --add-dir");
  });

  it("compile execution for gemini: adapter meta is correct", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({ provider: "gemini", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.equal(result!.meta.adapter, "gemini");
    assert.equal(result!.meta.phasesCount, 0);
  });

  it("compile execution for gemini: prompt references the issue title", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({ provider: "gemini", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result!.prompt.includes(title), "prompt contains issue title");
  });

  it("compile execution for gemini: payload is populated", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const provider = makeProvider({ provider: "gemini", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

    assert.ok(result!.payload !== null, "has payload");
    assert.equal(result!.payload!.version, 1);
    assert.equal(result!.payload!.issue.identifier, "CT-1");
  });

  it("compile review for gemini: produces valid command with read-only mode", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const reviewer = makeProvider({ provider: "gemini", role: "reviewer", model: "gemini-2.0-flash" });

    const result = await compileReview(issue, reviewer, WORKSPACE, "optimized 3 queries");

    assert.ok(result.command.startsWith("gemini"), "review command starts with gemini");
    assert.ok(result.command.includes("--approval-mode plan"), "review uses read-only mode");
    assert.ok(!result.command.includes("--yolo"), "review should NOT use yolo");
  });

  it("compile review for gemini: prompt includes diff summary", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const reviewer = makeProvider({ provider: "gemini", role: "reviewer" });
    const diff = "Modified src/db/queries.ts: rewrote 3 slow queries";

    const result = await compileReview(issue, reviewer, WORKSPACE, diff);

    assert.ok(result.prompt.includes(diff), "review prompt includes diff");
  });

  it("full chain: compile execution then review for gemini", async () => {
    const issue = makeIssue(title, description, { plan: makePlan() });
    const executor = makeProvider({ provider: "gemini", role: "executor", model: "gemini-2.5-pro" });
    const reviewer = makeProvider({ provider: "gemini", role: "reviewer", model: "gemini-2.0-flash" });

    const execResult = await compileExecution(issue, executor, BASE_CONFIG, WORKSPACE, "");
    const reviewResult = await compileReview(issue, reviewer, WORKSPACE, "3 files changed");

    assert.ok(execResult!.command.includes("gemini-2.5-pro"), "executor uses 2.5-pro");
    assert.ok(reviewResult.command.includes("gemini-2.0-flash"), "reviewer uses 2.0-flash");
    assert.ok(execResult!.command.startsWith("gemini"), "executor is gemini");
    assert.ok(reviewResult.command.startsWith("gemini"), "reviewer is gemini");
  });
});


// ── Cross-adapter: environment variables, hooks, and meta ─────────────────────

describe("cross-adapter: env vars are populated for all adapters", () => {
  const plan = makePlan({
    suggestedPaths: ["src/index.ts", "src/utils.ts"],
    estimatedComplexity: "high",
    validation: ["pnpm lint", "pnpm test"],
  });
  const issue = makeIssue("Cross-adapter test", "Test all adapters", { plan });

  for (const adapterName of ["claude", "codex", "gemini"]) {
    it(`${adapterName}: sets FIFONY_PLAN_COMPLEXITY`, async () => {
      const provider = makeProvider({ provider: adapterName, role: "executor" });
      const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");
      assert.equal(result!.env.FIFONY_PLAN_COMPLEXITY, "high");
    });

    it(`${adapterName}: sets FIFONY_PLAN_STEPS`, async () => {
      const provider = makeProvider({ provider: adapterName, role: "executor" });
      const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");
      assert.equal(result!.env.FIFONY_PLAN_STEPS, "3"); // plan has 3 steps
    });

    it(`${adapterName}: sets FIFONY_PLAN_PATHS when suggestedPaths exist`, async () => {
      const provider = makeProvider({ provider: adapterName, role: "executor" });
      const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");
      assert.ok(result!.env.FIFONY_PLAN_PATHS, "FIFONY_PLAN_PATHS should be set");
      assert.ok(result!.env.FIFONY_PLAN_PATHS.includes("src/index.ts"));
    });
  }
});


describe("cross-adapter: post-hooks extracted from plan.validation", () => {
  const plan = makePlan({
    validation: ["pnpm lint --strict", "pnpm typecheck", "pnpm test --coverage"],
  });
  const issue = makeIssue("Hooks test", "Test hooks", { plan });

  for (const adapterName of ["claude", "codex", "gemini"]) {
    it(`${adapterName}: extracts lint, typecheck, test hooks`, async () => {
      const provider = makeProvider({ provider: adapterName, role: "executor" });
      const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

      assert.ok(result!.postHooks.length >= 2, `${adapterName} should have post-hooks`);
      assert.ok(result!.postHooks.some(h => h.includes("lint")), "has lint hook");
      assert.ok(result!.postHooks.some(h => h.includes("tsc") || h.includes("typecheck")), "has typecheck hook");
    });
  }
});


describe("cross-adapter: meta fields populated consistently", () => {
  for (const adapterName of ["claude", "codex", "gemini"]) {
    it(`${adapterName}: meta.adapter matches provider name`, async () => {
      const issue = makeIssue("Meta test", "desc", { plan: makePlan() });
      const provider = makeProvider({ provider: adapterName, role: "executor", model: "test-model" });
      const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

      assert.equal(result!.meta.adapter, adapterName);
      assert.equal(result!.meta.model, "test-model");
      assert.equal(result!.meta.phasesCount, 0); // flat plan
    });

    it(`${adapterName}: meta.phasesCount reflects phased plan`, async () => {
      const phasedPlan = makePlan({
        phases: [
          { phaseName: "Phase 1", goal: "Setup", tasks: [{ step: 1, action: "Init" }], outputs: [] },
          { phaseName: "Phase 2", goal: "Build", tasks: [{ step: 2, action: "Build" }], outputs: [] },
        ],
      });
      const issue = makeIssue("Phased test", "desc", { plan: phasedPlan });
      const provider = makeProvider({ provider: adapterName, role: "executor" });
      const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

      assert.equal(result!.meta.phasesCount, 2);
    });
  }
});


describe("cross-adapter: payload structure consistent across all adapters", () => {
  const plan = makePlan({
    assumptions: ["Uses PostgreSQL"],
    constraints: ["No breaking changes"],
    risks: [{ risk: "Perf regression", impact: "slow queries", mitigation: "benchmark" }],
  });
  const issue = makeIssue("Payload test", "Test payload", { plan });

  for (const adapterName of ["claude", "codex", "gemini"]) {
    it(`${adapterName}: payload has version, issue, provider, plan fields`, async () => {
      const provider = makeProvider({ provider: adapterName, role: "executor" });
      const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

      const p = result!.payload!;
      assert.equal(p.version, 1);
      assert.equal(p.issue.identifier, "CT-1");
      assert.equal(p.provider.name, adapterName);
      assert.equal(p.provider.role, "executor");
      assert.ok(p.plan.steps.length >= 3);
      assert.ok(p.constraints.length > 0, "constraints populated");
      assert.ok(p.assumptions.length > 0, "assumptions populated");
      assert.ok(p.risks.length > 0, "risks populated");
    });
  }
});


describe("cross-adapter: compileExecution returns null for missing plan", () => {
  for (const adapterName of ["claude", "codex", "gemini"]) {
    it(`${adapterName}: returns null when issue has no plan`, async () => {
      const issue = makeIssue("No plan", "desc"); // no plan attached
      const provider = makeProvider({ provider: adapterName, role: "executor" });
      const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");
      assert.equal(result, null);
    });
  }
});


// ── Parameter flow tests — verify new features flow through compile() ────────

describe("cross-adapter: readOnly flows from role to command", () => {
  const issue = makeIssue("ReadOnly test", "desc", { plan: makePlan() });

  it("claude planner uses --permission-mode plan (not --dangerously-skip-permissions)", async () => {
    const planner = makeProvider({ provider: "claude", role: "planner" });
    const result = await compileExecution(issue, planner, BASE_CONFIG, WORKSPACE, "");
    assert.ok(result!.command.includes("--permission-mode plan"), "planner should be read-only");
    assert.ok(!result!.command.includes("--dangerously-skip-permissions"), "should NOT skip permissions");
  });

  it("claude executor uses --dangerously-skip-permissions (not plan mode)", async () => {
    const executor = makeProvider({ provider: "claude", role: "executor" });
    const result = await compileExecution(issue, executor, BASE_CONFIG, WORKSPACE, "");
    assert.ok(result!.command.includes("--dangerously-skip-permissions"), "executor needs full access");
    assert.ok(!result!.command.includes("--permission-mode"), "executor should NOT be read-only");
  });

  it("claude reviewer uses --permission-mode plan (not --dangerously-skip-permissions)", async () => {
    const reviewer = makeProvider({ provider: "claude", role: "reviewer" });
    const result = await compileExecution(issue, reviewer, BASE_CONFIG, WORKSPACE, "");
    assert.ok(result!.command.includes("--permission-mode plan"), "reviewer should be read-only");
  });

  it("gemini planner uses --approval-mode plan (not --yolo)", async () => {
    const planner = makeProvider({ provider: "gemini", role: "planner" });
    const result = await compileExecution(issue, planner, BASE_CONFIG, WORKSPACE, "");
    assert.ok(result!.command.includes("--approval-mode plan"), "gemini planner should be read-only");
    assert.ok(!result!.command.includes("--yolo"));
  });

  it("gemini executor uses --yolo (not plan mode)", async () => {
    const executor = makeProvider({ provider: "gemini", role: "executor" });
    const result = await compileExecution(issue, executor, BASE_CONFIG, WORKSPACE, "");
    assert.ok(result!.command.includes("--yolo"), "gemini executor needs full access");
    assert.ok(!result!.command.includes("--approval-mode"));
  });
});


describe("cross-adapter: readOnly in review commands", () => {
  const issue = makeIssue("Review readOnly", "desc", { plan: makePlan() });

  it("claude review command uses --permission-mode plan", async () => {
    const reviewer = makeProvider({ provider: "claude", role: "reviewer" });
    const result = await compileReview(issue, reviewer, WORKSPACE, "diff summary");
    assert.ok(result.command.includes("--permission-mode plan"), "review is read-only");
    assert.ok(!result.command.includes("--dangerously-skip-permissions"));
  });

  it("gemini review command uses --approval-mode plan", async () => {
    const reviewer = makeProvider({ provider: "gemini", role: "reviewer" });
    const result = await compileReview(issue, reviewer, WORKSPACE, "diff summary");
    assert.ok(result.command.includes("--approval-mode plan"), "review is read-only");
    assert.ok(!result.command.includes("--yolo"));
  });
});


describe("claude: maxBudgetUsd flows from config through compile()", () => {
  it("includes --max-budget-usd when config has it set", async () => {
    const issue = makeIssue("Budget test", "desc", { plan: makePlan() });
    const provider = makeProvider({ provider: "claude", role: "executor" });
    const config = { ...BASE_CONFIG, maxBudgetUsd: 2.50 };

    const result = await compileExecution(issue, provider, config, WORKSPACE, "");
    assert.ok(result!.command.includes("--max-budget-usd 2.5"), "budget should flow to command");
  });

  it("omits --max-budget-usd when config does not have it", async () => {
    const issue = makeIssue("No budget", "desc", { plan: makePlan() });
    const provider = makeProvider({ provider: "claude", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");
    assert.ok(!result!.command.includes("--max-budget-usd"), "should not have budget flag");
  });

  it("includes --max-budget-usd in review command when config has it", async () => {
    const issue = makeIssue("Budget review", "desc", { plan: makePlan() });
    const reviewer = makeProvider({ provider: "claude", role: "reviewer" });
    const config = { ...BASE_CONFIG, maxBudgetUsd: 1.00 };

    const result = await compileReview(issue, reviewer, WORKSPACE, "diff", config);
    assert.ok(result.command.includes("--max-budget-usd 1"), "review should respect budget");
  });
});


describe("gemini: --output-format json flows through compile()", () => {
  it("execution command always includes --output-format json", async () => {
    const issue = makeIssue("Gemini JSON", "desc", { plan: makePlan() });
    const provider = makeProvider({ provider: "gemini", role: "executor" });

    const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");
    assert.ok(result!.command.includes("--output-format json"), "gemini should always output JSON");
  });

  it("review command also includes --output-format json", async () => {
    const issue = makeIssue("Gemini JSON review", "desc", { plan: makePlan() });
    const reviewer = makeProvider({ provider: "gemini", role: "reviewer" });

    const result = await compileReview(issue, reviewer, WORKSPACE, "diff");
    assert.ok(result.command.includes("--output-format json"), "gemini review should output JSON");
  });
});
