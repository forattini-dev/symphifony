import runtimeStateResource from "./runtime-state.resource.ts";
import issuesResource from "./issues.resource.ts";
import issuePlansResource from "./issue-plans.resource.ts";
import eventsResource from "./events.resource.ts";
import settingsResource from "./settings.resource.ts";
import agentSessionsResource from "./agent-sessions.resource.ts";
import agentPipelinesResource from "./agent-pipelines.resource.ts";

export const NATIVE_RESOURCE_CONFIGS = [
  runtimeStateResource,
  issuesResource,
  issuePlansResource,
  eventsResource,
  settingsResource,
  agentSessionsResource,
  agentPipelinesResource,
] as const;

export const NATIVE_RESOURCE_NAMES = NATIVE_RESOURCE_CONFIGS.map((resource) => resource.name);
