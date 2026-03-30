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
    if (!currentSession) return [];
    return Array.isArray(currentSession.turns) ? currentSession.turns : [];
  }, [currentSession]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const sendMessageMut = useMutation({
    mutationFn: ({ sessionId, message }) =>
      api.post("/chat", { sessionId: sessionId || undefined, message }),
    onSuccess: (res) => {
      // If a new session was created, switch to it
      if (res.sessionId && res.sessionId !== currentSessionId) {
        setCurrentSessionId(res.sessionId);
      }
      // Invalidate queries to pick up the new message
      qc.invalidateQueries({ queryKey: SESSIONS_KEY });
      if (res.sessionId) {
        qc.invalidateQueries({ queryKey: sessionKey(res.sessionId) });
      }
    },
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
      sendMessageMut.mutate({ sessionId: currentSessionId, message: text.trim() });
    },
    [currentSessionId, sendMessageMut],
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
    (id) => setCurrentSessionId(id ?? null),
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
