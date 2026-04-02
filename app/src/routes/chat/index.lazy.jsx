import { createLazyFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Send,
  Loader,
  AlertTriangle,
  X,
  Search,
  ChevronDown,
  ChevronRight,
  ArrowDown,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import Markdown from "react-markdown";
import { useChat } from "../../hooks/useChat.js";
import { ChatActionCard } from "../../components/ChatActionCard.jsx";
import { useDashboard } from "../../context/DashboardContext.jsx";
import { api } from "../../api.js";

export const Route = createLazyFileRoute("/chat/")({
  component: ChatPage,
});

// ── Constants ───────────────────────────────────────────────────────────────

const COLUMNS = [
  { label: "Planning", states: ["Planning"] },
  { label: "Needs Approval", states: ["PendingApproval"] },
  { label: "In Progress", states: ["Queued", "Running", "Reviewing"] },
  { label: "Blocked", states: ["Blocked"] },
  { label: "Review", states: ["PendingDecision"] },
  { label: "Done", states: ["Approved", "Merged", "Cancelled"] },
];

const STATE_DOT = {
  Planning: "bg-info",
  Queued: "bg-info",
  Running: "bg-primary animate-pulse",
  Reviewing: "bg-secondary animate-pulse",
  PendingApproval: "bg-warning",
  PendingDecision: "bg-warning",
  Blocked: "bg-error",
  Merged: "bg-success",
  Approved: "bg-success",
  Cancelled: "bg-neutral",
};

const STATE_COLOR = {
  Planning: "info",
  Queued: "info",
  Running: "primary",
  Reviewing: "secondary",
  PendingApproval: "warning",
  PendingDecision: "warning",
  Blocked: "error",
  Merged: "success",
  Approved: "success",
  Cancelled: "neutral",
};

const GLOBAL_SUGGESTIONS = [
  "Create an issue",
  "What's the project status?",
  "Check services",
  "Show blocked issues",
];

const ISSUE_SUGGESTIONS = [
  "Explain the plan",
  "What's blocking this?",
  "Retry execution",
  "Show the diff",
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/** Should we show a timestamp between two messages? */
function shouldShowTimestamp(msg, prevMsg) {
  if (!prevMsg) return true;
  if (msg.role !== prevMsg.role) return true;
  const a = new Date(msg.timestamp).getTime();
  const b = new Date(prevMsg.timestamp).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) > 5 * 60_000;
}

/** Very basic markdown-ish code block detection */
const MD_COMPONENTS = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-inside mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  code: ({ inline, children }) =>
    inline
      ? <code className="bg-base-300/60 px-1 py-0.5 rounded text-[0.85em] font-mono">{children}</code>
      : <code>{children}</code>,
  pre: ({ children }) => (
    <pre className="my-2 rounded-lg bg-base-300/60 px-3 py-2 text-xs leading-relaxed overflow-x-auto font-mono">
      {children}
    </pre>
  ),
  h1: ({ children }) => <h3 className="font-bold text-base mb-1">{children}</h3>,
  h2: ({ children }) => <h3 className="font-bold text-sm mb-1">{children}</h3>,
  h3: ({ children }) => <h4 className="font-semibold text-sm mb-1">{children}</h4>,
  blockquote: ({ children }) => <blockquote className="border-l-2 border-base-content/20 pl-3 italic opacity-70 mb-2">{children}</blockquote>,
  hr: () => <hr className="border-base-content/10 my-2" />,
  a: ({ href, children }) => <a href={href} className="underline opacity-80 hover:opacity-100" target="_blank" rel="noopener noreferrer">{children}</a>,
};

function renderContent(text) {
  if (!text) return null;
  return <Markdown components={MD_COMPONENTS}>{text}</Markdown>;
}

// ── Reasoning mode ──────────────────────────────────────────────────────────

const READ_ACTIONS = new Set(["read-file", "read-service-log"]);
const DISPATCH_ACTIONS = new Set(["create-issue", "approve-issue", "merge-issue", "retry-issue", "replan-issue"]);
const SERVICE_ACTIONS = new Set(["start-service", "stop-service", "restart-service"]);

const RING_STYLES = {
  direct:     null,
  explored:   "0 0 0 2px oklch(0.62 0.21 250 / 0.65)",
  dispatched: "0 0 0 2px oklch(0.65 0.2 145 / 0.65)",
  operated:   "0 0 0 2px oklch(0.70 0.18 68 / 0.65)",
  multi:      "0 0 0 2px oklch(0.62 0.22 300 / 0.65), 0 0 8px oklch(0.62 0.22 300 / 0.25)",
};

const MODE_TOOLTIP = {
  direct:     "Fifony",
  explored:   "Read files to answer",
  dispatched: "Dispatched an action",
  operated:   "Managed a service",
  multi:      "Used multiple tools",
};

function deriveReasoningMode(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return "direct";
  const types = actions.map((a) => a?.type ?? a?.action ?? "").filter(Boolean);
  let hasRead = false;
  let hasDispatch = false;
  let hasService = false;
  for (const t of types) {
    if (READ_ACTIONS.has(t)) hasRead = true;
    else if (DISPATCH_ACTIONS.has(t)) hasDispatch = true;
    else if (SERVICE_ACTIONS.has(t)) hasService = true;
  }
  const count = (hasRead ? 1 : 0) + (hasDispatch ? 1 : 0) + (hasService ? 1 : 0);
  if (count >= 2) return "multi";
  if (hasRead) return "explored";
  if (hasDispatch) return "dispatched";
  if (hasService) return "operated";
  return "direct";
}

// ── DinoAvatar ───────────────────────────────────────────────────────────────

function DinoAvatar({ mode = "direct", pulsing = false }) {
  const ringStyle = RING_STYLES[mode] ?? null;
  const tooltip = MODE_TOOLTIP[mode] ?? "Fifony";
  return (
    <div
      className={`w-8 h-8 rounded-full overflow-hidden shrink-0${pulsing ? " animate-pulse" : ""}`}
      style={ringStyle ? { boxShadow: ringStyle } : undefined}
      title={tooltip}
    >
      <img src="/dinofffaur.webp" alt="Fifony" className="w-full h-full rounded-full object-cover" />
    </div>
  );
}

// ── TypingDots ──────────────────────────────────────────────────────────────

function TypingDots({ startedAt }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setElapsed(Math.round((Date.now() - startedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <div className="chat chat-start chat-msg-in">
      <div className="chat-image avatar">
        <DinoAvatar mode="direct" pulsing />
      </div>
      <div className="chat-bubble bg-base-200/60 text-base-content flex items-center gap-1.5 py-2.5 px-3">
        <span className="typing-dot size-1.5 rounded-full bg-base-content/40" style={{ animationDelay: "0ms" }} />
        <span className="typing-dot size-1.5 rounded-full bg-base-content/40" style={{ animationDelay: "150ms" }} />
        <span className="typing-dot size-1.5 rounded-full bg-base-content/40" style={{ animationDelay: "300ms" }} />
        {elapsed > 3 && (
          <span className="text-[10px] text-base-content/30 ml-1 tabular-nums">{elapsed}s</span>
        )}
      </div>
    </div>
  );
}

// ── InlineError ─────────────────────────────────────────────────────────────

function InlineError({ error, onRetry }) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 bg-error/8 border border-error/15 rounded-xl text-sm animate-fade-in max-w-lg">
      <AlertTriangle className="size-3.5 text-error/70 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <span className="text-error/70 text-xs leading-relaxed">{error}</span>
      </div>
      {onRetry && (
        <button className="btn btn-ghost btn-xs text-error/70 shrink-0" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

// ── MessageBubble ───────────────────────────────────────────────────────────

function MessageBubble({ role, content, timestamp, actions, sessionId, showTime }) {
  const isUser = role === "user";
  const mode = isUser ? null : deriveReasoningMode(actions);

  if (isUser) {
    return (
      <div className="chat chat-end chat-msg-out">
        <div
          className="chat-bubble bg-primary text-primary-content text-sm leading-relaxed"
          style={{ wordBreak: "break-word" }}
        >
          {content}
        </div>
        {showTime && timestamp && (
          <div className="chat-footer opacity-40 text-[10px] select-none">
            {relativeTime(timestamp)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 items-start chat-msg-in">
      <div className="chat chat-start w-full">
        <div className="chat-image avatar">
          <DinoAvatar mode={mode} />
        </div>
        <div className="chat-bubble bg-base-200/60 text-base-content text-sm leading-relaxed" style={{ wordBreak: "break-word" }}>
          {renderContent(content)}
        </div>
        {showTime && timestamp && (
          <div className="chat-footer opacity-40 text-[10px] select-none">
            {relativeTime(timestamp)}
          </div>
        )}
      </div>
      {Array.isArray(actions) && actions.length > 0 && (
        <div className="flex flex-col gap-2 pl-10">
          {actions.map((action, i) => (
            <ChatActionCard key={i} action={action} sessionId={sessionId} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

function EmptyState({ onSuggestion, selectedIssue }) {
  const suggestions = selectedIssue ? ISSUE_SUGGESTIONS : GLOBAL_SUGGESTIONS;

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-5 pb-8">
      <div className="w-full max-w-md space-y-6 animate-fade-in-up">
        {/* Greeting or issue context */}
        {selectedIssue ? (
          <div className="space-y-3">
            <div className="text-base-content/40 text-sm">Discussing</div>
            <div className="bg-base-200/40 rounded-xl px-4 py-3 border border-base-300/50">
              <div className="flex items-center gap-2">
                <span className={`size-2 rounded-full shrink-0 ${STATE_DOT[selectedIssue.state] || "bg-base-content/20"}`} />
                <span className="font-mono text-xs text-base-content/50">{selectedIssue.identifier}</span>
              </div>
              <div className="text-sm font-medium mt-1 text-base-content/80">{selectedIssue.title}</div>
              {selectedIssue.description && (
                <div className="text-xs text-base-content/40 mt-1.5 line-clamp-2 leading-relaxed">
                  {selectedIssue.description}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-1 text-center">
            <h2 className="text-xl font-semibold text-base-content/80">
              Hey. What are you working on?
            </h2>
            <p className="text-sm text-base-content/35">
              Ask about your project, manage issues, or just think out loud.
            </p>
          </div>
        )}

        {/* Suggestion chips */}
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 no-scrollbar">
          {suggestions.map((s) => (
            <button
              key={s}
              className="chip-suggestion shrink-0 text-xs px-3.5 py-2 rounded-full border border-base-300/60 text-base-content/50 bg-base-100 hover:border-primary/30 hover:text-primary/70 hover:bg-primary/5 transition-all duration-150 active:scale-95 whitespace-nowrap"
              onClick={() => onSuggestion(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Context banner ──────────────────────────────────────────────────────────

function ContextBanner({ issue, onDeselect }) {
  if (!issue) return null;
  const color = STATE_COLOR[issue.state] || "neutral";

  return (
    <div
      className="flex items-center gap-2.5 px-4 py-2 shrink-0 animate-fade-in"
      style={{
        background: `color-mix(in oklab, var(--color-${color}) 6%, transparent)`,
        borderBottom: `1px solid color-mix(in oklab, var(--color-${color}) 15%, transparent)`,
      }}
    >
      <span className={`size-2 rounded-full shrink-0 ${STATE_DOT[issue.state] || "bg-base-content/20"}`} />
      <span className="text-xs font-mono font-semibold truncate" style={{ color: `var(--color-${color})` }}>
        {issue.identifier}
      </span>
      <span className="text-xs text-base-content/50 truncate flex-1 min-w-0">
        {issue.title}
      </span>
      <button
        className="btn btn-ghost btn-xs btn-circle shrink-0 opacity-40 hover:opacity-80"
        onClick={onDeselect}
        aria-label="Clear issue context"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

// ── Issue sidebar item ──────────────────────────────────────────────────────

function IssueItem({ issue, isSelected, onToggle }) {
  const dotClass = STATE_DOT[issue.state] || "bg-base-content/20";
  return (
    <button
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left text-xs transition-all duration-150 ${
        isSelected
          ? "bg-primary/8 text-base-content border-l-2 border-l-primary pl-2"
          : "text-base-content/60 hover:bg-base-200/60 border-l-2 border-l-transparent"
      }`}
      onClick={() => onToggle(issue)}
      title={`${issue.identifier}: ${issue.title}`}
    >
      <span className={`size-1.5 rounded-full shrink-0 ${dotClass}`} />
      <span className={`font-mono shrink-0 ${isSelected ? "text-primary/70" : "opacity-40"}`}>
        {issue.identifier}
      </span>
      <span className="truncate flex-1">{issue.title}</span>
    </button>
  );
}

// ── Issue sidebar group ─────────────────────────────────────────────────────

function IssueGroup({ label, issues, selectedIssueId, onToggle, defaultCollapsed }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div className="space-y-0.5">
      <button
        className="flex items-center gap-1.5 px-2.5 py-1 w-full text-left text-[10px] font-semibold uppercase tracking-wider text-base-content/30 hover:text-base-content/50 transition-colors"
        onClick={() => setCollapsed((c) => !c)}
      >
        <Chevron className="size-2.5" />
        <span>{label}</span>
        <span className="ml-auto font-mono text-base-content/20">{issues.length}</span>
      </button>
      {!collapsed &&
        issues.map((issue) => (
          <IssueItem
            key={issue.id}
            issue={issue}
            isSelected={issue.id === selectedIssueId}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}

// ── Sidebar content ─────────────────────────────────────────────────────────

function SidebarContent({ issues, selectedIssueId, onToggle, search, onSearchChange }) {
  const grouped = useMemo(() => {
    const lower = search.toLowerCase();
    const filtered = lower
      ? issues.filter((i) => `${i.identifier} ${i.title}`.toLowerCase().includes(lower))
      : issues;

    return COLUMNS.map((col) => ({
      ...col,
      issues: filtered
        .filter((i) => col.states.includes(i.state))
        .sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "")),
    })).filter((g) => g.issues.length > 0);
  }, [issues, search]);

  const total = issues.length;

  return (
    <>
      {/* Header */}
      <div className="px-3 pt-3 pb-1.5 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-base-content/60">Issues</span>
          {total > 0 && (
            <span className="text-[10px] font-mono text-base-content/25 bg-base-200/60 rounded-full px-1.5 py-0.5">
              {total}
            </span>
          )}
        </div>
        <div className="relative">
          <Search className="size-3 absolute left-2.5 top-1/2 -translate-y-1/2 text-base-content/25" />
          <input
            className="input input-xs input-bordered w-full pl-7 text-xs bg-base-200/30 border-base-300/50 rounded-lg"
            placeholder="Search..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {search && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs btn-circle size-4"
              onClick={() => onSearchChange("")}
              aria-label="Clear search"
            >
              <X className="size-2.5" />
            </button>
          )}
        </div>
      </div>

      {/* Issue groups */}
      <div className="flex-1 overflow-y-auto min-h-0 px-1.5 py-1.5 space-y-2.5">
        {grouped.length === 0 ? (
          <div className="text-xs text-base-content/25 text-center py-8">
            {search ? "No matches" : "No issues yet"}
          </div>
        ) : (
          grouped.map((g) => (
            <IssueGroup
              key={g.label}
              label={g.label}
              issues={g.issues}
              selectedIssueId={selectedIssueId}
              onToggle={onToggle}
              defaultCollapsed={g.label === "Done"}
            />
          ))
        )}
      </div>
    </>
  );
}

// ── Mobile tab bar ──────────────────────────────────────────────────────────

function MobileTabBar({ activeTab, setActiveTab, issueCount }) {
  return (
    <div className="flex border-b border-base-300 bg-base-100 shrink-0 md:hidden">
      <button
        className={`flex-1 py-2.5 text-xs font-medium text-center transition-colors relative ${
          activeTab === "chat" ? "text-primary" : "text-base-content/40"
        }`}
        onClick={() => setActiveTab("chat")}
      >
        Chat
        {activeTab === "chat" && (
          <span className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary rounded-full" />
        )}
      </button>
      <button
        className={`flex-1 py-2.5 text-xs font-medium text-center transition-colors relative ${
          activeTab === "issues" ? "text-primary" : "text-base-content/40"
        }`}
        onClick={() => setActiveTab("issues")}
      >
        Issues
        {issueCount > 0 && (
          <span className="ml-1 text-[10px] font-mono text-base-content/25">{issueCount}</span>
        )}
        {activeTab === "issues" && (
          <span className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary rounded-full" />
        )}
      </button>
    </div>
  );
}

// ── ScrollToBottom button ───────────────────────────────────────────────────

function ScrollToBottomBtn({ visible, onClick }) {
  if (!visible) return null;
  return (
    <button
      className="absolute bottom-20 left-1/2 -translate-x-1/2 btn btn-circle btn-sm bg-base-200/80 border-base-300/50 shadow-lg backdrop-blur-sm hover:bg-base-200 transition-all duration-200 z-10 animate-fade-in"
      onClick={onClick}
      aria-label="Scroll to bottom"
    >
      <ArrowDown className="size-3.5 text-base-content/50" />
    </button>
  );
}

// ── ChatPage ────────────────────────────────────────────────────────────────

function ChatPage() {
  const chat = useChat();
  const { issues } = useDashboard();
  const qc = useQueryClient();

  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedIssueId, setSelectedIssueId] = useState(null);
  const [isSendingWithIssue, setIsSendingWithIssue] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [issueMessages, setIssueMessages] = useState([]);
  const [mobileTab, setMobileTab] = useState("chat");
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const prevMessagesLenRef = useRef(0);

  // ── Derived ────────────────────────────────────────────────────────────
  const selectedIssue = useMemo(
    () => (selectedIssueId ? issues.find((i) => i.id === selectedIssueId) ?? null : null),
    [selectedIssueId, issues],
  );

  const isSending = chat.isSending || isSendingWithIssue;
  const error = chat.error || sendError;

  // ── Listen for /chat/:issueId redirect ──────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      const id = e.detail?.issueId;
      if (id && id !== selectedIssueId) {
        setSelectedIssueId(id);
        setIssueMessages([]);
        setSendError(null);
        chat.selectSession(null);
        setMobileTab("chat");
      }
    };
    window.addEventListener("spark:chat:select-issue", handler);
    return () => window.removeEventListener("spark:chat:select-issue", handler);
  }, [selectedIssueId, chat]);

  // ── Scroll behavior ────────────────────────────────────────────────────
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    }
  }, []);

  useEffect(() => {
    if (scrollRef.current && chat.messages.length !== prevMessagesLenRef.current) {
      prevMessagesLenRef.current = chat.messages.length;
      scrollToBottom();
    }
  }, [chat.messages.length, scrollToBottom]);

  useEffect(() => {
    if (isSending) scrollToBottom();
  }, [isSending, scrollToBottom]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [chat.currentSessionId]);

  // Track scroll position for scroll-to-bottom button
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBtn(distFromBottom > 200);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // ── Issue toggle ───────────────────────────────────────────────────────
  const handleToggleIssue = useCallback(
    (issue) => {
      if (selectedIssueId === issue.id) {
        setSelectedIssueId(null);
      } else {
        setSelectedIssueId(issue.id);
      }
      chat.selectSession(null);
      setSendError(null);
      setIssueMessages([]);
    },
    [selectedIssueId, chat],
  );

  const handleDeselectIssue = useCallback(() => {
    setSelectedIssueId(null);
    chat.selectSession(null);
    setSendError(null);
    setIssueMessages([]);
  }, [chat]);

  // ── Send message ───────────────────────────────────────────────────────
  const handleSendText = useCallback(
    async (text) => {
      if (!text?.trim() || isSending) return;
      const trimmed = text.trim();

      if (!selectedIssueId) {
        chat.sendMessage(trimmed);
        return;
      }

      // Optimistic: show user message immediately
      setIssueMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed, timestamp: new Date().toISOString() },
      ]);
      setIsSendingWithIssue(true);
      setSendError(null);
      try {
        const res = await api.post("/chat", {
          message: trimmed,
          issueId: selectedIssueId,
          history: issueMessages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content })),
        });
        // Append AI response
        if (res.response) {
          setIssueMessages((prev) => [
            ...prev,
            { role: "assistant", content: res.response, actions: res.actions, timestamp: new Date().toISOString() },
          ]);
        }
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsSendingWithIssue(false);
      }
    },
    [isSending, selectedIssueId, chat, qc],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    handleSendText(text);
  }, [input, handleSendText]);

  const handleSuggestion = useCallback(
    (text) => {
      if (isSending) return;
      setMobileTab("chat");
      handleSendText(text);
    },
    [isSending, handleSendText],
  );

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        textareaRef.current?.blur();
      }
    },
    [handleSend],
  );

  const handleInputChange = useCallback((e) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  const handleRetry = useCallback(() => {
    const turns = chat.messages;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user") {
        chat.clearError();
        setSendError(null);
        handleSendText(turns[i].content);
        return;
      }
    }
  }, [chat, handleSendText]);

  // ── Timestamps refresh ─────────────────────────────────────────────────
  const [, setTick] = useState(0);
  useEffect(() => {
    if (chat.messages.length === 0 && issues.length === 0) return;
    const t = setInterval(() => setTick((v) => v + 1), 30_000);
    return () => clearInterval(t);
  }, [chat.messages.length, issues.length]);

  // ── Provider info from last response ───────────────────────────────────
  const provider = chat.lastResponse?.provider ?? null;

  // ── Normalize messages ─────────────────────────────────────────────────
  const rawMessages = selectedIssueId ? issueMessages : chat.messages;
  const normalizedMessages = useMemo(() => {
    return rawMessages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || m.createdAt || m.updatedAt,
      actions: m.actions,
    }));
  }, [rawMessages]);

  const hasMessages = normalizedMessages.length > 0;

  // When selecting an issue on mobile, switch back to chat tab
  const handleMobileIssueSelect = useCallback(
    (issue) => {
      handleToggleIssue(issue);
      setMobileTab("chat");
    },
    [handleToggleIssue],
  );

  return (
    <>
      {/* Scoped CSS for chat micro-interactions */}
      <style>{`
        .chat-msg-in { animation: chatSlideInLeft 220ms ease-out both; }
        .chat-msg-out { animation: chatSlideInRight 220ms ease-out both; }
        @keyframes chatSlideInLeft {
          from { opacity: 0; transform: translateX(-10px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes chatSlideInRight {
          from { opacity: 0; transform: translateX(10px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .typing-dot {
          animation: typingDot 1.2s ease-in-out infinite;
        }
        @keyframes typingDot {
          0%, 60%, 100% { opacity: 0.25; transform: scale(0.85); }
          30% { opacity: 1; transform: scale(1.1); }
        }
        .chip-suggestion:hover {
          transform: translateY(-1px);
        }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        .chat-input-wrap:focus-within {
          box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-primary) 20%, transparent);
          border-color: color-mix(in oklab, var(--color-primary) 40%, transparent);
        }
        .send-btn:active:not(:disabled) {
          transform: scale(0.88);
        }
      `}</style>

      <div className="flex-1 flex min-h-0">
        {/* ── Desktop sidebar ──────────────────────────────────────────── */}
        <aside
          className={`${
            sidebarOpen ? "w-[240px]" : "w-0"
          } hidden md:flex flex-col border-r border-base-300/60 bg-base-100 shrink-0 transition-all duration-200 overflow-hidden`}
        >
          <SidebarContent
            issues={issues}
            selectedIssueId={selectedIssueId}
            onToggle={handleToggleIssue}
            search={search}
            onSearchChange={setSearch}
          />
        </aside>

        {/* ── Main area ────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Mobile tab bar */}
          <MobileTabBar
            activeTab={mobileTab}
            setActiveTab={setMobileTab}
            issueCount={issues.length}
          />


          {/* Mobile issues tab content */}
          {mobileTab === "issues" && (
            <div className="flex-1 flex flex-col min-h-0 md:hidden bg-base-100">
              <SidebarContent
                issues={issues}
                selectedIssueId={selectedIssueId}
                onToggle={handleMobileIssueSelect}
                search={search}
                onSearchChange={setSearch}
              />
            </div>
          )}

          {/* Chat content (visible on desktop always, mobile when chat tab active) */}
          <div className={`flex-1 flex flex-col min-h-0 ${mobileTab !== "chat" ? "hidden md:flex" : "flex"}`}>
            {/* Context banner */}
            <ContextBanner issue={selectedIssue} onDeselect={handleDeselectIssue} />

            {/* Messages area */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto min-h-0 relative"
            >
              <div className="max-w-2xl mx-auto px-4 py-4 space-y-3">
                {!hasMessages && !isSending ? (
                  <EmptyState onSuggestion={handleSuggestion} selectedIssue={selectedIssue} />
                ) : hasMessages ? (
                  <>
                    {normalizedMessages.map((msg, i) => (
                      <MessageBubble
                        key={`${chat.currentSessionId}-${i}`}
                        role={msg.role}
                        content={msg.content}
                        timestamp={msg.timestamp}
                        actions={msg.actions}
                        sessionId={chat.currentSessionId}
                        showTime={shouldShowTimestamp(msg, normalizedMessages[i - 1])}
                      />
                    ))}
                    {isSending && <TypingDots startedAt={chat.sendingStartedAt} />}
                    {error && <InlineError error={error} onRetry={handleRetry} />}
                  </>
                ) : chat.isSessionLoading ? (
                  <div className="flex-1 flex items-center justify-center py-20">
                    <Loader className="size-5 animate-spin text-base-content/20" />
                  </div>
                ) : (
                  <EmptyState onSuggestion={handleSuggestion} selectedIssue={selectedIssue} />
                )}
              </div>

              {/* Scroll to bottom */}
              <ScrollToBottomBtn visible={showScrollBtn && hasMessages} onClick={scrollToBottom} />
            </div>

            {/* ── Input area ─────────────────────────────────────────────── */}
            <div className="shrink-0 bg-base-100 border-t border-base-300/40 pb-[env(safe-area-inset-bottom)]">
              <div className="max-w-2xl mx-auto px-3 py-3">
                <div className="chat-input-wrap flex items-end gap-0 bg-base-200/40 border border-base-300/50 rounded-2xl px-3 py-1.5 transition-all duration-200">
                  <textarea
                    ref={textareaRef}
                    className="flex-1 bg-transparent border-none outline-none resize-none text-sm leading-relaxed py-1.5 placeholder:text-base-content/25 min-h-[24px]"
                    rows={1}
                    placeholder={
                      selectedIssue
                        ? `Ask about ${selectedIssue.identifier}...`
                        : "What can I help with?"
                    }
                    value={input}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    disabled={isSending}
                    style={{ maxHeight: "120px" }}
                  />
                  <button
                    className={`send-btn shrink-0 size-8 rounded-xl flex items-center justify-center transition-all duration-150 ml-1 ${
                      input.trim()
                        ? "bg-primary text-primary-content hover:brightness-110"
                        : "bg-base-300/50 text-base-content/20"
                    }`}
                    onClick={handleSend}
                    disabled={isSending || !input.trim()}
                    aria-label="Send message"
                    title="Send (Enter)"
                  >
                    {isSending ? (
                      <Loader className="size-3.5 animate-spin" />
                    ) : (
                      <Send className="size-3.5" />
                    )}
                  </button>
                </div>
                <div className="flex items-center justify-between mt-1.5 px-1">
                  <div className="flex items-center gap-2">
                    <button
                      className="hidden md:flex btn btn-ghost btn-xs btn-square size-4 opacity-20 hover:opacity-50 p-0"
                      onClick={() => setSidebarOpen((v) => !v)}
                      aria-label="Toggle sidebar"
                      title="Toggle issues sidebar"
                    >
                      {sidebarOpen ? <ChevronRight className="size-3 rotate-180" /> : <ChevronRight className="size-3" />}
                    </button>
                    <span className="text-[10px] text-base-content/15">
                      Enter to send · Shift+Enter for newline
                    </span>
                  </div>
                  {provider && (
                    <span className="text-[10px] text-base-content/15">
                      via {provider}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
