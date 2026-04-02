import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api.js";
import { subscribeMesh, unsubscribeMesh } from "../hooks.js";

// ── Mesh entry pub/sub (WS push) ────────────────────────────────

const meshEntrySubs = new Set();
const meshEventSubs = new Set();
const meshSnapshotSubs = new Set();

export function dispatchMeshEntry(entry) {
  for (const cb of meshEntrySubs) cb(entry);
}

export function dispatchMeshEvent(event) {
  for (const cb of meshEventSubs) cb(event);
}

export function dispatchMeshSnapshot(snapshot) {
  for (const cb of meshSnapshotSubs) cb(snapshot);
}

function graphEdgeId(edge) {
  if (edge?.id) return edge.id;
  return `${edge?.source ?? "unknown"}\u0000${edge?.target ?? "unknown"}\u0000${edge?.dominantProtocol ?? "unknown"}`;
}

function adaptTelemetryEdge(edge) {
  if (!edge || typeof edge !== "object") return null;
  const percentiles = edge.latency?.percentiles ?? {};
  const requestCount = Number(edge.requestsTotal ?? 0) > 0
    ? Number(edge.requestsTotal ?? 0)
    : Number(edge.flowsTotal ?? 0);
  return {
    id: edge.id ?? graphEdgeId({
      source: edge.source,
      target: edge.target,
      dominantProtocol: edge.protocol,
    }),
    source: edge.source,
    target: edge.target,
    requestCount,
    errorCount: Number(edge.errorsTotal ?? 0),
    dominantProtocol: edge.protocol ?? "unknown",
    protocolCounts: [{ protocol: edge.protocol ?? "unknown", count: Number(edge.flowsTotal ?? 0) }],
    avgLatencyMs: edge.latency?.averageSeconds != null ? Math.round(edge.latency.averageSeconds * 1000) : 0,
    p50LatencyMs: percentiles.p50 != null ? Math.round(percentiles.p50 * 1000) : 0,
    p90LatencyMs: percentiles.p90 != null ? Math.round(percentiles.p90 * 1000) : 0,
    p95LatencyMs: percentiles.p95 != null ? Math.round(percentiles.p95 * 1000) : 0,
    p99LatencyMs: percentiles.p99 != null ? Math.round(percentiles.p99 * 1000) : 0,
    lastSeenAt: edge.lastSeenAt ?? new Date().toISOString(),
    topPaths: Array.isArray(edge.topPaths) ? edge.topPaths : [],
    bytesIn: Number(edge.bytesFromSource ?? 0),
    bytesOut: Number(edge.bytesToSource ?? 0),
    activeFlows: Number(edge.activeFlows ?? 0),
    flowsTotal: Number(edge.flowsTotal ?? 0),
    statusClassCounts: edge.statusClassCounts ?? {},
    methodCounts: edge.methodCounts ?? {},
  };
}

function ensureGraphNode(nodes, nodeId) {
  if (!nodeId) return nodes;
  if (nodes.some((node) => node.id === nodeId)) return nodes;
  return [...nodes, { id: nodeId, name: nodeId, state: "running" }];
}

function recomputeGraphTotals(graph) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  return {
    ...graph,
    totalRequests: edges.reduce((sum, edge) => sum + Number(edge?.requestCount ?? 0), 0),
  };
}

function applyTelemetryEventToGraph(current, event) {
  if (!event || typeof event !== "object") return current;
  const base = current && typeof current === "object"
    ? {
      ...current,
      nodes: Array.isArray(current.nodes) ? current.nodes : [],
      edges: Array.isArray(current.edges) ? current.edges : [],
    }
    : {
      nodes: [],
      edges: [],
      capturedSince: new Date().toISOString(),
      totalRequests: 0,
    };

  if (event.type === "reset") {
    return {
      ...base,
      edges: [],
      totalRequests: 0,
      capturedSince: new Date().toISOString(),
      seq: typeof event.seq === "number" ? event.seq : 0,
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
    };
  }

  if (event.type === "node:new") {
    return {
      ...base,
      nodes: ensureGraphNode(base.nodes, event.nodeId),
      seq: typeof event.seq === "number" ? event.seq : base.seq,
    };
  }

  if (event.type === "edge:expire") {
    const next = {
      ...base,
      edges: base.edges.filter((edge) => graphEdgeId(edge) !== event.edgeId),
      seq: typeof event.seq === "number" ? event.seq : base.seq,
      windowEnd: new Date().toISOString(),
    };
    return recomputeGraphTotals(next);
  }

  if (event.type === "edge:new" || event.type === "edge:update") {
    const nextEdge = adaptTelemetryEdge(event.edge);
    if (!nextEdge) return base;
    const edgeId = graphEdgeId(nextEdge);
    const edges = base.edges.some((edge) => graphEdgeId(edge) === edgeId)
      ? base.edges.map((edge) => graphEdgeId(edge) === edgeId ? { ...edge, ...nextEdge } : edge)
      : [...base.edges, nextEdge];
    const next = {
      ...base,
      nodes: ensureGraphNode(ensureGraphNode(base.nodes, nextEdge.source), nextEdge.target),
      edges,
      capturedSince: base.capturedSince ?? nextEdge.lastSeenAt,
      seq: typeof event.seq === "number" ? event.seq : base.seq,
      windowEnd: nextEdge.lastSeenAt,
    };
    return recomputeGraphTotals(next);
  }

  return base;
}

// ── Hook: full mesh graph + live traffic ─────────────────────────

export function useMesh({ liveMode = true } = {}) {
  const [graph, setGraph] = useState(null);
  const [nativeGraph, setNativeGraph] = useState(null);
  const [traffic, setTraffic] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const lastSnapshotSeq = useRef(0);
  const lastAppliedSeq = useRef(0);
  const meshResyncing = useRef(false);

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
      lastAppliedSeq.current = 0;
      lastSnapshotSeq.current = 0;
      await fetchGraph();
    } catch {}
  }, [fetchGraph]);

  const refetchMeshSnapshot = useCallback(async () => {
    if (meshResyncing.current) return;
    meshResyncing.current = true;
    try {
      const [statusRes, graphRes, nativeRes, trafficRes] = await Promise.all([
        api.get("/mesh/status").catch(() => null),
        api.get("/mesh").catch(() => null),
        api.get("/mesh/graph/native").catch(() => null),
        api.get("/mesh/traffic?limit=200").catch(() => null),
      ]);
      if (statusRes) setStatus(statusRes);
      if (graphRes?.graph) {
        setGraph(graphRes.graph);
        if (typeof graphRes.graph.seq === "number") {
          lastSnapshotSeq.current = graphRes.graph.seq;
          lastAppliedSeq.current = graphRes.graph.seq;
        }
      }
      if (nativeRes?.snapshot) setNativeGraph(nativeRes.snapshot);
      if (Array.isArray(trafficRes?.entries)) {
        setTraffic(trafficRes.entries.length > 500 ? trafficRes.entries.slice(-500) : trafficRes.entries);
      }
    } finally {
      meshResyncing.current = false;
    }
  }, []);

  const applySnapshot = useCallback((snapshot) => {
    if (!snapshot || typeof snapshot !== "object") return;
    const incomingSeq = typeof snapshot.seq === "number" ? snapshot.seq : null;
    if (incomingSeq !== null && incomingSeq <= lastSnapshotSeq.current) return;
    if (incomingSeq !== null) {
      lastSnapshotSeq.current = incomingSeq;
      lastAppliedSeq.current = incomingSeq;
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
    const eventHandler = (event) => {
      const seq = typeof event?.seq === "number" ? event.seq : null;
      if (seq != null) {
        if (seq <= lastAppliedSeq.current) return;
        if (lastAppliedSeq.current > 0 && seq > lastAppliedSeq.current + 1) {
          void refetchMeshSnapshot();
          return;
        }
        lastAppliedSeq.current = seq;
      }
      setGraph((prev) => applyTelemetryEventToGraph(prev, event));
    };

    meshEntrySubs.add(handler);
    meshEventSubs.add(eventHandler);
    meshSnapshotSubs.add(snapshotHandler);

    return () => {
      meshEntrySubs.delete(handler);
      meshEventSubs.delete(eventHandler);
      meshSnapshotSubs.delete(snapshotHandler);
      unsubscribeMesh();
    };
  }, [applySnapshot, refetchMeshSnapshot]);

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
