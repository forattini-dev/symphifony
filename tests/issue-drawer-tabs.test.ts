import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ISSUE_DRAWER_TABS,
  getDefaultIssueDrawerTab,
} from "../app/src/components/IssueDetailDrawer/constants.js";

describe("issue drawer tabs", () => {
  it("keeps a stable ordered tab list", () => {
    assert.deepEqual(
      ISSUE_DRAWER_TABS.map((tab) => tab.id),
      ["overview", "planning", "execution", "review", "diff", "routing", "events"],
    );
  });

  it("uses contextual defaults without changing the available tabs", () => {
    assert.equal(getDefaultIssueDrawerTab("Planning"), "planning");
    assert.equal(getDefaultIssueDrawerTab("PendingApproval"), "planning");
    assert.equal(getDefaultIssueDrawerTab("Reviewing"), "review");
    assert.equal(getDefaultIssueDrawerTab("PendingDecision"), "review");
    assert.equal(getDefaultIssueDrawerTab("Running"), "overview");
    assert.equal(getDefaultIssueDrawerTab("Approved"), "overview");
  });
});
