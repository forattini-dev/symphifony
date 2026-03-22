import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canProceedFromSetup,
  isGitReadyForWorktrees,
} from "../app/src/components/OnboardingWizard/helpers.js";

describe("onboarding git readiness helpers", () => {
  it("requires git and at least one commit for setup completion", () => {
    assert.equal(isGitReadyForWorktrees(null), false);
    assert.equal(isGitReadyForWorktrees({ isGit: false, hasCommits: false }), false);
    assert.equal(isGitReadyForWorktrees({ isGit: true, hasCommits: false }), false);
    assert.equal(isGitReadyForWorktrees({ isGit: true, hasCommits: true }), true);
  });

  it("blocks setup progression when project name or git readiness is missing", () => {
    assert.equal(canProceedFromSetup("", { isGit: true, hasCommits: true }), false);
    assert.equal(canProceedFromSetup("my-project", { isGit: false, hasCommits: false }), false);
    assert.equal(canProceedFromSetup("my-project", { isGit: true, hasCommits: false }), false);
    assert.equal(canProceedFromSetup("my-project", { isGit: true, hasCommits: true }), true);
  });
});
