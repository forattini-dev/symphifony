import type { RuntimeState, WorkflowDefinition } from "./types.ts";

type RuntimeApiContext = {
  state: RuntimeState;
  workflowDefinition: WorkflowDefinition | null;
};

let context: RuntimeApiContext | null = null;

export function setApiRuntimeContext(state: RuntimeState, workflowDefinition: WorkflowDefinition | null): void {
  context = { state, workflowDefinition };
}

export function clearApiRuntimeContext(): void {
  context = null;
}

export function getApiRuntimeContextOrThrow(): RuntimeApiContext {
  if (!context) {
    throw new Error("API runtime context was not initialized.");
  }
  return context;
}
