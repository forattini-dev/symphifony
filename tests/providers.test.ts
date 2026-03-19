/**
 * Tests for src/agent/providers.ts — provider normalization, effort resolution,
 * command resolution and default command building.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAgentProvider,
  normalizeAgentRole,
  resolveEffort,
  resolveAgentCommand,
  getProviderDefaultCommand,
} from "../src/agent/providers.ts";
import type { EffortConfig } from "../src/agent/types.ts";

// ── normalizeAgentProvider() ──────────────────────────────────────────────────

describe("normalizeAgentProvider", () => {
  it("returns 'claude' for 'claude'", () => {
    assert.equal(normalizeAgentProvider("claude"), "claude");
  });

  it("returns 'codex' for 'codex'", () => {
    assert.equal(normalizeAgentProvider("codex"), "codex");
  });

  it("normalizes to lowercase", () => {
    assert.equal(normalizeAgentProvider("Claude"), "claude");
    assert.equal(normalizeAgentProvider("CODEX"), "codex");
  });

  it("returns 'codex' for empty string (default)", () => {
    assert.equal(normalizeAgentProvider(""), "codex");
  });

  it("trims whitespace before normalizing", () => {
    assert.equal(normalizeAgentProvider("  claude  "), "claude");
  });

  it("passes through unknown values as-is (lowercased)", () => {
    // Unknown providers are passed through to allow future providers
    assert.equal(normalizeAgentProvider("gemini"), "gemini");
  });
});

// ── normalizeAgentRole() ──────────────────────────────────────────────────────

describe("normalizeAgentRole", () => {
  it("returns 'planner' for 'planner'", () => {
    assert.equal(normalizeAgentRole("planner"), "planner");
  });

  it("returns 'executor' for 'executor'", () => {
    assert.equal(normalizeAgentRole("executor"), "executor");
  });

  it("returns 'reviewer' for 'reviewer'", () => {
    assert.equal(normalizeAgentRole("reviewer"), "reviewer");
  });

  it("normalizes to lowercase", () => {
    assert.equal(normalizeAgentRole("Executor"), "executor");
    assert.equal(normalizeAgentRole("PLANNER"), "planner");
  });

  it("returns 'executor' as default for empty string", () => {
    assert.equal(normalizeAgentRole(""), "executor");
  });

  it("returns 'executor' as default for unknown role", () => {
    assert.equal(normalizeAgentRole("unknown"), "executor");
  });

  it("trims whitespace before normalizing", () => {
    assert.equal(normalizeAgentRole("  reviewer  "), "reviewer");
  });
});

// ── resolveEffort() ───────────────────────────────────────────────────────────

describe("resolveEffort", () => {
  it("returns issue-level role-specific effort (highest priority)", () => {
    const issueEffort: EffortConfig = { executor: "high" };
    const globalEffort: EffortConfig = { executor: "low", default: "medium" };
    assert.equal(resolveEffort("executor", issueEffort, globalEffort), "high");
  });

  it("falls back to issue-level default when role not set", () => {
    const issueEffort: EffortConfig = { default: "medium" };
    const globalEffort: EffortConfig = { executor: "low" };
    assert.equal(resolveEffort("executor", issueEffort, globalEffort), "medium");
  });

  it("uses global role-specific effort when issue effort is not set", () => {
    const globalEffort: EffortConfig = { executor: "high" };
    assert.equal(resolveEffort("executor", undefined, globalEffort), "high");
  });

  it("falls back to global default", () => {
    const globalEffort: EffortConfig = { default: "low" };
    assert.equal(resolveEffort("executor", undefined, globalEffort), "low");
  });

  it("returns undefined when no effort configured anywhere", () => {
    assert.equal(resolveEffort("executor", undefined, undefined), undefined);
  });

  it("issue role takes priority over issue default", () => {
    const issueEffort: EffortConfig = { executor: "high", default: "low" };
    assert.equal(resolveEffort("executor", issueEffort, undefined), "high");
  });

  it("issue default takes priority over global role", () => {
    const issueEffort: EffortConfig = { default: "medium" };
    const globalEffort: EffortConfig = { executor: "high" };
    assert.equal(resolveEffort("executor", issueEffort, globalEffort), "medium");
  });

  it("works for planner role", () => {
    const issueEffort: EffortConfig = { planner: "high" };
    assert.equal(resolveEffort("planner", issueEffort, undefined), "high");
  });

  it("works for reviewer role", () => {
    const globalEffort: EffortConfig = { reviewer: "low" };
    assert.equal(resolveEffort("reviewer", undefined, globalEffort), "low");
  });

  it("returns undefined when empty EffortConfig objects provided", () => {
    assert.equal(resolveEffort("executor", {}, {}), undefined);
  });
});

// ── getProviderDefaultCommand() ───────────────────────────────────────────────
// (More exhaustive tests are in commands.test.ts; these verify integration-level behavior)

describe("getProviderDefaultCommand", () => {
  it("generates a valid codex command", () => {
    const cmd = getProviderDefaultCommand("codex");
    assert.ok(cmd.startsWith("codex exec"), "codex command");
    assert.ok(cmd.includes("--skip-git-repo-check"), "has skip flag");
  });

  it("generates a valid claude command", () => {
    const cmd = getProviderDefaultCommand("claude");
    assert.ok(cmd.startsWith("claude "), "claude command");
    assert.ok(cmd.includes("--print"), "has print flag");
    assert.ok(cmd.includes("--output-format json"), "has json output");
  });

  it("returns empty string for unknown provider", () => {
    assert.equal(getProviderDefaultCommand("gpt"), "");
  });

  it("codex command includes model when provided", () => {
    const cmd = getProviderDefaultCommand("codex", undefined, "o3-mini");
    assert.ok(cmd.includes("--model o3-mini"), "has model");
  });

  it("codex command includes reasoning effort when provided", () => {
    const cmd = getProviderDefaultCommand("codex", "high");
    assert.ok(cmd.includes(`reasoning_effort="high"`), "has effort");
  });

  it("claude command includes model when provided", () => {
    const cmd = getProviderDefaultCommand("claude", undefined, "claude-opus-4-6");
    assert.ok(cmd.includes("--model claude-opus-4-6"), "has model");
  });

  it("claude command does NOT include --reasoning-effort (unsupported)", () => {
    const cmd = getProviderDefaultCommand("claude", "high");
    assert.ok(!cmd.includes("reasoning_effort="), "no effort flag for claude");
  });

  it("claude command includes --json-schema (for result parsing)", () => {
    const cmd = getProviderDefaultCommand("claude");
    assert.ok(cmd.includes("--json-schema"), "has json schema");
  });

  it("codex command with both model and effort", () => {
    const cmd = getProviderDefaultCommand("codex", "medium", "o4-mini");
    assert.ok(cmd.includes("--model o4-mini"), "has model");
    assert.ok(cmd.includes(`reasoning_effort="medium"`), "has effort");
  });
});

// ── resolveAgentCommand() ─────────────────────────────────────────────────────

describe("resolveAgentCommand", () => {
  const claudeDefault = getProviderDefaultCommand("claude");
  const codexDefault = getProviderDefaultCommand("codex");

  it("explicit command wins over all others", () => {
    const cmd = resolveAgentCommand("codex", "my explicit cmd", codexDefault, claudeDefault);
    assert.equal(cmd, "my explicit cmd");
  });

  it("trims whitespace from explicit command", () => {
    const cmd = resolveAgentCommand("codex", "  explicit  ", codexDefault, claudeDefault);
    assert.equal(cmd, "explicit");
  });

  it("uses claudeCommand for claude provider when explicit is empty", () => {
    const custom = "claude --print --custom";
    const cmd = resolveAgentCommand("claude", "", codexDefault, custom);
    assert.equal(cmd, custom);
  });

  it("uses codexCommand for codex provider when explicit is empty", () => {
    const custom = "codex exec --custom";
    const cmd = resolveAgentCommand("codex", "", custom, claudeDefault);
    assert.equal(cmd, custom);
  });

  it("falls back to provider default for codex when both commands are empty", () => {
    const cmd = resolveAgentCommand("codex", "", "", "");
    assert.ok(cmd.startsWith("codex exec"), "codex default");
  });

  it("falls back to provider default for claude when both commands are empty", () => {
    const cmd = resolveAgentCommand("claude", "", "", "");
    assert.ok(cmd.startsWith("claude "), "claude default");
  });

  it("reasoningEffort propagates through codex fallback", () => {
    const cmd = resolveAgentCommand("codex", "", "", "", "high");
    assert.ok(cmd.includes(`reasoning_effort="high"`), "effort in fallback");
  });

  it("claudeCommand not used for codex provider", () => {
    const custom = "claude --my-custom-flag";
    const cmd = resolveAgentCommand("codex", "", "", custom);
    assert.ok(!cmd.includes("--my-custom-flag"), "claude cmd not used for codex");
  });

  it("codexCommand not used for claude provider", () => {
    const custom = "codex exec --my-custom-flag";
    const cmd = resolveAgentCommand("claude", "", custom, "");
    assert.ok(!cmd.includes("--my-custom-flag"), "codex cmd not used for claude");
  });

  it("all four providers resolve to distinct commands", () => {
    const codexCmd = resolveAgentCommand("codex", "", "", "");
    const claudeCmd = resolveAgentCommand("claude", "", "", "");
    assert.notEqual(codexCmd, claudeCmd, "different providers produce different commands");
  });
});
