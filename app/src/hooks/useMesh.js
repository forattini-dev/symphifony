import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api.js";
import { subscribeMesh, unsubscribeMesh } from "../hooks.js";

// ── Mesh entry pub/sub (WS push) ────────────────────────────────

const meshEntrySubs = new Set();
const meshSnapshotSubs = new Set();

export function dispatchMeshEntry(entry) {
  for (const cb of meshEntrySubs) cb(entry);
}

export function dispatchMeshSnapshot(snapshot) {
  for (const cb of meshSnapshotSubs) cb(snapshot);
}

// ── Hook: full mesh graph + live traffic ─────────────────────────

export function useMesh({ liveMode = true } = {}) {
  const [graph, setGraph] = useState(null);
  const [nativeGraph, setNativeGraph] = useState(null);
  const [traffic, setTraffic] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const lastSnapshotSeq = useRef(0);

  const fetchGraph = useCallback(async () => {
    try {
      const res = await api.get("/mesh");
      if (res?.graph) setGraph(res.graph);
    } catch {}
  }, []);

  const fetchNativeGraph = useCallback(async () => {
    try {
      const res = await api.get("/mesh/graph/native");
      if (res?.snapshot) setNativeGraph(res.snapshot);
    } catch {}
  }, []);

  const fetchTraffic = useCallback(async () => {
    try {
      const res = await api.get("/mesh/traffic?limit=200");
      if (res?.entries) setTraffic(res.entries);
    } catch {}
  }, []);

  const clearMesh = useCallback(async () => {
    try {
      await api.post("/mesh/clear", {});
      setTraffic([]);
      await fetchGraph();
    } catch {}
  }, [fetchGraph]);

  const applySnapshot = useCallback((snapshot) => {
    if (!snapshot || typeof snapshot !== "object") return;
    const incomingSeq = typeof snapshot.seq === "number" ? snapshot.seq : null;
    if (incomingSeq !== null && incomingSeq <= lastSnapshotSeq.current) return;
    if (incomingSeq !== null) {
      lastSnapshotSeq.current = incomingSeq;
    }

    if (snapshot.graph !== undefined) setGraph(snapshot.graph);
    if (snapshot.nativeGraph !== undefined) setNativeGraph(snapshot.nativeGraph);
    if (snapshot.status && typeof snapshot.status === "object") {
      setStatus(snapshot.status);
    }
    if (Array.isArray(snapshot.traffic)) {
      setTraffic(snapshot.traffic.length > 500 ? snapshot.traffic.slice(-500) : snapshot.traffic);
    }
  }, []);

  // Initial fetch — only call graph/traffic if proxy is running
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get("/mesh/status");
        if (res) setStatus(res);
        if (res?.running) {
          await Promise.all([fetchGraph(), fetchNativeGraph(), fetchTraffic()]);
        }
      } catch {}
      setLoading(false);
    })();
  }, [fetchGraph, fetchNativeGraph, fetchTraffic]);

  // Subscribe to mesh WS room
  useEffect(() => {
    subscribeMesh();
    const seenTrafficIds = new Set();
    const entryLimit = 500;

    const handler = (entry) => {
      if (!entry?.id || seenTrafficIds.has(entry.id)) return;
      seenTrafficIds.add(entry.id);
      setTraffic((prev) => {
        const next = [...prev, entry];
        return next.length > entryLimit ? next.slice(-entryLimit) : next;
      });
    };
    const snapshotHandler = (payload) => {
      if (!payload?.graph && !payload?.nativeGraph && !Array.isArray(payload?.traffic)) return;
      applySnapshot(payload);
      if (Array.isArray(payload.traffic)) {
        seenTrafficIds.clear();
        for (const entry of payload.traffic) {
          if (entry?.id) seenTrafficIds.add(entry.id);
        }
      }
    };

    meshEntrySubs.add(handler);
    meshSnapshotSubs.add(snapshotHandler);

    return () => {
      meshEntrySubs.delete(handler);
      meshSnapshotSubs.delete(snapshotHandler);
      unsubscribeMesh();
    };
  }, [applySnapshot]);

  // Fallback polling whenever WS is not active:
  // keep traffic + snapshots reasonably fresh via REST instead of blocking updates.
  useEffect(() => {
    if (liveMode) return;
    const handle = setInterval(() => {
      fetchGraph();
      fetchNativeGraph();
      fetchTraffic();
    }, 3000);
    return () => clearInterval(handle);
  }, [liveMode, fetchGraph, fetchNativeGraph, fetchTraffic]);

  const toggleMesh = useCallback(async (enabled) => {
    try {
      const res = await api.post("/mesh/toggle", { enabled });
      setStatus((prev) => ({ ...prev, enabled, running: res.running, port: res.port }));
      if (enabled) {
        fetchGraph();
        fetchNativeGraph();
        fetchTraffic();
      } else {
        setGraph(null);
        setNativeGraph(null);
        setTraffic([]);
      }
    } catch {}
  }, [fetchGraph, fetchNativeGraph, fetchTraffic]);

  return { graph, nativeGraph, traffic, status, loading, refresh: fetchGraph, clearMesh, toggleMesh };
}
