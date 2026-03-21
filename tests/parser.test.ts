/**
 * Unit tests for planning-parser.ts
 *
 * Uses realistic fixture data mirroring real Claude and Codex CLI output.
 * No network calls, no subprocesses — pure parsing logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPlanTokenUsage, parsePlanOutput } from "../src/agents/planning/planning-parser.ts";

// ── extractPlanTokenUsage ─────────────────────────────────────────────────────

describe("extractPlanTokenUsage", () => {

  // ── Claude: modelUsage envelope (primary format) ──

  describe("Claude / modelUsage format", () => {
    it("extracts input+output tokens from modelUsage", () => {
      const raw = JSON.stringify({
        type: "result",
        subtype: "success",
        result: "PONG",
        model: "claude-sonnet-4-6-20251001",
        modelUsage: {
          "claude-sonnet-4-6-20251001": {
            inputTokens: 142,
            outputTokens: 38,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      });

      const usage = extractPlanTokenUsage(raw);
      assert.ok(usage !== null, "should parse usage");
      assert.equal(usage!.inputTokens, 142);
      assert.equal(usage!.outputTokens, 38);
      assert.equal(usage!.totalTokens, 180);
      assert.equal(usage!.model, "claude-sonnet-4-6-20251001");
    });

    it("sums across multiple models in modelUsage (multi-turn with cache)", () => {
      const raw = JSON.stringify({
        type: "result",
        result: "ok",
        modelUsage: {
          "claude-sonnet-4-6-20251001": {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 50,
            cacheCreationInputTokens: 10,
          },
          "claude-haiku-4-5-20251001": {
            inputTokens: 30,
            outputTokens: 5,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      });

      const usage = extractPlanTokenUsage(raw);
      assert.ok(usage !== null);
      // inputTokens = (100+50+10) + 30 = 190
      assert.equal(usage!.inputTokens, 190);
      // outputTokens = 20 + 5 = 25
      assert.equal(usage!.outputTokens, 25);
      assert.equal(usage!.totalTokens, 215);
      // primary model = the one with highest token count = sonnet
      assert.equal(usage!.model, "claude-sonnet-4-6-20251001");
    });

    it("returns null for modelUsage with all-zero counts", () => {
      const raw = JSON.stringify({
        modelUsage: {
          "claude-haiku-4-5-20251001": { inputTokens: 0, outputTokens: 0 },
        },
      });
      const usage = extractPlanTokenUsage(raw);
      assert.equal(usage, null);
    });
  });

  // ── Claude: usage fallback format ──

  describe("Claude / usage fallback format", () => {
    it("extracts input+output from usage field", () => {
      const raw = JSON.stringify({
        type: "result",
        result: "PONG",
        model: "claude-opus-4-6",
        usage: {
          input_tokens: 210,
          output_tokens: 55,
        },
      });

      const usage = extractPlanTokenUsage(raw);
      assert.ok(usage !== null);
      assert.equal(usage!.inputTokens, 210);
      assert.equal(usage!.outputTokens, 55);
      assert.equal(usage!.totalTokens, 265);
      assert.equal(usage!.model, "claude-opus-4-6");
    });

    it("returns null when usage has zeros", () => {
      const raw = JSON.stringify({
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      assert.equal(extractPlanTokenUsage(raw), null);
    });
  });

  // ── Codex: text format ──

  describe("Codex / text format", () => {
    it("parses 'tokens used\\n{count}' from stdout", () => {
      const raw = [
        "PONG",
        "",
        "tokens used",
        "1,681",
      ].join("\n");

      const usage = extractPlanTokenUsage(raw);
      assert.ok(usage !== null);
      assert.equal(usage!.totalTokens, 1681);
      // Codex doesn't split input/output in text mode
      assert.equal(usage!.inputTokens, 0);
      assert.equal(usage!.outputTokens, 0);
    });

    it("parses token count without comma separator", () => {
      const raw = "ok\n\nTokens Used\n842\n";
      const usage = extractPlanTokenUsage(raw);
      assert.ok(usage !== null);
      assert.equal(usage!.totalTokens, 842);
    });

    it("parses model name from 'model: xxx' line", () => {
      const raw = "ok\n\nmodel: gpt-5.1-codex-mini\ntokens used\n500\n";
      const usage = extractPlanTokenUsage(raw);
      assert.ok(usage !== null);
      assert.equal(usage!.totalTokens, 500);
      assert.equal(usage!.model, "gpt-5.1-codex-mini");
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("returns null for empty string", () => {
      assert.equal(extractPlanTokenUsage(""), null);
    });

    it("returns null for plain text with no token info", () => {
      assert.equal(extractPlanTokenUsage("PONG"), null);
    });

    it("returns null for malformed JSON", () => {
      assert.equal(extractPlanTokenUsage("{not json"), null);
    });

    it("returns null for JSON without usage fields", () => {
      const raw = JSON.stringify({ type: "result", result: "PONG" });
      assert.equal(extractPlanTokenUsage(raw), null);
    });
  });
});

// ── parsePlanOutput ───────────────────────────────────────────────────────────

// Minimal valid plan payload for fixture reuse
const MINIMAL_PLAN = {
  summary: "Implement JWT validation",
  estimatedComplexity: "medium",
  steps: [
    { step: 1, action: "Add jwt dependency", files: ["package.json"] },
    { step: 2, action: "Write middleware", files: ["src/auth.ts"] },
  ],
};

describe("parsePlanOutput", () => {

  // ── Claude JSON envelope ──

  describe("Claude / structured_output envelope", () => {
    it("parses plan from structured_output field (--json-schema mode)", () => {
      const raw = JSON.stringify({
        type: "result",
        subtype: "success",
        structured_output: MINIMAL_PLAN,
      });

      const plan = parsePlanOutput(raw);
      assert.ok(plan !== null, "should parse plan");
      assert.equal(plan!.steps.length, 2);
      assert.equal(plan!.steps[0].action, "Add jwt dependency");
      assert.equal(plan!.estimatedComplexity, "medium");
    });

    it("parses plan from result string containing JSON", () => {
      const raw = JSON.stringify({
        type: "result",
        result: JSON.stringify(MINIMAL_PLAN),
      });

      const plan = parsePlanOutput(raw);
      assert.ok(plan !== null);
      assert.equal(plan!.steps.length, 2);
    });

    it("parses plan from result string containing a JSON code block", () => {
      const raw = JSON.stringify({
        type: "result",
        result: "Here is the plan:\n```json\n" + JSON.stringify(MINIMAL_PLAN) + "\n```",
      });

      const plan = parsePlanOutput(raw);
      assert.ok(plan !== null);
      assert.equal(plan!.steps.length, 2);
    });
  });

  // ── Codex / raw JSON ──

  describe("Codex / raw JSON in text output", () => {
    it("parses plan from JSON code block in plain text", () => {
      const raw = "Here is my plan:\n\n```json\n" + JSON.stringify(MINIMAL_PLAN) + "\n```\n\nDone.";
      const plan = parsePlanOutput(raw);
      assert.ok(plan !== null);
      assert.equal(plan!.steps.length, 2);
    });

    it("parses plan from bare JSON object embedded in text", () => {
      const raw = "Let me think...\n\n" + JSON.stringify(MINIMAL_PLAN) + "\n\nAll done.";
      const plan = parsePlanOutput(raw);
      assert.ok(plan !== null);
      assert.equal(plan!.steps.length, 2);
    });
  });

  // ── Field normalisation ──

  describe("field normalisation", () => {
    it("accepts 'complexity' as alias for 'estimatedComplexity'", () => {
      const raw = JSON.stringify({
        structured_output: { ...MINIMAL_PLAN, estimatedComplexity: undefined, complexity: "high" },
      });
      const plan = parsePlanOutput(raw);
      assert.equal(plan!.estimatedComplexity, "high");
    });

    it("defaults estimatedComplexity to medium when missing/invalid", () => {
      const raw = JSON.stringify({ structured_output: { ...MINIMAL_PLAN, estimatedComplexity: "banana" } });
      const plan = parsePlanOutput(raw);
      assert.equal(plan!.estimatedComplexity, "medium");
    });

    it("accepts 'title' as alias for 'summary'", () => {
      const raw = JSON.stringify({
        structured_output: { ...MINIMAL_PLAN, summary: undefined, title: "My Title" },
      });
      const plan = parsePlanOutput(raw);
      assert.equal(plan!.summary, "My Title");
    });

    it("normalises step.action from various field names", () => {
      const raw = JSON.stringify({
        structured_output: {
          ...MINIMAL_PLAN,
          steps: [{ step: 1, description: "From description field", files: [] }],
        },
      });
      const plan = parsePlanOutput(raw);
      assert.equal(plan!.steps[0].action, "From description field");
    });
  });

  // ── Codex model variants — different models produce different field names ──

  describe("Codex / gpt-5.4-mini format (what, id, suggestedFilePaths)", () => {
    // Mirrors actual output captured from gpt-5.4-mini via codex CLI
    const GPT54_MINI_OUTPUT = {
      issueTitle: "mobile",
      complexity: "medium",
      effortSuggestion: { planner: "low", executor: "medium", reviewer: "medium" },
      assumptions: ["Frontend-only change"],
      constraints: ["No horizontal overflow on mobile"],
      unknowns: [
        { question: "What breakpoints?", resolveBy: "Check tailwind config" },
      ],
      risks: [{ risk: "Chart overflow", impact: "Unreadable", mitigation: "Responsive wrapper" }],
      labels: ["frontend", "mobile"],
      suggestedFilePaths: ["app/src/routes/agents.jsx", "app/src/routes/analytics.lazy.jsx"],
      steps: [
        {
          id: 1,
          ownerType: "agent",
          what: "Audit agents screen on 360px width and fix overflow",
          doneWhen: ["No horizontal scroll at 360px", "Actions reachable by touch"],
        },
        {
          id: 2,
          ownerType: "agent",
          what: "Audit analytics screen on 360px width and fix chart overflow",
          doneWhen: ["Charts fit within viewport", "KPI cards stack vertically"],
        },
      ],
    };

    it("parses issueTitle as summary", () => {
      const plan = parsePlanOutput(JSON.stringify(GPT54_MINI_OUTPUT));
      assert.ok(plan !== null);
      assert.equal(plan!.summary, "mobile");
    });

    it("parses complexity alias", () => {
      const plan = parsePlanOutput(JSON.stringify(GPT54_MINI_OUTPUT));
      assert.equal(plan!.estimatedComplexity, "medium");
    });

    it("parses step.what as action", () => {
      const plan = parsePlanOutput(JSON.stringify(GPT54_MINI_OUTPUT));
      assert.ok(plan !== null);
      assert.equal(plan!.steps[0].action, "Audit agents screen on 360px width and fix overflow");
    });

    it("parses step.id as step number", () => {
      const plan = parsePlanOutput(JSON.stringify(GPT54_MINI_OUTPUT));
      assert.equal(plan!.steps[0].step, 1);
      assert.equal(plan!.steps[1].step, 2);
    });

    it("joins doneWhen array into string", () => {
      const plan = parsePlanOutput(JSON.stringify(GPT54_MINI_OUTPUT));
      assert.ok(plan!.steps[0].doneWhen?.includes("No horizontal scroll at 360px"));
      assert.ok(plan!.steps[0].doneWhen?.includes("Actions reachable by touch"));
    });

    it("parses suggestedFilePaths as suggestedPaths", () => {
      const plan = parsePlanOutput(JSON.stringify(GPT54_MINI_OUTPUT));
      assert.ok(plan!.suggestedPaths.includes("app/src/routes/agents.jsx"));
    });

    it("parses suggestedSkills as empty array when not present", () => {
      const plan = parsePlanOutput(JSON.stringify(GPT54_MINI_OUTPUT));
      assert.deepEqual(plan!.suggestedSkills, []);
    });

    it("parses when output has codex preamble header + JSON + token count", () => {
      const preamble = [
        "",
        "Reading prompt from stdin...",
        "",
        "OpenAI Codex v0.115.0 (research preview)",
        "--------",
        "model: gpt-5.4-mini",
        "provider: openai",
        "--------",
        "user",
        "",
        "Return strict JSON...",
        "",
        "codex",
      ].join("\n");
      const raw = preamble + "\n" + JSON.stringify(GPT54_MINI_OUTPUT) + "\n\ntokens used\n33,834\n";
      const plan = parsePlanOutput(raw);
      assert.ok(plan !== null, "should parse plan from real codex stdout");
      assert.equal(plan!.steps.length, 2);
      assert.equal(plan!.steps[0].action, "Audit agents screen on 360px width and fix overflow");
    });
  });

  describe("Codex / alternative model format (task, index, file_paths)", () => {
    // Hypothetical output from a model that uses snake_case and different aliases
    const ALT_MODEL_OUTPUT = {
      title: "Add auth middleware",
      estimated_complexity: "low",
      steps: [
        {
          index: 1,
          task: "Create JWT validation middleware",
          file_paths: ["src/middleware/auth.ts"],
          done_when: "Middleware rejects requests with invalid tokens",
        },
      ],
      suggested_paths: ["src/middleware/"],
      suggested_labels: ["backend", "security"],
    };

    it("parses title as summary", () => {
      const plan = parsePlanOutput(JSON.stringify(ALT_MODEL_OUTPUT));
      assert.ok(plan !== null);
      assert.equal(plan!.summary, "Add auth middleware");
    });

    it("parses step number from fallback index", () => {
      const plan = parsePlanOutput(JSON.stringify(ALT_MODEL_OUTPUT));
      // index field not aliased — falls back to array position (i+1)
      assert.equal(plan!.steps[0].step, 1);
    });

    it("parses done_when string", () => {
      const plan = parsePlanOutput(JSON.stringify(ALT_MODEL_OUTPUT));
      assert.equal(plan!.steps[0].doneWhen, "Middleware rejects requests with invalid tokens");
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("returns null for empty string", () => {
      assert.equal(parsePlanOutput(""), null);
    });

    it("returns null for plain text with no JSON", () => {
      assert.equal(parsePlanOutput("PONG"), null);
    });

    it("returns null when steps array is empty", () => {
      const raw = JSON.stringify({ structured_output: { ...MINIMAL_PLAN, steps: [] } });
      assert.equal(parsePlanOutput(raw), null);
    });

    it("returns null when steps is missing", () => {
      const raw = JSON.stringify({ structured_output: { summary: "ok" } });
      assert.equal(parsePlanOutput(raw), null);
    });
  });
});
