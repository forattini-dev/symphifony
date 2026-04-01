import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api.js";
import {
  subscribeServiceLog,
  unsubscribeServiceLog,
  subscribeServices,
  unsubscribeServices,
} from "../hooks.js";

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

// ── Service state pub/sub (WebSocket push path) ──────────────────────────────

const serviceStateSubs = new Set(); // Set<(update: {id, state, running, pid}) => void>

/** Called by DashboardContext when a "service" WS message arrives. */
export function dispatchServiceUpdate(update) {
  for (const cb of serviceStateSubs) cb(update);
}

// ── Service snapshot pub/sub (WS push path) ────────────────────────────────

const serviceSnapshotSubs = new Set(); // Set<(payload: {services: unknown}) => void>

/** Called by DashboardContext when a "services:snapshot" WS message arrives. */
export function dispatchServicesSnapshot(payload) {
  for (const cb of serviceSnapshotSubs) cb(payload);
}

export function onServicesSnapshot(cb) {
  serviceSnapshotSubs.add(cb);
  return () => serviceSnapshotSubs.delete(cb);
}

// ── Service restart pub/sub ───────────────────────────────────────────────────

const serviceRestartSubs = new Map(); // id → Set<() => void>

export function onServiceRestart(id, cb) {
  if (!serviceRestartSubs.has(id)) serviceRestartSubs.set(id, new Set());
  serviceRestartSubs.get(id).add(cb);
  return () => serviceRestartSubs.get(id)?.delete(cb);
}

/**
 * Fetches all service statuses and polls at `pollInterval` ms.
 * Pass `liveMode: true` (or `pollInterval: false`) to disable polling — use when WS is connected.
 * Regardless of polling, always patches state from WS "service" messages instantly.
 */
export function useServices({ pollInterval = 30_000, liveMode = false } = {}) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const lastSnapshotSeq = useRef(0);
  const gotSnapshot = useRef(false);

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
    if (liveMode || !pollInterval) return;
    const id = setInterval(fetchAll, pollInterval);
    return () => clearInterval(id);
  }, [fetchAll, liveMode, pollInterval]);

  useEffect(() => {
    if (!liveMode) return;
    subscribeServices();
    return () => unsubscribeServices();
  }, [liveMode]);

  useEffect(() => {
    if (!liveMode || !pollInterval) return;
    const timeout = setTimeout(() => {
      if (!gotSnapshot.current) fetchAll();
    }, 750);
    return () => clearTimeout(timeout);
  }, [fetchAll, liveMode, pollInterval]);

  useEffect(() => {
    const handler = ({ services: snapshotServices, seq } = {}) => {
      if (!Array.isArray(snapshotServices)) return;
      if (typeof seq === "number" && seq <= lastSnapshotSeq.current) return;
      if (typeof seq === "number") {
        lastSnapshotSeq.current = seq;
      }
      setServices(snapshotServices);
      setLoading(false);
      gotSnapshot.current = true;
    };
    serviceSnapshotSubs.add(handler);
    return () => serviceSnapshotSubs.delete(handler);
  }, []);

  // Patch individual service state from WS push — instant, no re-fetch needed
  useEffect(() => {
    const handler = ({ id, state, running, pid }) => {
      if (!id) return;
      setServices((prev) =>
        prev.map((s) => s.id === id ? { ...s, state, running, pid: pid ?? s.pid } : s)
      );
      // Notify log viewers that this service restarted so they can reset
      if (state === "starting") {
        for (const cb of serviceRestartSubs.get(id) ?? []) cb();
      }
    };
    serviceStateSubs.add(handler);
    return () => serviceStateSubs.delete(handler);
  }, []);

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

  const fetchLog = useCallback((encId) => {
    api.get(`/services/${encId}/log`).then((res) => {
      setLog(res.logTail ?? "");
      setConnected(true);
      setError(null);
    }).catch((err) => {
      setConnected(false);
      setError(err instanceof Error ? err.message : "Failed to load logs.");
    });
  }, []);

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
    // Uses tracked subscription so it's restored after WS reconnect
    subscribeServiceLog(id);

    // 3. Listen for incoming chunks
    const unsub = onServiceLog(id, (chunk) => {
      if (!alive) return;
      setLog((prev) => prev + chunk);
      setConnected(true);
    });

    // 4. When service restarts, clear log and re-fetch fresh content
    const unsubRestart = onServiceRestart(id, () => {
      if (!alive) return;
      setLog("");
      setConnected(false);
      // Small delay to let the new process start writing before fetching
      setTimeout(() => {
        if (!alive) return;
        fetchLog(encId);
      }, 500);
    });

    return () => {
      alive = false;
      unsubscribeServiceLog(id);
      unsub();
      unsubRestart();
      setConnected(false);
      setError(null);
    };
  }, [id, enabled, fetchLog]);

  return { log, connected, error };
}
