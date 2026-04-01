import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api.js";
import { subscribeIssueLog, unsubscribeIssueLog } from "../hooks.js";

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
 * Streams live-output.log for an issue.
 *
 * On mount: fetches the log tail via HTTP once for the initial snapshot, then
 * subscribes to the issue's log room on the WebSocket. The server pushes only
 * NEW chunks (bytes written after the snapshot), so there is no duplication.
 *
 * While websocket is disconnected (`liveMode=false`), falls back to incremental
 * polling using `GET /issues/:id/live?after=<bytes>` to keep log updates flowing.
 *
 * On unmount: unsubscribes from the room.
 */
export function useIssueLog(issueId, enabled = false, liveMode = true) {
  const [log, setLog] = useState("");
  const [connected, setConnected] = useState(false);
  const [liveInfo, setLiveInfo] = useState(null);

  const lastSizeRef = useRef(0);
  const mountedRef = useRef(false);
  const encId = encodeURIComponent(issueId || "");

  const fetchInitial = useCallback(async () => {
    if (!issueId) return;
    try {
      const res = await api.get(`/issues/${encId}/live`);
      if (!mountedRef.current) return;
      setLog(res.logTail ?? "");
      setLiveInfo(res);
      lastSizeRef.current = Number.isFinite(res?.logSize) ? res.logSize : 0;
      setConnected(true);
    } catch {
      if (!mountedRef.current) return;
      setConnected(false);
    }
  }, [encId, issueId]);

  const fetchIncremental = useCallback(async () => {
    if (!issueId || liveMode) return;
    try {
      const res = await api.get(`/issues/${encId}/live?after=${lastSizeRef.current}`);
      if (!mountedRef.current) return;

      const serverSize = Number.isFinite(res?.logSize) ? res.logSize : lastSizeRef.current;
      if (typeof res?.text === "string" && res.text.length > 0) {
        setLog((prev) => prev + res.text);
        lastSizeRef.current = serverSize;
        setLiveInfo((prev) => (prev ? { ...prev, ...res } : res));
        setConnected(true);
        return;
      }

      if (serverSize < lastSizeRef.current) {
        // Log file rotated/truncated; re-sync with full snapshot.
        await fetchInitial();
        return;
      }

      if (serverSize > lastSizeRef.current) {
        lastSizeRef.current = serverSize;
      }
    } catch {
      if (!mountedRef.current) return;
    }
  }, [encId, issueId, liveMode, fetchInitial]);

  // Initial load + WS room subscription
  useEffect(() => {
    if (!enabled || !issueId) {
      mountedRef.current = false;
      setLog("");
      setConnected(false);
      setLiveInfo(null);
      lastSizeRef.current = 0;
      return;
    }

    mountedRef.current = true;
    setLog("");
    setLiveInfo(null);
    lastSizeRef.current = 0;
    setConnected(false);

    fetchInitial();
    subscribeIssueLog(issueId);

    const unsub = onIssueLog(issueId, (chunk) => {
      if (!mountedRef.current) return;
      setLog((prev) => prev + chunk);
      lastSizeRef.current += new TextEncoder().encode(chunk).length;
      setConnected(true);
    });

    return () => {
      mountedRef.current = false;
      unsubscribeIssueLog(issueId);
      unsub();
      setConnected(false);
      setLiveInfo(null);
    };
  }, [issueId, enabled, fetchInitial]);

  // Fallback API polling while websocket is unavailable
  useEffect(() => {
    if (!enabled || !issueId || liveMode) return;
    const handle = setInterval(fetchIncremental, 3000);
    return () => clearInterval(handle);
  }, [enabled, issueId, liveMode, fetchIncremental]);

  return { log, connected, liveInfo };
}
