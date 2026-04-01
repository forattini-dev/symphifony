import {
  dispatchServiceLog,
  dispatchServiceUpdate,
  dispatchServicesSnapshot,
} from "../hooks/useServices.js";
import { dispatchIssueLog } from "../hooks/useIssueLog.js";
import { dispatchMeshEntry, dispatchMeshSnapshot } from "../hooks/useMesh.js";
import { WS_MESSAGE_TYPES } from "./contracts.js";

const SNAPSHOT_TYPES = new Set([WS_MESSAGE_TYPES.CONNECTED, WS_MESSAGE_TYPES.STATE_UPDATE, WS_MESSAGE_TYPES.STATE_DELTA]);

function applyRuntimeStateTransitionFromMessage(qc, payload) {
  qc.setQueriesData({ queryKey: ["runtime-state"] }, (cur) => {
    if (!cur || !Array.isArray(cur.issues)) return cur;
    const issues = cur.issues.some((i) => i.id === payload.issue.id)
      ? cur.issues.map((i) => i.id === payload.issue.id ? payload.issue : i)
      : [...cur.issues, payload.issue];
    return { ...cur, issues };
  });
}

export function registerDashboardMessageHandlers(messageBus, options) {
  const {
    qc,
    setIssueProgress,
    setIssueSubTasks,
    setEventSnapshot,
  } = options;

  const unsubscribers = [];

  unsubscribers.push(
    messageBus.on(WS_MESSAGE_TYPES.SERVICE_LOG, (payload) => {
      if (typeof payload?.id === "string" && typeof payload?.chunk === "string") {
        dispatchServiceLog(payload.id, payload.chunk);
      }
    }),
  );
  unsubscribers.push(
    messageBus.on(WS_MESSAGE_TYPES.SERVICES_SNAPSHOT, (payload) => {
      dispatchServicesSnapshot(payload);
    }),
  );
  unsubscribers.push(
    messageBus.on(WS_MESSAGE_TYPES.SERVICE_STATE, (payload) => {
      if (payload?.id) dispatchServiceUpdate(payload);
    }),
  );
  unsubscribers.push(
    messageBus.on(WS_MESSAGE_TYPES.ISSUE_LOG, (payload) => {
      if (typeof payload?.id === "string" && typeof payload?.chunk === "string") {
        dispatchIssueLog(payload.id, payload.chunk);
      }
    }),
  );
  unsubscribers.push(
    messageBus.on(WS_MESSAGE_TYPES.MESH_ENTRY, (payload) => {
      if (payload?.entry) dispatchMeshEntry(payload.entry);
    }),
  );
  unsubscribers.push(
    messageBus.on(WS_MESSAGE_TYPES.MESH_SNAPSHOT, (payload) => {
      dispatchMeshSnapshot({
        graph: payload.graph,
        nativeGraph: payload.nativeGraph,
        traffic: payload.traffic,
        status: payload.status,
      });
    }),
  );
  unsubscribers.push(
    messageBus.on(WS_MESSAGE_TYPES.ISSUE_PROGRESS, (payload) => {
      if (payload.issueId) {
        setIssueProgress((prev) => ({ ...prev, [payload.issueId]: payload }));
      }
    }),
  );
  unsubscribers.push(
    messageBus.on(WS_MESSAGE_TYPES.ISSUE_SUBTASKS, (payload) => {
      if (!payload?.issueId) return;
      setIssueSubTasks((prev) => ({
        ...prev,
        [payload.issueId]: { phase: payload.phase, tasks: payload.tasks ?? [] },
      }));
    }),
  );
  unsubscribers.push(
    messageBus.on(WS_MESSAGE_TYPES.ISSUE_TRANSITION, (payload) => {
      if (!payload.issue) return;
      qc.cancelQueries({ queryKey: ["runtime-state"] });
      applyRuntimeStateTransitionFromMessage(qc, payload);
    }),
  );

  unsubscribers.push(
    messageBus.on("*", (payload) => {
      if (!payload || typeof payload !== "object") return;
      if (Array.isArray(payload.events)) {
        setEventSnapshot(payload.events);
      }
      if (!SNAPSHOT_TYPES.has(payload.type)) return;
      qc.cancelQueries({ queryKey: ["runtime-state"] });
    }),
  );

  return () => {
    for (const off of unsubscribers) off();
  };
}
