import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROMPT_TEMPLATES,
  AGENT_CATALOG,
  SKILL_CATALOG,
} from "../src/agents/generated/prompts.ts";

describe("prompt centralization", () => {
  it("includes renamed planning prompts and new MCP prompts in the generated bundle", () => {
    assert.ok("planning-issue-planner" in PROMPT_TEMPLATES);
    assert.ok("planning-issue-planner-refine" in PROMPT_TEMPLATES);
    assert.ok("planning-issue-enhancer-title" in PROMPT_TEMPLATES);
    assert.ok("planning-issue-enhancer-description" in PROMPT_TEMPLATES);
    assert.ok("mcp-diagnose-blocked" in PROMPT_TEMPLATES);
    assert.ok("mcp-weekly-summary" in PROMPT_TEMPLATES);
    assert.ok("mcp-refine-plan" in PROMPT_TEMPLATES);
    assert.ok("mcp-code-review" in PROMPT_TEMPLATES);
    assert.ok("mcp-code-review-empty" in PROMPT_TEMPLATES);
  });

  it("exports bundled agent and skill catalogs from the generated module", () => {
    assert.ok(AGENT_CATALOG.length > 0, "agent catalog exported");
    assert.ok(SKILL_CATALOG.length > 0, "skill catalog exported");
    assert.equal(typeof AGENT_CATALOG[0]?.content, "string");
    assert.ok(SKILL_CATALOG.some((entry) => entry.name === "impeccable"), "reference-only skill entry preserved");
    assert.ok(SKILL_CATALOG.some((entry) => entry.name === "commit" && typeof entry.content === "string"), "bundled skill content embedded");
  });

  it("keeps MCP prompt handler free of large inline prompt bodies", () => {
    const source = readFileSync(
      join(process.cwd(), "src/mcp/prompts/prompt-handler.ts"),
      "utf8",
    );

    assert.doesNotMatch(source, /# Diagnostic Report for Issue/);
    assert.doesNotMatch(source, /# Fifony Weekly Progress Summary/);
    assert.doesNotMatch(source, /# Plan Refinement for Issue/);
    assert.doesNotMatch(source, /## Review Checklist/);
    assert.match(source, /renderPrompt\("mcp-diagnose-blocked"/);
    assert.match(source, /renderPrompt\("mcp-weekly-summary"/);
    assert.match(source, /renderPrompt\("mcp-refine-plan"/);
    assert.match(source, /renderPrompt\("mcp-code-review"/);
  });
});
