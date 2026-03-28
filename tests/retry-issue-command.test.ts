import { after, before } from "node:test";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IssueEntry } from "../src/types.ts";
import { setEnqueueFn } from "../src/persistence/plugins/fsm-issue.ts";

function makeIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? "issue-1",
    identifier: overrides.identifier ?? "#1",
    title: overrides.title ?? "Retry test",
    description: overrides.description ?? "",
    state: overrides.state ?? "Blocked",
    labels: [],
    blockedBy: [],
    assignedToWorker: false,
    createdAt: now,
    updatedAt: now,
    history: [],
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    planVersion: overrides.planVersion ?? 1,
    executeAttempt: overrides.executeAttempt ?? 1,
    reviewAttempt: overrides.reviewAttempt ?? 1,
    ...overrides,
  } as IssueEntry;
}

function makeDeps() {
  const events: Array<{ issueId: string | undefined; kind: string; message: string }> = [];
  return {
    deps: {
      issueRepository: {
        save() {},
        findById() { return undefined; },
        findAll() { return []; },
        markDirty() {},
      },
      eventStore: {
        addEvent(issueId: string | undefined, kind: string, message: string) {
          events.push({ issueId, kind, message });
        },
        async listEvents() { return []; },
      },
    },
    events,
  };
}

describe("retry commands", () => {
  before(() => {
    setEnqueueFn(async () => {});
  });

  after(() => {
    setEnqueueFn(null);
  });

  it("retryExecutionCommand increments attempts once via FSM", async () => {
    const { retryExecutionCommand } = await import("../src/commands/retry-execution.command.ts");
    const issue = makeIssue({
      state: "Blocked",
      attempts: 0,
      lastError: "Execution failed",
      lastFailedPhase: "execution",
    });
    const { deps, events } = makeDeps();

    await retryExecutionCommand({ issue }, deps);

    assert.equal(issue.state, "Queued");
    assert.equal(issue.attempts, 0); // UNBLOCK no longer increments attempts
    assert.equal(events.length, 1);
    assert.match(events[0].message, /Execution retry requested/i);
  });

  it("requestReworkCommand preserves review feedback and increments once", async () => {
    const { requestReworkCommand } = await import("../src/commands/request-rework.command.ts");
    const issue = makeIssue({
      state: "PendingDecision",
      attempts: 0,
      lastError: "Old review error",
      lastFailedPhase: "review",
      workspacePath: undefined,
    });
    const { deps, events } = makeDeps();

    await requestReworkCommand(
      {
        issue,
        reviewerFeedback: "Tests are missing for the regression path.",
        note: "Reviewer requested rework.",
      },
      deps,
    );

    assert.equal(issue.state, "Queued");
    assert.equal(issue.attempts, 1);
    assert.equal(issue.lastError, undefined);
    assert.equal(issue.lastFailedPhase, undefined);
    assert.ok(issue.previousAttemptSummaries?.length, "rework should archive the failed review attempt");
    assert.equal(issue.previousAttemptSummaries?.at(-1)?.phase, "review");
    assert.equal(events.length, 1);
    assert.match(events[0].message, /Reviewer requested rework/i);
  });

  it("retryIssueCommand routes review failures back to Reviewing", async () => {
    const { retryIssueCommand } = await import("../src/commands/retry-issue.command.ts");
    const issue = makeIssue({
      state: "Blocked",
      attempts: 2,
      lastError: "Reviewer timed out",
      lastFailedPhase: "review",
    });
    const { deps, events } = makeDeps();

    await retryIssueCommand({ issue }, deps);

    assert.equal(issue.state, "Reviewing");
    assert.equal(issue.attempts, 2);
    assert.equal(issue.lastError, undefined);
    assert.equal(issue.lastFailedPhase, undefined);
    assert.equal(events.length, 1);
    assert.match(events[0].message, /Manual retry requested/i);
  });

  it("retryIssueCommand routes failed checkpoints back to execution", async () => {
    const { retryIssueCommand } = await import("../src/commands/retry-issue.command.ts");
    const issue = makeIssue({
      state: "Blocked",
      attempts: 1,
      lastError: "Checkpoint review failed",
      lastFailedPhase: "review",
      checkpointStatus: "failed",
    });
    const { deps, events } = makeDeps();

    await retryIssueCommand({ issue }, deps);

    assert.equal(issue.state, "Queued");
    assert.equal(issue.attempts, 1); // UNBLOCK no longer double-counts attempts
    assert.equal(events.length, 1);
    assert.match(events[0].message, /Execution retry requested/i);
  });

  it("retryIssueCommand reopens approved issues and auto-queues existing plans", async () => {
    const { retryIssueCommand } = await import("../src/commands/retry-issue.command.ts");
    const issue = makeIssue({
      state: "Approved",
      plan: {
        title: "Existing plan",
        steps: [{ title: "Step 1", done: false }],
      } as IssueEntry["plan"],
    });
    const { deps, events } = makeDeps();

    await retryIssueCommand({ issue }, deps);

    assert.equal(issue.state, "Queued");
    assert.equal(events.length, 1);
    assert.match(events[0].message, /Manual retry requested/i);
  });
});
