/**
 * Service log broadcaster — pushes new log chunks to connected WebSocket clients.
 *
 * Primary: fs.watch (inotify on Linux) for zero-latency delivery.
 * Fallback: 500ms polling to catch events fs.watch misses silently on some
 * filesystems / kernel versions / Docker bind mounts.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { sendToServiceLogRoom, serviceLogRoomSize } from "../../routes/websocket.ts";
import { serviceLogPath } from "./fsm-service.ts";
import { logger } from "../../concerns/logger.ts";

const MAX_CHUNK_BYTES = 16_384;
const POLL_INTERVAL_MS = 500;

type Entry = { stop: () => void; position: number };

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

export function startServiceLogBroadcasting(id: string, fifonyDir: string): void {
  if (active.has(id)) return;

  const logPath = serviceLogPath(fifonyDir, id);
  if (!existsSync(logPath)) return;

  let initialPosition = 0;
  try {
    initialPosition = statSync(logPath).size;
  } catch {
    initialPosition = 0;
  }

  const entry: Entry = { stop: () => {}, position: initialPosition };

  const flush = () => {
    try {
      // Reset position on truncation (new service session)
      const size = statSync(logPath).size;
      if (size < entry.position) entry.position = 0;
    } catch { return; }
    const result = readNewBytes(logPath, entry.position);
    if (!result) return;
    entry.position = result.newPosition;
    sendToServiceLogRoom(id, JSON.stringify({ type: "service:log", id, chunk: result.chunk }));
  };

  // Primary: fs.watch for zero-latency delivery (inotify on Linux)
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(logPath, { persistent: false }, flush);
    watcher.on("error", () => { watcher = null; });
  } catch {
    // fs.watch unavailable — polling will cover it
  }

  // Fallback: 500ms poll to catch events fs.watch misses silently
  const pollTimer = setInterval(flush, POLL_INTERVAL_MS);

  entry.stop = () => {
    if (watcher) try { watcher.close(); } catch {}
    clearInterval(pollTimer);
  };

  active.set(id, entry);
  logger.debug({ id }, "[ServiceLogBroadcaster] Started");

  // Flush immediately to catch bytes written before watcher was registered
  flush();
}

export function stopServiceLogBroadcasting(id: string): void {
  const entry = active.get(id);
  if (!entry) return;
  entry.stop();
  active.delete(id);
}

export function stopAllServiceLogBroadcasting(): void {
  for (const id of [...active.keys()]) stopServiceLogBroadcasting(id);
}
