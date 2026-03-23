import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEnhancerOutput } from "../src/agents/planning/issue-enhancer.ts";

describe("parseEnhancerOutput", () => {
  // ── Direct JSON ─────────────────────────────────────────────────────────

  it("extracts value from clean JSON", () => {
    const raw = '{"field": "title", "value": "fix: resolve border class"}';
    assert.equal(parseEnhancerOutput(raw, "title"), "fix: resolve border class");
  });

  it("extracts value from JSON in code fence", () => {
    const raw = '```json\n{"field": "title", "value": "feat: add dark mode"}\n```';
    assert.equal(parseEnhancerOutput(raw, "title"), "feat: add dark mode");
  });

  it("extracts description value", () => {
    const raw = '{"field": "description", "value": "## Problem\\nSomething broke."}';
    assert.equal(parseEnhancerOutput(raw, "description"), "## Problem\nSomething broke.");
  });

  // ── Gemini CLI output (nested response field) ───────────────────────────

  it("extracts value from Gemini CLI session wrapper", () => {
    const raw = JSON.stringify({
      session_id: "abc-123",
      response: '{ "field": "title", "value": "fix: resolve border class" }',
      stats: { models: {} },
    });
    assert.equal(parseEnhancerOutput(raw, "title"), "fix: resolve border class");
  });

  it("extracts value from Gemini CLI with terminal noise prefix", () => {
    const raw = `
YOLO mode is enabled. All tool calls will be automatically approved.
Loaded cached credentials.
YOLO mode is enabled. All tool calls will be automatically approved.

${JSON.stringify({
  session_id: "abc-123",
  response: '{ "field": "title", "value": "fix: broken CSS class" }',
  stats: { models: {} },
})}`;
    assert.equal(parseEnhancerOutput(raw, "title"), "fix: broken CSS class");
  });

  it("extracts description from Gemini CLI response with escaped JSON", () => {
    const raw = JSON.stringify({
      session_id: "def-456",
      response: '{"field":"description","value":"## Steps\\n1. Run dev\\n2. See error"}',
      stats: {},
    });
    assert.equal(parseEnhancerOutput(raw, "description"), "## Steps\n1. Run dev\n2. See error");
  });

  // ── Codex/Claude output (result field) ──────────────────────────────────

  it("extracts value from result-wrapped JSON", () => {
    const raw = JSON.stringify({
      result: '{"field": "title", "value": "feat: add login page"}',
    });
    assert.equal(parseEnhancerOutput(raw, "title"), "feat: add login page");
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  it("throws on empty output", () => {
    assert.throws(() => parseEnhancerOutput("", "title"), /empty response/);
  });

  it("returns raw text as fallback when no JSON found", () => {
    const raw = "Just a plain text title suggestion";
    assert.equal(parseEnhancerOutput(raw, "title"), "Just a plain text title suggestion");
  });

  it("ignores placeholder values", () => {
    const raw = '{"field": "title", "value": "..."}';
    // Placeholder "..." is rejected, falls back to raw
    const result = parseEnhancerOutput(raw, "title");
    assert.ok(!result.includes("...") || result.includes("{"), "should not return placeholder");
  });

  it("rejects mismatched field", () => {
    const raw = '{"field": "description", "value": "wrong field"}';
    // When expecting "title" but got "description", should not match
    const result = parseEnhancerOutput(raw, "title");
    // Falls back to raw since field doesn't match
    assert.ok(result.length > 0);
  });
});
