import type { IssuePlan, RuntimeConfig, IssueEntry } from "../../types.ts";
import { now } from "../../concerns/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { markIssuePlanDirty } from "../../persistence/dirty-tracker.ts";
import { type PlanningSessionUsage } from "./planning-session.ts";
import { generatePlan } from "./plan-generator.ts";
import { refinePlan } from "./plan-refiner.ts";

// ── Callbacks type ────────────────────────────────────────────────────────────

export type PlanCallbacks = {
  addEvent: (issueId: string, kind: string, message: string) => void;
  persistState: () => Promise<void>;
  applyUsage: (issue: IssueEntry, usage: PlanningSessionUsage) => void;
  applySuggestions: (issue: IssueEntry, plan: IssuePlan) => void;
};

/**
 * Start plan generation in the background. Returns immediately.
 * Updates issue.plan and broadcasts via WS when done.
 */
export function generatePlanInBackground(
  issue: IssueEntry,
  config: RuntimeConfig,
  _workflowDefinition: null,
  callbacks: PlanCallbacks,
  options?: { fast?: boolean },
): void {
  const { addEvent, persistState, applyUsage, applySuggestions } = callbacks;
  const fast = options?.fast ?? false;

  issue.planningStatus = "planning";
  issue.planningStartedAt = now();
  issue.planningError = undefined;
  issue.updatedAt = now();

  addEvent(issue.id, "info", `${fast ? "Fast plan" : "Plan"} generation starting for ${issue.identifier} (provider detection in progress).`);

  // Fire-and-forget — errors are caught and stored on the issue
  generatePlan(issue.title, issue.description, config, null, { fast })
    .then(async ({ plan, usage }) => {
      issue.plan = plan;
      markIssuePlanDirty(issue.id);
      issue.planningStatus = "idle";
      issue.planningStartedAt = undefined;
      issue.planningError = undefined;
      issue.updatedAt = now();

      applyUsage(issue, usage);
      applySuggestions(issue, plan);

      addEvent(issue.id, "progress", `${fast ? "Fast plan" : "Plan"} generated for ${issue.identifier}: ${plan.steps.length} steps, complexity: ${plan.estimatedComplexity}.`);
      if (usage.totalTokens > 0) {
        addEvent(issue.id, "info", `Plan tokens (${issue.identifier}): ${usage.totalTokens.toLocaleString()} (in: ${usage.inputTokens.toLocaleString()}, out: ${usage.outputTokens.toLocaleString()}) [${usage.model}]`);
      }
      await persistState();
    })
    .catch(async (err) => {
      issue.planningStatus = "idle";
      issue.planningStartedAt = undefined;
      issue.planningError = err instanceof Error ? err.message : String(err);
      issue.updatedAt = now();
      addEvent(issue.id, "error", `Plan generation failed for ${issue.identifier}: ${issue.planningError}`);
      await persistState();
      logger.error({ err }, `Background plan generation failed for ${issue.identifier}`);
    });
}

/**
 * Start plan refinement in the background. Returns immediately.
 * Updates issue.plan and broadcasts via WS when done.
 */
export function refinePlanInBackground(
  issue: IssueEntry,
  feedback: string,
  config: RuntimeConfig,
  _workflowDefinition: null,
  callbacks: PlanCallbacks,
): void {
  const { addEvent, persistState, applyUsage, applySuggestions } = callbacks;

  issue.planningStatus = "planning";
  issue.planningStartedAt = now();
  issue.planningError = undefined;
  issue.updatedAt = now();

  const feedbackSnippet = feedback.length > 60 ? `${feedback.slice(0, 57)}...` : feedback;
  addEvent(issue.id, "info", `Plan refinement starting for ${issue.identifier}: "${feedbackSnippet}".`);

  refinePlan(issue, feedback, config, null)
    .then(async ({ plan, usage }) => {
      issue.plan = plan;
      markIssuePlanDirty(issue.id);
      issue.planningStatus = "idle";
      issue.planningStartedAt = undefined;
      issue.planningError = undefined;
      issue.updatedAt = now();

      applyUsage(issue, usage);
      applySuggestions(issue, plan);

      const feedbackPreview = feedback.length > 80 ? `${feedback.slice(0, 77)}...` : feedback;
      addEvent(issue.id, "progress", `Plan refined for ${issue.identifier}: "${feedbackPreview}" → ${plan.steps.length} steps, complexity: ${plan.estimatedComplexity}.`);
      if (usage.totalTokens > 0) {
        addEvent(issue.id, "info", `Refinement tokens (${issue.identifier}): ${usage.totalTokens.toLocaleString()} (in: ${usage.inputTokens.toLocaleString()}, out: ${usage.outputTokens.toLocaleString()}) [${usage.model}]`);
      }
      await persistState();
    })
    .catch(async (err) => {
      issue.planningStatus = "idle";
      issue.planningStartedAt = undefined;
      issue.planningError = err instanceof Error ? err.message : String(err);
      issue.updatedAt = now();
      addEvent(issue.id, "error", `Plan refinement failed for ${issue.identifier}: ${issue.planningError}`);
      await persistState();
      logger.error({ err }, `Background plan refinement failed for ${issue.identifier}`);
    });
}
