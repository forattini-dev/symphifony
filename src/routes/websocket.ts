import { now } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { computeMetrics } from "../domains/metrics.ts";
import { STATE_ROOT } from "../concerns/constants.ts";
import { startServiceLogBroadcasting } from "../persistence/plugins/service-log-broadcaster.ts";
import type { RuntimeState } from "../types.ts";

// ── WebSocket broadcast (same port via listeners) ────────────────────────────
// s3db.js 21.2.7 WebSocket contract: handlers receive (socketId, send, req)
// instead of raw socket objects. We track socketId → send function.

export type WsSendFn = (data: string) => void;
export const wsClients = new Map<string, WsSendFn>(); // socketId → send
export let broadcastSeq = 0;
export let lastBroadcastIssueSnapshot: Map<string, string> = new Map(); // id → JSON

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
  for (const socketId of [...room]) {
    const send = wsClients.get(socketId);
    if (!send) { room.delete(socketId); continue; }
    try { send(msg); } catch { wsClients.delete(socketId); room.delete(socketId); }
  }
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
  for (const socketId of [...room]) {
    const send = wsClients.get(socketId);
    if (!send) { room.delete(socketId); continue; }
    try { send(data); } catch { wsClients.delete(socketId); room.delete(socketId); }
  }
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
  for (const socketId of [...meshRoom]) {
    const send = wsClients.get(socketId);
    if (!send) { meshRoom.delete(socketId); continue; }
    try { send(msg); } catch { wsClients.delete(socketId); meshRoom.delete(socketId); }
  }
}

export function meshRoomHasSubscribers(): boolean {
  return meshRoom.size > 0;
}

export function unsubscribeFromAllRooms(socketId: string): void {
  for (const room of serviceLogRooms.values()) room.delete(socketId);
  for (const room of analyticsRooms.values()) room.delete(socketId);
  for (const room of issueLogRooms.values()) room.delete(socketId);
  meshRoom.delete(socketId);
}

export function serviceLogRoomSize(serviceId: string): number {
  return serviceLogRooms.get(serviceId)?.size ?? 0;
}

export function sendToServiceLogRoom(serviceId: string, data: string): void {
  const room = serviceLogRooms.get(serviceId);
  if (!room || room.size === 0) return;
  for (const socketId of [...room]) {
    const send = wsClients.get(socketId);
    if (!send) { room.delete(socketId); continue; }
    try { send(data); } catch { wsClients.delete(socketId); room.delete(socketId); }
  }
}

export function sendToAllClients(data: string): void {
  for (const [socketId, send] of [...wsClients]) {
    try { send(data); } catch (error) {
      logger.debug(`WebSocket send failed for ${socketId}, removing (remaining: ${wsClients.size - 1}): ${String(error)}`);
      wsClients.delete(socketId);
    }
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
  return {
    enabled: true,
    path: "/ws",
    maxPayloadBytes: 512_000,
    onConnection: (socketId: string, send: WsSendFn) => {
      wsClients.set(socketId, send);
      logger.debug(`WebSocket client connected: ${socketId} (total: ${wsClients.size})`);
      try {
        send(JSON.stringify({
          type: "connected",
          seq: broadcastSeq,
          timestamp: now(),
          metrics: computeMetrics(state.issues),
          milestones: state.milestones,
          issues: state.issues,
          events: state.events.slice(0, 50),
        }));
      } catch (error) {
        logger.debug(`WebSocket initial send failed for ${socketId}: ${String(error)}`);
      }
    },
    onMessage: (socketId: string, message: string | Buffer, send: WsSendFn) => {
      try {
        const msg = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
        if (msg.type === "ping") {
          send(JSON.stringify({ type: "pong", timestamp: now() }));
        } else if (msg.type === "service:log:subscribe" && typeof msg.id === "string") {
          subscribeServiceLogRoom(socketId, msg.id);
          // Ensure the file watcher is active — it may not be if the server restarted
          // while the service was already running, or if the page opened mid-run.
          startServiceLogBroadcasting(msg.id, STATE_ROOT);
          logger.debug({ socketId, serviceId: msg.id }, "[WebSocket] Subscribed to service log room");
        } else if (msg.type === "service:log:unsubscribe" && typeof msg.id === "string") {
          unsubscribeServiceLogRoom(socketId, msg.id);
          logger.debug({ socketId, serviceId: msg.id }, "[WebSocket] Unsubscribed from service log room");
        } else if (msg.type === "analytics:subscribe" && typeof msg.topic === "string") {
          subscribeAnalyticsRoom(socketId, msg.topic);
          logger.debug({ socketId, topic: msg.topic }, "[WebSocket] Subscribed to analytics room");
        } else if (msg.type === "analytics:unsubscribe" && typeof msg.topic === "string") {
          unsubscribeAnalyticsRoom(socketId, msg.topic);
          logger.debug({ socketId, topic: msg.topic }, "[WebSocket] Unsubscribed from analytics room");
        } else if (msg.type === "issue:log:subscribe" && typeof msg.id === "string") {
          subscribeIssueLogRoom(socketId, msg.id);
          logger.debug({ socketId, issueId: msg.id }, "[WebSocket] Subscribed to issue log room");
        } else if (msg.type === "issue:log:unsubscribe" && typeof msg.id === "string") {
          unsubscribeIssueLogRoom(socketId, msg.id);
          logger.debug({ socketId, issueId: msg.id }, "[WebSocket] Unsubscribed from issue log room");
        } else if (msg.type === "mesh:subscribe") {
          subscribeMeshRoom(socketId);
          logger.debug({ socketId }, "[WebSocket] Subscribed to mesh traffic room");
        } else if (msg.type === "mesh:unsubscribe") {
          unsubscribeMeshRoom(socketId);
          logger.debug({ socketId }, "[WebSocket] Unsubscribed from mesh traffic room");
        }
      } catch {}
    },
    onClose: (socketId: string) => {
      wsClients.delete(socketId);
      unsubscribeFromAllRooms(socketId);
      logger.debug(`WebSocket client disconnected: ${socketId} (total: ${wsClients.size})`);
    },
  };
}
