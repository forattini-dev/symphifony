import type { RuntimeState } from "../types.ts";
import { logger } from "../concerns/logger.ts";
import { toStringValue } from "../concerns/helpers.ts";
import { addEvent } from "../domains/issues.ts";
import { mutateIssueState } from "../routes/helpers.ts";
import { applyPlanUsage, applyPlanSuggestions } from "../routes/helpers.ts";
import { persistState } from "../persistence/store.ts";
import {
  generatePlan,
  refinePlan,
  generatePlanInBackground,
  refinePlanInBackground,
  loadPlanningSession,
  savePlanningInput,
  clearPlanningSession,
} from "../agents/planning/issue-planner.ts";
import { enhanceIssueField } from "../agents/planning/issue-enhancer.ts";

export function registerPlanRoutes(
  app: any,
  state: RuntimeState,
): void {
  app.get("/api/planning/session", async (c: any) => {
    const session = await loadPlanningSession();
    return c.json({ ok: true, session });
  });

  app.post("/api/planning/save", async (c: any) => {
    try {
      const payload = await c.req.json();
      const title = toStringValue(payload.title);
      const description = toStringValue(payload.description);
      const session = await savePlanningInput(title, description);
      return c.json({ ok: true, session });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/planning/generate", async (c: any) => {
    try {
      const payload = await c.req.json();
      const title = toStringValue(payload.title);
      const description = toStringValue(payload.description);
      if (!title) return c.json({ ok: false, error: "Title is required." }, 400);
      logger.info({ title: title.slice(0, 80) }, "[API] POST /api/planning/generate");
      const result = await generatePlan(title, description, state.config, null);
      return c.json({ ok: true, plan: result.plan, usage: result.usage });
    } catch (error) {
      logger.error({ err: error }, `Plan generation failed: ${String(error)}`);
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/planning/clear", async (c: any) => {
    await clearPlanningSession();
    return c.json({ ok: true });
  });

  // Legacy alias
  app.post("/api/issues/plan", async (c: any) => {
    try {
      const payload = await c.req.json();
      const title = toStringValue(payload.title);
      const description = toStringValue(payload.description);
      if (!title) return c.json({ ok: false, error: "Title is required." }, 400);
      const result = await generatePlan(title, description, state.config, null);
      return c.json({ ok: true, plan: result.plan, usage: result.usage });
    } catch (error) {
      logger.error({ err: error }, `Plan generation failed: ${String(error)}`);
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/issues/:id/plan", async (c: any) => {
    return mutateIssueState(state, c, async (issue) => {
      if (issue.state !== "Planning") {
        throw new Error(`Cannot plan issue in state ${issue.state}. Must be in Planning.`);
      }
      if (issue.planningStatus === "planning") {
        throw new Error("Planning already running in worker slot.");
      }
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const fast = body.fast === true;

      // Fire-and-forget — plan runs in background, updates via WS
      generatePlanInBackground(issue, state.config, null, {
        addEvent: (issueId, kind, message) => addEvent(state, issueId, kind as any, message),
        persistState: () => persistState(state),
        applyUsage: (iss, usage) => applyPlanUsage(iss, usage),
        applySuggestions: (iss, plan) => applyPlanSuggestions(iss, plan),
      }, { fast });

      addEvent(state, issue.id, "progress", `${fast ? "Fast plan" : "Plan"} generation started for ${issue.identifier}.`);
    });
  });

  app.post("/api/issues/:id/plan/refine", async (c: any) => {
    return mutateIssueState(state, c, async (issue) => {
      if (issue.state !== "Planning") {
        throw new Error(`Cannot refine plan for issue in state ${issue.state}. Must be in Planning.`);
      }
      if (!issue.plan) {
        throw new Error("Issue has no plan to refine. Generate a plan first.");
      }
      if (issue.planningStatus === "planning") {
        throw new Error("A plan operation is already in progress for this issue.");
      }
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
      if (!feedback) {
        throw new Error("Feedback message is required.");
      }

      // Fire-and-forget — refinement runs in background, updates via WS
      refinePlanInBackground(issue, feedback, state.config, null, {
        addEvent: (issueId, kind, message) => addEvent(state, issueId, kind as any, message),
        persistState: () => persistState(state),
        applyUsage: (iss, usage) => applyPlanUsage(iss, usage),
        applySuggestions: (iss, plan) => {
          if (plan.suggestedPaths?.length) iss.paths = plan.suggestedPaths;
          if (plan.suggestedLabels?.length) iss.labels = plan.suggestedLabels;
          if (plan.suggestedEffort) iss.effort = plan.suggestedEffort;
        },
      });

      addEvent(state, issue.id, "progress", `Plan refinement started for ${issue.identifier}.`);
    });
  });

  app.post("/api/issues/enhance", async (c: any) => {
    try {
      const payload = await c.req.json();
      const field = payload.field === "description" ? "description" : payload.field === "title" ? "title" : null;
      if (!field) {
        return c.json({ ok: false, error: 'Invalid field. Expected "title" or "description".' }, 400);
      }

      const title = toStringValue(payload.title);
      const description = toStringValue(payload.description);
      const provider = toStringValue(payload.provider, state.config.agentProvider);
      const issueType = toStringValue(payload.issueType);
      const images = Array.isArray(payload.images) ? payload.images.filter((p: unknown): p is string => typeof p === "string") : undefined;

      const result = await enhanceIssueField(
        { field, title, description, issueType, images, provider },
        state.config,
        null,
      );

      return c.json({ ok: true, field: result.field, value: result.value, provider: result.provider });
    } catch (error) {
      logger.error({ err: error }, `Issue enhance failed: ${String(error)}`);
      return c.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  });
}
