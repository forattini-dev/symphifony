import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import { getSettingValue, getSettingsList, useSettings } from "../hooks.js";

const SETTING_ID_WORKFLOW_CONFIG = "runtime.workflowConfig";

function isValidStage(value) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.provider === "string"
    && typeof value.model === "string"
    && typeof value.effort === "string";
}

function readWorkflowConfig(payload) {
  const workflow = getSettingValue(getSettingsList(payload), SETTING_ID_WORKFLOW_CONFIG, null);
  if (!workflow || typeof workflow !== "object") return null;
  return isValidStage(workflow.plan) && isValidStage(workflow.execute) && isValidStage(workflow.review)
    ? workflow
    : null;
}

/** Fetch workflow config (plan/execute/review stages). */
export function useWorkflowConfig() {
  const settingsQuery = useSettings();
  const savedWorkflow = readWorkflowConfig(settingsQuery.data);
  const fallbackQuery = useQuery({
    queryKey: ["workflow-config"],
    queryFn: () => api.get("/config/workflow"),
    enabled: !savedWorkflow,
    staleTime: 60_000,
  });

  return {
    ...fallbackQuery,
    data: savedWorkflow
      ? { ok: true, workflow: savedWorkflow, isDefault: false }
      : fallbackQuery.data,
  };
}
