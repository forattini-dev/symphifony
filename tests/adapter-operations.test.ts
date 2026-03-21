/**
 * All 6 operations × 3 CLIs = 18 combinations.
 *
 * Tests the full adapter pipeline for each operation:
 *   enhance  → capability routing (pre-CLI, provider-agnostic)
 *   plan     → plan command flags differ from execution (noToolAccess, readOnly, json-schema)
 *   replan   → refine prompt includes current plan + feedback (learning from errors)
 *   execute  → full compilation with effort, dirs, hooks, payload
 *   re-execute → retry context injected with previous attempt summaries (learning)
 *   review   → readOnly mode, diff summary, review schema
 *
 * Run with: pnpm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileExecution, compileReview } from "../src/agents/adapters/index.ts";
import { getPlanCommand, buildPlanPrompt, buildRefinePrompt } from "../src/agents/planning/planning-prompts.ts";
import { buildRetryContext, buildTurnPrompt } from "../src/agents/prompt-builder.ts";
import { resolveTaskCapabilities } from "../src/routing/capability-resolver.ts";
import { extractFailureInsights } from "../src/agents/failure-analyzer.ts";
import { readAgentDirective, extractTokenUsage, normalizeAgentDirectiveStatus } from "../src/agents/directive-parser.ts";
import { parsePlanOutput } from "../src/agents/planning/planning-parser.ts";
import type {
  IssueEntry,
  IssuePlan,
  AgentProviderDefinition,
  RuntimeConfig,
  AttemptSummary,
} from "../src/types.ts";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const WORKSPACE = "/tmp/test-workspace";
const PROVIDERS = ["claude", "codex", "gemini"] as const;

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
  afterCreateHook: "",
  beforeRunHook: "",
  afterRunHook: "",
  beforeRemoveHook: "",
};

function makeIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  return {
    id: "ops-test-001",
    identifier: "OPS-1",
    title: "Optimize database connection pooling",
    description: "Refactor the PostgreSQL connection pool to use pgBouncer with transaction-level pooling",
    state: "PendingApproval",
    labels: ["backend", "performance"],
    paths: [],
    blockedBy: [],
    assignedToWorker: false,
    createdAt: "2026-03-21T00:00:00.000Z",
    updatedAt: "2026-03-21T00:00:00.000Z",
    history: [],
    attempts: 0,
    maxAttempts: 3,
    planVersion: 1,
    executeAttempt: 0,
    reviewAttempt: 0,
    ...overrides,
  } as IssueEntry;
}

function makePlan(overrides: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "Refactor DB pool to use pgBouncer",
    estimatedComplexity: "medium",
    steps: [
      { step: 1, action: "Add pgbouncer dependency", files: ["package.json"] },
      { step: 2, action: "Refactor pool.ts", files: ["src/db/pool.ts"] },
      { step: 3, action: "Update tests", files: ["tests/db.test.ts"] },
    ],
    successCriteria: ["All tests pass", "Connection pool uses pgBouncer"],
    validation: ["pnpm typecheck", "pnpm test"],
    suggestedPaths: ["src/db/pool.ts", "tests/db.test.ts"],
    suggestedLabels: ["backend"],
    suggestedEffort: { executor: "medium", reviewer: "low", planner: "low" },
    assumptions: ["pgBouncer is available"],
    constraints: ["No breaking API changes"],
    provider: "claude",
    createdAt: "2026-03-21T00:00:00.000Z",
    ...overrides,
  } as IssuePlan;
}

function makeProvider(provider: string, role: string, overrides: Partial<AgentProviderDefinition> = {}): AgentProviderDefinition {
  return {
    provider,
    role: role as any,
    command: "",
    model: `${provider}-test-model`,
    profile: "",
    profilePath: "",
    profileInstructions: "",
    ...overrides,
  } as AgentProviderDefinition;
}


// ══════════════════════════════════════════════════════════════════════════════
// 1. ENHANCE — capability resolution (provider-agnostic, pre-CLI)
// ══════════════════════════════════════════════════════════════════════════════

describe("operation: enhance (capability routing)", () => {
  it("routes backend task to correct category", () => {
    const issue = makeIssue({ title: "Optimize database queries", description: "PostgreSQL slow query optimization" });
    const resolution = resolveTaskCapabilities(issue);
    assert.equal(resolution.category, "backend");
    assert.ok(resolution.providers.length >= 2, "has planner + executor suggestions");
  });

  it("routes frontend task to correct category", () => {
    const issue = makeIssue({ title: "Build React dashboard", description: "Responsive UI with Tailwind charts" });
    const resolution = resolveTaskCapabilities(issue);
    assert.equal(resolution.category, "frontend-ui");
  });

  it("routes security task to correct category", () => {
    const issue = makeIssue({ title: "Add JWT authentication", description: "Token validation middleware" });
    const resolution = resolveTaskCapabilities(issue);
    assert.equal(resolution.category, "security");
  });

  it("provides provider suggestions with roles for all categories", () => {
    for (const title of ["Fix auth bug", "Build React form", "Deploy Kubernetes"]) {
      const issue = makeIssue({ title, description: "test" });
      const resolution = resolveTaskCapabilities(issue);
      const planner = resolution.providers.find(p => p.role === "planner");
      const executor = resolution.providers.find(p => p.role === "executor");
      assert.ok(planner, `${title}: should have planner`);
      assert.ok(executor, `${title}: should have executor`);
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// 2. PLAN — plan command flags differ from execution
// ══════════════════════════════════════════════════════════════════════════════

describe("operation: plan — command per CLI", () => {
  it("claude: uses --json-schema with PLAN_JSON_SCHEMA and noToolAccess", () => {
    const cmd = getPlanCommand("claude", "claude-sonnet-4-6");
    assert.ok(cmd.includes("claude"), "starts with claude");
    assert.ok(cmd.includes("--json-schema"), "uses plan JSON schema");
    assert.ok(!cmd.includes("--dangerously-skip-permissions"), "no tool access for planning");
    assert.ok(cmd.includes("--output-format json"), "JSON output");
  });

  it("codex: NO --json-schema (plan schema embedded in prompt)", () => {
    const cmd = getPlanCommand("codex", "o4-mini");
    assert.ok(cmd.includes("codex exec"), "starts with codex exec");
    assert.ok(!cmd.includes("--json-schema"), "codex has no schema flag");
    assert.ok(cmd.includes("--model o4-mini"), "model injected");
  });

  it("gemini: NO --json-schema, uses --output-format json", () => {
    const cmd = getPlanCommand("gemini", "gemini-2.5-pro");
    assert.ok(cmd.includes("gemini"), "starts with gemini");
    assert.ok(!cmd.includes("--json-schema"), "gemini has no schema flag");
    assert.ok(cmd.includes("--output-format json"), "JSON output enabled");
  });

  it("plan command with images: codex passes --image, others do not", () => {
    const images = ["/tmp/screenshot.png"];
    const claudeCmd = getPlanCommand("claude", undefined, images);
    const codexCmd = getPlanCommand("codex", undefined, images);
    const geminiCmd = getPlanCommand("gemini", undefined, images);

    assert.ok(!claudeCmd.includes("--image"), "claude has no --image flag");
    assert.ok(codexCmd.includes("--image"), "codex passes --image");
    assert.ok(!geminiCmd.includes("--image"), "gemini has no --image flag");
  });

  it("returns empty string for unknown provider", () => {
    assert.equal(getPlanCommand("unknown-provider"), "");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// 3. REPLAN — refine prompt with learning from previous plan
// ══════════════════════════════════════════════════════════════════════════════

describe("operation: replan — learning from previous plan", () => {
  it("refine prompt includes the current plan JSON", async () => {
    const plan = makePlan({ summary: "Original approach with direct SQL" });
    const prompt = await buildRefinePrompt(
      "Optimize queries",
      "PostgreSQL optimization",
      plan,
      "The direct SQL approach caused N+1 queries. Try using query batching instead.",
    );

    assert.ok(prompt.includes("Original approach with direct SQL"), "includes current plan summary");
    assert.ok(prompt.includes("query batching"), "includes user feedback");
  });

  it("refine prompt includes feedback about what went wrong", async () => {
    const plan = makePlan();
    const feedback = "Step 2 failed because pgBouncer requires transaction-level settings that conflict with our ORM. Switch to connection-level pooling.";

    const prompt = await buildRefinePrompt("DB optimization", "desc", plan, feedback);

    assert.ok(prompt.includes("pgBouncer requires transaction-level"), "feedback is present");
    assert.ok(prompt.includes("connection-level pooling"), "corrective guidance present");
  });

  it("replan command uses same flags as plan per provider", () => {
    // Replan uses the same getPlanCommand — just with a different prompt
    for (const provider of PROVIDERS) {
      const planCmd = getPlanCommand(provider);
      // Verify the command is valid (non-empty) for all providers
      assert.ok(planCmd.length > 0, `${provider} should produce a plan command`);
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// 4. EXECUTE — full compilation per CLI
// ══════════════════════════════════════════════════════════════════════════════

describe("operation: execute — compile per CLI", () => {
  for (const providerName of PROVIDERS) {
    describe(`${providerName}`, () => {
      it("compiles a valid command with model", async () => {
        const issue = makeIssue({ plan: makePlan() });
        const provider = makeProvider(providerName, "executor");
        const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

        assert.ok(result !== null, "compilation should succeed");
        assert.ok(result!.command.includes(providerName === "codex" ? "codex exec" : providerName), "command starts correctly");
        assert.ok(result!.command.includes(`${providerName}-test-model`), "model injected");
      });

      it("executor uses full-access permissions", async () => {
        const issue = makeIssue({ plan: makePlan() });
        const provider = makeProvider(providerName, "executor");
        const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

        if (providerName === "claude") {
          assert.ok(result!.command.includes("--dangerously-skip-permissions"), "claude executor: full access");
        } else if (providerName === "gemini") {
          assert.ok(result!.command.includes("--yolo"), "gemini executor: yolo mode");
        }
      });

      it("prompt contains issue title", async () => {
        const issue = makeIssue({ plan: makePlan() });
        const provider = makeProvider(providerName, "executor");
        const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

        assert.ok(result!.prompt.includes("Optimize database connection pooling"), "prompt has title");
      });

      it("sets environment variables", async () => {
        const issue = makeIssue({ plan: makePlan() });
        const provider = makeProvider(providerName, "executor");
        const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

        assert.equal(result!.env.FIFONY_PLAN_COMPLEXITY, "medium");
        assert.equal(result!.env.FIFONY_PLAN_STEPS, "3");
      });

      it("extracts post-hooks from validation", async () => {
        const issue = makeIssue({ plan: makePlan({ validation: ["pnpm lint", "pnpm test"] }) });
        const provider = makeProvider(providerName, "executor");
        const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

        assert.ok(result!.postHooks.some(h => h.includes("lint")), "has lint hook");
        assert.ok(result!.postHooks.some(h => h.includes("test")), "has test hook");
      });

      it("populates execution payload", async () => {
        const issue = makeIssue({ plan: makePlan() });
        const provider = makeProvider(providerName, "executor");
        const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

        assert.ok(result!.payload !== null);
        assert.equal(result!.payload!.version, 1);
        assert.equal(result!.payload!.provider.name, providerName);
        assert.equal(result!.payload!.provider.role, "executor");
      });

      it("meta.adapter matches provider", async () => {
        const issue = makeIssue({ plan: makePlan() });
        const provider = makeProvider(providerName, "executor");
        const result = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

        assert.equal(result!.meta.adapter, providerName);
      });
    });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// 5. RE-EXECUTE — retry with learning context from previous failures
// ══════════════════════════════════════════════════════════════════════════════

describe("operation: re-execute — learning from previous failures", () => {
  it("buildRetryContext generates context from previousAttemptSummaries", () => {
    const issue = makeIssue({
      attempts: 2,
      previousAttemptSummaries: [
        {
          planVersion: 1,
          executeAttempt: 1,
          error: "TypeError: pool.connect is not a function",
          outputTail: "at Pool.connect (pool.ts:42)\nat main (index.ts:10)",
          timestamp: "2026-03-21T10:00:00.000Z",
        },
        {
          planVersion: 1,
          executeAttempt: 2,
          error: "Connection timeout after 30s",
          outputTail: "FATAL: too many connections for role 'app'",
          timestamp: "2026-03-21T10:05:00.000Z",
        },
      ],
    });

    const context = buildRetryContext(issue);

    assert.ok(context.includes("## Previous Attempts"), "has header");
    assert.ok(context.includes("Do NOT repeat the same approach"), "has learning instruction");
    assert.ok(context.includes("pool.connect is not a function"), "includes first error");
    assert.ok(context.includes("Connection timeout"), "includes second error");
    assert.ok(context.includes("Attempt 1"), "labels attempt 1");
    assert.ok(context.includes("Attempt 2"), "labels attempt 2");
    assert.ok(context.includes("plan v1, exec #1"), "includes version/attempt info");
    assert.ok(context.includes("too many connections"), "includes output tail");
  });

  it("returns empty string when no previous attempts", () => {
    const issue = makeIssue({ previousAttemptSummaries: [] });
    assert.equal(buildRetryContext(issue), "");
  });

  it("returns empty string when previousAttemptSummaries is undefined", () => {
    const issue = makeIssue();
    assert.equal(buildRetryContext(issue), "");
  });

  it("truncates very long retry context to ~8000 chars", () => {
    const longOutput = "x".repeat(5000);
    const issue = makeIssue({
      previousAttemptSummaries: [
        { planVersion: 1, executeAttempt: 1, error: "err1", outputTail: longOutput, timestamp: "" },
        { planVersion: 1, executeAttempt: 2, error: "err2", outputTail: longOutput, timestamp: "" },
      ],
    });

    const context = buildRetryContext(issue);
    assert.ok(context.length <= 8100, "should be truncated to ~8000 chars");
    assert.ok(context.includes("[...truncated]"), "should have truncation marker");
  });

  it("re-execute uses same compiled command as original execute", async () => {
    // The command doesn't change — only the prompt gets retry context appended
    for (const providerName of PROVIDERS) {
      const issue = makeIssue({ plan: makePlan() });
      const provider = makeProvider(providerName, "executor");

      const firstExec = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");
      const secondExec = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");

      assert.equal(firstExec!.command, secondExec!.command, `${providerName}: command should be identical on retry`);
    }
  });

  it("buildTurnPrompt injects continuation context for multi-turn", async () => {
    const issue = makeIssue();
    const basePrompt = "You are working on database optimization.";
    const previousOutput = "I analyzed the queries and found 3 slow ones.";

    // Turn 1 = base prompt only
    const turn1 = await buildTurnPrompt(issue, basePrompt, "", 1, 5, "");
    assert.equal(turn1, basePrompt, "turn 1 is just the base prompt");

    // Turn 2 = continuation with previous output
    const turn2 = await buildTurnPrompt(issue, basePrompt, previousOutput, 2, 5, "Now optimize those 3 queries");
    assert.ok(turn2.includes("optimize those 3 queries"), "has continuation guidance");
    assert.ok(turn2.includes("3 slow ones"), "has previous output");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// 6. REVIEW — readOnly mode, diff summary, review schema
// ══════════════════════════════════════════════════════════════════════════════

describe("operation: review — compile per CLI", () => {
  for (const providerName of PROVIDERS) {
    describe(`${providerName}`, () => {
      it("review command uses read-only mode where supported", async () => {
        const issue = makeIssue({ plan: makePlan() });
        const reviewer = makeProvider(providerName, "reviewer");
        const result = await compileReview(issue, reviewer, WORKSPACE, "3 files changed", BASE_CONFIG);

        if (providerName === "claude") {
          assert.ok(result.command.includes("--permission-mode plan"), "claude reviewer: read-only");
          assert.ok(!result.command.includes("--dangerously-skip-permissions"), "no full access");
        } else if (providerName === "gemini") {
          assert.ok(result.command.includes("--approval-mode plan"), "gemini reviewer: read-only");
          assert.ok(!result.command.includes("--yolo"), "no yolo");
        }
        // codex has no read-only equivalent — just standard exec
      });

      it("review prompt includes diff summary", async () => {
        const issue = makeIssue({ plan: makePlan() });
        const reviewer = makeProvider(providerName, "reviewer");
        const diff = "Modified src/db/pool.ts (+45 -12), added tests/pool.test.ts (+89)";

        const result = await compileReview(issue, reviewer, WORKSPACE, diff, BASE_CONFIG);
        assert.ok(result.prompt.includes(diff), "diff summary in prompt");
      });

      it("review prompt includes success criteria from plan", async () => {
        const plan = makePlan({ successCriteria: ["Connection pool uses pgBouncer", "All tests pass"] });
        const issue = makeIssue({ plan });
        const reviewer = makeProvider(providerName, "reviewer");

        const result = await compileReview(issue, reviewer, WORKSPACE, "diff", BASE_CONFIG);
        assert.ok(result.prompt.includes("pgBouncer"), "criteria referenced in prompt");
      });

      it("review command includes model", async () => {
        const issue = makeIssue({ plan: makePlan() });
        const reviewer = makeProvider(providerName, "reviewer", { model: `${providerName}-review-model` });
        const result = await compileReview(issue, reviewer, WORKSPACE, "diff", BASE_CONFIG);

        assert.ok(result.command.includes(`${providerName}-review-model`), "model in command");
      });
    });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// Cross-operation: planner vs executor vs reviewer permissions
// ══════════════════════════════════════════════════════════════════════════════

describe("cross-operation: role-based permissions per CLI", () => {
  for (const providerName of PROVIDERS) {
    it(`${providerName}: planner uses read-only, executor uses full-access`, async () => {
      const issue = makeIssue({ plan: makePlan() });

      const planner = makeProvider(providerName, "planner");
      const executor = makeProvider(providerName, "executor");
      const reviewer = makeProvider(providerName, "reviewer");

      const planResult = await compileExecution(issue, planner, BASE_CONFIG, WORKSPACE, "");
      const execResult = await compileExecution(issue, executor, BASE_CONFIG, WORKSPACE, "");
      const reviewResult = await compileExecution(issue, reviewer, BASE_CONFIG, WORKSPACE, "");

      if (providerName === "claude") {
        assert.ok(planResult!.command.includes("--permission-mode plan"), "planner: read-only");
        assert.ok(execResult!.command.includes("--dangerously-skip-permissions"), "executor: full access");
        assert.ok(reviewResult!.command.includes("--permission-mode plan"), "reviewer: read-only");
      } else if (providerName === "gemini") {
        assert.ok(planResult!.command.includes("--approval-mode plan"), "planner: read-only");
        assert.ok(execResult!.command.includes("--yolo"), "executor: yolo");
        assert.ok(reviewResult!.command.includes("--approval-mode plan"), "reviewer: read-only");
      }
      // codex: no read-only mode
    });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// Cross-operation: plan → execute → review pipeline consistency
// ══════════════════════════════════════════════════════════════════════════════

describe("cross-operation: full pipeline per CLI", () => {
  for (const providerName of PROVIDERS) {
    it(`${providerName}: plan → execute → review produces valid commands at each stage`, async () => {
      // 1. Plan command
      const planCmd = getPlanCommand(providerName, `${providerName}-plan-model`);
      assert.ok(planCmd.length > 0, "plan command produced");

      // 2. Execute compilation
      const issue = makeIssue({ plan: makePlan() });
      const executor = makeProvider(providerName, "executor");
      const execResult = await compileExecution(issue, executor, BASE_CONFIG, WORKSPACE, "");
      assert.ok(execResult !== null, "execution compiled");

      // 3. Review compilation
      const reviewer = makeProvider(providerName, "reviewer");
      const reviewResult = await compileReview(issue, reviewer, WORKSPACE, "src/db/pool.ts modified", BASE_CONFIG);
      assert.ok(reviewResult.command.length > 0, "review command produced");

      // All three should reference the correct CLI
      const cliName = providerName === "codex" ? "codex exec" : providerName;
      assert.ok(planCmd.includes(cliName), "plan uses correct CLI");
      assert.ok(execResult!.command.includes(cliName), "execute uses correct CLI");
      assert.ok(reviewResult.command.includes(cliName), "review uses correct CLI");
    });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// LEARNING LOOP SIMULATION
//
// Simulates the full cycle:
//   plan → execute (fails) → analyze output → learn → re-execute (different approach)
//   → execute (fails again) → analyze → learn → replan → execute (succeeds)
//   → review → done
//
// Each step's output becomes the next step's input.
// ══════════════════════════════════════════════════════════════════════════════

describe("learning loop simulation", () => {
  for (const providerName of PROVIDERS) {
    describe(`${providerName}: plan → fail → learn → retry → replan → succeed → review`, () => {

      // ── Simulated CLI outputs — realistic per-provider format ──
      // Claude: --output-format json produces pure JSON on stdout
      // Codex: plain text with token info at the end
      // Gemini: --output-format json produces pure JSON on stdout

      const TS_ERROR = "src/db/pool.ts(42,5): error TS2339: Property 'connect' does not exist on type 'PoolConfig'.\nFound 1 error.";

      function makeFailedExecOutput(provider: string): string {
        if (provider === "claude") {
          return JSON.stringify({
            type: "result",
            subtype: "error_max_turns",
            result: `I tried to refactor pool.ts but TypeScript compilation failed:\n\n${TS_ERROR}`,
            modelUsage: { "claude-sonnet-4-6": { inputTokens: 2000, outputTokens: 500, cacheReadInputTokens: 800 } },
          });
        }
        if (provider === "codex") {
          return `I tried to refactor pool.ts but the TypeScript compiler found errors.\n\n${TS_ERROR}\n\nmodel: gpt-5.3\ntokens used\n4,200\n`;
        }
        // gemini: pure JSON
        return JSON.stringify({
          response: `I attempted to refactor pool.ts but hit a TS error:\n\n${TS_ERROR}`,
          stats: { models: { "gemini-2.5-flash": { tokens: { input: 3000, candidates: 400, total: 3400, cached: 500 } } } },
        });
      }

      function makeSuccessExecOutput(provider: string): string {
        if (provider === "claude") {
          return JSON.stringify({
            type: "result",
            structured_output: { status: "done", summary: "Refactored pool.ts using PoolClient interface", nextPrompt: "" },
            modelUsage: { "claude-sonnet-4-6": { inputTokens: 3000, outputTokens: 800 } },
          });
        }
        if (provider === "codex") {
          return `I successfully refactored pool.ts using the correct PoolClient interface.\n\nAll tests pass.\n\nFIFONY_STATUS=done\nFIFONY_SUMMARY=Refactored pool.ts\n\nmodel: gpt-5.3\ntokens used\n5,100\n`;
        }
        return JSON.stringify({
          response: JSON.stringify({ status: "done", summary: "Pool refactored successfully" }),
          stats: { models: { "gemini-2.5-flash": { tokens: { input: 4000, candidates: 600, total: 4600, cached: 1000 } } } },
        });
      }

      function makeReviewOutput(provider: string): string {
        if (provider === "claude") {
          return JSON.stringify({
            type: "result",
            structured_output: { status: "done", summary: "Code review passed — all criteria met" },
            modelUsage: { "claude-opus-4-6": { inputTokens: 1500, outputTokens: 200 } },
          });
        }
        if (provider === "codex") {
          return `Review complete. All success criteria are met.\n\nFIFONY_STATUS=done\n\nmodel: gpt-5.3\ntokens used\n2,000\n`;
        }
        return JSON.stringify({
          response: JSON.stringify({ status: "done", summary: "Review passed" }),
          stats: { models: { "gemini-2.5-flash": { tokens: { input: 2000, candidates: 100, total: 2100, cached: 0 } } } },
        });
      }

      // ── STEP 1: Plan ──
      it("step 1: generates plan command", () => {
        const cmd = getPlanCommand(providerName, `${providerName}-plan-model`);
        assert.ok(cmd.length > 0, "plan command generated");
        assert.ok(cmd.includes(providerName === "codex" ? "codex" : providerName));
      });

      // ── STEP 2: Execute (fails with TS error) ──
      it("step 2: execute fails — parse output + extract tokens", async () => {
        const failedOutput = makeFailedExecOutput(providerName);

        // Parse the CLI output as the system would (success=false because exit code != 0)
        const directive = readAgentDirective("/tmp/fake-workspace", failedOutput, false);

        // Directive should report failure (fallback since no structured status field in error output)
        assert.equal(directive.status, "failed", "should detect failure via exit code fallback");

        // Token usage should be extracted from all providers
        assert.ok(directive.tokenUsage, `${providerName} should extract token usage`);
        assert.ok(directive.tokenUsage!.totalTokens > 0, "tokens > 0");
      });

      // ── STEP 3: Analyze failure (learning) ──
      it("step 3: analyze failure output → structured insight", () => {
        const failedOutput = makeFailedExecOutput(providerName);

        // The failure analyzer works on raw output text — it searches for error patterns
        // regardless of JSON wrapper. For Claude/Gemini the TS error is inside the JSON value.
        const insight = extractFailureInsights(failedOutput, 1);

        assert.equal(insight.errorType, "typescript", `${providerName}: should detect TS error`);
        assert.ok(insight.filesInvolved.includes("src/db/pool.ts"), "should find the file");
        assert.ok(insight.errorMessage.includes("TS2339"), "should capture error code");
        assert.ok(insight.suggestion.length > 0, "should produce actionable suggestion");
      });

      // ── STEP 4: Build retry context via production buildRetryContext ──
      it("step 4: build retry context from failure insight (production path)", () => {
        const failedOutput = makeFailedExecOutput(providerName);
        const insight = extractFailureInsights(failedOutput, 1);

        // Simulate what FSM does: create AttemptSummary with insight
        const issue = makeIssue({
          previousAttemptSummaries: [{
            planVersion: 1, executeAttempt: 1, error: insight.rootCause,
            outputTail: failedOutput.slice(-500), timestamp: "",
            insight: {
              errorType: insight.errorType, rootCause: insight.rootCause,
              failedCommand: insight.failedCommand, filesInvolved: insight.filesInvolved,
              suggestion: insight.suggestion,
            },
          }],
        });

        const retryContext = buildRetryContext(issue);
        assert.ok(retryContext.includes("Attempt 1"), "has attempt number");
        assert.ok(retryContext.includes("typescript"), "has error type");
        assert.ok(retryContext.includes("src/db/pool.ts"), "has file reference");
        assert.ok(retryContext.includes("What to do differently"), "has actionable guidance");
      });

      // ── STEP 5: Re-execute with learning context ──
      it("step 5: re-execute — compile with retry context in prompt", async () => {
        const failedOutput = makeFailedExecOutput(providerName);
        const insight = extractFailureInsights(failedOutput, 1);

        // The issue now has previous attempt summaries with structured insight
        const issue = makeIssue({
          plan: makePlan(),
          attempts: 1,
          executeAttempt: 1,
          previousAttemptSummaries: [{
            planVersion: 1, executeAttempt: 1, error: insight.rootCause,
            outputTail: failedOutput.slice(-500), timestamp: "2026-03-21T10:00:00.000Z",
            insight: {
              errorType: insight.errorType, rootCause: insight.rootCause,
              failedCommand: insight.failedCommand, filesInvolved: insight.filesInvolved,
              suggestion: insight.suggestion,
            },
          }],
        });

        // Compile execution — command stays the same
        const provider = makeProvider(providerName, "executor");
        const compiled = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");
        assert.ok(compiled !== null);

        // Build retry context using production path (buildRetryContext uses insight)
        const retryCtx = buildRetryContext(issue);
        assert.ok(retryCtx.includes("Previous Attempts"), "has header");
        assert.ok(retryCtx.includes("TypeScript compilation failed"), "has root cause from insight");
        assert.ok(retryCtx.includes("What to do differently"), "has guidance from insight");
        assert.ok(retryCtx.includes("src/db/pool.ts"), "has file from insight");
      });

      // ── STEP 6: Success on retry ──
      it("step 6: re-execute succeeds — parse success output", () => {
        const successOutput = makeSuccessExecOutput(providerName);
        const directive = readAgentDirective("/tmp/fake-workspace", successOutput, true);

        assert.equal(directive.status, "done", "should report success");
        assert.ok(directive.summary.length > 0, "should have summary");

        if (providerName !== "codex") {
          assert.ok(directive.tokenUsage, "should extract tokens from success");
          assert.ok(directive.tokenUsage!.totalTokens > 0);
        }
      });

      // ── STEP 7: Review ──
      it("step 7: review — compile + parse review output", async () => {
        const issue = makeIssue({ plan: makePlan() });
        const reviewer = makeProvider(providerName, "reviewer");

        // Compile review command
        const compiled = await compileReview(issue, reviewer, WORKSPACE, "src/db/pool.ts modified (+45 -12)", BASE_CONFIG);
        assert.ok(compiled.command.length > 0);
        assert.ok(compiled.prompt.includes("pool.ts"), "review prompt has diff info");

        // Parse review output
        const reviewOutput = makeReviewOutput(providerName);
        const directive = readAgentDirective("/tmp/fake-workspace", reviewOutput, true);
        assert.equal(directive.status, "done", "review should pass");
      });

      // ── FULL CYCLE: chain all steps together ──
      it("full cycle: output of each step feeds into the next", async () => {
        // 1. Plan
        const planCmd = getPlanCommand(providerName, `${providerName}-model`);
        assert.ok(planCmd.length > 0, "[plan] command generated");

        // 2. Execute — FAILS
        const failedOutput = makeFailedExecOutput(providerName);
        const failDirective = readAgentDirective("/tmp/ws", failedOutput, false);
        assert.equal(failDirective.status, "failed", "[execute] should fail");

        // 3. Analyze failure → structured insight
        const insight = extractFailureInsights(failedOutput, 1);
        assert.equal(insight.errorType, "typescript", "[analyze] detected TS error");

        // 4. Build retry context via production path (buildRetryContext with insight)
        const issueWithInsight = makeIssue({
          previousAttemptSummaries: [{
            planVersion: 1, executeAttempt: 1, error: insight.rootCause, timestamp: "",
            insight: {
              errorType: insight.errorType, rootCause: insight.rootCause,
              failedCommand: insight.failedCommand, filesInvolved: insight.filesInvolved,
              suggestion: insight.suggestion,
            },
          }],
        });
        const retryCtx = buildRetryContext(issueWithInsight);
        assert.ok(retryCtx.includes("typescript"), "[learn] context has error type");

        // 5. Replan with feedback from failure
        const replanPrompt = await buildRefinePrompt(
          "Optimize DB pooling",
          "PostgreSQL connection pooling",
          makePlan(),
          `Previous attempt failed: ${insight.rootCause}. ${insight.suggestion}`,
        );
        assert.ok(replanPrompt.includes(insight.rootCause), "[replan] includes failure reason");
        assert.ok(replanPrompt.includes("type"), "[replan] includes guidance");

        // 6. Re-execute with enriched context — SUCCEEDS
        const successOutput = makeSuccessExecOutput(providerName);
        const successDirective = readAgentDirective("/tmp/ws", successOutput, true);
        assert.equal(successDirective.status, "done", "[re-execute] should succeed");

        // 7. Review
        const issue = makeIssue({ plan: makePlan() });
        const reviewer = makeProvider(providerName, "reviewer");
        const reviewCompiled = await compileReview(issue, reviewer, WORKSPACE, "pool.ts refactored", BASE_CONFIG);
        assert.ok(reviewCompiled.prompt.includes("pool.ts"), "[review] has diff");

        const reviewOutput = makeReviewOutput(providerName);
        const reviewDirective = readAgentDirective("/tmp/ws", reviewOutput, true);
        assert.equal(reviewDirective.status, "done", "[review] should approve");
      });
    });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// FILE-BASED LEARNING LOOP
//
// Simulates the REAL flow where CLI output is written to a file, then
// read back for analysis before the next execution.
// ══════════════════════════════════════════════════════════════════════════════

describe("file-based learning loop", () => {
  for (const providerName of PROVIDERS) {
    it(`${providerName}: write output file → analyze → build enriched retry prompt`, async () => {
      const tempWorkspace = mkdtempSync(join(tmpdir(), "learning-loop-"));
      const outputsDir = join(tempWorkspace, "outputs");
      mkdirSync(outputsDir, { recursive: true });

      try {
        // ── CLI executes and fails → output written to file ──
        const tsError = "src/db/pool.ts(42,5): error TS2339: Property 'connect' does not exist on type 'PoolConfig'.\nFound 1 error.";
        let cliOutput: string;
        if (providerName === "claude") {
          cliOutput = JSON.stringify({
            type: "result",
            result: `Refactor failed:\n\n${tsError}`,
            modelUsage: { "claude-sonnet-4-6": { inputTokens: 5000, outputTokens: 1200, cacheReadInputTokens: 2000 } },
          });
        } else if (providerName === "codex") {
          cliOutput = `Attempted refactor.\n\n${tsError}\n\nmodel: gpt-5.3\ntokens used\n8,500\n`;
        } else {
          cliOutput = JSON.stringify({
            response: `Types are wrong:\n\n${tsError}`,
            stats: { models: { "gemini-2.5-flash": { tokens: { input: 6000, candidates: 800, total: 6800, cached: 1500 } } } },
          });
        }

        writeFileSync(join(outputsDir, "turn-1.stdout.log"), cliOutput, "utf8");

        // ── Parse directive ──
        const directive = readAgentDirective(tempWorkspace, cliOutput, false);
        assert.equal(directive.status, "failed");
        assert.ok(directive.tokenUsage);
        assert.ok(directive.tokenUsage!.totalTokens > 0);

        // ── Analyze output ──
        const insight = extractFailureInsights(cliOutput, 1);
        assert.equal(insight.errorType, "typescript");
        assert.ok(insight.filesInvolved.includes("src/db/pool.ts"));

        // ── Build AttemptSummary with insight ──
        const summary: AttemptSummary = {
          planVersion: 1, executeAttempt: 1, error: insight.rootCause,
          outputTail: cliOutput.slice(-500), outputFile: "turn-1.stdout.log",
          timestamp: "2026-03-21T10:00:00.000Z",
          insight: {
            errorType: insight.errorType, rootCause: insight.rootCause,
            failedCommand: insight.failedCommand, filesInvolved: insight.filesInvolved,
            suggestion: insight.suggestion,
          },
        };

        // ── Build enriched retry prompt ──
        const issue = makeIssue({ plan: makePlan(), attempts: 1, previousAttemptSummaries: [summary] });
        const retryContext = buildRetryContext(issue);

        assert.ok(retryContext.includes("typescript"), "has error type");
        assert.ok(retryContext.includes("src/db/pool.ts"), "has file");
        assert.ok(retryContext.includes("What to do differently"), "has guidance");

        // ── Compile retry execution ──
        const provider = makeProvider(providerName, "executor");
        const compiled = await compileExecution(issue, provider, BASE_CONFIG, WORKSPACE, "");
        const fullPrompt = `${compiled!.prompt}\n\n${retryContext}`;
        assert.ok(fullPrompt.includes("TypeScript compilation failed"), "prompt has failure context");
      } finally {
        rmSync(tempWorkspace, { recursive: true, force: true });
      }
    });
  }
});


describe("file-based learning: two failures accumulate insights", () => {
  it("second retry has insights from BOTH previous failures", () => {
    const insight1 = extractFailureInsights(
      "src/db/pool.ts(42,5): error TS2339: Property 'connect' does not exist.\nFound 1 error.", 1,
    );
    const insight2 = extractFailureInsights(
      "FAIL tests/db/pool.test.ts\n  ✖ handles timeout\n    AssertionError: expected 'connected' but got null", 1,
    );

    const issue = makeIssue({
      plan: makePlan(), attempts: 2,
      previousAttemptSummaries: [
        {
          planVersion: 1, executeAttempt: 1, error: insight1.rootCause, timestamp: "",
          insight: { errorType: insight1.errorType, rootCause: insight1.rootCause, failedCommand: insight1.failedCommand, filesInvolved: insight1.filesInvolved, suggestion: insight1.suggestion },
        },
        {
          planVersion: 1, executeAttempt: 2, error: insight2.rootCause, timestamp: "",
          insight: { errorType: insight2.errorType, rootCause: insight2.rootCause, failedCommand: insight2.failedCommand, filesInvolved: insight2.filesInvolved, suggestion: insight2.suggestion },
        },
      ],
    });

    const retryContext = buildRetryContext(issue);

    assert.ok(retryContext.includes("Attempt 1") && retryContext.includes("Attempt 2"), "both attempts");
    assert.ok(retryContext.includes("typescript"), "attempt 1 type");
    assert.ok(retryContext.includes("test"), "attempt 2 type");
    assert.ok(retryContext.includes("src/db/pool.ts"), "attempt 1 file");
    assert.ok(retryContext.includes("pool.test.ts"), "attempt 2 file");
    assert.equal((retryContext.match(/What to do differently/g) || []).length, 2, "each attempt has guidance");
  });
});
