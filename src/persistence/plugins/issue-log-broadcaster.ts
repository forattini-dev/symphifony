/**
 * Issue log broadcaster — polls live-output.log at 500ms intervals while an
 * agent is running and pushes new chunks to subscribed WebSocket clients.
 *
 * Position always advances (regardless of subscriber count) so that late
 * subscribers receive only bytes written after their HTTP initial-fetch, with
 * no duplication.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { agentLogPath } from "./fsm-agent.ts";
import { sendToIssueLogRoom, issueLogRoomSize } from "../../routes/websocket.ts";
import { logger } from "../../concerns/logger.ts";

const POLL_INTERVAL_MS = 500;
const MAX_CHUNK_BYTES = 16_384;

type Entry = { timerId: ReturnType<typeof setInterval>; position: number };

const active = new Map<string, Entry>();

function readNewBytes(
  logPath: string,
  position: number,
): { chunk: string; newPosition: number } | null {
  try {
    const size = statSync(logPath).size;
    if (size <= position) return null;
    const toRead = Math.min(size - position, MAX_CHUNK_BYTES);
    const buf = Buffer.alloc(toRead);
    const fd = openSync(logPath, "r");
    const n = readSync(fd, buf, 0, toRead, position);
    closeSync(fd);
    if (n <= 0) return null;
    return { chunk: buf.slice(0, n).toString("utf8"), newPosition: position + n };
  } catch {
    return null;
  }
}

export function startIssueLogBroadcasting(issueId: string, workspacePath: string): void {
  stopIssueLogBroadcasting(issueId);

  const logPath = agentLogPath(workspacePath);
  const entry: Entry = { timerId: null!, position: 0 };

  const flush = () => {
    if (!existsSync(logPath)) return; // file not created yet — agent CLI hasn't started
    try {
      const size = statSync(logPath).size;
      if (size < entry.position) entry.position = 0; // truncation (new agent run)
      if (size <= entry.position) return; // no new bytes
    } catch { return; }

    const result = readNewBytes(logPath, entry.position);
    if (!result) return;
    entry.position = result.newPosition; // always advance, even without subscribers

    if (issueLogRoomSize(issueId) === 0) return; // no one to send to
    sendToIssueLogRoom(issueId, JSON.stringify({ type: "issue:log", id: issueId, chunk: result.chunk }));
  };

  entry.timerId = setInterval(flush, POLL_INTERVAL_MS);
  active.set(issueId, entry);
  logger.debug({ issueId }, "[IssueLogBroadcaster] Started");
}

export function stopIssueLogBroadcasting(issueId: string): void {
  const entry = active.get(issueId);
  if (!entry) return;
  clearInterval(entry.timerId);
  active.delete(issueId);
  logger.debug({ issueId }, "[IssueLogBroadcaster] Stopped");
}

export function stopAllIssueLogBroadcasting(): void {
  for (const id of [...active.keys()]) stopIssueLogBroadcasting(id);
}
