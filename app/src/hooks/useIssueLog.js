import { useState, useEffect } from "react";
import { api } from "../api.js";
import { sendWsMessage } from "../hooks.js";

// ── Issue log pub/sub (WebSocket push path) ──────────────────────────────────

const issueLogSubs = new Map(); // issueId → Set<(chunk: string) => void>

/** Subscribe to WS-pushed log chunks for an issue. Returns an unsubscribe fn. */
export function onIssueLog(id, cb) {
  if (!issueLogSubs.has(id)) issueLogSubs.set(id, new Set());
  issueLogSubs.get(id).add(cb);
  return () => issueLogSubs.get(id)?.delete(cb);
}

/** Called by DashboardContext when an "issue:log" WS message arrives. */
export function dispatchIssueLog(id, chunk) {
  for (const cb of issueLogSubs.get(id) ?? []) cb(chunk);
}

/**
 * Streams live-output.log for an issue via WebSocket.
 *
 * On mount: fetches the log tail via HTTP once for the initial snapshot, then
 * subscribes to the issue's log room on the WebSocket. The server pushes only
 * NEW chunks (bytes written after the snapshot), so there is no duplication.
 *
 * On unmount: unsubscribes from the room.
 *
 * Returns { log, connected, liveInfo } where liveInfo has metadata (elapsed,
 * logSize, agentPid, agentAlive) from the initial HTTP fetch.
 */
export function useIssueLog(issueId, enabled = false) {
  const [log, setLog] = useState("");
  const [connected, setConnected] = useState(false);
  const [liveInfo, setLiveInfo] = useState(null);

  useEffect(() => {
    if (!enabled || !issueId) {
      setLog("");
      setConnected(false);
      setLiveInfo(null);
      return;
    }

    let alive = true;
    const encId = encodeURIComponent(issueId);

    // 1. Fetch initial log tail + metadata via HTTP
    api.get(`/issues/${encId}/live`).then((res) => {
      if (!alive) return;
      setLog(res.logTail ?? "");
      setLiveInfo(res);
      setConnected(true);
    }).catch(() => {
      if (!alive) return;
      setConnected(false);
    });

    // 2. Subscribe to WS room — server will push NEW chunks from now on
    sendWsMessage({ type: "issue:log:subscribe", id: issueId });

    // 3. Append incoming chunks (new bytes only, no duplicates)
    const unsub = onIssueLog(issueId, (chunk) => {
      if (!alive) return;
      setLog((prev) => prev + chunk);
      setConnected(true);
    });

    return () => {
      alive = false;
      sendWsMessage({ type: "issue:log:unsubscribe", id: issueId });
      unsub();
      setConnected(false);
      setLiveInfo(null);
    };
  }, [issueId, enabled]);

  return { log, connected, liveInfo };
}
