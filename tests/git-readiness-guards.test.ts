import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueEntry } from "../src/types.ts";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "fifony-guard-test-"));
const PERSIST_ROOT = mkdtempSync(join(tmpdir(), "fifony-guard-persist-"));

process.env.FIFONY_WORKSPACE_ROOT = TEST_ROOT;
process.env.FIFONY_PERSISTENCE = PERSIST_ROOT;
process.env.FIFONY_LOG_LEVEL = "silent";

const { approvePlanCommand } = await import("../src/commands/approve-plan.command.ts");
const { executeIssueCommand } = await import("../src/commands/execute-issue.command.ts");

function makeIssue(state: IssueEntry["state"]): IssueEntry {
  return {
    id: `issue-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    identifier: "#1",
    title: "Guard test",
    description: "Guard test",
    state,
    labels: [],
    blockedBy: [],
    assignedToWorker: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [],
    attempts: 0,
    maxAttempts: 3,
  } as IssueEntry;
}

const deps = {
  issueRepository: {
    save() {},
    findById() { return null; },
    list() { return []; },
    delete() {},
    markDirty() {},
    markPlanDirty() {},
  },
  eventStore: {
    addEvent() {},
  },
};

after(() => {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  try { rmSync(PERSIST_ROOT, { recursive: true, force: true }); } catch {}
});

describe("git readiness guards", () => {
  it("approvePlanCommand fails fast when the target workspace is not a git repo", async () => {
    const issue = makeIssue("Planning");

    await assert.rejects(
      () => approvePlanCommand({ issue }, deps),
      /requires a git repository with at least one commit/i,
    );

    assert.equal(issue.state, "Planning");
  });

  it("executeIssueCommand fails fast when the target workspace is not a git repo", async () => {
    const issue = makeIssue("PendingApproval");

    await assert.rejects(
      () => executeIssueCommand({ issue }, deps),
      /requires a git repository with at least one commit/i,
    );

    assert.equal(issue.state, "PendingApproval");
  });
});
