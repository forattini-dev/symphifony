import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan, AgentTokenUsage } from "../types.ts";
import { compileForClaude } from "./plan-to-claude.ts";
import { compileForCodex } from "./plan-to-codex.ts";
import { buildFullPlanPrompt, buildValidationSection, buildExecutionPayload } from "./shared.ts";
import type { ExecutionPayload } from "./shared.ts";

export type CompiledExecution = {
  /** Enriched prompt with plan context, phases, risks, validation */
  prompt: string;
  /** Fully resolved CLI command string */
  command: string;
  /** Additional environment variables */
  env: Record<string, string>;
  /** Shell commands to run before the agent */
  preHooks: string[];
  /** Shell commands to run after the agent */
  postHooks: string[];
  /** JSON schema for structured output (empty string if not applicable) */
  outputSchema: string;
  /** Canonical structured input payload (source of truth for the task) */
  payload: ExecutionPayload | null;
  /** Metadata for logging and audit */
  meta: {
    adapter: "claude" | "codex" | "passthrough";
    reasoningEffort: string;
    model: string;
    skillsActivated: string[];
    subagentsRequested: string[];
    phasesCount: number;
  };
};

export type CompiledReview = {
  /** Rich review prompt with plan context, diff, and criteria */
  prompt: string;
  /** Fully resolved CLI command string */
  command: string;
};

export type ExecutionAudit = {
  runtime: string;
  model: string;
  effort: string;
  role: string;
  skillsActivated: string[];
  subagentsRequested: string[];
  durationMs: number;
  tokenUsage: AgentTokenUsage | null;
  diffStats: { filesChanged: number; linesAdded: number; linesRemoved: number } | null;
  result: string;
  compiledAt: string;
  completedAt: string;
};

/**
 * Compile an issue's plan into a provider-maximalist execution.
 * If no plan exists, returns null (caller falls back to default behavior).
 *
 * Generates a canonical ExecutionPayload (JSON source of truth) and
 * a provider-specific prompt (markdown frame that references the payload).
 */
export function compileExecution(
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  config: RuntimeConfig,
  workspacePath: string,
  skillContext: string,
): CompiledExecution | null {
  const plan = issue.plan;
  if (!plan?.steps?.length) return null; // No plan → use default behavior

  // Build canonical payload — same for all providers
  const payload = buildExecutionPayload(issue, provider, plan, workspacePath);

  let compiled: CompiledExecution | null = null;

  if (provider.provider === "claude") {
    compiled = compileForClaude(issue, provider, plan, config, workspacePath, skillContext);
  } else if (provider.provider === "codex") {
    compiled = compileForCodex(issue, provider, plan, config, workspacePath, skillContext);
  }

  if (compiled) {
    compiled.payload = payload;
  }

  return compiled;
}

/**
 * Compile a rich review prompt using the original plan, diff context, and success criteria.
 */
export function compileReview(
  issue: IssueEntry,
  reviewer: AgentProviderDefinition,
  workspacePath: string,
  diffSummary: string,
): CompiledReview {
  const sections: string[] = [];

  sections.push(`Review the work done for ${issue.identifier}.`);
  sections.push("");
  sections.push(`Title: ${issue.title}`);
  sections.push(`Description: ${issue.description || "(none)"}`);
  sections.push("");
  sections.push(`Workspace: ${workspacePath}`);

  // Include the original plan for context
  const plan = issue.plan;
  if (plan) {
    sections.push("");
    sections.push("# Original Execution Plan");
    sections.push("");
    sections.push(buildFullPlanPrompt(plan));

    // Explicit success criteria for the reviewer to evaluate against
    if (plan.successCriteria?.length) {
      sections.push("");
      sections.push("# Success Criteria (evaluate against these)");
      for (const criterion of plan.successCriteria) {
        sections.push(`- [ ] ${criterion}`);
      }
    }

    // Deliverables checklist
    if (plan.deliverables?.length) {
      sections.push("");
      sections.push("# Expected Deliverables");
      for (const d of plan.deliverables) {
        sections.push(`- [ ] ${d}`);
      }
    }
  }

  // Include diff summary if available
  if (diffSummary) {
    sections.push("");
    sections.push("# Changes Made (diff summary)");
    sections.push("```");
    sections.push(diffSummary);
    sections.push("```");
  }

  // Reference the execution payload if it exists
  sections.push("");
  sections.push("# Structured Context");
  sections.push("If `fifony-execution-payload.json` exists in the workspace, read it for the canonical structured task data.");
  sections.push("Use the `successCriteria`, `constraints`, and `deliverables` fields as your evaluation checklist.");

  sections.push("");
  sections.push("# Review Instructions");
  sections.push("");
  sections.push("1. Verify each success criterion from the plan is met.");
  sections.push("2. Check that all expected deliverables are present.");
  sections.push("3. Review the diff for correctness, security issues, and code quality.");
  sections.push("4. Verify validation checks pass (run commands if specified in the plan).");
  sections.push("5. Check for unintended side effects or regressions.");
  sections.push("");
  sections.push("If the work is acceptable, emit FIFONY_STATUS=done.");
  sections.push("If rework is needed, emit FIFONY_STATUS=continue and provide actionable feedback in nextPrompt.");
  sections.push("If the work is fundamentally broken, emit FIFONY_STATUS=blocked.");

  const prompt = sections.join("\n");

  // Build the reviewer command with model injection
  const REVIEW_RESULT_SCHEMA = JSON.stringify({
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

  let command = reviewer.command;

  // If command is default/empty, build one with model/effort
  if (!command.trim() || command.includes("$FIFONY_PROMPT_FILE")) {
    if (reviewer.provider === "claude") {
      const effort = reviewer.reasoningEffort === "extra-high" ? "high" : reviewer.reasoningEffort;
      const parts = [
        "claude",
        "--print",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--output-format json",
        `--json-schema '${REVIEW_RESULT_SCHEMA}'`,
      ];
      if (effort) parts.splice(2, 0, `--reasoning-effort ${effort}`);
      if (reviewer.model) parts.splice(2, 0, `--model ${reviewer.model}`);
      parts.push("< \"$FIFONY_PROMPT_FILE\"");
      command = parts.join(" ");
    } else if (reviewer.provider === "codex") {
      const parts = ["codex", "exec", "--skip-git-repo-check"];
      if (reviewer.model && reviewer.model !== "codex") parts.push(`--model ${reviewer.model}`);
      parts.push("< \"$FIFONY_PROMPT_FILE\"");
      command = parts.join(" ");
    }
  }

  return { prompt, command };
}

/**
 * Build a structured execution audit record.
 */
export function buildExecutionAudit(
  provider: AgentProviderDefinition,
  compiled: CompiledExecution | null,
  issue: IssueEntry,
  durationMs: number,
  result: string,
): ExecutionAudit {
  return {
    runtime: provider.provider,
    model: provider.model || compiled?.meta.model || "default",
    effort: provider.reasoningEffort || compiled?.meta.reasoningEffort || "default",
    role: provider.role,
    skillsActivated: compiled?.meta.skillsActivated || [],
    subagentsRequested: compiled?.meta.subagentsRequested || [],
    durationMs,
    tokenUsage: issue.tokenUsage ?? null,
    diffStats: issue.filesChanged != null
      ? { filesChanged: issue.filesChanged, linesAdded: issue.linesAdded || 0, linesRemoved: issue.linesRemoved || 0 }
      : null,
    result,
    compiledAt: compiled ? new Date().toISOString() : "",
    completedAt: new Date().toISOString(),
  };
}

/**
 * Persist compilation artifacts to workspace for audit/debugging.
 * Writes both the metadata summary and the canonical execution payload.
 */
export function persistCompilationArtifacts(
  workspacePath: string,
  compiled: CompiledExecution,
): void {
  const { writeFileSync } = require("node:fs");
  const { join } = require("node:path");

  try {
    writeFileSync(
      join(workspacePath, "fifony-compiled-execution.json"),
      JSON.stringify({
        adapter: compiled.meta.adapter,
        model: compiled.meta.model,
        reasoningEffort: compiled.meta.reasoningEffort,
        skillsActivated: compiled.meta.skillsActivated,
        subagentsRequested: compiled.meta.subagentsRequested,
        phasesCount: compiled.meta.phasesCount,
        preHooks: compiled.preHooks,
        postHooks: compiled.postHooks,
        hasOutputSchema: !!compiled.outputSchema,
        hasPayload: !!compiled.payload,
        commandLength: compiled.command.length,
        promptLength: compiled.prompt.length,
        compiledAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );
  } catch {
    // Ignore write failures — this is optional audit data
  }

  // Write the canonical execution payload as a separate file
  if (compiled.payload) {
    try {
      writeFileSync(
        join(workspacePath, "fifony-execution-payload.json"),
        JSON.stringify(compiled.payload, null, 2),
        "utf8",
      );
    } catch {
      // Ignore — optional
    }
  }
}

/**
 * Persist execution audit to workspace.
 */
export function persistExecutionAudit(
  workspacePath: string,
  audit: ExecutionAudit,
): void {
  const { writeFileSync } = require("node:fs");
  const { join } = require("node:path");

  try {
    writeFileSync(
      join(workspacePath, "fifony-execution-audit.json"),
      JSON.stringify(audit, null, 2),
      "utf8",
    );
  } catch {
    // Ignore write failures — this is optional audit data
  }
}
