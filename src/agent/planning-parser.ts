import type { IssuePlan } from "./types.ts";
import { now, toStringArray, extractJsonObjects, repairTruncatedJson } from "./helpers.ts";
import { logger } from "./logger.ts";

// ── Parser ────────────────────────────────────────────────────────────────────

export function tryBuildPlan(parsed: any): IssuePlan | null {
  if (!parsed || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
  // Accept various summary field names that different models use
  const summary = parsed.summary || parsed.issueTitle || parsed.title || parsed.issue_title || parsed.description || "";

  const complexities = ["trivial", "low", "medium", "high"];

  return {
    summary: String(summary),
    estimatedComplexity: complexities.includes(parsed.estimatedComplexity) ? parsed.estimatedComplexity
      : complexities.includes(parsed.complexity) ? parsed.complexity : "medium",

    steps: parsed.steps.map((s: any, i: number) => ({
      step: typeof s.step === "number" ? s.step : i + 1,
      action: String(s.action || s.description || s.title || s.task_name || (typeof s.step === "string" ? s.step : "") || ""),
      files: toStringArray(s.files),
      details: s.details ? String(s.details) : undefined,
      ownerType: s.ownerType || s.owner_type || undefined,
      doneWhen: s.doneWhen || s.done_when || undefined,
    })),

    assumptions: toStringArray(parsed.assumptions),
    constraints: toStringArray(parsed.constraints),
    unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns.map((u: any) => ({
      question: String(u.question || ""),
      whyItMatters: String(u.whyItMatters || u.why_it_matters || ""),
      howToResolve: String(u.howToResolve || u.how_to_resolve || ""),
    })) : undefined,
    successCriteria: toStringArray(parsed.successCriteria || parsed.success_criteria),
    risks: Array.isArray(parsed.risks) ? parsed.risks.map((r: any) => ({
      risk: String(r.risk || ""),
      impact: String(r.impact || ""),
      mitigation: String(r.mitigation || ""),
    })) : undefined,
    validation: toStringArray(parsed.validation),
    deliverables: toStringArray(parsed.deliverables),

    executionStrategy: parsed.executionStrategy || parsed.execution_strategy || undefined,
    toolingDecision: parsed.toolingDecision || parsed.tooling_decision || undefined,

    suggestedPaths: toStringArray(parsed.suggestedPaths || parsed.suggested_paths || parsed.filePaths || parsed.file_paths || parsed.paths),
    suggestedLabels: toStringArray(parsed.suggestedLabels || parsed.suggested_labels || parsed.labels),
    suggestedEffort: parsed.suggestedEffort || parsed.suggested_effort || parsed.effortSuggestion || parsed.effort_suggestion || parsed.effort || { default: "medium" },

    provider: "",
    createdAt: now(),
  };
}

export function parsePlanOutput(raw: string): IssuePlan | null {
  const text = raw.trim();
  if (!text) return null;

  const candidates: string[] = [];

  // 1. Try to unwrap --output-format json envelope
  try {
    const outer = JSON.parse(text);

    // --json-schema puts structured output in .structured_output (not .result)
    if (outer?.structured_output && typeof outer.structured_output === "object") {
      const plan = tryBuildPlan(outer.structured_output);
      if (plan) return plan;
      // If it didn't validate, still try as a candidate string
      candidates.push(JSON.stringify(outer.structured_output));
    }

    if (outer?.result && typeof outer.result === "string") {
      const result = outer.result;
      candidates.push(result);
      // Also extract any JSON objects embedded in the result string
      candidates.push(...extractJsonObjects(result));
      // Try code blocks inside .result
      const resultCodeBlocks = result.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
      for (const match of resultCodeBlocks) candidates.push(match[1]);
    }
    // If the outer object itself looks like a plan (no .type envelope)
    if (outer?.summary) candidates.push(text);
  } catch {}

  // 2. Try code blocks in full output
  const codeBlocks = text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
  for (const match of codeBlocks) candidates.push(match[1]);

  // 3. Extract top-level JSON objects from full text
  candidates.push(...extractJsonObjects(text));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      // Direct plan
      const plan = tryBuildPlan(parsed);
      if (plan) return plan;
      // Envelope with structured_output
      if (parsed?.structured_output && typeof parsed.structured_output === "object") {
        const innerPlan = tryBuildPlan(parsed.structured_output);
        if (innerPlan) return innerPlan;
      }
    } catch {}
  }

  // Last resort: try to repair truncated JSON output
  const repaired = repairTruncatedJson(text);
  if (repaired) {
    try {
      const parsed = JSON.parse(repaired);
      const plan = tryBuildPlan(parsed);
      if (plan) {
        logger.warn("[Planner] Plan parsed from repaired truncated JSON output");
        return plan;
      }
      // Check for envelope
      if (parsed?.structured_output && typeof parsed.structured_output === "object") {
        const innerPlan = tryBuildPlan(parsed.structured_output);
        if (innerPlan) {
          logger.warn("[Planner] Plan parsed from repaired truncated JSON envelope");
          return innerPlan;
        }
      }
    } catch {
      logger.debug("[Planner] JSON repair attempted but result still not parseable");
    }
  }

  return null;
}

/** Extract token usage from CLI output (Claude JSON or Codex text) */
export function extractPlanTokenUsage(raw: string): { inputTokens: number; outputTokens: number; totalTokens: number; model: string } | null {
  // 1. Claude --output-format json: parse the outer JSON envelope
  try {
    const parsed = JSON.parse(raw.trim());

    // Try modelUsage field first (richer data, per-model breakdown)
    if (parsed?.modelUsage && typeof parsed.modelUsage === "object") {
      let totalInput = 0, totalOutput = 0, primaryModel = "";
      let maxTokens = 0;
      for (const [model, data] of Object.entries<any>(parsed.modelUsage)) {
        const inp = Number(data?.inputTokens || 0) + Number(data?.cacheReadInputTokens || 0) + Number(data?.cacheCreationInputTokens || 0);
        const out = Number(data?.outputTokens || 0);
        totalInput += inp;
        totalOutput += out;
        if (inp + out > maxTokens) {
          maxTokens = inp + out;
          primaryModel = model;
        }
      }
      if (totalInput > 0 || totalOutput > 0) {
        return { inputTokens: totalInput, outputTokens: totalOutput, totalTokens: totalInput + totalOutput, model: primaryModel };
      }
    }

    // Fallback: usage field
    const usage = parsed?.usage;
    if (usage && typeof usage === "object") {
      const input = Number(usage.input_tokens) || 0;
      const output = Number(usage.output_tokens) || 0;
      if (input > 0 || output > 0) {
        return {
          inputTokens: input,
          outputTokens: output,
          totalTokens: input + output,
          model: typeof parsed.model === "string" ? parsed.model : "",
        };
      }
    }

    // Fallback: total_cost_usd present means we can at least log the cost
  } catch { /* not JSON — try Codex format */ }

  // 2. Codex: "tokens used\n1,681\n"
  const codexMatch = raw.match(/tokens?\s+used\s*\n\s*([\d,]+)/i);
  if (codexMatch) {
    const total = parseInt(codexMatch[1].replace(/,/g, ""), 10);
    const modelMatch = raw.match(/^model:\s*(.+)$/im);
    if (total > 0) {
      return { inputTokens: 0, outputTokens: 0, totalTokens: total, model: modelMatch?.[1]?.trim() || "" };
    }
  }

  return null;
}
