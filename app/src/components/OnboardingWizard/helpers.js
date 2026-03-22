import { api } from "../../api";
import { EFFORT_OPTIONS } from "./constants";

export async function saveSetting(id, value, scope = "ui") {
  return api.post(`/settings/${encodeURIComponent(id)}`, { value, scope, source: "user" });
}

export function normalizeEffortValue(value, fallback = "medium") {
  return EFFORT_OPTIONS.some((option) => option.value === value) ? value : fallback;
}

export function normalizeRoleEfforts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { planner: "medium", executor: "medium", reviewer: "medium" };
  }

  return {
    planner: normalizeEffortValue(value.planner ?? value.default, "medium"),
    executor: normalizeEffortValue(value.executor ?? value.default, "medium"),
    reviewer: normalizeEffortValue(value.reviewer ?? value.default, "medium"),
  };
}

/**
 * Build a WorkflowConfig object from wizard pipeline + efforts + models state.
 * This is the format expected by `runtime.workflowConfig` (plan/execute/review stages).
 */
export function buildWorkflowConfig(pipeline, efforts, models = {}) {
  return {
    plan: { provider: pipeline.planner || pipeline.executor || "", model: models.plan || "", effort: efforts.planner || "medium" },
    execute: { provider: pipeline.executor || "", model: models.execute || "", effort: efforts.executor || "medium" },
    review: { provider: pipeline.reviewer || pipeline.executor || "", model: models.review || "", effort: efforts.reviewer || "medium" },
  };
}

export function isGitReadyForWorktrees(gitStatus) {
  return Boolean(gitStatus?.isGit && gitStatus?.hasCommits);
}

export function canProceedFromSetup(projectName, gitStatus) {
  return Boolean(projectName) && isGitReadyForWorktrees(gitStatus);
}
