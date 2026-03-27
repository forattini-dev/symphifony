import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api.js";

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
 * Primary path: WebSocket push via "service:log" events (zero client polling).
 * Fallback: HTTP polling every second when WS chunks haven't arrived yet.
 *
 * Returns { log, connected } — connected = true once first data arrives.
 */
export function useServiceLog(id, enabled = false) {
  const [log, setLog] = useState("");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const sizeRef = useRef(0);
  const wsReceivedRef = useRef(false); // true after first WS chunk — disables HTTP fallback

  useEffect(() => {
    if (!enabled || !id) {
      setLog("");
      setConnected(false);
      setError(null);
      sizeRef.current = 0;
      wsReceivedRef.current = false;
      return;
    }

    let alive = true;
    sizeRef.current = 0;
    wsReceivedRef.current = false;
    setError(null);

    const encId = encodeURIComponent(id);

    // Initial load — fetch full tail once
    api.get(`/services/${encId}/log`).then((res) => {
      if (!alive) return;
      setLog(res.logTail ?? "");
      if (res.logSize !== undefined) sizeRef.current = res.logSize;
      setConnected(true);
      setError(null);
    }).catch((err) => {
      if (!alive) return;
      setConnected(false);
      setError(err instanceof Error ? err.message : "Failed to load logs.");
    });

    // WS subscription — primary real-time path (no polling)
    const unsub = onServiceLog(id, (chunk) => {
      if (!alive) return;
      wsReceivedRef.current = true;
      setLog((prev) => prev + chunk);
      setConnected(true);
    });

    // HTTP fallback — only runs until the first WS chunk arrives
    const fetchIncremental = async () => {
      if (!alive || wsReceivedRef.current) return;
      try {
        const after = sizeRef.current;
        const res = after > 0
          ? await api.get(`/services/${encId}/log?after=${after}`)
          : await api.get(`/services/${encId}/log`);
        if (!alive) return;
        if (after > 0 && res.text !== undefined) {
          if (res.text) setLog((prev) => prev + res.text);
        } else if (res.logTail !== undefined) {
          setLog(res.logTail ?? "");
        }
        if (res.logSize !== undefined) sizeRef.current = res.logSize;
        setConnected(true);
      } catch { /* non-critical */ }
    };

    const pollId = setInterval(fetchIncremental, 1_000);

    return () => {
      alive = false;
      clearInterval(pollId);
      unsub();
      setConnected(false);
      setError(null);
      sizeRef.current = 0;
      wsReceivedRef.current = false;
    };
  }, [id, enabled]);

  return { log, connected, error };
}
