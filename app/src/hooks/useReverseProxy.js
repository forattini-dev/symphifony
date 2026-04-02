import { useState, useEffect, useCallback } from "react";
import { api } from "../api.js";
import { subscribeReverseProxy, unsubscribeReverseProxy } from "../hooks.js";

// ── Reverse proxy snapshot pub/sub (WS push) ─────────────────────

const reverseProxySnapshotSubs = new Set();

export function dispatchReverseProxySnapshot(snapshot) {
  for (const cb of reverseProxySnapshotSubs) cb(snapshot);
}

// ── Hook ─────────────────────────────────────────────────────────

export function useReverseProxy() {
  const [status, setStatus] = useState(null);
  const [stats, setStats] = useState(null);
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get("/proxy/reverse/status");
      if (res) {
        setStatus(res);
        setError(null);
      }
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reverse proxy status.");
      return null;
    }
  }, []);

  // Initial status fetch on mount
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Subscribe to WS room for pushed stats+graph
  useEffect(() => {
    subscribeReverseProxy();

    const handler = (payload) => {
      if (!payload || typeof payload !== "object") return;
      if (payload.stats !== undefined) setStats(payload.stats ?? null);
      if (payload.snapshot !== undefined) setGraph(payload.snapshot ?? null);
      if (payload.running !== undefined) {
        setStatus((prev) => (prev ? { ...prev, running: payload.running } : prev));
      }
      setError(null);
    };

    reverseProxySnapshotSubs.add(handler);
    return () => {
      reverseProxySnapshotSubs.delete(handler);
      unsubscribeReverseProxy();
    };
  }, []);

  const toggle = useCallback(async (enabled) => {
    try {
      const res = await api.post("/proxy/reverse/toggle", { enabled });
      setStatus((prev) => ({ ...prev, enabled, running: res.running, port: res.port }));
      setError(null);
      if (!enabled) {
        setStats(null);
        setGraph(null);
      }
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update reverse proxy state.";
      setError(message);
      throw err;
    }
  }, []);

  return { status, stats, graph, error, toggle, refresh: fetchStatus };
}
