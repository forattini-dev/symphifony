import React, { useState, useEffect, useRef, useCallback } from "react";
import { X, Send, Loader, AlertTriangle } from "lucide-react";
import { DrawerBackdrop, DrawerPanel } from "./DrawerPrimitives.jsx";
import { api } from "../api.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(ts) {
  if (!ts) return "";
  const diff = Math.abs(Date.now() - ts);
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

// ── Message Bubble ───────────────────────────────────────────────────────────

function MessageBubble({ role, content, timestamp }) {
  const isUser = role === "user";

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} gap-0.5`}>
      <div
        className={`max-w-[85%] text-sm leading-relaxed px-3 py-2 rounded-lg ${
          isUser
            ? "bg-base-300 text-base-content"
            : "text-base-content"
        }`}
        style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      >
        {content}
      </div>
      {timestamp && (
        <span className="text-[10px] opacity-25 px-1 select-none">
          {relativeTime(timestamp)}
        </span>
      )}
    </div>
  );
}

// ── Empty State ──────────────────────────────────────────────────────────────

function EmptyState({ issue }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 gap-4 opacity-50">
      <div className="text-center space-y-2 max-w-sm">
        <div className="text-sm font-medium">Ask anything about this issue</div>
        <div className="border border-base-300 rounded-box p-3 text-left space-y-1.5">
          <div className="text-xs font-semibold truncate">{issue.title}</div>
          {issue.description && (
            <p className="text-xs opacity-60 line-clamp-3 leading-relaxed">
              {issue.description}
            </p>
          )}
        </div>
        <div className="text-[11px] opacity-50 leading-relaxed">
          The AI has full context of the issue, its plan, and current state.
        </div>
      </div>
    </div>
  );
}

// ── Inline Error ─────────────────────────────────────────────────────────────

function InlineError({ error, onRetry }) {
  return (
    <div className="flex items-start gap-2 px-3 py-2 bg-error/10 border border-error/20 rounded-lg text-sm">
      <AlertTriangle className="size-3.5 text-error shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <span className="text-error/80 text-xs">{error}</span>
      </div>
      <button
        className="btn btn-ghost btn-xs text-error shrink-0"
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}

// ── ChatDrawer ───────────────────────────────────────────────────────────────

export function ChatDrawer({ issue, open, onClose }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(false);
  const [lastProvider, setLastProvider] = useState(null);

  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const prevIssueIdRef = useRef(null);

  // Reset messages when issue changes
  useEffect(() => {
    if (issue?.id !== prevIssueIdRef.current) {
      setMessages([]);
      setInput("");
      setError(null);
      setLoading(false);
      setLastProvider(null);
      prevIssueIdRef.current = issue?.id ?? null;
    }
  }, [issue?.id]);

  // Auto-scroll to bottom on new messages or loading state
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  // Focus textarea when drawer opens
  useEffect(() => {
    if (open && textareaRef.current) {
      const t = setTimeout(() => textareaRef.current?.focus(), 300);
      return () => clearTimeout(t);
    }
  }, [open]);

  const handleClose = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setClosing(false);
      onClose();
    }, 250);
  }, [onClose]);

  // Build conversation history for API (exclude timestamps)
  const buildHistory = useCallback((msgs) => {
    return msgs.map(({ role, content }) => ({ role, content }));
  }, []);

  const sendMessage = useCallback(async (retryContent) => {
    const text = retryContent ?? input.trim();
    if (!text || loading || !issue?.id) return;

    setError(null);
    if (!retryContent) {
      setInput("");
    }

    const userMsg = { role: "user", content: text, timestamp: Date.now() };

    setMessages((prev) => {
      // If retrying, the user message is already in the list
      if (retryContent) return prev;
      return [...prev, userMsg];
    });

    setLoading(true);

    try {
      // Build history from current messages (before adding the new user msg if not retry)
      const currentMessages = retryContent
        ? messages
        : [...messages, userMsg];
      const history = buildHistory(currentMessages);

      const res = await api.post(`/issues/${encodeURIComponent(issue.id)}/chat`, {
        message: text,
        history: history.slice(0, -1), // history excludes the current message
      });

      if (res.provider) setLastProvider(res.provider);

      const assistantMsg = {
        role: "assistant",
        content: res.response,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [input, loading, issue?.id, messages, buildHistory]);

  const handleRetry = useCallback(() => {
    // Find the last user message to retry
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (lastUserMsg) {
      setError(null);
      sendMessage(lastUserMsg.content);
    }
  }, [messages, sendMessage]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    }
  }, [sendMessage, handleClose]);

  // Auto-resize textarea (1-4 lines)
  const handleInputChange = useCallback((e) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`; // 96px ~ 4 lines
  }, []);

  // Timestamps update every 30s
  const [, setTick] = useState(0);
  useEffect(() => {
    if (messages.length === 0) return;
    const t = setInterval(() => setTick((v) => v + 1), 30_000);
    return () => clearInterval(t);
  }, [messages.length]);

  if (!open) return null;

  return (
    <div>
      <DrawerBackdrop
        onClick={handleClose}
        className={closing ? "animate-fade-out" : "animate-fade-in"}
      />
      <DrawerPanel
        closing={closing}
        width="w-full md:w-[40vw] md:min-w-[460px] md:max-w-[540px]"
      >
        {/* ── Header ────────────────────────────────────────────────── */}
        <div className="px-4 py-3 border-b border-base-300 shrink-0 flex items-center gap-3 min-w-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[11px] opacity-35 shrink-0">
                {issue?.identifier}
              </span>
              <span className="text-sm font-medium truncate">
                {issue?.title}
              </span>
            </div>
            {lastProvider && (
              <span className="text-[10px] font-mono opacity-30 mt-0.5 block">
                via {lastProvider}
              </span>
            )}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-circle shrink-0 opacity-40 hover:opacity-80"
            onClick={handleClose}
            aria-label="Close chat"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* ── Messages ──────────────────────────────────────────────── */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-3"
        >
          {messages.length === 0 && !loading ? (
            <EmptyState issue={issue} />
          ) : (
            <>
              {messages.map((msg, i) => (
                <MessageBubble
                  key={i}
                  role={msg.role}
                  content={msg.content}
                  timestamp={msg.timestamp}
                />
              ))}

              {/* Loading indicator */}
              {loading && (
                <div className="flex items-center gap-2 px-1 py-1">
                  <Loader className="size-3.5 animate-spin opacity-40" />
                  <span className="text-xs opacity-35">Thinking...</span>
                </div>
              )}

              {/* Error */}
              {error && (
                <InlineError error={error} onRetry={handleRetry} />
              )}
            </>
          )}
        </div>

        {/* ── Input ─────────────────────────────────────────────────── */}
        <div className="px-4 py-3 border-t border-base-300 shrink-0">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              className="textarea textarea-bordered flex-1 text-sm resize-none leading-snug min-h-[36px]"
              rows={1}
              placeholder="Ask about this issue..."
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              disabled={loading}
              style={{ maxHeight: "96px" }}
            />
            <button
              className="btn btn-primary btn-sm btn-square shrink-0"
              onClick={() => sendMessage()}
              disabled={loading || !input.trim()}
              aria-label="Send message"
              title="Send (Enter)"
            >
              {loading ? (
                <Loader className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
            </button>
          </div>
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[10px] opacity-25">
              Enter to send, Shift+Enter for newline
            </span>
            <span className="text-[10px] opacity-25">
              Esc to close
            </span>
          </div>
        </div>
      </DrawerPanel>
    </div>
  );
}

export default ChatDrawer;
