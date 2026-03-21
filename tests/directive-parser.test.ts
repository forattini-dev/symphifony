/**
 * Tests for directive-parser.ts — the core module that interprets
 * agent execution output (stdout, result.json, markers) into structured
 * AgentDirective objects.
 *
 * Also covers: Gemini CLI command builder (zero previous tests).
 *
 * Run with: pnpm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeAgentDirectiveStatus,
  extractOutputMarker,
  extractTokenUsage,
  tryParseJsonOutput,
  readAgentDirective,
  addTokenUsage,
} from "../src/agents/directive-parser.ts";
import { buildGeminiCommand } from "../src/agents/adapters/gemini.ts";
import { buildClaudeCommand } from "../src/agents/adapters/claude.ts";
import { buildCodexCommand } from "../src/agents/adapters/codex.ts";
import { buildImagePromptSection } from "../src/agents/adapters/shared.ts";
import type { IssueEntry, AgentTokenUsage } from "../src/types.ts";


// ══════════════════════════════════════════════════════════════════════════════
// normalizeAgentDirectiveStatus
// ══════════════════════════════════════════════════════════════════════════════

describe("normalizeAgentDirectiveStatus", () => {
  it("passes through valid statuses", () => {
    assert.equal(normalizeAgentDirectiveStatus("done", "failed"), "done");
    assert.equal(normalizeAgentDirectiveStatus("continue", "failed"), "continue");
    assert.equal(normalizeAgentDirectiveStatus("blocked", "failed"), "blocked");
    assert.equal(normalizeAgentDirectiveStatus("failed", "done"), "failed");
  });

  it("normalizes case and whitespace", () => {
    assert.equal(normalizeAgentDirectiveStatus("Done", "failed"), "done");
    assert.equal(normalizeAgentDirectiveStatus("BLOCKED", "failed"), "blocked");
    assert.equal(normalizeAgentDirectiveStatus("  continue  ", "failed"), "continue");
  });

  it("returns fallback for invalid values", () => {
    assert.equal(normalizeAgentDirectiveStatus("success", "done"), "done");
    assert.equal(normalizeAgentDirectiveStatus("error", "failed"), "failed");
    assert.equal(normalizeAgentDirectiveStatus("", "done"), "done");
    assert.equal(normalizeAgentDirectiveStatus(null, "blocked"), "blocked");
    assert.equal(normalizeAgentDirectiveStatus(undefined, "done"), "done");
    assert.equal(normalizeAgentDirectiveStatus(123, "failed"), "failed");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// extractOutputMarker
// ══════════════════════════════════════════════════════════════════════════════

describe("extractOutputMarker", () => {
  it("extracts a marker value from output", () => {
    const output = "some output\nFIFONY_STATUS=done\nmore output";
    assert.equal(extractOutputMarker(output, "FIFONY_STATUS"), "done");
  });

  it("extracts FIFONY_SUMMARY marker", () => {
    const output = "log line\nFIFONY_SUMMARY=Added JWT validation middleware\nend";
    assert.equal(extractOutputMarker(output, "FIFONY_SUMMARY"), "Added JWT validation middleware");
  });

  it("is case-insensitive", () => {
    const output = "fifony_status=Continue\n";
    assert.equal(extractOutputMarker(output, "FIFONY_STATUS"), "Continue");
  });

  it("trims whitespace from value", () => {
    const output = "FIFONY_STATUS=  blocked  \n";
    assert.equal(extractOutputMarker(output, "FIFONY_STATUS"), "blocked");
  });

  it("returns empty string when marker not found", () => {
    assert.equal(extractOutputMarker("no markers here", "FIFONY_STATUS"), "");
    assert.equal(extractOutputMarker("", "FIFONY_STATUS"), "");
  });

  it("extracts first occurrence when marker appears multiple times", () => {
    const output = "FIFONY_STATUS=done\nFIFONY_STATUS=failed\n";
    assert.equal(extractOutputMarker(output, "FIFONY_STATUS"), "done");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// extractTokenUsage (from directive-parser, not planning-parser)
// ══════════════════════════════════════════════════════════════════════════════

describe("extractTokenUsage", () => {
  describe("from JSON object with modelUsage", () => {
    it("extracts token counts including cache tokens", () => {
      const json = {
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 50,
            cacheCreationInputTokens: 10,
          },
        },
      };

      const usage = extractTokenUsage("", json);
      assert.ok(usage);
      assert.equal(usage!.inputTokens, 160); // 100 + 50 + 10
      assert.equal(usage!.outputTokens, 20);
      assert.equal(usage!.totalTokens, 180);
      assert.equal(usage!.model, "claude-sonnet-4-6");
    });

    it("sums across multiple models and picks primary", () => {
      const json = {
        modelUsage: {
          "claude-sonnet-4-6": { inputTokens: 200, outputTokens: 50 },
          "claude-haiku-4-5": { inputTokens: 30, outputTokens: 5 },
        },
      };

      const usage = extractTokenUsage("", json);
      assert.ok(usage);
      assert.equal(usage!.inputTokens, 230);
      assert.equal(usage!.outputTokens, 55);
      assert.equal(usage!.model, "claude-sonnet-4-6"); // highest total
    });

    it("includes cost_usd when present", () => {
      const json = {
        cost_usd: 0.0042,
        modelUsage: { "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 20 } },
      };

      const usage = extractTokenUsage("", json);
      assert.equal(usage!.costUsd, 0.0042);
    });
  });

  describe("from JSON object with usage field (fallback)", () => {
    it("extracts input_tokens and output_tokens", () => {
      const json = {
        model: "claude-opus-4-6",
        usage: { input_tokens: 300, output_tokens: 80 },
      };

      const usage = extractTokenUsage("", json);
      assert.ok(usage);
      assert.equal(usage!.inputTokens, 300);
      assert.equal(usage!.outputTokens, 80);
      assert.equal(usage!.totalTokens, 380);
      assert.equal(usage!.model, "claude-opus-4-6");
    });

    it("returns undefined when usage has zeros", () => {
      const json = { usage: { input_tokens: 0, output_tokens: 0 } };
      assert.equal(extractTokenUsage("", json), undefined);
    });
  });

  describe("from Gemini --output-format json (stats.models)", () => {
    // Real fixture captured from: echo "PONG" | gemini --output-format json -p ""
    it("extracts tokens from stats.models per-model breakdown", () => {
      const json = {
        response: "PONG",
        stats: {
          models: {
            "gemini-2.5-flash-lite": {
              tokens: { input: 807, prompt: 2702, candidates: 28, total: 2805, cached: 1895, thoughts: 75, tool: 0 },
            },
          },
        },
      };

      const usage = extractTokenUsage("", json);
      assert.ok(usage);
      assert.equal(usage!.inputTokens, 807 + 1895); // input + cached
      assert.equal(usage!.outputTokens, 28); // candidates
      assert.equal(usage!.model, "gemini-2.5-flash-lite");
    });

    it("sums across multiple Gemini models and picks primary", () => {
      const json = {
        response: "done",
        stats: {
          models: {
            "gemini-2.5-flash-lite": {
              tokens: { input: 807, candidates: 28, total: 2805, cached: 1895 },
            },
            "gemini-3-flash-preview": {
              tokens: { input: 9004, candidates: 2, total: 9091, cached: 0 },
            },
          },
        },
      };

      const usage = extractTokenUsage("", json);
      assert.ok(usage);
      // flash-lite: 807+1895=2702 input, 28 output
      // 3-flash: 9004+0=9004 input, 2 output
      assert.equal(usage!.inputTokens, 2702 + 9004);
      assert.equal(usage!.outputTokens, 28 + 2);
      assert.equal(usage!.model, "gemini-3-flash-preview"); // highest total
    });

    it("returns undefined when stats.models has zero tokens", () => {
      const json = {
        response: "x",
        stats: { models: { "gemini-2.5-flash": { tokens: { input: 0, candidates: 0, total: 0 } } } },
      };
      assert.equal(extractTokenUsage("", json), undefined);
    });
  });

  describe("from Codex text format", () => {
    it("parses 'tokens used\\n{count}' pattern", () => {
      const output = "done\n\ntokens used\n2,345\n";
      const usage = extractTokenUsage(output);
      assert.ok(usage);
      assert.equal(usage!.totalTokens, 2345);
      assert.equal(usage!.inputTokens, 0); // Codex doesn't split
      assert.equal(usage!.outputTokens, 0);
    });

    it("parses without comma separator", () => {
      const usage = extractTokenUsage("ok\n\nTokens Used\n842\n");
      assert.ok(usage);
      assert.equal(usage!.totalTokens, 842);
    });

    it("extracts model from output", () => {
      const output = "model: gpt-5.3\ntokens used\n1000\n";
      const usage = extractTokenUsage(output);
      assert.equal(usage!.model, "gpt-5.3");
    });
  });

  describe("edge cases", () => {
    it("returns undefined for empty string with no JSON", () => {
      assert.equal(extractTokenUsage(""), undefined);
    });

    it("returns undefined for plain text with no token info", () => {
      assert.equal(extractTokenUsage("just some text output"), undefined);
    });

    it("returns undefined when JSON has no usage fields", () => {
      assert.equal(extractTokenUsage("", { result: "ok" }), undefined);
    });

    it("prefers modelUsage over stats.models when both present", () => {
      const json = {
        modelUsage: { "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 20 } },
        stats: { models: { "gemini-2.5-flash": { tokens: { input: 999, candidates: 999, total: 999 } } } },
      };
      const usage = extractTokenUsage("", json);
      assert.equal(usage!.inputTokens, 100); // from modelUsage, not gemini stats
    });

    it("prefers modelUsage over usage when both present", () => {
      const json = {
        modelUsage: { "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 20 } },
        usage: { input_tokens: 999, output_tokens: 999 },
      };
      const usage = extractTokenUsage("", json);
      assert.equal(usage!.inputTokens, 100); // from modelUsage, not usage
    });
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// tryParseJsonOutput
// ══════════════════════════════════════════════════════════════════════════════

describe("tryParseJsonOutput", () => {
  it("parses structured_output from Claude --json-schema mode", () => {
    const output = JSON.stringify({
      type: "result",
      structured_output: { status: "done", summary: "Completed task" },
    });
    const result = tryParseJsonOutput(output);
    assert.deepEqual(result, { status: "done", summary: "Completed task" });
  });

  it("parses result string containing nested JSON", () => {
    const output = JSON.stringify({
      type: "result",
      result: JSON.stringify({ status: "done", summary: "Inner result" }),
    });
    const result = tryParseJsonOutput(output);
    assert.deepEqual(result, { status: "done", summary: "Inner result" });
  });

  it("returns object directly when it has a status field", () => {
    const output = JSON.stringify({ status: "continue", summary: "Still working" });
    const result = tryParseJsonOutput(output);
    assert.deepEqual(result, { status: "continue", summary: "Still working" });
  });

  it("returns null for result string that is not JSON", () => {
    const output = JSON.stringify({
      type: "result",
      result: "This is just plain text output from the agent.",
    });
    const result = tryParseJsonOutput(output);
    // result is a string that can't be parsed as JSON, and the outer object has no .status
    assert.equal(result, null);
  });

  it("parses Gemini response field containing nested JSON", () => {
    const output = JSON.stringify({
      response: JSON.stringify({ status: "done", summary: "Gemini result" }),
      stats: { models: {} },
    });
    const result = tryParseJsonOutput(output);
    assert.deepEqual(result, { status: "done", summary: "Gemini result" });
  });

  it("returns null when Gemini response is plain text (not JSON)", () => {
    const output = JSON.stringify({
      response: "Just a plain text response from Gemini",
      stats: { models: {} },
    });
    const result = tryParseJsonOutput(output);
    assert.equal(result, null);
  });

  it("returns null for non-JSON input", () => {
    assert.equal(tryParseJsonOutput("not json at all"), null);
    assert.equal(tryParseJsonOutput(""), null);
  });

  it("returns null for JSON arrays", () => {
    assert.equal(tryParseJsonOutput("[1, 2, 3]"), null);
  });

  it("returns null for JSON object without status or structured_output", () => {
    const output = JSON.stringify({ type: "result", cost: 0.01 });
    assert.equal(tryParseJsonOutput(output), null);
  });

  it("handles whitespace around JSON", () => {
    const output = "  \n" + JSON.stringify({ status: "done", summary: "ok" }) + "\n  ";
    const result = tryParseJsonOutput(output);
    assert.equal(result?.status, "done");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// readAgentDirective — full integration of all parsers
// ══════════════════════════════════════════════════════════════════════════════

describe("readAgentDirective", () => {
  describe("from structured JSON stdout (Claude --json-schema)", () => {
    it("reads directive from structured_output envelope", () => {
      const output = JSON.stringify({
        type: "result",
        structured_output: {
          status: "done",
          summary: "Task completed successfully",
          nextPrompt: "Review the changes",
        },
        modelUsage: {
          "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 20 },
        },
      });

      const directive = readAgentDirective("/tmp/fake", output, true);
      assert.equal(directive.status, "done");
      assert.equal(directive.summary, "Task completed successfully");
      assert.equal(directive.nextPrompt, "Review the changes");
      assert.ok(directive.tokenUsage);
      assert.equal(directive.tokenUsage!.totalTokens, 120);
    });

    it("reads directive from result string containing JSON", () => {
      const output = JSON.stringify({
        type: "result",
        result: JSON.stringify({
          status: "continue",
          summary: "Need more turns",
          nextPrompt: "Continue with step 3",
        }),
      });

      const directive = readAgentDirective("/tmp/fake", output, true);
      assert.equal(directive.status, "continue");
      assert.equal(directive.summary, "Need more turns");
      assert.equal(directive.nextPrompt, "Continue with step 3");
    });
  });

  describe("from result.json file", () => {
    it("reads directive from result.json when stdout has no JSON", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "directive-test-"));
      try {
        writeFileSync(
          join(tempDir, "result.json"),
          JSON.stringify({ status: "blocked", summary: "Missing dependency", nextPrompt: "" }),
        );

        const directive = readAgentDirective(tempDir, "plain text output with no JSON", false);
        assert.equal(directive.status, "blocked");
        assert.equal(directive.summary, "Missing dependency");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("handles invalid result.json gracefully", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "directive-bad-json-"));
      try {
        writeFileSync(join(tempDir, "result.json"), "not valid json {{{");

        const directive = readAgentDirective(tempDir, "output", true);
        // Should not crash — falls through to marker/fallback parsing
        assert.equal(directive.status, "done"); // success=true → fallback "done"
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("from output markers", () => {
    it("reads status and summary from FIFONY_ markers", () => {
      const output = [
        "some agent output...",
        "FIFONY_STATUS=blocked",
        "FIFONY_SUMMARY=Cannot proceed without API key",
      ].join("\n");

      const directive = readAgentDirective("/tmp/nonexistent", output, false);
      assert.equal(directive.status, "blocked");
      assert.equal(directive.summary, "Cannot proceed without API key");
    });
  });

  describe("fallback behavior", () => {
    it("returns done when success=true and no structured output", () => {
      const directive = readAgentDirective("/tmp/nonexistent", "plain output", true);
      assert.equal(directive.status, "done");
    });

    it("returns failed when success=false and no structured output", () => {
      const directive = readAgentDirective("/tmp/nonexistent", "error happened", false);
      assert.equal(directive.status, "failed");
    });

    it("returns empty summary and nextPrompt by default", () => {
      const directive = readAgentDirective("/tmp/nonexistent", "", true);
      assert.equal(directive.summary, "");
      assert.equal(directive.nextPrompt, "");
    });
  });

  describe("token usage extraction in directive", () => {
    it("extracts Claude token usage from stdout JSON", () => {
      const output = JSON.stringify({
        type: "result",
        structured_output: { status: "done", summary: "ok" },
        modelUsage: {
          "claude-sonnet-4-6": { inputTokens: 500, outputTokens: 100, cacheReadInputTokens: 200 },
        },
      });

      const directive = readAgentDirective("/tmp/fake", output, true);
      assert.ok(directive.tokenUsage);
      assert.equal(directive.tokenUsage!.inputTokens, 700); // 500 + 200
      assert.equal(directive.tokenUsage!.outputTokens, 100);
      assert.equal(directive.tokenUsage!.model, "claude-sonnet-4-6");
    });

    it("extracts Codex token usage from text output", () => {
      const output = "Task done.\n\nmodel: gpt-5.3\ntokens used\n3,500\n";
      const directive = readAgentDirective("/tmp/nonexistent", output, true);
      assert.ok(directive.tokenUsage);
      assert.equal(directive.tokenUsage!.totalTokens, 3500);
      assert.equal(directive.tokenUsage!.model, "gpt-5.3");
    });

    it("extracts Gemini token usage from stats.models in JSON output", () => {
      const output = JSON.stringify({
        response: JSON.stringify({ status: "done", summary: "Gemini completed" }),
        stats: {
          models: {
            "gemini-2.5-flash-lite": {
              tokens: { input: 807, candidates: 28, total: 2805, cached: 1895 },
            },
          },
          files: { totalLinesAdded: 5, totalLinesRemoved: 2 },
        },
      });

      const directive = readAgentDirective("/tmp/fake", output, true);
      assert.ok(directive.tokenUsage, "should extract Gemini token usage");
      assert.equal(directive.tokenUsage!.inputTokens, 807 + 1895); // input + cached
      assert.equal(directive.tokenUsage!.outputTokens, 28); // candidates
      assert.equal(directive.tokenUsage!.model, "gemini-2.5-flash-lite");
    });
  });

  describe("priority: JSON stdout > result.json > markers > fallback", () => {
    it("prefers stdout JSON over result.json", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "directive-priority-"));
      try {
        writeFileSync(
          join(tempDir, "result.json"),
          JSON.stringify({ status: "blocked", summary: "from file" }),
        );

        const output = JSON.stringify({
          type: "result",
          structured_output: { status: "done", summary: "from stdout" },
        });

        const directive = readAgentDirective(tempDir, output, true);
        assert.equal(directive.status, "done");
        assert.equal(directive.summary, "from stdout");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// addTokenUsage — token aggregation across turns/phases/models
// ══════════════════════════════════════════════════════════════════════════════

describe("addTokenUsage", () => {
  function makeIssue(): IssueEntry {
    return {
      id: "test", identifier: "T-1", title: "", description: "",
      state: "Running", labels: [], blockedBy: [],
      assignedToWorker: false, createdAt: "", updatedAt: "",
      history: [], attempts: 0, maxAttempts: 3,
      planVersion: 0, executeAttempt: 0, reviewAttempt: 0,
    } as IssueEntry;
  }

  it("initializes tokenUsage on first call", () => {
    const issue = makeIssue();
    addTokenUsage(issue, { inputTokens: 100, outputTokens: 20, totalTokens: 120, model: "claude-sonnet-4-6" });

    assert.deepEqual(issue.tokenUsage, {
      inputTokens: 100, outputTokens: 20, totalTokens: 120, model: "claude-sonnet-4-6",
    });
  });

  it("accumulates across multiple calls", () => {
    const issue = makeIssue();
    addTokenUsage(issue, { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    addTokenUsage(issue, { inputTokens: 50, outputTokens: 10, totalTokens: 60 });

    assert.equal(issue.tokenUsage!.inputTokens, 150);
    assert.equal(issue.tokenUsage!.outputTokens, 30);
    assert.equal(issue.tokenUsage!.totalTokens, 180);
  });

  it("tracks per-phase breakdown when role is provided", () => {
    const issue = makeIssue();
    addTokenUsage(issue, { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, "planner");
    addTokenUsage(issue, { inputTokens: 200, outputTokens: 50, totalTokens: 250 }, "executor");

    assert.equal(issue.tokensByPhase!.planner.totalTokens, 120);
    assert.equal(issue.tokensByPhase!.executor.totalTokens, 250);
  });

  it("tracks per-model breakdown", () => {
    const issue = makeIssue();
    addTokenUsage(issue, { inputTokens: 100, outputTokens: 20, totalTokens: 120, model: "claude-sonnet-4-6" });
    addTokenUsage(issue, { inputTokens: 50, outputTokens: 10, totalTokens: 60, model: "claude-haiku-4-5" });

    assert.equal(issue.tokensByModel!["claude-sonnet-4-6"].totalTokens, 120);
    assert.equal(issue.tokensByModel!["claude-haiku-4-5"].totalTokens, 60);
  });

  it("accumulates per-model when same model used multiple times", () => {
    const issue = makeIssue();
    addTokenUsage(issue, { inputTokens: 100, outputTokens: 20, totalTokens: 120, model: "claude-sonnet-4-6" });
    addTokenUsage(issue, { inputTokens: 100, outputTokens: 20, totalTokens: 120, model: "claude-sonnet-4-6" });

    assert.equal(issue.tokensByModel!["claude-sonnet-4-6"].totalTokens, 240);
  });

  it("updates legacy usage.tokens for EventualConsistency", () => {
    const issue = makeIssue();
    addTokenUsage(issue, { inputTokens: 100, outputTokens: 20, totalTokens: 120, model: "claude-sonnet-4-6" });

    assert.equal(issue.usage!.tokens["claude-sonnet-4-6"], 120);
  });

  it("is a no-op when usage is undefined", () => {
    const issue = makeIssue();
    addTokenUsage(issue, undefined);
    assert.equal(issue.tokenUsage, undefined);
  });

  it("is a no-op when totalTokens is 0", () => {
    const issue = makeIssue();
    addTokenUsage(issue, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.equal(issue.tokenUsage, undefined);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// buildGeminiCommand — CLI command builder for Gemini (ZERO previous tests)
// ══════════════════════════════════════════════════════════════════════════════

describe("buildGeminiCommand", () => {
  it("produces the base skeleton", () => {
    const cmd = buildGeminiCommand({});
    assert.ok(cmd.startsWith("gemini"), "starts with 'gemini'");
    assert.ok(cmd.includes("--yolo"), "has --yolo flag");
    assert.ok(cmd.includes('-p ""'), "has -p for headless mode");
    assert.ok(cmd.endsWith('< "$FIFONY_PROMPT_FILE"'), "ends with stdin redirection");
  });

  it("includes --model when provided", () => {
    const cmd = buildGeminiCommand({ model: "gemini-2.0-flash" });
    assert.ok(cmd.includes("--model gemini-2.0-flash"));
  });

  it("omits --model when not provided", () => {
    const cmd = buildGeminiCommand({});
    assert.ok(!cmd.includes("--model"));
  });

  it("includes --include-directories with comma-separated quoted paths", () => {
    const cmd = buildGeminiCommand({ addDirs: ["/src/a", "/src/b"] });
    assert.ok(cmd.includes('--include-directories "/src/a","/src/b"'));
  });

  it("omits --include-directories when array is empty", () => {
    const cmd = buildGeminiCommand({ addDirs: [] });
    assert.ok(!cmd.includes("--include-directories"));
  });

  it("omits --include-directories when not provided", () => {
    const cmd = buildGeminiCommand({});
    assert.ok(!cmd.includes("--include-directories"));
  });

  it("combines model + directories correctly", () => {
    const cmd = buildGeminiCommand({
      model: "gemini-2.5-pro",
      addDirs: ["/workspace/src"],
    });
    assert.ok(cmd.includes("--model gemini-2.5-pro"));
    assert.ok(cmd.includes('--include-directories "/workspace/src"'));
    assert.ok(cmd.includes("--yolo"));
  });

  it("does NOT include reasoning_effort (Gemini has no such flag)", () => {
    const cmd = buildGeminiCommand({ effort: "high" });
    assert.ok(!cmd.includes("reasoning_effort"));
    assert.ok(!cmd.includes("effort"));
  });

  it("does NOT include --json-schema (Gemini uses embedded contract)", () => {
    const cmd = buildGeminiCommand({ jsonSchema: '{"type":"object"}' });
    assert.ok(!cmd.includes("--json-schema"));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Image handling strategy — differs per CLI capability
//
// Validated against actual CLI help output:
//   claude --help → NO --image flag (uses prompt embedding)
//   codex --help  → HAS --image <FILE> flag
//   gemini --help → NO --image flag (uses prompt embedding)
// ══════════════════════════════════════════════════════════════════════════════

describe("buildImagePromptSection", () => {
  it("embeds a PNG image as base64 data URI in markdown", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "img-test-"));
    const imgPath = join(tempDir, "screenshot.png");
    // 1x1 red pixel PNG
    const pngData = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64");
    writeFileSync(imgPath, pngData);

    try {
      const section = buildImagePromptSection([imgPath]);
      assert.ok(section.includes("## Attached Images"), "has header");
      assert.ok(section.includes("screenshot.png"), "has filename");
      assert.ok(section.includes("data:image/png;base64,"), "has base64 data URI");
      assert.ok(section.includes("![screenshot.png]"), "has markdown image syntax");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles JPEG images with correct mime type", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "img-test-"));
    const imgPath = join(tempDir, "photo.jpg");
    writeFileSync(imgPath, Buffer.from("fake-jpeg-data"));

    try {
      const section = buildImagePromptSection([imgPath]);
      assert.ok(section.includes("data:image/jpeg;base64,"), "uses image/jpeg mime");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles multiple images", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "img-test-"));
    writeFileSync(join(tempDir, "a.png"), Buffer.from("png-a"));
    writeFileSync(join(tempDir, "b.png"), Buffer.from("png-b"));

    try {
      const section = buildImagePromptSection([join(tempDir, "a.png"), join(tempDir, "b.png")]);
      assert.ok(section.includes("a.png"), "has first image");
      assert.ok(section.includes("b.png"), "has second image");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns empty string when no images exist", () => {
    assert.equal(buildImagePromptSection(["/nonexistent/path.png"]), "");
  });

  it("returns empty string for empty array", () => {
    assert.equal(buildImagePromptSection([]), "");
  });

  it("skips non-existent files but includes existing ones", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "img-test-"));
    writeFileSync(join(tempDir, "real.png"), Buffer.from("data"));

    try {
      const section = buildImagePromptSection(["/nonexistent.png", join(tempDir, "real.png")]);
      assert.ok(section.includes("real.png"), "includes existing file");
      assert.ok(!section.includes("nonexistent"), "skips missing file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});


describe("image strategy per adapter CLI", () => {
  // Codex: uses --image flag (confirmed via `codex --help`)
  describe("codex: images via --image CLI flag", () => {
    it("adds --image flags for each image path", () => {
      const cmd = buildCodexCommand({ imagePaths: ["/tmp/a.png", "/tmp/b.jpg"] });
      assert.ok(cmd.includes('--image "/tmp/a.png"'), "has first image flag");
      assert.ok(cmd.includes('--image "/tmp/b.jpg"'), "has second image flag");
    });

    it("omits --image when no images", () => {
      const cmd = buildCodexCommand({});
      assert.ok(!cmd.includes("--image"));
    });

    it("omits --image for empty array", () => {
      const cmd = buildCodexCommand({ imagePaths: [] });
      assert.ok(!cmd.includes("--image"));
    });
  });

  // Claude: NO --image flag (confirmed via `claude --help`)
  describe("claude: NO --image flag (uses prompt embedding)", () => {
    it("does NOT include --image flag even when imagePaths provided", () => {
      const cmd = buildClaudeCommand({ imagePaths: ["/tmp/screenshot.png"] });
      assert.ok(!cmd.includes("--image"), "claude CLI has no --image flag");
    });
  });

  // Gemini: NO --image flag (confirmed via `gemini --help`)
  describe("gemini: NO --image flag (uses prompt embedding)", () => {
    it("does NOT include --image flag even when imagePaths provided", () => {
      const cmd = buildGeminiCommand({ imagePaths: ["/tmp/screenshot.png"] });
      assert.ok(!cmd.includes("--image"), "gemini CLI has no --image flag");
    });
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// CLI-specific features — validated against --help output
// ══════════════════════════════════════════════════════════════════════════════

describe("claude: --max-budget-usd (confirmed via claude --help)", () => {
  it("includes --max-budget-usd when set", () => {
    const cmd = buildClaudeCommand({ maxBudgetUsd: 0.50 });
    assert.ok(cmd.includes("--max-budget-usd 0.5"), "should include budget flag");
  });

  it("omits --max-budget-usd when not set", () => {
    const cmd = buildClaudeCommand({});
    assert.ok(!cmd.includes("--max-budget-usd"), "should not include budget flag");
  });

  it("omits --max-budget-usd when 0", () => {
    const cmd = buildClaudeCommand({ maxBudgetUsd: 0 });
    assert.ok(!cmd.includes("--max-budget-usd"), "zero budget should be omitted");
  });
});


describe("claude: --permission-mode plan (confirmed via claude --help)", () => {
  it("uses --permission-mode plan when readOnly=true", () => {
    const cmd = buildClaudeCommand({ readOnly: true });
    assert.ok(cmd.includes("--permission-mode plan"), "should use plan mode");
    assert.ok(!cmd.includes("--dangerously-skip-permissions"), "should NOT have skip-permissions");
  });

  it("uses --dangerously-skip-permissions when readOnly=false", () => {
    const cmd = buildClaudeCommand({ readOnly: false });
    assert.ok(cmd.includes("--dangerously-skip-permissions"));
    assert.ok(!cmd.includes("--permission-mode"), "should not have permission-mode");
  });

  it("readOnly takes priority over noToolAccess", () => {
    const cmd = buildClaudeCommand({ readOnly: true, noToolAccess: true });
    assert.ok(cmd.includes("--permission-mode plan"));
    assert.ok(!cmd.includes("--dangerously-skip-permissions"));
  });
});


describe("codex: --search (confirmed via codex --help)", () => {
  it("includes --search when enabled", () => {
    const cmd = buildCodexCommand({ search: true });
    assert.ok(cmd.includes("--search"), "should include search flag");
  });

  it("omits --search when not set", () => {
    const cmd = buildCodexCommand({});
    assert.ok(!cmd.includes("--search"));
  });

  it("omits --search when false", () => {
    const cmd = buildCodexCommand({ search: false });
    assert.ok(!cmd.includes("--search"));
  });

  it("combines --search with other flags", () => {
    const cmd = buildCodexCommand({ model: "o4-mini", effort: "high", search: true });
    assert.ok(cmd.includes("--search"));
    assert.ok(cmd.includes("--model o4-mini"));
    assert.ok(cmd.includes('reasoning_effort="high"'));
  });
});


describe("gemini: --output-format json (confirmed via gemini --help)", () => {
  it("always includes --output-format json", () => {
    const cmd = buildGeminiCommand({});
    assert.ok(cmd.includes("--output-format json"), "should always output JSON");
  });

  it("still includes --output-format json with model", () => {
    const cmd = buildGeminiCommand({ model: "gemini-2.5-pro" });
    assert.ok(cmd.includes("--output-format json"));
  });
});


describe("gemini: --approval-mode plan (confirmed via gemini --help)", () => {
  it("uses --approval-mode plan when readOnly=true", () => {
    const cmd = buildGeminiCommand({ readOnly: true });
    assert.ok(cmd.includes("--approval-mode plan"), "should use plan mode");
    assert.ok(!cmd.includes("--yolo"), "should NOT have yolo in plan mode");
  });

  it("uses --yolo when readOnly=false (default)", () => {
    const cmd = buildGeminiCommand({});
    assert.ok(cmd.includes("--yolo"));
    assert.ok(!cmd.includes("--approval-mode"), "should not have approval-mode");
  });

  it("uses --yolo when readOnly is explicitly false", () => {
    const cmd = buildGeminiCommand({ readOnly: false });
    assert.ok(cmd.includes("--yolo"));
  });
});


describe("cross-adapter: readOnly flag strategy per CLI", () => {
  it("claude uses --permission-mode plan", () => {
    const cmd = buildClaudeCommand({ readOnly: true });
    assert.ok(cmd.includes("--permission-mode plan"));
  });

  it("codex has no readOnly flag (no equivalent in CLI)", () => {
    const cmd = buildCodexCommand({ readOnly: true });
    // Codex doesn't have --approval-mode or --permission-mode
    assert.ok(!cmd.includes("--permission-mode"));
    assert.ok(!cmd.includes("--approval-mode"));
  });

  it("gemini uses --approval-mode plan", () => {
    const cmd = buildGeminiCommand({ readOnly: true });
    assert.ok(cmd.includes("--approval-mode plan"));
  });
});
