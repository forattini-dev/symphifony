import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Send,
  Plus,
  Loader,
  Trash2,
  AlertTriangle,
  Menu,
  X,
  MessageSquare,
  Pencil,
  Check,
} from "lucide-react";
import { useChat } from "../hooks/useChat.js";
import { ChatActionCard } from "../components/ChatActionCard.jsx";

export const Route = createFileRoute("/chat")({
  component: ChatPage,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function sessionDisplayName(session) {
  return session?.name || session?.sessionName || "New chat";
}

// ── Suggestion chips ─────────────────────────────────────────────────────────

const SUGGESTIONS = [
  "Create an issue",
  "Check service health",
  "What is the project status?",
  "List all active issues",
  "Show blocked issues",
];

// ── MessageBubble ────────────────────────────────────────────────────────────

function MessageBubble({ role, content, timestamp, actions, sessionId }) {
  const isUser = role === "user";

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} gap-1`}>
      <div
        className={`max-w-[80%] text-sm leading-relaxed px-3 py-2 rounded-lg ${
          isUser ? "bg-base-300 text-base-content" : "text-base-content"
        }`}
        style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      >
        {content}
      </div>
      {/* Action cards inline after AI message */}
      {!isUser && Array.isArray(actions) && actions.length > 0 && (
        <div className="flex flex-col gap-2 mt-1 max-w-[80%]">
          {actions.map((action, i) => (
            <ChatActionCard key={i} action={action} sessionId={sessionId} />
          ))}
        </div>
      )}
      {timestamp && (
        <span className="text-[10px] opacity-25 px-1 select-none">
          {relativeTime(timestamp)}
        </span>
      )}
    </div>
  );
}

// ── Session sidebar item ─────────────────────────────────────────────────────

function SessionItem({ session, isActive, onSelect, onDelete, onRename }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const inputRef = useRef(null);

  const handleStartEdit = useCallback((e) => {
    e.stopPropagation();
    setEditName(sessionDisplayName(session));
    setIsEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [session]);

  const handleFinishEdit = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== sessionDisplayName(session)) {
      onRename(session.id, trimmed);
    }
    setIsEditing(false);
  }, [editName, session, onRename]);

  const handleEditKeyDown = useCallback((e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleFinishEdit();
    }
    if (e.key === "Escape") {
      setIsEditing(false);
    }
  }, [handleFinishEdit]);

  return (
    <div
      className={`group flex items-center gap-2 px-3 py-2 cursor-pointer rounded-lg text-sm transition-colors ${
        isActive
          ? "bg-base-300 text-base-content"
          : "text-base-content/70 hover:bg-base-200"
      }`}
      onClick={() => onSelect(session.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onSelect(session.id)}
    >
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            ref={inputRef}
            className="input input-xs input-bordered w-full text-sm"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleFinishEdit}
            onKeyDown={handleEditKeyDown}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <div className="truncate text-xs font-medium">{sessionDisplayName(session)}</div>
            <div className="text-[10px] opacity-40">{relativeTime(session.updatedAt || session.createdAt)}</div>
          </>
        )}
      </div>
      {!isEditing && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            className="btn btn-ghost btn-xs btn-square"
            onClick={handleStartEdit}
            aria-label="Rename session"
            title="Rename"
          >
            <Pencil className="size-3" />
          </button>
          <button
            className="btn btn-ghost btn-xs btn-square text-error/60 hover:text-error"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(session.id);
            }}
            aria-label="Delete session"
            title="Delete"
          >
            <Trash2 className="size-3" />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onSuggestion }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5 opacity-60">
      <MessageSquare className="size-10 opacity-30" />
      <div className="text-sm font-medium">Start a conversation</div>
      <div className="flex flex-wrap gap-2 justify-center max-w-md">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            className="btn btn-xs btn-outline btn-ghost"
            onClick={() => onSuggestion(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      <Loader className="size-3.5 animate-spin opacity-40" />
      <span className="text-xs opacity-35">Thinking...</span>
    </div>
  );
}

// ── Inline error ─────────────────────────────────────────────────────────────

function InlineError({ error, onRetry }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 bg-error/10 border border-error/20 rounded-lg text-sm">
      <AlertTriangle className="size-3.5 text-error shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <span className="text-error/80 text-xs">{error}</span>
      </div>
      {onRetry && (
        <button className="btn btn-ghost btn-xs text-error shrink-0" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

// ── ChatPage ─────────────────────────────────────────────────────────────────

function ChatPage() {
  const chat = useChat();
  const [input, setInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const prevMessagesLenRef = useRef(0);

  // ── Auto-scroll on new messages ──────────────────────────────────────────
  useEffect(() => {
    if (scrollRef.current && chat.messages.length !== prevMessagesLenRef.current) {
      prevMessagesLenRef.current = chat.messages.length;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat.messages.length]);

  // Also scroll when loading indicator appears
  useEffect(() => {
    if (scrollRef.current && chat.isSending) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat.isSending]);

  // Focus textarea when session changes
  useEffect(() => {
    textareaRef.current?.focus();
  }, [chat.currentSessionId]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || chat.isSending) return;
    setInput("");
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    chat.sendMessage(text);
  }, [input, chat]);

  const handleSuggestion = useCallback(
    (text) => {
      if (chat.isSending) return;
      chat.sendMessage(text);
    },
    [chat],
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
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const handleNewSession = useCallback(() => {
    chat.createSession();
  }, [chat]);

  const handleRetry = useCallback(() => {
    // Find last user message to retry
    const turns = chat.messages;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user") {
        chat.clearError();
        chat.sendMessage(turns[i].content);
        return;
      }
    }
  }, [chat]);

  // ── Timestamps refresh ───────────────────────────────────────────────────
  const [, setTick] = useState(0);
  useEffect(() => {
    if (chat.messages.length === 0 && chat.sessions.length === 0) return;
    const t = setInterval(() => setTick((v) => v + 1), 30_000);
    return () => clearInterval(t);
  }, [chat.messages.length, chat.sessions.length]);

  // ── Provider info from last response ─────────────────────────────────────
  const provider = chat.lastResponse?.provider ?? null;

  // ── Normalize messages — the API may return turns with role "assistant" ──
  const normalizedMessages = useMemo(() => {
    return chat.messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || m.createdAt || m.updatedAt,
      actions: m.actions,
    }));
  }, [chat.messages]);

  const hasMessages = normalizedMessages.length > 0;
  const hasSession = !!chat.currentSessionId;

  return (
    <div className="flex-1 flex min-h-0">
      {/* ── Sidebar (desktop) ──────────────────────────────────────────── */}
      <aside
        className={`${
          sidebarOpen ? "w-60" : "w-0"
        } hidden md:flex flex-col border-r border-base-300 bg-base-100 shrink-0 transition-all duration-200 overflow-hidden`}
      >
        <SidebarContent
          sessions={chat.sessions}
          currentSessionId={chat.currentSessionId}
          isLoading={chat.isSessionsLoading}
          onSelect={chat.selectSession}
          onDelete={chat.deleteSession}
          onRename={chat.renameSession}
          onNew={handleNewSession}
        />
      </aside>

      {/* ── Sidebar (mobile overlay) ───────────────────────────────────── */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="relative w-64 flex flex-col bg-base-100 shadow-xl z-10">
            <div className="flex items-center justify-between px-3 py-2 border-b border-base-300">
              <span className="text-xs font-semibold uppercase tracking-wider opacity-40">
                Sessions
              </span>
              <button
                className="btn btn-ghost btn-xs btn-square"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close sidebar"
              >
                <X className="size-4" />
              </button>
            </div>
            <SidebarContent
              sessions={chat.sessions}
              currentSessionId={chat.currentSessionId}
              isLoading={chat.isSessionsLoading}
              onSelect={(id) => {
                chat.selectSession(id);
                setSidebarOpen(false);
              }}
              onDelete={chat.deleteSession}
              onRename={chat.renameSession}
              onNew={() => {
                handleNewSession();
                setSidebarOpen(false);
              }}
            />
          </aside>
        </div>
      )}

      {/* ── Chat area ──────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Top bar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-base-300 shrink-0 bg-base-100">
          <button
            className="btn btn-ghost btn-xs btn-square md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
          >
            <Menu className="size-4" />
          </button>
          <button
            className="btn btn-ghost btn-xs btn-square hidden md:flex"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
          >
            <Menu className="size-4" />
          </button>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium truncate">
              {hasSession ? sessionDisplayName(chat.currentSession) : "Chat"}
            </span>
          </div>
          {provider && (
            <span className="text-[10px] font-mono opacity-30 shrink-0">
              via {provider}
            </span>
          )}
        </div>

        {/* Messages */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-3"
        >
          {!hasSession && !hasMessages && !chat.isSending ? (
            <EmptyState onSuggestion={handleSuggestion} />
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
                />
              ))}
              {chat.isSending && <TypingIndicator />}
              {chat.error && <InlineError error={chat.error} onRetry={handleRetry} />}
            </>
          ) : chat.isSessionLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader className="size-5 animate-spin opacity-30" />
            </div>
          ) : (
            <EmptyState onSuggestion={handleSuggestion} />
          )}
        </div>

        {/* Input bar */}
        <div className="px-4 py-3 border-t border-base-300 shrink-0 bg-base-100">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              className="textarea textarea-bordered flex-1 text-sm resize-none leading-snug min-h-[36px]"
              rows={1}
              placeholder="Ask anything..."
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={chat.isSending}
              style={{ maxHeight: "96px" }}
            />
            <button
              className="btn btn-primary btn-sm btn-square shrink-0"
              onClick={handleSend}
              disabled={chat.isSending || !input.trim()}
              aria-label="Send message"
              title="Send (Enter)"
            >
              {chat.isSending ? (
                <Loader className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
            </button>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] opacity-25">
              Enter to send, Shift+Enter for newline
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sidebar content (shared between desktop and mobile) ──────────────────────

function SidebarContent({ sessions, currentSessionId, isLoading, onSelect, onDelete, onRename, onNew }) {
  return (
    <>
      {/* New session button */}
      <div className="px-3 py-2 border-b border-base-300 shrink-0">
        <button
          className="btn btn-sm btn-ghost w-full justify-start gap-2 text-xs"
          onClick={onNew}
        >
          <Plus className="size-3.5" />
          New chat
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2 space-y-0.5">
        {isLoading && sessions.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader className="size-4 animate-spin opacity-30" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="text-xs opacity-30 text-center py-8">No sessions yet</div>
        ) : (
          sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isActive={s.id === currentSessionId}
              onSelect={onSelect}
              onDelete={onDelete}
              onRename={onRename}
            />
          ))
        )}
      </div>
    </>
  );
}
