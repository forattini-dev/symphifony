import type { RuntimeState } from "../../types.ts";

type RuntimeApiContext = {
  state: RuntimeState;
};

let context: RuntimeApiContext | null = null;

export function setApiRuntimeContext(state: RuntimeState): void {
  context = { state };
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
