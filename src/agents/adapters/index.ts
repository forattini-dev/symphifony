import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, AgentTokenUsage } from "../../types.ts";
import type { CompiledExecution, CompiledReview, ExecutionAudit } from "./types.ts";
import { buildExecutionPayload } from "./shared.ts";
import type { ExecutionPayload } from "./shared.ts";
import { ADAPTERS } from "./registry.ts";
import { renderPrompt } from "../prompting.ts";
import { buildFullPlanPrompt } from "./shared.ts";

export type { CompiledExecution, CompiledReview, ExecutionAudit };

// ── Compile execution ────────────────────────────────────────────────────────

export async function compileExecution(
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  config: RuntimeConfig,
  workspacePath: string,
  skillContext: string,
  capabilitiesManifest?: string,
): Promise<CompiledExecution | null> {
  const plan = issue.plan;
  if (!plan?.steps?.length) return null;

  const adapter = ADAPTERS[provider.provider];
  if (!adapter) return null;

  const payload = buildExecutionPayload(issue, provider, plan, workspacePath);
  const compiled = await adapter.compile(issue, provider, plan, config, workspacePath, skillContext, capabilitiesManifest);
  compiled.payload = payload;
  return compiled;
}

// ── Compile review ───────────────────────────────────────────────────────────

export async function compileReview(
  issue: IssueEntry,
  reviewer: AgentProviderDefinition,
  workspacePath: string,
  diffSummary: string,
  config?: RuntimeConfig,
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

  const adapter = ADAPTERS[reviewer.provider];
  const command = adapter
    ? adapter.buildReviewCommand(reviewer, config)
    : reviewer.command;

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
      join(workspacePath, "compiled-execution.json"),
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
        command: compiled.command,
        promptLength: compiled.prompt.length,
        compiledAt: new Date().toISOString(),
      }, null, 2),
      "utf8",
    );
  } catch { /* optional audit data */ }

  try {
    writeFileSync(join(workspacePath, "prompt.md"), compiled.prompt, "utf8");
  } catch { /* optional */ }

  if (compiled.payload) {
    try {
      writeFileSync(
        join(workspacePath, "execution-payload.json"),
        JSON.stringify(compiled.payload, null, 2),
        "utf8",
      );
    } catch { /* optional */ }
  }
}

export function persistExecutionAudit(workspacePath: string, audit: ExecutionAudit): void {
  try {
    writeFileSync(
      join(workspacePath, "execution-audit.json"),
      JSON.stringify(audit, null, 2),
      "utf8",
    );
  } catch { /* optional audit data */ }
}
