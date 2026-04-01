import {
  WS_MESSAGE_TYPES,
  WS_COMMAND_TYPES,
  makeAnalyticsSubscribe,
  makeAnalyticsUnsubscribe,
  makeIssueLogSubscribe,
  makeIssueLogUnsubscribe,
  makeServicesSubscribe,
  makeServicesUnsubscribe,
  makeMeshSubscribe,
  makeMeshUnsubscribe,
  makeReverseProxySubscribe,
  makeReverseProxyUnsubscribe,
  makeServiceLogSubscribe,
  makeServiceLogUnsubscribe,
  parseIncomingMessage,
} from "./contracts.js";

const WS_STATUS = {
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  ERROR: "error",
};

const STATUS_ANY = "__all__";
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 2_000;
const PING_INTERVAL_MS = 25_000;
const EVENT_WINDOW = 100;

let websocket = null;
let status = WS_STATUS.DISCONNECTED;
let reconnectTimer = null;
let pingTimer = null;
let reconnectBackoff = BASE_BACKOFF_MS;
let isActive = false;
let consumerCount = 0;
let currentPingSeq = 0;
let connectedSince = null;

const pendingPings = new Map();
const messageCounts = new Map();
const outboundMessageCounts = new Map();
const connectEvents = [];
const inboundEvents = [];
const outboundEvents = [];

const statusListeners = new Set();
const messageListeners = new Map(); // key: eventType | "__all__" -> Set<fn>

const serviceLogSubscribers = new Set();
const issueLogSubscribers = new Set();
const analyticsSubscribers = new Map();
let meshSubscribers = 0;
let servicesSubscribers = 0;
let reverseProxySubscribers = 0;

const telemetry = {
  startedAt: Date.now(),
  connectAttempts: 0,
  reconnects: 0,
  successfulConnections: 0,
  disconnects: 0,
  connectionErrors: 0,
  parseErrors: 0,
  reconnectWaitMs: BASE_BACKOFF_MS,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastMessageAt: null,
  lastSentAt: null,
  status: WS_STATUS.DISCONNECTED,
  activeConsumers: 0,
  activeSocket: false,
  totalSent: 0,
  totalReceived: 0,
  pingsSent: 0,
  pongsReceived: 0,
  lastPingRttMs: null,
  messageCounts: {},
  outboundMessageCounts: {},
  connectEvents: [],
  inboundEvents: [],
  outboundEvents: [],
};

function now() {
  return Date.now();
}

function keepRecent(list, item, max = EVENT_WINDOW) {
  list.push(item);
  if (list.length > max) list.shift();
}

function emitMetricEvent(type, payload = {}) {
  const event = { at: now(), ...payload };
  if (type === "inbound") keepRecent(inboundEvents, event);
  else if (type === "outbound") keepRecent(outboundEvents, event);
  else if (type === "connect") keepRecent(connectEvents, event);
}

function normalizeMessageType(value) {
  return typeof value === "string" && value.length > 0 ? value : "__unknown__";
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapToRecord(map) {
  return Object.fromEntries(map.entries());
}

function getSnapshot() {
  return {
    ...telemetry,
    activeConsumers: consumerCount,
    activeSocket: websocket !== null,
    reconnectWaitMs: reconnectBackoff,
    messageCounts: mapToRecord(messageCounts),
    outboundMessageCounts: mapToRecord(outboundMessageCounts),
    connectEvents: [...connectEvents],
    inboundEvents: [...inboundEvents],
    outboundEvents: [...outboundEvents],
    connectedSince,
  };
}

function emitStatus(nextStatus) {
  if (status === nextStatus) return;
  status = nextStatus;
  telemetry.status = nextStatus;
  for (const cb of [...statusListeners]) {
    try {
      cb(status);
    } catch {
      // Best effort fanout.
    }
  }
}

function addMessageListener(type, handler) {
  let set = messageListeners.get(type);
  if (!set) {
    set = new Set();
    messageListeners.set(type, set);
  }
  set.add(handler);
  return () => set.delete(handler);
}

function emitMessage(msg) {
  const type = normalizeMessageType(msg?.type);
  telemetry.totalReceived += 1;
  telemetry.lastMessageAt = now();
  bump(messageCounts, type);
  emitMetricEvent("inbound", { type, status });

  const allSet = messageListeners.get(STATUS_ANY) ?? new Set();
  for (const cb of [...allSet]) {
    try {
      cb(msg);
    } catch {
      // Listener failures should not block the rest.
    }
  }

  const typedSet = messageListeners.get(msg?.type);
  if (!typedSet) return;
  for (const cb of [...typedSet]) {
    try {
      cb(msg);
    } catch {
      // Listener failures should not block the rest.
    }
  }
}

function sendIfConnected(payload) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
  const type = normalizeMessageType(payload?.type);
  telemetry.totalSent += 1;
  telemetry.lastSentAt = now();
  bump(outboundMessageCounts, type);
  if (type === WS_COMMAND_TYPES.PING && typeof payload?.seq === "number") {
    const ts = typeof payload?.ts === "number" ? payload.ts : now();
    pendingPings.set(payload.seq, ts);
  }
  emitMetricEvent("outbound", {
    type,
    consumerCount,
    socketReadyState: websocket.readyState,
  });
  websocket.send(JSON.stringify(payload));
  return true;
}

function safeSendPayload(payload) {
  try {
    return sendIfConnected(payload);
  } catch (error) {
    telemetry.connectionErrors += 1;
    throw error;
  }
}

function sendPing() {
  currentPingSeq += 1;
  const payload = {
    type: WS_COMMAND_TYPES.PING,
    seq: currentPingSeq,
    ts: now(),
  };
  pendingPings.set(currentPingSeq, payload.ts);
  telemetry.pingsSent += 1;
  safeSendPayload(payload);
}

function resubscribeAll() {
  for (const serviceId of serviceLogSubscribers) {
    sendIfConnected(makeServiceLogSubscribe(serviceId));
  }
  for (const issueId of issueLogSubscribers) {
    sendIfConnected(makeIssueLogSubscribe(issueId));
  }
  for (const [topic, count] of analyticsSubscribers) {
    if (count > 0) sendIfConnected(makeAnalyticsSubscribe(topic));
  }
  if (servicesSubscribers > 0) sendIfConnected(makeServicesSubscribe());
  if (meshSubscribers > 0) sendIfConnected(makeMeshSubscribe());
  if (reverseProxySubscribers > 0) sendIfConnected(makeReverseProxySubscribe());
}

function connect() {
  if (websocket) return;
  if (!isActive || consumerCount <= 0) return;

  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  try {
    telemetry.connectAttempts += 1;
    emitMetricEvent("connect", { type: "attempt", url, consumerCount });
    websocket = new WebSocket(url);
  } catch {
    emitStatus(WS_STATUS.ERROR);
    telemetry.connectionErrors += 1;
    reconnectLater();
    return;
  }

  emitStatus(WS_STATUS.CONNECTING);

  websocket.onopen = () => {
    emitStatus(WS_STATUS.CONNECTED);
    telemetry.successfulConnections += 1;
    telemetry.lastConnectedAt = now();
    connectedSince = telemetry.lastConnectedAt;
    emitMetricEvent("connect", { type: "open", status });
    reconnectBackoff = BASE_BACKOFF_MS;
    telemetry.reconnectWaitMs = BASE_BACKOFF_MS;
    resubscribeAll();
    clearInterval(pingTimer);
    pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
  };

  websocket.onmessage = (event) => {
    const msg = parseIncomingMessage(event.data);
    if (!msg) {
      telemetry.parseErrors += 1;
      emitMetricEvent("inbound", { type: "parse_error", status });
      return;
    }

    if (msg.type === WS_MESSAGE_TYPES.PONG && typeof msg.seq === "number") {
      const sentAt = pendingPings.get(msg.seq);
      if (typeof sentAt === "number") {
        telemetry.pongsReceived += 1;
        telemetry.lastPingRttMs = Math.max(0, now() - sentAt);
        pendingPings.delete(msg.seq);
      }
    }

    emitMessage(msg);
  };

  websocket.onclose = () => {
    emitStatus(WS_STATUS.DISCONNECTED);
    telemetry.disconnects += 1;
    telemetry.lastDisconnectedAt = now();
    connectedSince = null;
    websocket = null;
    clearInterval(pingTimer);
    pingTimer = null;
    pendingPings.clear();

    if (isActive && consumerCount > 0) {
      telemetry.reconnects += 1;
      reconnectLater();
    } else {
      reconnectBackoff = BASE_BACKOFF_MS;
      telemetry.reconnectWaitMs = BASE_BACKOFF_MS;
    }
  };

  websocket.onerror = () => {
    emitStatus(WS_STATUS.ERROR);
    telemetry.connectionErrors += 1;
  };
}

function reconnectLater() {
  if (!isActive || consumerCount <= 0) return;
  clearTimeout(reconnectTimer);
  const delay = reconnectBackoff;
  telemetry.reconnectWaitMs = delay;
  emitMetricEvent("connect", { type: "reconnect_scheduled", delay });

  reconnectTimer = setTimeout(() => {
    reconnectBackoff = Math.min(reconnectBackoff * 2, MAX_BACKOFF_MS);
    telemetry.reconnectWaitMs = reconnectBackoff;
    connect();
  }, delay);
}

function closeSocket() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(pingTimer);
  pingTimer = null;

  if (!websocket) {
    reconnectBackoff = BASE_BACKOFF_MS;
    telemetry.reconnectWaitMs = BASE_BACKOFF_MS;
    return;
  }

  websocket.onopen = null;
  websocket.onmessage = null;
  websocket.onclose = null;
  websocket.onerror = null;
  websocket.close();
  websocket = null;
  reconnectBackoff = BASE_BACKOFF_MS;
  telemetry.reconnectWaitMs = BASE_BACKOFF_MS;
}

export function onRuntimeStatus(handler) {
  statusListeners.add(handler);
  handler(status);
  return () => statusListeners.delete(handler);
}

export function onRuntimeMessage(type, handler) {
  return addMessageListener(type, handler);
}

export function startRuntimeSocket() {
  consumerCount += 1;
  isActive = true;
  connect();
  return () => {
    consumerCount = Math.max(consumerCount - 1, 0);
    if (consumerCount === 0) {
      isActive = false;
      closeSocket();
      emitStatus(WS_STATUS.DISCONNECTED);
    }
  };
}

export function sendWsPayload(payload) {
  if (!payload) return;
  safeSendPayload(payload);
}

export function subscribeServiceLog(serviceId) {
  if (!serviceId || typeof serviceId !== "string") return;
  serviceLogSubscribers.add(serviceId);
  safeSendPayload(makeServiceLogSubscribe(serviceId));
}

export function unsubscribeServiceLog(serviceId) {
  if (!serviceId || typeof serviceId !== "string") return;
  serviceLogSubscribers.delete(serviceId);
  safeSendPayload(makeServiceLogUnsubscribe(serviceId));
}

export function subscribeIssueLog(issueId) {
  if (!issueId || typeof issueId !== "string") return;
  issueLogSubscribers.add(issueId);
  safeSendPayload(makeIssueLogSubscribe(issueId));
}

export function unsubscribeIssueLog(issueId) {
  if (!issueId || typeof issueId !== "string") return;
  issueLogSubscribers.delete(issueId);
  safeSendPayload(makeIssueLogUnsubscribe(issueId));
}

export function subscribeMesh() {
  meshSubscribers += 1;
  if (meshSubscribers === 1) safeSendPayload(makeMeshSubscribe());
}

export function unsubscribeMesh() {
  meshSubscribers = Math.max(meshSubscribers - 1, 0);
  if (meshSubscribers === 0) safeSendPayload(makeMeshUnsubscribe());
}

export function subscribeServices() {
  servicesSubscribers += 1;
  if (servicesSubscribers === 1) safeSendPayload(makeServicesSubscribe());
}

export function unsubscribeServices() {
  servicesSubscribers = Math.max(servicesSubscribers - 1, 0);
  if (servicesSubscribers === 0) safeSendPayload(makeServicesUnsubscribe());
}

export function subscribeReverseProxy() {
  reverseProxySubscribers += 1;
  if (reverseProxySubscribers === 1) safeSendPayload(makeReverseProxySubscribe());
}

export function unsubscribeReverseProxy() {
  reverseProxySubscribers = Math.max(reverseProxySubscribers - 1, 0);
  if (reverseProxySubscribers === 0) safeSendPayload(makeReverseProxyUnsubscribe());
}

export function subscribeAnalyticsTopic(topic) {
  if (!topic || typeof topic !== "string") return;
  const next = (analyticsSubscribers.get(topic) ?? 0) + 1;
  analyticsSubscribers.set(topic, next);
  if (next === 1) safeSendPayload(makeAnalyticsSubscribe(topic));
}

export function unsubscribeAnalyticsTopic(topic) {
  if (!topic || typeof topic !== "string") return;
  const previous = analyticsSubscribers.get(topic) ?? 0;
  const next = Math.max(previous - 1, 0);
  analyticsSubscribers.set(topic, next);
  if (next === 0) safeSendPayload(makeAnalyticsUnsubscribe(topic));
}

export function clearRuntimeSocketState() {
  serviceLogSubscribers.clear();
  issueLogSubscribers.clear();
  analyticsSubscribers.clear();
  meshSubscribers = 0;
  servicesSubscribers = 0;
  reverseProxySubscribers = 0;
  pendingPings.clear();
  messageCounts.clear();
  outboundMessageCounts.clear();
}

export function getRuntimeSocketTelemetry() {
  return getSnapshot();
}

export function resetRuntimeSocketTelemetry() {
  telemetry.startedAt = now();
  telemetry.connectAttempts = 0;
  telemetry.reconnects = 0;
  telemetry.successfulConnections = 0;
  telemetry.disconnects = 0;
  telemetry.connectionErrors = 0;
  telemetry.parseErrors = 0;
  telemetry.lastConnectedAt = null;
  telemetry.lastDisconnectedAt = null;
  telemetry.lastMessageAt = null;
  telemetry.lastSentAt = null;
  telemetry.lastPingRttMs = null;
  telemetry.totalSent = 0;
  telemetry.totalReceived = 0;
  telemetry.pingsSent = 0;
  telemetry.pongsReceived = 0;
  telemetry.messageCounts = {};
  telemetry.outboundMessageCounts = {};
  telemetry.connectEvents.length = 0;
  telemetry.inboundEvents.length = 0;
  telemetry.outboundEvents.length = 0;
  connectEvents.length = 0;
  inboundEvents.length = 0;
  outboundEvents.length = 0;
  currentPingSeq = 0;
  messageCounts.clear();
  outboundMessageCounts.clear();
  connectedSince = null;
  reconnectBackoff = BASE_BACKOFF_MS;
  telemetry.reconnectWaitMs = BASE_BACKOFF_MS;
  return getSnapshot();
}

export function __setRuntimeSocketStateForTest(nextStatus, nextBackoff = BASE_BACKOFF_MS) {
  if (typeof nextStatus === "string" && Object.values(WS_STATUS).includes(nextStatus)) {
    emitStatus(nextStatus);
  }

  const backoff =
    typeof nextStatus === "number" && Number.isFinite(nextStatus)
      ? nextStatus
      : typeof nextBackoff === "number" && Number.isFinite(nextBackoff)
      ? nextBackoff
      : NaN;

  if (Number.isFinite(backoff)) {
    reconnectBackoff = Math.min(Math.max(250, Math.floor(backoff)), MAX_BACKOFF_MS);
    telemetry.reconnectWaitMs = reconnectBackoff;
  }
}

export { WS_MESSAGE_TYPES as messageTypes };
