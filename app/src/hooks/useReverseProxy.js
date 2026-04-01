import { useState, useEffect, useCallback } from "react";
import { api } from "../api.js";

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

  const fetchStats = useCallback(async () => {
    try {
      const res = await api.get("/proxy/reverse/stats");
      if (res?.stats) setStats(res.stats);
    } catch {}
  }, []);

  const fetchGraph = useCallback(async () => {
    try {
      const res = await api.get("/proxy/reverse/graph");
      if (res?.snapshot) setGraph(res.snapshot);
    } catch {}
  }, []);

  useEffect(() => {
    (async () => {
      const res = await fetchStatus();
      if (res?.running) {
        fetchStats();
        fetchGraph();
      }
    })();
  }, [fetchStatus, fetchStats, fetchGraph]);

  // Poll every 5s when running
  useEffect(() => {
    if (!status?.running) return;
    const id = setInterval(() => {
      fetchStats();
      fetchGraph();
    }, 5_000);
    return () => clearInterval(id);
  }, [status?.running, fetchStats, fetchGraph]);

  const toggle = useCallback(async (enabled) => {
    try {
      const res = await api.post("/proxy/reverse/toggle", { enabled });
      setStatus((prev) => ({ ...prev, enabled, running: res.running, port: res.port }));
      if (enabled) {
        fetchStats();
        fetchGraph();
      } else {
        setStats(null);
        setGraph(null);
      }
    } catch {}
  }, [fetchStats, fetchGraph]);

  return { status, stats, graph, toggle, refresh: fetchStatus };
}
