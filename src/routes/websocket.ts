import { now } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { computeMetrics } from "../domains/metrics.ts";
import { STATE_ROOT } from "../concerns/constants.ts";
import { startServiceLogBroadcasting } from "../persistence/plugins/service-log-broadcaster.ts";
import type { RuntimeState } from "../types.ts";

// ── WebSocket broadcast (same port via listeners) ────────────────────────────
// s3db.js 21.2.7 WebSocket contract: handlers receive (socketId, send, req)
// instead of raw socket objects. We track socketId → send function.

type WsClientMessage = Record<string, unknown>;
type WsClientCommandHandler = (socketId: string, payload: WsClientMessage, send: WsSendFn) => void;

type WsClientMessageType =
  | "ping"
  | "service:log:subscribe"
  | "service:log:unsubscribe"
  | "services:subscribe"
  | "services:unsubscribe"
  | "analytics:subscribe"
  | "analytics:unsubscribe"
  | "issue:log:subscribe"
  | "issue:log:unsubscribe"
  | "mesh:subscribe"
  | "mesh:unsubscribe";

type MeshSnapshotPayload = {
  graph: unknown;
  traffic: unknown;
  nativeGraph?: unknown;
  status?: Record<string, unknown>;
};

type ServicesSnapshotPayload = {
  services: unknown;
};

type MeshSnapshotProvider = (() => MeshSnapshotPayload | null) | null;
type ServicesSnapshotProvider = (() => ServicesSnapshotPayload | null) | null;

let meshSnapshotProvider: MeshSnapshotProvider = null;
let servicesSnapshotProvider: ServicesSnapshotProvider = null;
let meshSnapshotSeq = 0;

const wsClientHandlers = new Map<WsClientMessageType, WsClientCommandHandler>();
const wsClientTypeGuards: Record<WsClientMessageType, (msg: WsClientMessage) => boolean> = {
  ping: () => true,
  "service:log:subscribe": (msg) => typeof msg?.id === "string",
  "service:log:unsubscribe": (msg) => typeof msg?.id === "string",
  "services:subscribe": () => true,
  "services:unsubscribe": () => true,
  "analytics:subscribe": (msg) => typeof msg?.topic === "string",
  "analytics:unsubscribe": (msg) => typeof msg?.topic === "string",
  "issue:log:subscribe": (msg) => typeof msg?.id === "string",
  "issue:log:unsubscribe": (msg) => typeof msg?.id === "string",
  "mesh:subscribe": () => true,
  "mesh:unsubscribe": () => true,
};

const wsTelemetry = {
  startedAt: now(),
  connectionAttempts: 0,
  successfulConnections: 0,
  disconnections: 0,
  connectionErrors: 0,
  inboundMessages: 0,
  outboundMessages: 0,
  inboundByType: Object.create(null),
  outboundByType: Object.create(null),
  invalidMessages: 0,
  unknownCommands: 0,
  invalidCommandPayloads: 0,
  commandErrors: 0,
  lastInboundAt: null as string | null,
  lastOutboundAt: null as string | null,
  lastConnectedAt: null as string | null,
  lastDisconnectedAt: null as string | null,
};

function wsNow() {
  return now();
}

function normalizeWsMessageType(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "__unknown__";
}

function incrementRecord(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function resolvePayloadType(payload: string | object): string {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
        return normalizeWsMessageType((parsed as { type?: unknown }).type);
      }
    } catch {
      return "__invalid-json__";
    }
  } else if ((payload as { type?: unknown }).type !== undefined) {
    return normalizeWsMessageType((payload as { type?: unknown }).type);
  }
  return "__unknown__";
}

function trackOutboundMessage(payload: string | object): void {
  const type = resolvePayloadType(payload);
  wsTelemetry.outboundMessages += 1;
  wsTelemetry.lastOutboundAt = wsNow();
  incrementRecord(wsTelemetry.outboundByType, type);
}

function trackInboundMessage(message: WsClientMessage): void {
  const type = normalizeWsMessageType(message?.type);
  wsTelemetry.inboundMessages += 1;
  wsTelemetry.lastInboundAt = wsNow();
  incrementRecord(wsTelemetry.inboundByType, type);
}

function cleanupStaleSocket(socketId: string): void {
  unsubscribeFromAllRooms(socketId);
  wsClients.delete(socketId);
}

function sendToSocket(socketId: string, payload: string | object): boolean {
  const send = wsClients.get(socketId);
  if (!send) return false;
  const encoded = typeof payload === "string" ? payload : JSON.stringify(payload);
  try {
    send(encoded);
    trackOutboundMessage(encoded);
    return true;
  } catch {
    wsTelemetry.connectionErrors += 1;
    cleanupStaleSocket(socketId);
    return false;
  }
}

function sendToSocketList(socketIds: Set<string>, payload: string | object): void {
  const safePayload = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const socketId of [...socketIds]) {
    const send = wsClients.get(socketId);
    if (!send) {
      socketIds.delete(socketId);
      continue;
    }
    try {
      send(safePayload);
      trackOutboundMessage(safePayload);
    } catch {
      wsTelemetry.connectionErrors += 1;
      cleanupStaleSocket(socketId);
      socketIds.delete(socketId);
    }
  }
}

export type WsSendFn = (data: string) => void;
export const wsClients = new Map<string, WsSendFn>(); // socketId → send
export let broadcastSeq = 0;
let servicesSnapshotSeq = 0;
export let lastBroadcastIssueSnapshot: Map<string, string> = new Map(); // id → JSON

export function setMeshSnapshotProvider(fn: MeshSnapshotProvider): void {
  meshSnapshotProvider = fn;
}

export function setServicesSnapshotProvider(fn: ServicesSnapshotProvider): void {
  servicesSnapshotProvider = fn;
}

export function notifyServicesSnapshot(): void {
  const payload = servicesSnapshotProvider?.();
  if (!payload || wsClients.size === 0) return;

  servicesSnapshotSeq += 1;
  sendToServicesRoom({
    type: "services:snapshot",
    ...payload,
    seq: servicesSnapshotSeq,
    timestamp: now(),
  });
}

export function notifyMeshSnapshot(): void {
  const payload = meshSnapshotProvider?.();
  if (!payload || !meshRoomHasSubscribers()) return;

  meshSnapshotSeq += 1;
  sendToMeshRoom({
    type: "mesh:snapshot",
    ...payload,
    seq: meshSnapshotSeq,
    timestamp: now(),
  });
}

// ── Service log rooms ─────────────────────────────────────────────────────────
// Clients subscribe to a specific service's log stream.
// Chunks are only sent to subscribed clients — not broadcasted to everyone.

const serviceLogRooms = new Map<string, Set<string>>(); // serviceId → Set<socketId>

export function subscribeServiceLogRoom(socketId: string, serviceId: string): void {
  if (!serviceLogRooms.has(serviceId)) serviceLogRooms.set(serviceId, new Set());
  serviceLogRooms.get(serviceId)!.add(socketId);
}

export function unsubscribeServiceLogRoom(socketId: string, serviceId: string): void {
  serviceLogRooms.get(serviceId)?.delete(socketId);
}

// ── Analytics rooms ───────────────────────────────────────────────────────────
// Clients subscribe to analytics topics (e.g. "analytics:tokens").
// Server pushes computed payloads proactively; no polling needed on the client.

const analyticsRooms = new Map<string, Set<string>>(); // topic → Set<socketId>

// Called when a client subscribes — injected by queue-workers to push current data immediately.
type AnalyticsPushFn = (socketId: string, topic: string) => void;
let analyticsOnSubscribeFn: AnalyticsPushFn | null = null;

export function setAnalyticsOnSubscribeFn(fn: AnalyticsPushFn | null): void {
  analyticsOnSubscribeFn = fn;
}

export function subscribeAnalyticsRoom(socketId: string, topic: string): void {
  if (!analyticsRooms.has(topic)) analyticsRooms.set(topic, new Set());
  analyticsRooms.get(topic)!.add(socketId);
  analyticsOnSubscribeFn?.(socketId, topic);
}

export function unsubscribeAnalyticsRoom(socketId: string, topic: string): void {
  analyticsRooms.get(topic)?.delete(socketId);
}

export function analyticsRoomHasSubscribers(topic: string): boolean {
  return (analyticsRooms.get(topic)?.size ?? 0) > 0;
}

export function sendToAnalyticsRoom(topic: string, data: Record<string, unknown>): void {
  const room = analyticsRooms.get(topic);
  if (!room || room.size === 0) return;
  const msg = JSON.stringify({ type: "analytics:update", topic, data });
  sendToSocketList(room, msg);
}

// ── Issue log rooms ───────────────────────────────────────────────────────────
// Clients subscribe to a specific issue's live-output.log stream.
// The broadcaster (issue-log-broadcaster.ts) pushes new chunks as the agent writes.

const issueLogRooms = new Map<string, Set<string>>(); // issueId → Set<socketId>

export function subscribeIssueLogRoom(socketId: string, issueId: string): void {
  if (!issueLogRooms.has(issueId)) issueLogRooms.set(issueId, new Set());
  issueLogRooms.get(issueId)!.add(socketId);
}

export function unsubscribeIssueLogRoom(socketId: string, issueId: string): void {
  issueLogRooms.get(issueId)?.delete(socketId);
}

export function issueLogRoomSize(issueId: string): number {
  return issueLogRooms.get(issueId)?.size ?? 0;
}

export function sendToIssueLogRoom(issueId: string, data: string): void {
  const room = issueLogRooms.get(issueId);
  if (!room || room.size === 0) return;
  sendToSocketList(room, data);
}

// ── Services room ────────────────────────────────────────────────────────────
// Clients subscribed to this room receive the global services list snapshot.

const servicesRoom = new Set<string>(); // socketIds

export function subscribeServicesRoom(socketId: string): void {
  servicesRoom.add(socketId);
}

export function unsubscribeServicesRoom(socketId: string): void {
  servicesRoom.delete(socketId);
}

export function servicesRoomHasSubscribers(): boolean {
  return servicesRoom.size > 0;
}

export function sendToServicesRoom(data: Record<string, unknown>): void {
  if (servicesRoom.size === 0) return;
  const msg = JSON.stringify(data);
  sendToSocketList(servicesRoom, msg);
}

// ── Mesh traffic room ─────────────────────────────────────────────────────────
// Clients subscribe to real-time inter-service traffic captured by the mesh proxy.

const meshRoom = new Set<string>(); // socketIds

export function subscribeMeshRoom(socketId: string): void {
  meshRoom.add(socketId);
}

export function unsubscribeMeshRoom(socketId: string): void {
  meshRoom.delete(socketId);
}

export function sendToMeshRoom(data: Record<string, unknown>): void {
  if (meshRoom.size === 0) return;
  const msg = JSON.stringify(data);
  sendToSocketList(meshRoom, msg);
}

export function meshRoomHasSubscribers(): boolean {
  return meshRoom.size > 0;
}

export function unsubscribeFromAllRooms(socketId: string): void {
  for (const room of serviceLogRooms.values()) room.delete(socketId);
  for (const room of analyticsRooms.values()) room.delete(socketId);
  for (const room of issueLogRooms.values()) room.delete(socketId);
  servicesRoom.delete(socketId);
  meshRoom.delete(socketId);
}

export function serviceLogRoomSize(serviceId: string): number {
  return serviceLogRooms.get(serviceId)?.size ?? 0;
}

export function sendToServiceLogRoom(serviceId: string, data: string): void {
  const room = serviceLogRooms.get(serviceId);
  if (!room || room.size === 0) return;
  sendToSocketList(room, data);
}

export function sendToAllClients(data: string): void {
  for (const socketId of [...wsClients.keys()]) {
    if (!sendToSocket(socketId, data)) {
      logger.debug(`WebSocket send failed for ${socketId}, removing (remaining: ${wsClients.size - 1})`);
    }
  }
}

export function parseWsClientMessage(raw: string | Buffer): WsClientMessage | null {
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) return null;
  const payload = typeof raw === "string" ? raw : raw.toString("utf8");
  try {
    const msg = JSON.parse(payload);
    return msg && typeof msg === "object" ? msg : null;
  } catch {
    return null;
  }
}

function registerWsCommandHandlers() {
  if (wsClientHandlers.size > 0) return;

  wsClientHandlers.set("ping", (_socketId, _payload) => {
    const payload = _payload as { type?: unknown; seq?: unknown; clientTs?: unknown };
    const seq = typeof payload.seq === "number" ? payload.seq : undefined;
    const clientTs = typeof payload.clientTs === "number" || typeof payload.clientTs === "string"
      ? payload.clientTs
      : undefined;
    sendToSocket(_socketId, {
      type: "pong",
      seq,
      clientTs,
      timestamp: now(),
    });
  });

  wsClientHandlers.set("service:log:subscribe", (socketId, payload) => {
    const serviceId = payload.id;
    if (typeof serviceId !== "string") return;
    subscribeServiceLogRoom(socketId, serviceId);
    // Ensure the file watcher is active — it may not be if the server restarted
    // while the service was already running, or if the page opened mid-run.
    startServiceLogBroadcasting(serviceId, STATE_ROOT);
    logger.debug({ socketId, serviceId }, "[WebSocket] Subscribed to service log room");
  });
  wsClientHandlers.set("service:log:unsubscribe", (socketId, payload) => {
    const serviceId = payload.id;
    if (typeof serviceId !== "string") return;
    unsubscribeServiceLogRoom(socketId, serviceId);
    logger.debug({ socketId, serviceId }, "[WebSocket] Unsubscribed from service log room");
  });

  wsClientHandlers.set("services:subscribe", (socketId) => {
    subscribeServicesRoom(socketId);
    const snapshot = servicesSnapshotProvider?.();
    if (snapshot) {
      sendToSocket(socketId, {
        type: "services:snapshot",
        ...snapshot,
        seq: servicesSnapshotSeq,
        timestamp: now(),
      });
    }
    logger.debug({ socketId }, "[WebSocket] Subscribed to services room");
  });
  wsClientHandlers.set("services:unsubscribe", (socketId) => {
    unsubscribeServicesRoom(socketId);
    logger.debug({ socketId }, "[WebSocket] Unsubscribed from services room");
  });

  wsClientHandlers.set("analytics:subscribe", (socketId, payload) => {
    const topic = payload.topic;
    if (typeof topic !== "string") return;
    subscribeAnalyticsRoom(socketId, topic);
    logger.debug({ socketId, topic }, "[WebSocket] Subscribed to analytics room");
  });
  wsClientHandlers.set("analytics:unsubscribe", (socketId, payload) => {
    const topic = payload.topic;
    if (typeof topic !== "string") return;
    unsubscribeAnalyticsRoom(socketId, topic);
    logger.debug({ socketId, topic }, "[WebSocket] Unsubscribed from analytics room");
  });

  wsClientHandlers.set("issue:log:subscribe", (socketId, payload) => {
    const issueId = payload.id;
    if (typeof issueId !== "string") return;
    subscribeIssueLogRoom(socketId, issueId);
    logger.debug({ socketId, issueId }, "[WebSocket] Subscribed to issue log room");
  });
  wsClientHandlers.set("issue:log:unsubscribe", (socketId, payload) => {
    const issueId = payload.id;
    if (typeof issueId !== "string") return;
    unsubscribeIssueLogRoom(socketId, issueId);
    logger.debug({ socketId, issueId }, "[WebSocket] Unsubscribed from issue log room");
  });

  wsClientHandlers.set("mesh:subscribe", (socketId) => {
    subscribeMeshRoom(socketId);
    const snapshot = meshSnapshotProvider?.();
    if (snapshot) {
      sendToSocket(socketId, {
        type: "mesh:snapshot",
        ...snapshot,
        seq: meshSnapshotSeq,
        timestamp: now(),
      });
    }
    logger.debug({ socketId }, "[WebSocket] Subscribed to mesh traffic room");
  });
  wsClientHandlers.set("mesh:unsubscribe", (socketId) => {
    unsubscribeMeshRoom(socketId);
    logger.debug({ socketId }, "[WebSocket] Unsubscribed from mesh traffic room");
  });
}

export function handleWsClientMessage(socketId: string, rawMessage: string | Buffer, send: WsSendFn): void {
  const msg = parseWsClientMessage(rawMessage);
  if (!msg) {
    wsTelemetry.invalidMessages += 1;
    return;
  }

  trackInboundMessage(msg);
  const type = msg.type;
  if (typeof type !== "string") {
    wsTelemetry.invalidMessages += 1;
    return;
  }
  const handler = wsClientHandlers.get(type as WsClientMessageType);
  if (!handler) {
    wsTelemetry.unknownCommands += 1;
    return;
  }

  const guard = wsClientTypeGuards[type as WsClientMessageType];
  if (guard && !guard(msg)) {
    wsTelemetry.invalidCommandPayloads += 1;
    return;
  }

  try {
    handler(socketId, msg, send);
  } catch (error) {
    wsTelemetry.commandErrors += 1;
    logger.debug({ err: String(error), type, socketId }, "[WebSocket] Command handler failed");
  }
}

/** Real-time execution progress push — tokens, turn count, phase, elapsed time.
 *  Inspired by Claude Code's ProgressTracker per agent. */
export type IssueProgress = {
  issueId: string;
  identifier: string;
  phase: "turn_started" | "turn_completed";
  turn: number;
  maxTurns: number;
  role: string;
  provider: string;
  elapsedMs: number;
  tokens?: { input: number; output: number; total: number };
  cumulativeTokens?: { input: number; output: number; total: number };
  toolsUsed?: string[];
  directiveStatus?: string;
  directiveSummary?: string;
};

export function broadcastIssueProgress(progress: IssueProgress): void {
  if (wsClients.size === 0) return;
  const data = JSON.stringify({ type: "issue:progress", ...progress });
  sendToAllClients(data);
}

/** Direct WS push when an issue transitions state.
 *  Bypasses the persist→broadcast→delta chain for instant frontend updates. */
export function broadcastIssueTransition(issue: { id: string; state: string; [k: string]: unknown }): void {
  if (wsClients.size === 0) return;
  const data = JSON.stringify({
    type: "issue:transition",
    id: issue.id,
    state: issue.state,
    issue,
  });
  sendToAllClients(data);
}

export function broadcastToWebSocketClients(message: Record<string, unknown>): void {
  if (wsClients.size === 0) return;

  broadcastSeq++;
  logger.debug({ seq: broadcastSeq, type: message.type, clientCount: wsClients.size }, "[WebSocket] Broadcasting state update");
  const issues = message.issues as Array<Record<string, unknown>> | undefined;

  if (issues && lastBroadcastIssueSnapshot.size > 0) {
    // Compute delta: only changed/new/removed issues
    const currentIds = new Set<string>();
    const changedIssues: Array<Record<string, unknown>> = [];

    for (const issue of issues) {
      const id = issue.id as string;
      currentIds.add(id);
      const serialized = JSON.stringify(issue);
      if (lastBroadcastIssueSnapshot.get(id) !== serialized) {
        changedIssues.push(issue);
      }
    }

    const removedIds: string[] = [];
    for (const prevId of lastBroadcastIssueSnapshot.keys()) {
      if (!currentIds.has(prevId)) {
        removedIds.push(prevId);
      }
    }

    // Update snapshot
    lastBroadcastIssueSnapshot = new Map(
      issues.map((issue) => [issue.id as string, JSON.stringify(issue)]),
    );

    // If fewer than half changed, send a delta instead of full state
    if (changedIssues.length < issues.length / 2 || changedIssues.length <= 3) {
      const delta: Record<string, unknown> = {
        type: "state:delta",
        seq: broadcastSeq,
        metrics: message.metrics,
        milestones: message.milestones,
        updatedAt: message.updatedAt,
        issuesDelta: changedIssues,
        issuesRemoved: removedIds,
        events: message.events,
      };
      sendToAllClients(JSON.stringify(delta));
      return;
    }
  }

  // Full state broadcast (first time or too many changes)
  if (issues) {
    lastBroadcastIssueSnapshot = new Map(
      issues.map((issue) => [issue.id as string, JSON.stringify(issue)]),
    );
  }

  sendToAllClients(JSON.stringify({
    ...message,
    seq: broadcastSeq,
  }));
}

export function makeWebSocketConfig(state: RuntimeState) {
  registerWsCommandHandlers();
  return {
    enabled: true,
    path: "/ws",
    maxPayloadBytes: 512_000,
    onConnection: (socketId: string, send: WsSendFn) => {
      wsClients.set(socketId, send);
      wsTelemetry.connectionAttempts += 1;
      wsTelemetry.successfulConnections += 1;
      wsTelemetry.lastConnectedAt = wsNow();
      logger.debug(`WebSocket client connected: ${socketId} (total: ${wsClients.size})`);
      try {
        subscribeServicesRoom(socketId);
        sendToSocket(socketId, JSON.stringify({
          type: "connected",
          seq: broadcastSeq,
          timestamp: now(),
          metrics: computeMetrics(state.issues),
          milestones: state.milestones,
          issues: state.issues,
          events: state.events.slice(0, 50),
        }));

        const servicesSnapshot = servicesSnapshotProvider?.();
        if (servicesSnapshot) {
          sendToSocket(socketId, {
            type: "services:snapshot",
            ...servicesSnapshot,
            seq: servicesSnapshotSeq,
            timestamp: now(),
          });
        }

        const meshSnapshot = meshSnapshotProvider?.();
        if (meshSnapshot) {
          sendToSocket(socketId, {
            type: "mesh:snapshot",
            ...meshSnapshot,
            seq: meshSnapshotSeq,
            timestamp: now(),
          });
        }
      } catch (error) {
        logger.debug(`WebSocket initial send failed for ${socketId}: ${String(error)}`);
      }
    },
    onMessage: (socketId: string, message: string | Buffer, send: WsSendFn) => {
      handleWsClientMessage(socketId, message, send);
    },
    onClose: (socketId: string) => {
      wsClients.delete(socketId);
      wsTelemetry.disconnections += 1;
      wsTelemetry.lastDisconnectedAt = wsNow();
      unsubscribeFromAllRooms(socketId);
      logger.debug(`WebSocket client disconnected: ${socketId} (total: ${wsClients.size})`);
    },
  };
}

export function getWsTelemetry() {
  return {
    ...wsTelemetry,
    activeConnections: wsClients.size,
    inboundByType: { ...wsTelemetry.inboundByType },
    outboundByType: { ...wsTelemetry.outboundByType },
    startedAt: wsTelemetry.startedAt,
    lastInboundAt: wsTelemetry.lastInboundAt,
    lastOutboundAt: wsTelemetry.lastOutboundAt,
    lastConnectedAt: wsTelemetry.lastConnectedAt,
    lastDisconnectedAt: wsTelemetry.lastDisconnectedAt,
  };
}

export function resetWsTelemetry() {
  wsTelemetry.startedAt = now();
  wsTelemetry.connectionAttempts = 0;
  wsTelemetry.successfulConnections = 0;
  wsTelemetry.disconnections = 0;
  wsTelemetry.connectionErrors = 0;
  wsTelemetry.inboundMessages = 0;
  wsTelemetry.outboundMessages = 0;
  wsTelemetry.inboundByType = Object.create(null);
  wsTelemetry.outboundByType = Object.create(null);
  wsTelemetry.invalidMessages = 0;
  wsTelemetry.unknownCommands = 0;
  wsTelemetry.invalidCommandPayloads = 0;
  wsTelemetry.commandErrors = 0;
  wsTelemetry.lastInboundAt = null;
  wsTelemetry.lastOutboundAt = null;
  wsTelemetry.lastConnectedAt = null;
  wsTelemetry.lastDisconnectedAt = null;
  return getWsTelemetry();
}
