/**
 * CLI command builders for each provider.
 *
 * Single source of truth for how we invoke Claude Code and Codex CLI.
 * Every caller (execution, review, planning) uses these builders
 * so flag changes only need to happen in one place.
 */

import type { IssuePlan } from "../types.ts";

// ── Result schemas ───────────────────────────────────────────────────────────

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

// ── Claude command builder ───────────────────────────────────────────────────

export function buildClaudeCommand(options: {
  model?: string;
  effort?: string;
  jsonSchema?: string;
  /** Skip --dangerously-skip-permissions (e.g. for planning where tool access breaks --json-schema) */
  noToolAccess?: boolean;
}): string {
  const parts = [
    "claude",
    "--print",
  ];

  if (!options.noToolAccess) {
    parts.push("--dangerously-skip-permissions");
  }

  parts.push("--no-session-persistence", "--output-format json");

  if (options.effort) {
    parts.push(`--effort ${options.effort}`);
  }

  if (options.jsonSchema) {
    parts.push(`--json-schema '${options.jsonSchema}'`);
  }

  if (options.model && options.model !== "claude") {
    parts.splice(1, 0, `--model ${options.model}`);
  }

  parts.push("< \"$FIFONY_PROMPT_FILE\"");
  return parts.join(" ");
}

// ── Codex command builder ────────────────────────────────────────────────────

export function buildCodexCommand(options: {
  model?: string;
  addDirs?: string[];
  imagePaths?: string[];
  reasoningEffort?: string;
}): string {
  const parts = ["codex", "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];

  if (options.model && options.model !== "codex") {
    parts.push(`--model ${options.model}`);
  }

  if (options.reasoningEffort) {
    // Codex uses -c config overrides, not a dedicated --reasoning-effort flag
    parts.push(`-c reasoning_effort="${options.reasoningEffort}"`);
  }

  if (options.addDirs?.length) {
    for (const dir of options.addDirs) {
      parts.push(`--add-dir "${dir}"`);
    }
  }

  if (options.imagePaths?.length) {
    for (const img of options.imagePaths) {
      parts.push(`--image "${img}"`);
    }
  }

  parts.push("< \"$FIFONY_PROMPT_FILE\"");
  return parts.join(" ");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract unique directory paths from plan suggested paths (for --add-dir). */
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
