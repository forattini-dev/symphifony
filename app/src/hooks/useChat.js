import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";

const SESSIONS_KEY = ["chat-sessions"];
const sessionKey = (id) => ["chat-session", id];

/**
 * Chat hook — manages sessions, messages, and mutations via TanStack Query.
 *
 * State:
 *   sessions[]          — all chat sessions (from GET /api/chat/sessions)
 *   currentSessionId    — the selected session id
 *   messages[]          — turns from the selected session
 *   isLoading           — true while sending a message
 *
 * Mutations:
 *   sendMessage(text)   — POST /api/chat   { sessionId?, message }
 *   executeAction(action) — POST /api/chat/action { sessionId, action }
 *   createSession(name?) — POST /api/chat/sessions { name? }
 *   deleteSession(id)   — DELETE /api/chat/sessions/:id
 *   renameSession(id, name) — PATCH /api/chat/sessions/:id { name }
 *   selectSession(id)   — switch to a session (local state)
 */
export function useChat() {
  const qc = useQueryClient();
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [optimisticMessages, setOptimisticMessages] = useState([]);

  // ── Queries ────────────────────────────────────────────────────────────────

  const sessionsQuery = useQuery({
    queryKey: SESSIONS_KEY,
    queryFn: () => api.get("/chat/sessions"),
    staleTime: 10_000,
  });

  const sessionQuery = useQuery({
    queryKey: sessionKey(currentSessionId),
    queryFn: () => api.get(`/chat/sessions/${encodeURIComponent(currentSessionId)}`),
    enabled: !!currentSessionId,
    staleTime: 5_000,
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const sessions = useMemo(() => {
    const list = sessionsQuery.data?.sessions;
    return Array.isArray(list) ? list : [];
  }, [sessionsQuery.data]);

  const currentSession = sessionQuery.data?.session ?? null;

  const messages = useMemo(() => {
    const persisted = currentSession && Array.isArray(currentSession.turns) ? currentSession.turns : [];
    // Merge persisted + optimistic (dedup by checking if last persisted matches)
    if (optimisticMessages.length === 0) return persisted;
    // If persisted already has the optimistic messages, return persisted
    if (persisted.length >= optimisticMessages.length) return persisted;
    return [...persisted, ...optimisticMessages.slice(persisted.length)];
  }, [currentSession, optimisticMessages]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const sendMessageMut = useMutation({
    mutationFn: ({ sessionId, message, history }) =>
      api.post("/chat", { sessionId: sessionId || undefined, message, history }),
  });

  const executeActionMut = useMutation({
    mutationFn: ({ sessionId, action }) =>
      api.post("/chat/action", { sessionId, action }),
  });

  const createSessionMut = useMutation({
    mutationFn: (name) => api.post("/chat/sessions", name ? { name } : {}),
    onSuccess: (res) => {
      if (res.session?.id) {
        setCurrentSessionId(res.session.id);
      }
      qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });

  const deleteSessionMut = useMutation({
    mutationFn: (id) => api.delete(`/chat/sessions/${encodeURIComponent(id)}`),
    onSuccess: (_res, id) => {
      if (currentSessionId === id) {
        setCurrentSessionId(null);
      }
      qc.invalidateQueries({ queryKey: SESSIONS_KEY });
    },
  });

  const renameSessionMut = useMutation({
    mutationFn: ({ id, name }) =>
      api.patch(`/chat/sessions/${encodeURIComponent(id)}`, { name }),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      qc.invalidateQueries({ queryKey: sessionKey(id) });
    },
  });

  // ── Public API ─────────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    (text) => {
      if (!text?.trim()) return;
      const trimmed = text.trim();
      // Optimistic: show user message immediately
      setOptimisticMessages((prev) => [
        ...prev,
        { role: "user", content: trimmed, timestamp: new Date().toISOString() },
      ]);
      // Build history from current optimistic messages
      const history = optimisticMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content }));
      sendMessageMut.mutate(
        { sessionId: currentSessionId, message: trimmed, history },
        {
          onSuccess: (res) => {
            // Add AI response to optimistic messages
            if (res.response) {
              setOptimisticMessages((prev) => [
                ...prev,
                { role: "assistant", content: res.response, actions: res.actions, timestamp: new Date().toISOString() },
              ]);
            }
          },
        },
      );
    },
    [currentSessionId, sendMessageMut, optimisticMessages],
  );

  const executeAction = useCallback(
    (action) => {
      if (!currentSessionId || !action) return Promise.resolve(null);
      return executeActionMut.mutateAsync({ sessionId: currentSessionId, action });
    },
    [currentSessionId, executeActionMut],
  );

  const createSession = useCallback(
    (name) => createSessionMut.mutate(name),
    [createSessionMut],
  );

  const deleteSession = useCallback(
    (id) => deleteSessionMut.mutate(id),
    [deleteSessionMut],
  );

  const renameSession = useCallback(
    (id, name) => renameSessionMut.mutate({ id, name }),
    [renameSessionMut],
  );

  const selectSession = useCallback(
    (id) => {
      setCurrentSessionId(id ?? null);
      setOptimisticMessages([]);
    },
    [],
  );

  return {
    // State
    sessions,
    currentSessionId,
    currentSession,
    messages,
    // Loading
    isLoading: sendMessageMut.isPending,
    isSending: sendMessageMut.isPending,
    isSessionsLoading: sessionsQuery.isLoading,
    isSessionLoading: sessionQuery.isLoading && !!currentSessionId,
    // Error
    error: sendMessageMut.error?.message ?? null,
    sessionsError: sessionsQuery.error?.message ?? null,
    // Last response metadata
    lastResponse: sendMessageMut.data ?? null,
    // Mutations
    sendMessage,
    executeAction,
    createSession,
    deleteSession,
    renameSession,
    selectSession,
    // Mutation states (for button spinners, etc.)
    isExecutingAction: executeActionMut.isPending,
    isCreatingSession: createSessionMut.isPending,
    isDeletingSession: deleteSessionMut.isPending,
    isRenamingSession: renameSessionMut.isPending,
    // Reset send error
    clearError: () => sendMessageMut.reset(),
  };
}
