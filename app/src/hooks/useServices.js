import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api.js";
import { sendWsMessage } from "../hooks.js";

// ── Service log pub/sub (WebSocket push path) ───────────────────────────────

const serviceLogSubs = new Map(); // id → Set<(chunk: string) => void>

/** Subscribe to WS-pushed log chunks for a service. Returns an unsubscribe fn. */
export function onServiceLog(id, cb) {
  if (!serviceLogSubs.has(id)) serviceLogSubs.set(id, new Set());
  serviceLogSubs.get(id).add(cb);
  return () => serviceLogSubs.get(id)?.delete(cb);
}

/** Called by DashboardContext when a "service:log" WS message arrives. */
export function dispatchServiceLog(id, chunk) {
  for (const cb of serviceLogSubs.get(id) ?? []) cb(chunk);
}

/**
 * Fetches all service statuses and polls at `pollInterval` ms.
 * Pass `pollInterval: false` (or 0) to disable polling — use when WS is connected.
 */
export function useServices({ pollInterval = 3_000 } = {}) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    try {
      const res = await api.get("/services");
      if (res?.services) setServices(res.services);
    } catch {
      /* non-critical */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!pollInterval) return;
    const id = setInterval(fetchAll, pollInterval);
    return () => clearInterval(id);
  }, [fetchAll, pollInterval]);

  return { services, loading, refresh: fetchAll };
}

/**
 * Streams log output for a service.
 *
 * On mount: fetches the full log tail via HTTP once, then subscribes to the
 * service's log room on the WebSocket. The server pushes new chunks as they
 * arrive (fs.watch-driven), so there is NO client-side polling.
 *
 * On unmount: unsubscribes from the room so the server stops sending chunks.
 *
 * Returns { log, connected } — connected = true once first data arrives.
 */
export function useServiceLog(id, enabled = false) {
  const [log, setLog] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled || !id) {
      setLog("");
      setConnected(false);
      setError(null);
      return;
    }

    let alive = true;
    setError(null);

    const encId = encodeURIComponent(id);

    // 1. Fetch full log tail once (initial render)
    api.get(`/services/${encId}/log`).then((res) => {
      if (!alive) return;
      setLog(res.logTail ?? "");
      setConnected(true);
      setError(null);
    }).catch((err) => {
      if (!alive) return;
      setConnected(false);
      setError(err instanceof Error ? err.message : "Failed to load logs.");
    });

    // 2. Subscribe to the WS room — server will push chunks from now on
    sendWsMessage({ type: "service:log:subscribe", id });

    // 3. Listen for incoming chunks
    const unsub = onServiceLog(id, (chunk) => {
      if (!alive) return;
      setLog((prev) => prev + chunk);
      setConnected(true);
    });

    return () => {
      alive = false;
      sendWsMessage({ type: "service:log:unsubscribe", id });
      unsub();
      setConnected(false);
      setError(null);
    };
  }, [id, enabled]);

  return { log, connected, error };
}
