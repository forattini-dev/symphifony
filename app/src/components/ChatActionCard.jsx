import { useState, useCallback } from "react";
import {
  Plus,
  Play,
  Square,
  RotateCcw,
  RefreshCw,
  CheckCircle,
  GitMerge,
  FileText,
  Terminal,
  Loader,
  Check,
} from "lucide-react";
import { api } from "../api.js";

// ── Action type → display config ─────────────────────────────────────────────

const ACTION_CONFIG = {
  "create-issue": {
    label: "Create Issue",
    icon: Plus,
    btnClass: "btn-success",
    hasButton: true,
  },
  "start-service": {
    label: "Start Service",
    icon: Play,
    btnClass: "btn-primary",
    hasButton: true,
  },
  "stop-service": {
    label: "Stop Service",
    icon: Square,
    btnClass: "btn-warning",
    hasButton: true,
  },
  "restart-service": {
    label: "Restart Service",
    icon: RefreshCw,
    btnClass: "btn-info",
    hasButton: true,
  },
  "retry-issue": {
    label: "Retry",
    icon: RotateCcw,
    btnClass: "btn-warning",
    hasButton: true,
  },
  "replan-issue": {
    label: "Replan",
    icon: RefreshCw,
    btnClass: "btn-warning",
    hasButton: true,
  },
  "approve-issue": {
    label: "Approve",
    icon: CheckCircle,
    btnClass: "btn-success",
    hasButton: true,
  },
  "merge-issue": {
    label: "Merge",
    icon: GitMerge,
    btnClass: "btn-primary",
    hasButton: true,
  },
  "read-file": {
    label: "File",
    icon: FileText,
    hasButton: false,
  },
  "read-service-log": {
    label: "Service Log",
    icon: Terminal,
    hasButton: false,
  },
};

// ── Issue type badge colors ──────────────────────────────────────────────────

const ISSUE_TYPE_BADGE = {
  task: "badge-primary",
  bug: "badge-error",
  feature: "badge-info",
  chore: "badge-ghost",
};

// ── Card body per action type ────────────────────────────────────────────────

function CreateIssueBody({ payload }) {
  const typeBadge = ISSUE_TYPE_BADGE[payload?.issueType] ?? "badge-ghost";
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 min-w-0">
        {payload?.issueType && (
          <span className={`badge badge-xs ${typeBadge}`}>{payload.issueType}</span>
        )}
        <span className="text-sm font-medium truncate">{payload?.title || "Untitled"}</span>
      </div>
      {payload?.description && (
        <p className="text-xs opacity-60 line-clamp-2 leading-relaxed">
          {payload.description}
        </p>
      )}
    </div>
  );
}

function ServiceBody({ payload }) {
  return (
    <div className="text-sm">
      <span className="font-mono text-xs opacity-70">{payload?.serviceName || payload?.name || "service"}</span>
    </div>
  );
}

function IssueBody({ payload }) {
  return (
    <div className="text-sm">
      <span className="font-mono text-xs opacity-70">
        {payload?.identifier || payload?.issueId || payload?.id || "issue"}
      </span>
      {payload?.title && (
        <span className="ml-2 text-xs opacity-50 truncate">{payload.title}</span>
      )}
    </div>
  );
}

function ReadFileBody({ payload }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-mono opacity-60 truncate">{payload?.path || payload?.filePath || "unknown"}</div>
      {payload?.content && (
        <pre className="text-[11px] leading-relaxed bg-base-200 rounded px-2.5 py-2 overflow-x-auto max-h-48 font-mono">
          <code>{payload.content}</code>
        </pre>
      )}
    </div>
  );
}

function ReadServiceLogBody({ payload }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-mono opacity-60">{payload?.serviceName || payload?.name || "service"}</div>
      {payload?.content && (
        <pre className="text-[11px] leading-relaxed bg-base-200 rounded px-2.5 py-2 overflow-x-auto max-h-48 font-mono whitespace-pre-wrap">
          {payload.content}
        </pre>
      )}
    </div>
  );
}

function getCardBody(type, payload) {
  switch (type) {
    case "create-issue":
      return <CreateIssueBody payload={payload} />;
    case "start-service":
    case "stop-service":
    case "restart-service":
      return <ServiceBody payload={payload} />;
    case "retry-issue":
    case "replan-issue":
    case "approve-issue":
    case "merge-issue":
      return <IssueBody payload={payload} />;
    case "read-file":
      return <ReadFileBody payload={payload} />;
    case "read-service-log":
      return <ReadServiceLogBody payload={payload} />;
    default:
      return (
        <div className="text-xs opacity-50 font-mono">
          {JSON.stringify(payload, null, 2)}
        </div>
      );
  }
}

// ── ChatActionCard ───────────────────────────────────────────────────────────

/**
 * Renders an action card inline in a chat message.
 *
 * Props:
 *   action    — { type: string, payload: object }
 *   sessionId — current chat session id
 */
export function ChatActionCard({ action, sessionId }) {
  const [status, setStatus] = useState("idle"); // idle | loading | success | error
  const [errorMsg, setErrorMsg] = useState(null);

  const config = ACTION_CONFIG[action?.type];
  if (!config) return null;

  // Skip card rendering for list actions — data is in AI text
  if (action.type === "list-issues" || action.type === "list-services") return null;

  const { label, icon: Icon, btnClass, hasButton } = config;

  const handleExecute = useCallback(async () => {
    if (status === "loading" || status === "success") return;
    setStatus("loading");
    setErrorMsg(null);
    try {
      await api.post("/chat/action", { sessionId, action });
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId, action, status]);

  return (
    <div className="border border-base-300 rounded-lg overflow-hidden bg-base-100 max-w-md">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-base-200/50 border-b border-base-300">
        <Icon className="size-3.5 opacity-50 shrink-0" />
        <span className="text-[11px] font-semibold uppercase tracking-wider opacity-40">{label}</span>
      </div>

      {/* Body */}
      <div className="px-3 py-2">
        {getCardBody(action.type, action.payload)}
      </div>

      {/* Footer with action button */}
      {hasButton && (
        <div className="px-3 py-2 border-t border-base-300 flex items-center justify-between gap-2">
          {status === "error" && errorMsg && (
            <span className="text-[11px] text-error truncate flex-1">{errorMsg}</span>
          )}
          {status !== "error" && <span />}
          <button
            className={`btn btn-xs ${status === "success" ? "btn-ghost text-success" : btnClass} gap-1`}
            onClick={handleExecute}
            disabled={status === "loading" || status === "success"}
          >
            {status === "loading" && <Loader className="size-3 animate-spin" />}
            {status === "success" && <Check className="size-3" />}
            {status === "idle" && <Icon className="size-3" />}
            {status === "error" && <RotateCcw className="size-3" />}
            <span>
              {status === "success" ? "Done" : status === "error" ? "Retry" : label}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export default ChatActionCard;
