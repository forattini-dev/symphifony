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

  const fetchStatus = useCallback(async () => {
    try {
      const res = await api.get("/proxy/reverse/status");
      if (res) setStatus(res);
      return res;
    } catch {}
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
      if (!enabled) {
        setStats(null);
        setGraph(null);
      }
    } catch {}
  }, []);

  return { status, stats, graph, toggle, refresh: fetchStatus };
}
