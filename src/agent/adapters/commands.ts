/**
 * Shared schemas and helpers used by all provider adapters.
 *
 * Provider-specific command builders live in their own adapter files:
 *   adapters/claude.ts → buildClaudeCommand
 *   adapters/codex.ts  → buildCodexCommand
 *   adapters/gemini.ts → buildGeminiCommand
 */

import type { IssuePlan } from "../types.ts";

// ── Result schemas ────────────────────────────────────────────────────────────

export const CLAUDE_RESULT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "continue", "blocked", "failed"] },
    summary: { type: "string" },
    nextPrompt: { type: "string" },
  },
  required: ["status"],
});

export const REVIEW_RESULT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "continue", "blocked", "failed"] },
    summary: { type: "string" },
    nextPrompt: { type: "string" },
    criteriaResults: {
      type: "array",
      items: {
        type: "object",
        properties: { criterion: { type: "string" }, met: { type: "boolean" }, note: { type: "string" } },
      },
    },
  },
  required: ["status"],
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract unique directory paths from plan suggested paths (for --add-dir / --include-directories). */
export function extractPlanDirs(plan: IssuePlan): string[] {
  if (!plan.suggestedPaths?.length) return [];
  const dirs = new Set<string>();
  for (const p of plan.suggestedPaths) {
    const lastSlash = p.lastIndexOf("/");
    if (lastSlash > 0) dirs.add(p.slice(0, lastSlash));
    else if (!p.includes(".")) dirs.add(p);
  }
  return [...dirs];
}
