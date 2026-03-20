/**
 * issue-planner.ts — Public entry point for the planning subsystem.
 *
 * All implementation lives in the modules below. This file re-exports
 * everything that external consumers (api-server, agent, run-local) import.
 *
 * Dependency hierarchy (no cycles):
 *   planning-background → plan-generator / plan-refiner
 *     → planning-prompts → planning-schema / planning-session
 *     → planning-parser → (helpers, logger, types)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type { PlanningSessionStatus, PlanningSessionUsage, PlanningSession } from "./planning-session.ts";
export type { GeneratePlanResult } from "./plan-generator.ts";
export type { RefinePlanResult } from "./plan-refiner.ts";
export type { PlanCallbacks } from "./planning-background.ts";

// ── Session management ────────────────────────────────────────────────────────

export {
  loadPlanningSession,
  clearPlanningSession,
  recoverPlanningSession,
} from "./planning-session.ts";

// ── Plan generation ───────────────────────────────────────────────────────────

export { generatePlan, savePlanningInput } from "./plan-generator.ts";

// ── Plan refinement ───────────────────────────────────────────────────────────

export { refinePlan } from "./plan-refiner.ts";

// ── Background wrappers ───────────────────────────────────────────────────────

export { generatePlanInBackground, refinePlanInBackground } from "./planning-background.ts";
