/**
 * Service log broadcaster — watches log files via fs.watch and pushes new
 * chunks to connected WebSocket clients.  Zero polling; driven by inotify.
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
import { sendToAllClients, wsClients } from "../../routes/websocket.ts";
import { serviceLogPath } from "./fsm-service.ts";
import { logger } from "../../concerns/logger.ts";

const MAX_CHUNK_BYTES = 16_384;

type Entry = { watcher: FSWatcher; position: number };

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
  stopServiceLogBroadcasting(id);

  const logPath = serviceLogPath(fifonyDir, id);
  if (!existsSync(logPath)) return;

  const entry: Entry = { watcher: null!, position: 0 };

  const flush = () => {
    if (wsClients.size === 0) return;
    try {
      // Reset position on truncation (new service session)
      const size = statSync(logPath).size;
      if (size < entry.position) entry.position = 0;
    } catch { return; }
    const result = readNewBytes(logPath, entry.position);
    if (!result) return;
    entry.position = result.newPosition;
    sendToAllClients(JSON.stringify({ type: "service:log", id, chunk: result.chunk }));
  };

  try {
    const watcher = watch(logPath, { persistent: false }, flush);
    watcher.on("error", () => active.delete(id));
    entry.watcher = watcher;
    active.set(id, entry);
    logger.debug({ id }, "[ServiceLogBroadcaster] Started");
  } catch (err) {
    logger.debug({ err, id }, "[ServiceLogBroadcaster] Could not watch log file");
  }
}

export function stopServiceLogBroadcasting(id: string): void {
  const entry = active.get(id);
  if (!entry) return;
  try { entry.watcher.close(); } catch {}
  active.delete(id);
}

export function stopAllServiceLogBroadcasting(): void {
  for (const id of [...active.keys()]) stopServiceLogBroadcasting(id);
}
