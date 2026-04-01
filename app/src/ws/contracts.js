import { safeJson } from "../utils.js";

export const WS_MESSAGE_TYPES = Object.freeze({
  CONNECTED: "connected",
  STATE_UPDATE: "state:update",
  STATE_DELTA: "state:delta",
  ANALYTICS_UPDATE: "analytics:update",
  SERVICE_LOG: "service:log",
  SERVICE_STATE: "service",
  ISSUE_LOG: "issue:log",
  ISSUE_PROGRESS: "issue:progress",
  ISSUE_SUBTASKS: "issue:subtasks",
  ISSUE_TRANSITION: "issue:transition",
  MESH_ENTRY: "mesh:entry",
  MESH_SNAPSHOT: "mesh:snapshot",
  SERVICES_SNAPSHOT: "services:snapshot",
  REVERSE_PROXY_SNAPSHOT: "proxy:reverse:snapshot",
  AGENT_FSM: "agent-fsm",
  VARIABLES: "variables",
  BOOT_SCAN_SKIPPED: "boot:scan:skipped",
  PING: "ping",
  PONG: "pong",
});

export const WS_COMMAND_TYPES = Object.freeze({
  PING: "ping",
  PONG: "pong",
  SERVICE_LOG_SUBSCRIBE: "service:log:subscribe",
  SERVICE_LOG_UNSUBSCRIBE: "service:log:unsubscribe",
  SERVICES_SUBSCRIBE: "services:subscribe",
  SERVICES_UNSUBSCRIBE: "services:unsubscribe",
  ISSUE_LOG_SUBSCRIBE: "issue:log:subscribe",
  ISSUE_LOG_UNSUBSCRIBE: "issue:log:unsubscribe",
  ANALYTICS_SUBSCRIBE: "analytics:subscribe",
  ANALYTICS_UNSUBSCRIBE: "analytics:unsubscribe",
  MESH_SUBSCRIBE: "mesh:subscribe",
  MESH_UNSUBSCRIBE: "mesh:unsubscribe",
  REVERSE_PROXY_SUBSCRIBE: "proxy:reverse:subscribe",
  REVERSE_PROXY_UNSUBSCRIBE: "proxy:reverse:unsubscribe",
});

export const ANALYTICS_TOPICS = Object.freeze([
  "analytics:tokens",
  "analytics:lines",
  "analytics:kpis",
  "analytics:hourly",
]);

const QUERY_KEY_BY_TOPIC = Object.freeze({
  "analytics:tokens": ["token-analytics"],
  "analytics:lines": ["analytics-lines"],
  "analytics:kpis": ["analytics-kpis"],
  "analytics:hourly": ["hourly-analytics"],
});

export const WS_RUNTIME_STATE_TYPES = new Set([
  WS_MESSAGE_TYPES.CONNECTED,
  WS_MESSAGE_TYPES.STATE_UPDATE,
  WS_MESSAGE_TYPES.STATE_DELTA,
]);

export function resolveAnalyticsQueryKey(topic) {
  return QUERY_KEY_BY_TOPIC[topic];
}

export function isRuntimeStatePayload(msg) {
  return WS_RUNTIME_STATE_TYPES.has(msg?.type);
}

export function parseIncomingMessage(raw) {
  if (!raw) return null;
  const msg = typeof raw === "string" ? safeJson(raw) : raw;
  if (!msg || typeof msg !== "object") return null;
  return msg;
}

export function makeWsCommand(type, payload = null) {
  if (!type || typeof type !== "string") return null;
  if (!payload) return { type };
  return { type, ...payload };
}

export function makeAnalyticsSubscribe(topic) {
  return makeWsCommand(WS_COMMAND_TYPES.ANALYTICS_SUBSCRIBE, { topic });
}

export function makeAnalyticsUnsubscribe(topic) {
  return makeWsCommand(WS_COMMAND_TYPES.ANALYTICS_UNSUBSCRIBE, { topic });
}

export function makeMeshSubscribe() {
  return makeWsCommand(WS_COMMAND_TYPES.MESH_SUBSCRIBE);
}

export function makeMeshUnsubscribe() {
  return makeWsCommand(WS_COMMAND_TYPES.MESH_UNSUBSCRIBE);
}

export function makeReverseProxySubscribe() {
  return makeWsCommand(WS_COMMAND_TYPES.REVERSE_PROXY_SUBSCRIBE);
}

export function makeReverseProxyUnsubscribe() {
  return makeWsCommand(WS_COMMAND_TYPES.REVERSE_PROXY_UNSUBSCRIBE);
}

export function makeServiceLogSubscribe(serviceId) {
  return makeWsCommand(WS_COMMAND_TYPES.SERVICE_LOG_SUBSCRIBE, { id: serviceId });
}

export function makeServiceLogUnsubscribe(serviceId) {
  return makeWsCommand(WS_COMMAND_TYPES.SERVICE_LOG_UNSUBSCRIBE, { id: serviceId });
}

export function makeServicesSubscribe() {
  return makeWsCommand(WS_COMMAND_TYPES.SERVICES_SUBSCRIBE);
}

export function makeServicesUnsubscribe() {
  return makeWsCommand(WS_COMMAND_TYPES.SERVICES_UNSUBSCRIBE);
}

export function makeIssueLogSubscribe(issueId) {
  return makeWsCommand(WS_COMMAND_TYPES.ISSUE_LOG_SUBSCRIBE, { id: issueId });
}

export function makeIssueLogUnsubscribe(issueId) {
  return makeWsCommand(WS_COMMAND_TYPES.ISSUE_LOG_UNSUBSCRIBE, { id: issueId });
}
