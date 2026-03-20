/**
 * CLI command builder tests.
 *
 * Verifies that model, reasoningEffort, schema, dirs and other flags
 * correctly appear (or don't appear) in generated command strings.
 *
 * Run with: pnpm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPlanDirs,
  CLAUDE_RESULT_SCHEMA,
  REVIEW_RESULT_SCHEMA,
} from "../src/agents/adapters/commands.ts";
import { buildClaudeCommand } from "../src/agents/adapters/claude.ts";
import { buildCodexCommand } from "../src/agents/adapters/codex.ts";
import {
  getProviderDefaultCommand,
  resolveAgentCommand,
} from "../src/agents/providers.ts";
import type { IssuePlan } from "../src/types.ts";

// ── buildClaudeCommand ────────────────────────────────────────────────────────

describe("buildClaudeCommand", () => {
  it("produces the base skeleton", () => {
    const cmd = buildClaudeCommand({});
    assert.ok(cmd.startsWith("claude "), "starts with 'claude '");
    assert.ok(cmd.includes("--print"), "has --print");
    assert.ok(cmd.includes("--dangerously-skip-permissions"), "has tool-access flag");
    assert.ok(cmd.includes("--no-session-persistence"), "has no-session-persistence");
    assert.ok(cmd.includes("--output-format json"), "has output-format json");
    assert.ok(cmd.endsWith('< "$FIFONY_PROMPT_FILE"'), "ends with stdin redirection");
  });

  it("inserts --model right after 'claude' when provided", () => {
    const cmd = buildClaudeCommand({ model: "claude-opus-4-5" });
    const parts = cmd.split(" ");
    assert.equal(parts[0], "claude");
    assert.equal(parts[1], "--model");
    assert.equal(parts[2], "claude-opus-4-5");
  });

  it("does NOT include --model when not provided", () => {
    const cmd = buildClaudeCommand({});
    assert.ok(!cmd.includes("--model"), "no --model flag without model");
  });

  it("includes --json-schema when jsonSchema is provided", () => {
    const cmd = buildClaudeCommand({ jsonSchema: CLAUDE_RESULT_SCHEMA });
    assert.ok(cmd.includes("--json-schema"), "has --json-schema flag");
    assert.ok(cmd.includes(CLAUDE_RESULT_SCHEMA), "schema content is embedded");
  });

  it("omits --json-schema when not provided", () => {
    const cmd = buildClaudeCommand({});
    assert.ok(!cmd.includes("--json-schema"), "no --json-schema without schema");
  });

  it("omits --dangerously-skip-permissions when noToolAccess=true", () => {
    const cmd = buildClaudeCommand({ noToolAccess: true });
    assert.ok(!cmd.includes("--dangerously-skip-permissions"), "no tool access flag");
  });

  it("combines model + schema + noToolAccess correctly", () => {
    const cmd = buildClaudeCommand({
      model: "claude-haiku-4-5",
      jsonSchema: REVIEW_RESULT_SCHEMA,
      noToolAccess: true,
    });
    assert.ok(cmd.includes("--model claude-haiku-4-5"), "has model");
    assert.ok(cmd.includes("--json-schema"), "has schema");
    assert.ok(!cmd.includes("--dangerously-skip-permissions"), "no tool access");
    assert.ok(cmd.includes("--no-session-persistence"), "has session flag");
  });

  it("model appears before --print in the command", () => {
    const cmd = buildClaudeCommand({ model: "claude-sonnet-4-5" });
    const modelIdx = cmd.indexOf("--model");
    const printIdx = cmd.indexOf("--print");
    assert.ok(modelIdx < printIdx, "--model precedes --print");
  });
});

// ── buildCodexCommand ─────────────────────────────────────────────────────────

describe("buildCodexCommand", () => {
  it("produces the base skeleton", () => {
    const cmd = buildCodexCommand({});
    assert.ok(cmd.startsWith("codex exec"), "starts with 'codex exec'");
    assert.ok(cmd.includes("--skip-git-repo-check"), "has skip-git-repo-check");
    assert.ok(cmd.endsWith('< "$FIFONY_PROMPT_FILE"'), "ends with stdin redirection");
  });

  it("includes --model when a non-default model is provided", () => {
    const cmd = buildCodexCommand({ model: "o3-mini" });
    assert.ok(cmd.includes("--model o3-mini"), "has --model o3-mini");
  });

  it("omits --model when model is 'codex' (the default placeholder)", () => {
    const cmd = buildCodexCommand({ model: "codex" });
    assert.ok(!cmd.includes("--model"), "no --model for default 'codex' value");
  });

  it("omits --model when not provided", () => {
    const cmd = buildCodexCommand({});
    assert.ok(!cmd.includes("--model"), "no --model when absent");
  });

  it("includes reasoning_effort config when provided", () => {
    const cmd = buildCodexCommand({ effort: "high" });
    assert.ok(cmd.includes(`reasoning_effort="high"`), "has reasoning_effort high");
  });

  it("includes reasoning_effort medium config", () => {
    const cmd = buildCodexCommand({ effort: "medium" });
    assert.ok(cmd.includes(`reasoning_effort="medium"`), "has reasoning_effort medium");
  });

  it("includes reasoning_effort low config", () => {
    const cmd = buildCodexCommand({ effort: "low" });
    assert.ok(cmd.includes(`reasoning_effort="low"`), "has reasoning_effort low");
  });

  it("omits reasoning_effort when not provided", () => {
    const cmd = buildCodexCommand({});
    assert.ok(!cmd.includes("reasoning_effort="), "no reasoning_effort when absent");
  });

  it("omits reasoning_effort when empty string", () => {
    const cmd = buildCodexCommand({ effort: "" });
    assert.ok(!cmd.includes("reasoning_effort="), "no reasoning_effort for empty string");
  });

  it("adds --add-dir for each directory", () => {
    const cmd = buildCodexCommand({ addDirs: ["/src/a", "/src/b"] });
    assert.ok(cmd.includes('--add-dir "/src/a"'), "has first dir");
    assert.ok(cmd.includes('--add-dir "/src/b"'), "has second dir");
  });

  it("omits --add-dir when array is empty", () => {
    const cmd = buildCodexCommand({ addDirs: [] });
    assert.ok(!cmd.includes("--add-dir"), "no --add-dir for empty array");
  });

  it("combines model + reasoningEffort + addDirs correctly", () => {
    const cmd = buildCodexCommand({
      model: "o4-mini",
      effort: "high",
      addDirs: ["/workspace/src"],
    });
    assert.ok(cmd.includes("--model o4-mini"), "has model");
    assert.ok(cmd.includes(`reasoning_effort="high"`), "has effort");
    assert.ok(cmd.includes('--add-dir "/workspace/src"'), "has dir");
  });

  it("reasoning_effort config appears before --add-dir flags", () => {
    const cmd = buildCodexCommand({
      effort: "medium",
      addDirs: ["/src"],
    });
    const effortIdx = cmd.indexOf('reasoning_effort="medium"');
    const addDirIdx = cmd.indexOf("--add-dir");
    assert.ok(effortIdx >= 0, "reasoning_effort should be present");
    assert.ok(addDirIdx >= 0, "add-dir should be present");
    assert.ok(effortIdx < addDirIdx, "reasoning_effort precedes --add-dir");
  });
});

// ── extractPlanDirs ───────────────────────────────────────────────────────────

describe("extractPlanDirs", () => {
  const basePlan = {
    steps: [],
    estimatedComplexity: "medium",
  } as unknown as IssuePlan;

  it("returns empty array when suggestedPaths is absent", () => {
    const result = extractPlanDirs({ ...basePlan, suggestedPaths: undefined });
    assert.deepEqual(result, []);
  });

  it("returns empty array when suggestedPaths is empty", () => {
    const result = extractPlanDirs({ ...basePlan, suggestedPaths: [] });
    assert.deepEqual(result, []);
  });

  it("extracts directory from a file path", () => {
    const result = extractPlanDirs({ ...basePlan, suggestedPaths: ["src/utils/helpers.ts"] });
    assert.deepEqual(result, ["src/utils"]);
  });

  it("deduplicates directories from multiple files in the same dir", () => {
    const result = extractPlanDirs({
      ...basePlan,
      suggestedPaths: ["src/utils/a.ts", "src/utils/b.ts"],
    });
    assert.deepEqual(result, ["src/utils"]);
  });

  it("keeps bare directories (no extension, no slash) as-is", () => {
    const result = extractPlanDirs({ ...basePlan, suggestedPaths: ["src"] });
    assert.deepEqual(result, ["src"]);
  });

  it("handles mix of file paths and directory names", () => {
    const result = extractPlanDirs({
      ...basePlan,
      suggestedPaths: ["src/index.ts", "tests"],
    });
    assert.ok(result.includes("src"), "has src");
    assert.ok(result.includes("tests"), "has tests");
  });
});

// ── getProviderDefaultCommand ─────────────────────────────────────────────────

describe("getProviderDefaultCommand", () => {
  it("returns codex command for codex provider", () => {
    const cmd = getProviderDefaultCommand("codex");
    assert.ok(cmd.startsWith("codex exec"), "starts with codex exec");
    assert.ok(cmd.includes("--skip-git-repo-check"), "has skip flag");
  });

  it("returns claude command for claude provider", () => {
    const cmd = getProviderDefaultCommand("claude");
    assert.ok(cmd.startsWith("claude "), "starts with claude");
    assert.ok(cmd.includes("--print"), "has --print");
  });

  it("returns empty string for unknown provider", () => {
    const cmd = getProviderDefaultCommand("unknown");
    assert.equal(cmd, "");
  });

  it("passes reasoningEffort into codex command", () => {
    const cmd = getProviderDefaultCommand("codex", "high");
    assert.ok(cmd.includes(`reasoning_effort="high"`), "effort in codex default");
  });

  it("does NOT inject reasoning-effort into claude command (unsupported flag)", () => {
    const cmd = getProviderDefaultCommand("claude", "high");
    assert.ok(!cmd.includes("reasoning_effort="), "no effort flag in claude");
  });

  it("passes model into codex command", () => {
    const cmd = getProviderDefaultCommand("codex", undefined, "o3-mini");
    assert.ok(cmd.includes("--model o3-mini"), "model in codex default");
  });

  it("passes model into claude command", () => {
    const cmd = getProviderDefaultCommand("claude", undefined, "claude-sonnet-4-5");
    assert.ok(cmd.includes("--model claude-sonnet-4-5"), "model in claude default");
  });

  it("passes both reasoningEffort and model to codex", () => {
    const cmd = getProviderDefaultCommand("codex", "medium", "o4-mini");
    assert.ok(cmd.includes("--model o4-mini"), "model present");
    assert.ok(cmd.includes(`reasoning_effort="medium"`), "effort present");
  });

  it("codex default includes CLAUDE_RESULT_SCHEMA for claude", () => {
    const cmd = getProviderDefaultCommand("claude");
    assert.ok(cmd.includes("--json-schema"), "claude default has json-schema");
  });
});

// ── resolveAgentCommand ───────────────────────────────────────────────────────

describe("resolveAgentCommand", () => {
  const codexDefault = buildCodexCommand({});
  const claudeDefault = buildClaudeCommand({ jsonSchema: CLAUDE_RESULT_SCHEMA });

  it("returns explicit command when provided (overrides everything)", () => {
    const cmd = resolveAgentCommand("codex", "my custom command", codexDefault, claudeDefault);
    assert.equal(cmd, "my custom command");
  });

  it("trims explicit command", () => {
    const cmd = resolveAgentCommand("codex", "  my cmd  ", codexDefault, claudeDefault);
    assert.equal(cmd, "my cmd");
  });

  it("uses claudeCommand when provider is claude and claudeCommand is set", () => {
    const customClaude = "claude --print --custom-flag < \"$FIFONY_PROMPT_FILE\"";
    const cmd = resolveAgentCommand("claude", "", codexDefault, customClaude);
    assert.equal(cmd, customClaude);
  });

  it("uses codexCommand when provider is codex and codexCommand is set", () => {
    const customCodex = "codex exec --my-flag < \"$FIFONY_PROMPT_FILE\"";
    const cmd = resolveAgentCommand("codex", "", customCodex, claudeDefault);
    assert.equal(cmd, customCodex);
  });

  it("falls back to getProviderDefaultCommand for codex when no explicit commands", () => {
    const cmd = resolveAgentCommand("codex", "", "", "", "high");
    assert.ok(cmd.startsWith("codex exec"), "falls back to codex default");
    assert.ok(cmd.includes(`reasoning_effort="high"`), "effort propagated in fallback");
  });

  it("falls back to getProviderDefaultCommand for claude when no explicit commands", () => {
    const cmd = resolveAgentCommand("claude", "", "", "");
    assert.ok(cmd.startsWith("claude "), "falls back to claude default");
    assert.ok(cmd.includes("--print"), "has --print in fallback");
  });

  it("explicit command takes priority over provider-specific command", () => {
    const cmd = resolveAgentCommand("claude", "explicit!", "codex-cmd", "claude-cmd");
    assert.equal(cmd, "explicit!");
  });

  it("codex provider-specific command not used for claude provider", () => {
    const customCodex = "codex exec --custom";
    const cmd = resolveAgentCommand("claude", "", customCodex, "");
    // codexCommand is set but provider is claude — should NOT use codexCommand
    assert.ok(!cmd.includes("--custom"), "codex command not used for claude provider");
  });

  it("claude provider-specific command not used for codex provider", () => {
    const customClaude = "claude --custom-thing";
    const cmd = resolveAgentCommand("codex", "", "", customClaude);
    // claudeCommand is set but provider is codex — should NOT use claudeCommand
    assert.ok(!cmd.includes("--custom-thing"), "claude command not used for codex provider");
  });
});
