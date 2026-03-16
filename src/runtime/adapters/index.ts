import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, AgentTokenUsage } from "../types.ts";
import { compileForClaude } from "./plan-to-claude.ts";
import { compileForCodex } from "./plan-to-codex.ts";
import { buildFullPlanPrompt, buildExecutionPayload } from "./shared.ts";
import type { ExecutionPayload } from "./shared.ts";
import { buildClaudeCommand, buildCodexCommand, REVIEW_RESULT_SCHEMA } from "./commands.ts";
import { renderPrompt } from "../../prompting.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type CompiledExecution = {
  prompt: string;
  command: string;
  env: Record<string, string>;
  preHooks: string[];
  postHooks: string[];
  outputSchema: string;
  payload: ExecutionPayload | null;
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
  prompt: string;
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

// ── Compile execution ────────────────────────────────────────────────────────

export async function compileExecution(
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  config: RuntimeConfig,
  workspacePath: string,
  skillContext: string,
): Promise<CompiledExecution | null> {
  const plan = issue.plan;
  if (!plan?.steps?.length) return null;

  const payload = buildExecutionPayload(issue, provider, plan, workspacePath);

  let compiled: CompiledExecution | null = null;
  if (provider.provider === "claude") {
    compiled = await compileForClaude(issue, provider, plan, config, workspacePath, skillContext);
  } else if (provider.provider === "codex") {
    compiled = await compileForCodex(issue, provider, plan, config, workspacePath, skillContext);
  }

  if (compiled) {
    compiled.payload = payload;
  }

  return compiled;
}

// ── Compile review ───────────────────────────────────────────────────────────

export async function compileReview(
  issue: IssueEntry,
  reviewer: AgentProviderDefinition,
  workspacePath: string,
  diffSummary: string,
): Promise<CompiledReview> {
  const plan = issue.plan;
  const prompt = await renderPrompt("compile-review", {
    issueIdentifier: issue.identifier,
    title: issue.title,
    description: issue.description || "(none)",
    workspacePath,
    planPrompt: plan ? buildFullPlanPrompt(plan) : "",
    successCriteria: (plan?.successCriteria ?? []).map((value) => ({ value })),
    deliverables: (plan?.deliverables ?? []).map((value) => ({ value })),
    diffSummary,
  });

  // Build command using shared builder — single source of truth for CLI flags
  let command = reviewer.command;
  if (!command.trim() || command.includes("$FIFONY_PROMPT_FILE")) {
    if (reviewer.provider === "claude") {
      command = buildClaudeCommand({ model: reviewer.model, jsonSchema: REVIEW_RESULT_SCHEMA });
    } else if (reviewer.provider === "codex") {
      command = buildCodexCommand({ model: reviewer.model });
    }
  }

  return { prompt, command };
}

// ── Audit ────────────────────────────────────────────────────────────────────

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

// ── Persistence ──────────────────────────────────────────────────────────────

export function persistCompilationArtifacts(workspacePath: string, compiled: CompiledExecution): void {
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
  } catch { /* optional audit data */ }

  if (compiled.payload) {
    try {
      writeFileSync(
        join(workspacePath, "fifony-execution-payload.json"),
        JSON.stringify(compiled.payload, null, 2),
        "utf8",
      );
    } catch { /* optional */ }
  }
}

export function persistExecutionAudit(workspacePath: string, audit: ExecutionAudit): void {
  try {
    writeFileSync(
      join(workspacePath, "fifony-execution-audit.json"),
      JSON.stringify(audit, null, 2),
      "utf8",
    );
  } catch { /* optional audit data */ }
}
