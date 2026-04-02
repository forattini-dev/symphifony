import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IssueEntry } from "../src/types.ts";
import { buildRuntimeState } from "../src/domains/issues.ts";
import { deriveConfig } from "../src/domains/config.ts";
import { clearApiRuntimeContext, setApiRuntimeContext } from "../src/persistence/plugins/api-runtime-context.ts";
import { registerAnalyticsRoutes } from "../src/routes/analytics.ts";

afterEach(() => {
  clearApiRuntimeContext();
});

describe("analytics contract", () => {
  it("hydrates top issues with per-phase breakdown", async () => {
    const { hydrate, getAnalytics } = await import("../src/domains/tokens.ts");

    const issue = {
      id: "issue-analytics-1",
      identifier: "#42",
      title: "Hydrated analytics",
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
        costUsd: 1.5,
      },
      tokensByPhase: {
        planner: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        executor: { inputTokens: 70, outputTokens: 50, totalTokens: 120 },
        reviewer: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
      },
    } as IssueEntry;

    hydrate([issue]);
    const analytics = getAnalytics();
    const top = analytics.topIssues[0];

    assert.equal(top.identifier, "#42");
    assert.equal(top.totalTokens, 200);
    assert.equal(top.inputTokens, 120);
    assert.equal(top.outputTokens, 80);
    assert.equal(top.costUsd, 1.5);
    assert.equal(top.byPhase?.executor?.totalTokens, 120);
    assert.equal(top.byPhase?.planner?.totalTokens, 30);
    assert.equal(top.byPhase?.reviewer?.totalTokens, 50);
  });

  it("incremental record keeps top issue phase split in sync", async () => {
    const { hydrate, record, getAnalytics } = await import("../src/domains/tokens.ts");

    hydrate([]);
    const issue = {
      id: "issue-analytics-2",
      identifier: "#99",
      title: "Incremental analytics",
    } as IssueEntry;

    record(issue, { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.2, model: "gpt-5.4" }, "planner");
    record(issue, { inputTokens: 30, outputTokens: 10, totalTokens: 40, costUsd: 0.4, model: "gpt-5.4" }, "executor");

    const analytics = getAnalytics();
    const top = analytics.topIssues.find((entry) => entry.id === issue.id);

    assert.ok(top, "recorded issue should appear in topIssues");
    assert.equal(top?.totalTokens, 55);
    assert.equal(top?.inputTokens, 40);
    assert.equal(top?.outputTokens, 15);
    assert.equal(top?.costUsd, 0.6000000000000001);
    assert.equal(top?.byPhase?.planner?.totalTokens, 15);
    assert.equal(top?.byPhase?.executor?.totalTokens, 40);
  });

  it("exposes stage-quality aggregates by role", async () => {
    const state = buildRuntimeState(null, deriveConfig([]));
    state.issues = [
      {
        id: "issue-stage-1",
        identifier: "#201",
        title: "Merged issue",
        description: "desc",
        state: "Merged",
        labels: [],
        blockedBy: [],
        assignedToWorker: false,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        completedAt: "2026-04-01T01:00:00.000Z",
        history: [],
        attempts: 1,
        maxAttempts: 3,
        planVersion: 1,
        executeAttempt: 1,
        reviewAttempt: 1,
        tokensByPhase: {
          executor: { inputTokens: 90, outputTokens: 10, totalTokens: 100, costUsd: 1.25, model: "claude-opus-4.6" },
          reviewer: { inputTokens: 30, outputTokens: 10, totalTokens: 40, costUsd: 0.5, model: "claude-opus-4.6" },
        },
        previousAttemptSummaries: [],
      } as IssueEntry,
      {
        id: "issue-stage-2",
        identifier: "#202",
        title: "Rework issue",
        description: "desc",
        state: "Approved",
        labels: [],
        blockedBy: [],
        assignedToWorker: false,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        completedAt: "2026-04-01T02:00:00.000Z",
        history: [],
        attempts: 2,
        maxAttempts: 3,
        planVersion: 1,
        executeAttempt: 2,
        reviewAttempt: 2,
        tokensByPhase: {
          executor: { inputTokens: 45, outputTokens: 5, totalTokens: 50, costUsd: 0.75, model: "gpt-5.4" },
        },
        previousAttemptSummaries: [
          { planVersion: 1, executeAttempt: 1, phase: "review", error: "needs rework", timestamp: "2026-04-01T01:30:00.000Z" },
        ],
      } as IssueEntry,
    ];
    setApiRuntimeContext(state);

    const handlers = new Map<string, (context: any) => Response | Promise<Response>>();
    registerAnalyticsRoutes({
      get(path, handler) { handlers.set(path, handler); },
      post() {},
      put() {},
      patch() {},
      delete() {},
    });

    const response = await handlers.get("/api/analytics/stage-quality")!({
      req: {
        query() { return undefined; },
        param() { return undefined; },
        async json() { return {}; },
      },
      json(body: unknown, status?: number) {
        return new Response(JSON.stringify(body), { status });
      },
      body(body: unknown, status?: number, headers?: Record<string, string>) {
        return new Response(body as BodyInit, { status, headers });
      },
    });
    const payload = await response.json() as {
      ok: boolean;
      roles: Array<{
        role: string;
        totalTokens: number;
        issueCount: number;
        outcomes: Record<string, number>;
        topIssues: Array<{ identifier: string }>;
      }>;
    };

    assert.equal(payload.ok, true);
    const executor = payload.roles.find((entry) => entry.role === "executor");
    assert.ok(executor, "executor bucket should exist");
    assert.equal(executor?.totalTokens, 150);
    assert.equal(executor?.issueCount, 2);
    assert.equal(executor?.outcomes.Merged, 1);
    assert.equal(executor?.outcomes.rework, 1);
    assert.equal(executor?.topIssues[0]?.identifier, "#201");
  });

  it("computes quality gate metrics from review reports", async () => {
    const { computeQualityGateMetrics } = await import("../src/domains/metrics.ts");

    const issues = [
      {
        id: "issue-qg-1",
        identifier: "#100",
        title: "Reviewed once and merged",
        state: "Merged",
        plan: { harnessMode: "standard" },
        reviewProfile: {
          primary: "general-quality",
          secondary: [],
          rationale: [],
          focusAreas: [],
          failureModes: [],
          evidencePriorities: [],
          severityBias: "",
        },
        reviewAttempt: 1,
        executeAttempt: 1,
        memoryFlushCount: 2,
        contextReportsByRole: {
          planner: {
            role: "planner",
            query: "planning query",
            generatedAt: "2026-03-26T00:00:10.000Z",
            maxHits: 6,
            totalHits: 5,
            selectedHits: 4,
            discardedHits: 1,
            layers: [
              { name: "bootstrap", hitCount: 2, selectedHitCount: 2, discardedHitCount: 0 },
              { name: "workspace-memory", hitCount: 1, selectedHitCount: 1, discardedHitCount: 0 },
              { name: "issue-memory", hitCount: 0, selectedHitCount: 0, discardedHitCount: 0 },
              { name: "retrieval", hitCount: 2, selectedHitCount: 1, discardedHitCount: 1 },
            ],
            stages: [
              { name: "ingest", status: "completed", durationMs: 4, inputCount: 3, outputCount: 1 },
              { name: "flush-memory", status: "completed", durationMs: 2, inputCount: 1, outputCount: 3 },
              { name: "retrieve", status: "completed", durationMs: 9, inputCount: 24, outputCount: 7 },
              { name: "budget", status: "completed", durationMs: 1, inputCount: 7, outputCount: 6, budgetLimit: 6 },
              { name: "compact", status: "skipped", durationMs: 0, inputCount: 6, outputCount: 6, budgetLimit: 6 },
              { name: "assemble", status: "completed", durationMs: 1, inputCount: 6, outputCount: 6, budgetLimit: 6 },
            ],
          },
        },
        previousAttemptSummaries: [],
        gradingReport: {
          scope: "final",
          overallVerdict: "PASS",
          blockingVerdict: "PASS",
          reviewAttempt: 1,
          criteria: [
            {
              id: "AC-1",
              description: "Tests pass",
              category: "validation",
              verificationMethod: "run_command",
              evidenceExpected: "pnpm test exits 0",
              blocking: true,
              weight: 3,
              result: "PASS",
              evidence: "pnpm test passed",
            },
          ],
        },
        reviewRuns: [
          {
            id: "review.final.v1a1",
            scope: "final",
            planVersion: 1,
            attempt: 1,
            cycle: 1,
            status: "completed",
            reviewProfile: {
              primary: "general-quality",
              secondary: [],
              rationale: [],
              focusAreas: [],
              failureModes: [],
              evidencePriorities: [],
              severityBias: "",
            },
            routing: {
              provider: "codex",
              model: "gpt-5.4",
              reasoningEffort: "medium",
              overlays: [],
            },
            promptFile: "/tmp/review-prompt.md",
            startedAt: "2026-03-26T00:00:00.000Z",
            completedAt: "2026-03-26T00:01:00.000Z",
            sessionSuccess: true,
            continueRequested: false,
            blocked: false,
            exitCode: 0,
            turns: 2,
            overallVerdict: "PASS",
            blockingVerdict: "PASS",
            criteriaCount: 1,
            failedCriteriaCount: 0,
            blockingFailedCriteriaCount: 0,
            advisoryFailedCriteriaCount: 0,
          },
        ],
        policyDecisions: [
          {
            id: "policy.plan.v1.harness-mode",
            kind: "harness-mode",
            scope: "planning",
            planVersion: 1,
            basis: "historical",
            from: "standard",
            to: "contractual",
            rationale: "Adaptive harness policy changed mode based on lift.",
            recordedAt: "2026-03-26T00:00:30.000Z",
            profile: "general-quality",
          },
        ],
      },
      {
        id: "issue-qg-2",
        identifier: "#101",
        title: "Needed rework",
        state: "Approved",
        plan: {
          harnessMode: "contractual",
          executionContract: {
            checkpointPolicy: "checkpointed",
          },
        },
        reviewProfile: {
          primary: "security-hardening",
          secondary: [],
          rationale: [],
          focusAreas: [],
          failureModes: [],
          evidencePriorities: [],
          severityBias: "",
        },
        reviewAttempt: 2,
        executeAttempt: 2,
        memoryFlushCount: 1,
        contextReportsByRole: {
          executor: {
            role: "executor",
            query: "execution query",
            generatedAt: "2026-03-26T00:02:10.000Z",
            maxHits: 8,
            totalHits: 7,
            selectedHits: 5,
            discardedHits: 2,
            layers: [
              { name: "bootstrap", hitCount: 2, selectedHitCount: 1, discardedHitCount: 1 },
              { name: "workspace-memory", hitCount: 1, selectedHitCount: 1, discardedHitCount: 0 },
              { name: "issue-memory", hitCount: 2, selectedHitCount: 2, discardedHitCount: 0 },
              { name: "retrieval", hitCount: 2, selectedHitCount: 1, discardedHitCount: 1 },
            ],
            stages: [
              { name: "ingest", status: "completed", durationMs: 5, inputCount: 5, outputCount: 2 },
              { name: "flush-memory", status: "completed", durationMs: 3, inputCount: 1, outputCount: 4 },
              { name: "retrieve", status: "completed", durationMs: 12, inputCount: 31, outputCount: 11 },
              { name: "budget", status: "completed", durationMs: 1, inputCount: 11, outputCount: 8, budgetLimit: 8 },
              { name: "compact", status: "completed", durationMs: 2, inputCount: 11, outputCount: 8, budgetLimit: 8 },
              { name: "assemble", status: "completed", durationMs: 1, inputCount: 8, outputCount: 8, budgetLimit: 8 },
            ],
          },
          reviewer: {
            role: "reviewer",
            query: "review query",
            generatedAt: "2026-03-26T00:04:10.000Z",
            maxHits: 8,
            totalHits: 6,
            selectedHits: 4,
            discardedHits: 2,
            layers: [
              { name: "bootstrap", hitCount: 1, selectedHitCount: 1, discardedHitCount: 0 },
              { name: "workspace-memory", hitCount: 1, selectedHitCount: 0, discardedHitCount: 1 },
              { name: "issue-memory", hitCount: 2, selectedHitCount: 2, discardedHitCount: 0 },
              { name: "retrieval", hitCount: 2, selectedHitCount: 1, discardedHitCount: 1 },
            ],
            stages: [
              { name: "ingest", status: "completed", durationMs: 6, inputCount: 6, outputCount: 2 },
              { name: "flush-memory", status: "completed", durationMs: 4, inputCount: 1, outputCount: 4 },
              { name: "retrieve", status: "completed", durationMs: 15, inputCount: 28, outputCount: 10 },
              { name: "budget", status: "completed", durationMs: 1, inputCount: 10, outputCount: 8, budgetLimit: 8 },
              { name: "compact", status: "completed", durationMs: 2, inputCount: 10, outputCount: 8, budgetLimit: 8 },
              { name: "assemble", status: "completed", durationMs: 1, inputCount: 8, outputCount: 8, budgetLimit: 8 },
            ],
          },
        },
        previousAttemptSummaries: [
          { planVersion: 1, executeAttempt: 1, phase: "review", error: "AC-1 failed", timestamp: "2026-03-26T00:00:00.000Z" },
        ],
        gradingReport: {
          scope: "final",
          overallVerdict: "FAIL",
          blockingVerdict: "FAIL",
          reviewAttempt: 2,
          criteria: [
            {
              id: "AC-1",
              description: "API returns 401",
              category: "security",
              verificationMethod: "api_probe",
              evidenceExpected: "Observed 401 response",
              blocking: true,
              weight: 3,
              result: "FAIL",
              evidence: "Observed 200 instead of 401",
            },
          ],
        },
        reviewRuns: [
          {
            id: "review.checkpoint.v1a1",
            scope: "checkpoint",
            planVersion: 1,
            attempt: 1,
            cycle: 101,
            status: "completed",
            reviewProfile: {
              primary: "security-hardening",
              secondary: [],
              rationale: [],
              focusAreas: [],
              failureModes: [],
              evidencePriorities: [],
              severityBias: "",
            },
            routing: {
              provider: "claude",
              model: "claude-opus-4-6",
              reasoningEffort: "extra-high",
              overlays: ["security-hardening"],
            },
            promptFile: "/tmp/checkpoint-review-prompt.md",
            startedAt: "2026-03-26T00:00:00.000Z",
            completedAt: "2026-03-26T00:02:00.000Z",
            sessionSuccess: false,
            continueRequested: true,
            blocked: false,
            exitCode: 0,
            turns: 2,
            overallVerdict: "FAIL",
            blockingVerdict: "FAIL",
            criteriaCount: 1,
            failedCriteriaCount: 1,
            blockingFailedCriteriaCount: 1,
            advisoryFailedCriteriaCount: 0,
          },
          {
            id: "review.final.v1a2",
            scope: "final",
            planVersion: 1,
            attempt: 2,
            cycle: 1,
            status: "completed",
            reviewProfile: {
              primary: "security-hardening",
              secondary: [],
              rationale: [],
              focusAreas: [],
              failureModes: [],
              evidencePriorities: [],
              severityBias: "",
            },
            routing: {
              provider: "claude",
              model: "claude-opus-4-6",
              reasoningEffort: "extra-high",
              overlays: ["security-hardening"],
            },
            promptFile: "/tmp/review-prompt.md",
            startedAt: "2026-03-26T00:03:00.000Z",
            completedAt: "2026-03-26T00:05:00.000Z",
            sessionSuccess: false,
            continueRequested: true,
            blocked: false,
            exitCode: 0,
            turns: 3,
            overallVerdict: "FAIL",
            blockingVerdict: "FAIL",
            criteriaCount: 1,
            failedCriteriaCount: 1,
            blockingFailedCriteriaCount: 1,
            advisoryFailedCriteriaCount: 0,
          },
        ],
        contractNegotiationRuns: [
          {
            id: "contract.v1a1",
            planVersion: 1,
            attempt: 1,
            status: "completed",
            reviewProfile: {
              primary: "security-hardening",
              secondary: [],
              rationale: [],
              focusAreas: [],
              failureModes: [],
              evidencePriorities: [],
              severityBias: "",
            },
            routing: {
              provider: "claude",
              model: "claude-opus-4-6",
              reasoningEffort: "extra-high",
              overlays: ["security-hardening"],
            },
            promptFile: "/tmp/contract-prompt.md",
            startedAt: "2026-03-26T00:00:00.000Z",
            completedAt: "2026-03-26T00:00:20.000Z",
            sessionSuccess: true,
            continueRequested: false,
            blocked: false,
            exitCode: 0,
            turns: 2,
            decisionStatus: "revise",
            summary: "Auth contract incomplete",
            rationale: "Need explicit auth evidence",
            concerns: [],
            concernsCount: 2,
            blockingConcernsCount: 1,
            advisoryConcernsCount: 1,
            appliedRefinement: true,
          },
          {
            id: "contract.v1a2",
            planVersion: 1,
            attempt: 2,
            status: "completed",
            reviewProfile: {
              primary: "security-hardening",
              secondary: [],
              rationale: [],
              focusAreas: [],
              failureModes: [],
              evidencePriorities: [],
              severityBias: "",
            },
            routing: {
              provider: "claude",
              model: "claude-opus-4-6",
              reasoningEffort: "extra-high",
              overlays: ["security-hardening"],
            },
            promptFile: "/tmp/contract-prompt.md",
            startedAt: "2026-03-26T00:00:21.000Z",
            completedAt: "2026-03-26T00:00:40.000Z",
            sessionSuccess: true,
            continueRequested: false,
            blocked: false,
            exitCode: 0,
            turns: 1,
            decisionStatus: "approved",
            summary: "Contract approved after fixes",
            rationale: "Ready to execute",
            concerns: [],
            concernsCount: 0,
            blockingConcernsCount: 0,
            advisoryConcernsCount: 0,
            appliedRefinement: false,
          },
        ],
        policyDecisions: [
          {
            id: "policy.final.v1a2.review-recovery",
            kind: "review-recovery",
            scope: "final-review",
            planVersion: 1,
            attempt: 2,
            basis: "runtime",
            from: "rework",
            to: "replan",
            rationale: "Recurring final review failures detected.",
            recordedAt: "2026-03-26T00:05:30.000Z",
            profile: "security-hardening",
            reviewScope: "final",
          },
        ],
      },
      {
        id: "issue-qg-3",
        identifier: "#102",
        title: "Contractual final-only issue",
        state: "Merged",
        plan: {
          harnessMode: "contractual",
          executionContract: {
            checkpointPolicy: "final_only",
          },
        },
        reviewProfile: {
          primary: "general-quality",
          secondary: [],
          rationale: [],
          focusAreas: [],
          failureModes: [],
          evidencePriorities: [],
          severityBias: "",
        },
        reviewAttempt: 1,
        executeAttempt: 1,
        previousAttemptSummaries: [],
        gradingReport: {
          scope: "final",
          overallVerdict: "PASS",
          blockingVerdict: "PASS",
          reviewAttempt: 1,
          criteria: [
            {
              id: "AC-1",
              description: "Final-only contractual path works",
              category: "correctness",
              verificationMethod: "code_inspection",
              evidenceExpected: "Implementation is coherent",
              blocking: true,
              weight: 2,
              result: "PASS",
              evidence: "Verified the core path and final review gate.",
            },
          ],
        },
        reviewRuns: [
          {
            id: "review.final.v1a1.contractual-final-only",
            scope: "final",
            planVersion: 1,
            attempt: 1,
            cycle: 1,
            status: "completed",
            reviewProfile: {
              primary: "general-quality",
              secondary: [],
              rationale: [],
              focusAreas: [],
              failureModes: [],
              evidencePriorities: [],
              severityBias: "",
            },
            routing: {
              provider: "codex",
              model: "gpt-5.4",
              reasoningEffort: "medium",
              overlays: [],
            },
            promptFile: "/tmp/review-prompt.md",
            startedAt: "2026-03-26T00:06:00.000Z",
            completedAt: "2026-03-26T00:07:00.000Z",
            sessionSuccess: true,
            continueRequested: false,
            blocked: false,
            exitCode: 0,
            turns: 1,
            overallVerdict: "PASS",
            blockingVerdict: "PASS",
            criteriaCount: 1,
            failedCriteriaCount: 0,
            blockingFailedCriteriaCount: 0,
            advisoryFailedCriteriaCount: 0,
          },
        ],
        contractNegotiationRuns: [
          {
            id: "contract.v1a1.final-only",
            planVersion: 1,
            attempt: 1,
            status: "completed",
            reviewProfile: {
              primary: "general-quality",
              secondary: [],
              rationale: [],
              focusAreas: [],
              failureModes: [],
              evidencePriorities: [],
              severityBias: "",
            },
            routing: {
              provider: "codex",
              model: "gpt-5.4",
              reasoningEffort: "medium",
              overlays: [],
            },
            promptFile: "/tmp/contract-prompt.md",
            startedAt: "2026-03-26T00:05:00.000Z",
            completedAt: "2026-03-26T00:05:20.000Z",
            sessionSuccess: true,
            continueRequested: false,
            blocked: false,
            exitCode: 0,
            turns: 1,
            decisionStatus: "approved",
            summary: "Contract approved",
            rationale: "Final review is enough here",
            concerns: [],
            concernsCount: 0,
            blockingConcernsCount: 0,
            advisoryConcernsCount: 0,
            appliedRefinement: false,
          },
        ],
        policyDecisions: [
          {
            id: "policy.plan.v1.checkpoint-policy",
            kind: "checkpoint-policy",
            scope: "planning",
            planVersion: 1,
            basis: "heuristic",
            from: "checkpointed",
            to: "final_only",
            rationale: "Checkpoint review was unnecessary for this contractual slice.",
            recordedAt: "2026-03-26T00:05:30.000Z",
            profile: "general-quality",
          },
        ],
      },
    ] as IssueEntry[];

    const metrics = computeQualityGateMetrics(issues);
    assert.equal(metrics.reviewedIssues, 3);
    assert.equal(metrics.completedReviewedIssues, 3);
    assert.equal(metrics.reviewReworkRate, 1 / 3);
    assert.equal(metrics.firstPassReviewPassRate, 2 / 3);
    assert.equal(metrics.failedCriteria, 1);
    assert.equal(metrics.criteriaByCategory.security.fail, 1);
    assert.equal(metrics.byReviewProfile["general-quality"].reviewedIssues, 2);
    assert.equal(metrics.byReviewProfile["security-hardening"].blockingFailedCriteria, 1);
    assert.equal(metrics.byReviewerRoute["codex/gpt-5.4 | [medium]"].reviewedIssues, 2);
    assert.equal(metrics.byReviewerRoute["claude/claude-opus-4-6 | [extra-high] | overlays:security-hardening"].blockingFailedCriteria, 1);
    assert.equal(metrics.byHarnessMode.standard.reviewedIssues, 1);
    assert.equal(metrics.byHarnessMode.standard.firstPassReviewPassRate, 1);
    assert.equal(metrics.byHarnessMode.contractual.reviewedIssues, 2);
    assert.equal(metrics.byHarnessMode.contractual.reviewReworkRate, 0.5);
    assert.equal(metrics.byHarnessMode.contractual.failedCriteria, 1);
    assert.equal(metrics.contractNegotiation.negotiatedIssues, 2);
    assert.equal(metrics.contractNegotiation.firstPassApprovals, 1);
    assert.equal(metrics.contractNegotiation.revisedIssues, 1);
    assert.equal(metrics.contractNegotiation.blockingConcernIssues, 1);
    assert.equal(metrics.contractNegotiation.avgRoundsPerIssue, 1.5);
    assert.equal(metrics.contractNegotiation.byReviewProfile["general-quality"].firstPassApprovals, 1);
    assert.equal(metrics.contractNegotiation.byReviewProfile["security-hardening"].blockingConcernIssues, 1);
    assert.equal(metrics.checkpointPolicy.final_only.reviewedIssues, 1);
    assert.equal(metrics.checkpointPolicy.final_only.firstPassReviewPassRate, 1);
    assert.equal(metrics.checkpointPolicy.final_only.checkpointCatchRate, 0);
    assert.equal(metrics.checkpointPolicy.checkpointed.reviewedIssues, 1);
    assert.equal(metrics.checkpointPolicy.checkpointed.checkpointCatchRate, 1);
    assert.equal(metrics.checkpointPolicy.checkpointed.gatePassRate, 0);
    assert.equal(metrics.memoryPipeline.totalMemoryFlushes, 3);
    assert.equal(metrics.memoryPipeline.issuesWithMemoryFlushes, 2);
    assert.equal(metrics.memoryPipeline.issuesWithContextReports, 2);
    assert.equal(metrics.memoryPipeline.memoryFlushCoverageRate, 2 / 3);
    assert.equal(metrics.memoryPipeline.contextReportCoverageRate, 2 / 3);
    assert.equal(metrics.memoryPipeline.stageReportCoverageRate, 2 / 3);
    assert.equal(metrics.memoryPipeline.compactionCoverageRate, 1 / 3);
    assert.equal(metrics.memoryPipeline.byRole.planner.reports, 1);
    assert.equal(metrics.memoryPipeline.byRole.executor.reports, 1);
    assert.equal(metrics.memoryPipeline.byRole.reviewer.reports, 1);
    assert.equal(metrics.memoryPipeline.byLayer["issue-memory"].selectedHitCount, 4);
    assert.equal(metrics.memoryPipeline.byStage.ingest.reports, 3);
    assert.equal(metrics.memoryPipeline.byStage.compact.completed, 2);
    assert.equal(metrics.memoryPipeline.byStage.compact.skipped, 1);
    assert.equal(metrics.memoryPipeline.byStage.compact.completionRate, 2 / 3);
    assert.equal(metrics.memoryPipeline.byStage.compact.avgBudgetLimit, (6 + 8 + 8) / 3);
    assert.equal(metrics.policyDecisions.total, 3);
    assert.equal(metrics.policyDecisions.harnessModeChanges, 1);
    assert.equal(metrics.policyDecisions.checkpointPolicyChanges, 1);
    assert.equal(metrics.policyDecisions.reviewRecoveryReplans, 1);
    assert.equal(metrics.policyDecisions.byBasis.historical, 1);
    assert.equal(metrics.policyDecisions.byBasis.heuristic, 1);
    assert.equal(metrics.policyDecisions.byBasis.runtime, 1);
  });
});
