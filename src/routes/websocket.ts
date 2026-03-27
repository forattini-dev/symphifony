import { now } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { computeMetrics } from "../domains/metrics.ts";
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

export function unsubscribeFromAllRooms(socketId: string): void {
  for (const room of serviceLogRooms.values()) room.delete(socketId);
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
          logger.debug({ socketId, serviceId: msg.id }, "[WebSocket] Subscribed to service log room");
        } else if (msg.type === "service:log:unsubscribe" && typeof msg.id === "string") {
          unsubscribeServiceLogRoom(socketId, msg.id);
          logger.debug({ socketId, serviceId: msg.id }, "[WebSocket] Unsubscribed from service log room");
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
