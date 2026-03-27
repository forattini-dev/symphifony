import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildContractNegotiationFeedback, extractContractDecision } from "../src/agents/contract-negotiation.ts";
import { needsContractNegotiationWork, getPlanExecutionBlocker } from "../src/domains/contract-negotiation.ts";
import { canDispatchAgent } from "../src/persistence/plugins/fsm-agent.ts";
import { transitionIssueCommand } from "../src/commands/transition-issue.command.ts";
import type { IssueEntry, IssuePlan } from "../src/types.ts";

function makePlan(overrides: Partial<IssuePlan> = {}): IssuePlan {
  return {
    summary: "Contract negotiation fixture plan",
    estimatedComplexity: "high",
    harnessMode: "contractual",
    steps: [{ step: 1, action: "Implement contractual flow" }],
    acceptanceCriteria: [
      {
        id: "AC-1",
        description: "Lifecycle gate is enforced",
        category: "correctness",
        verificationMethod: "code_inspection",
        evidenceExpected: "State machine blocks illegal transitions",
        blocking: true,
        weight: 3,
      },
    ],
    executionContract: {
      summary: "Execution contract must be negotiated before code runs",
      deliverables: ["working gate"],
      requiredChecks: ["pnpm test"],
      requiredEvidence: ["guarded transition"],
      focusAreas: ["src/persistence/plugins/fsm-issue.ts"],
      checkpointPolicy: "checkpointed",
    },
    suggestedPaths: ["src/persistence/plugins/fsm-issue.ts"],
    suggestedSkills: [],
    suggestedAgents: [],
    suggestedEffort: { default: "high", reviewer: "high" },
    provider: "claude",
    createdAt: "2026-03-26T00:00:00.000Z",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  return {
    id: "issue-contract-1",
    identifier: "#CN-1",
    title: "Contract negotiation fixture",
    description: "Contract negotiation fixture",
    state: "Planning",
    labels: [],
    blockedBy: [],
    assignedToWorker: true,
    createdAt: "2026-03-26T00:00:00.000Z",
    updatedAt: "2026-03-26T00:00:00.000Z",
    history: [],
    attempts: 0,
    maxAttempts: 3,
    planVersion: 1,
    executeAttempt: 0,
    reviewAttempt: 0,
    planningStatus: "idle",
    plan: makePlan(),
    ...overrides,
  } as IssueEntry;
}

describe("contract negotiation parser", () => {
  it("extracts the tagged contract_decision block", () => {
    const output = [
      "Reviewer critique",
      "```json contract_decision",
      JSON.stringify({
        status: "revise",
        summary: "Contract is too vague.",
        rationale: "Blocking criteria do not prove the route contract.",
        concerns: [
          {
            id: "NC-1",
            severity: "blocking",
            area: "acceptance_criteria",
            problem: "Missing route contract assertion.",
            requiredChange: "Add a blocking criterion for response shape and status code.",
          },
        ],
      }, null, 2),
      "```",
      "FIFONY_STATUS=continue",
    ].join("\n");

    const decision = extractContractDecision(output);
    assert.ok(decision);
    assert.equal(decision?.status, "revise");
    assert.equal(decision?.concerns.length, 1);
    assert.match(buildContractNegotiationFeedback(decision!), /Required contract fixes/i);
  });
});

describe("contract negotiation readiness", () => {
  it("reports contractual blockers until negotiation is approved", () => {
    // "pending" = not yet approved → blocks
    const issue = makeIssue({ contractNegotiationStatus: "pending" });
    assert.match(getPlanExecutionBlocker(issue) || "", /requires approved contract negotiation/i);
    assert.equal(needsContractNegotiationWork(issue), true);
  });

  it("treats failed negotiation as non-blocking — user chose to proceed at own risk", () => {
    const issue = makeIssue({ contractNegotiationStatus: "failed" });
    assert.equal(getPlanExecutionBlocker(issue), null);
    assert.equal(needsContractNegotiationWork(issue), false);
  });

  it("dispatches planning work for unapproved contractual plans but not approved ones", () => {
    const issues = [makeIssue()];
    const running = new Set<string>();

    assert.equal(canDispatchAgent(makeIssue({ contractNegotiationStatus: undefined }), "plan", running, issues), true);
    assert.equal(canDispatchAgent(makeIssue({ contractNegotiationStatus: "approved" }), "plan", running, issues), false);
    assert.equal(canDispatchAgent(makeIssue({ contractNegotiationStatus: "failed" }), "plan", running, issues), false);
  });
});

describe("contract negotiation FSM gates", () => {
  it("blocks Planning -> PendingApproval when the contractual negotiation is not approved", async () => {
    const issue = makeIssue({ contractNegotiationStatus: "running" });

    await assert.rejects(
      () => transitionIssueCommand({ issue, target: "PendingApproval", note: "Try to approve early." }),
      /guard 'requireReadyExecutionPlan' rejected event 'PLANNED'/i,
    );
  });

  it("blocks PendingApproval -> Queued when the contractual negotiation is not approved", async () => {
    // "pending" = has never been approved → blocks execution
    const issue = makeIssue({ state: "PendingApproval", contractNegotiationStatus: "pending" });

    await assert.rejects(
      () => transitionIssueCommand({ issue, target: "Queued", note: "Try to execute early." }),
      /guard 'requireReadyExecutionPlan' rejected event 'QUEUE'/i,
    );
  });
});
