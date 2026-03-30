import type { RuntimeState, ChatAction } from "../types.ts";
import type { RouteRegistrar } from "./http.ts";
import { logger } from "../concerns/logger.ts";
import { toStringValue } from "../concerns/helpers.ts";
import {
  createChatSession,
  loadChatSession,
  persistChatSession,
  listChatSessions,
  deleteChatSession,
  appendTurn,
} from "../agents/chat/chat-session.ts";
import { buildGlobalChatPrompt } from "../agents/chat/chat-prompt.ts";
import { parseActionsFromResponse } from "../agents/chat/action-parser.ts";
import { executeChatAction } from "../agents/chat/action-executor.ts";

// Reuse the one-shot runner and provider resolution from issue-chat
import { chatWithIssue } from "../agents/planning/issue-chat.ts";

export function registerChatRoutes(
  app: RouteRegistrar,
  state: RuntimeState,
): void {
  // ── Session CRUD ────────────────────────────────────────────────────

  app.get("/api/chat/sessions", async (c) => {
    try {
      const sessions = await listChatSessions();
      return c.json({ ok: true, sessions });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/chat/sessions", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : undefined;
      const session = await createChatSession(state.config.agentProvider, name);
      return c.json({ ok: true, session });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/chat/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ ok: false, error: "Session id is required." }, 400);
    try {
      const session = await loadChatSession(id);
      if (!session) return c.json({ ok: false, error: "Session not found." }, 404);
      return c.json({ ok: true, session });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.delete("/api/chat/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ ok: false, error: "Session id is required." }, 400);
    try {
      const deleted = await deleteChatSession(id);
      return c.json({ ok: true, deleted });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.patch("/api/chat/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!id) return c.json({ ok: false, error: "Session id is required." }, 400);
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return c.json({ ok: false, error: "Name is required." }, 400);
      const session = await loadChatSession(id);
      if (!session) return c.json({ ok: false, error: "Session not found." }, 404);
      session.name = name;
      await persistChatSession(session);
      return c.json({ ok: true, session });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Chat message ────────────────────────────────────────────────────

  app.post("/api/chat", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const message = toStringValue(body.message, "").trim();
      if (!message) return c.json({ ok: false, error: "Message is required." }, 400);

      const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;

      // Load or create session
      let session = sessionId ? await loadChatSession(sessionId) : null;
      if (!session) {
        session = await createChatSession(state.config.agentProvider);
      }

      // Append user turn
      appendTurn(session, { role: "user", content: message });

      // Build full prompt: system + history + user message
      const systemPrompt = buildGlobalChatPrompt(state);

      // Build conversation history for the one-shot runner
      const history = session.turns
        .filter((t) => t.role === "user" || t.role === "assistant")
        .slice(0, -1) // exclude the just-appended user message
        .map((t) => ({ role: t.role as "user" | "assistant", content: t.content }));

      // Use the existing chatWithIssue pattern but with global context
      const result = await chatWithIssue(
        {
          issueId: "global-chat",
          title: "Global Chat",
          description: systemPrompt,
          plan: null,
          message,
          history,
        },
        state.config,
      );

      // Parse actions from the response
      const actions = parseActionsFromResponse(result.response);

      // Append assistant turn
      appendTurn(session, {
        role: "assistant",
        content: result.response,
        actions: actions.length > 0 ? actions : undefined,
      });

      // Update provider info
      session.provider = result.provider;

      // Persist
      await persistChatSession(session);

      logger.info(
        { sessionId: session.id, provider: result.provider, actions: actions.length },
        "[Chat] Message processed",
      );

      return c.json({
        ok: true,
        response: result.response,
        actions,
        sessionId: session.id,
        sessionName: session.name,
        provider: result.provider,
      });
    } catch (err) {
      logger.error({ err }, "[Chat] POST /api/chat failed");
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Execute single action ───────────────────────────────────────────

  app.post("/api/chat/action", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      const action = body.action as ChatAction | undefined;

      if (!action?.type) {
        return c.json({ ok: false, error: "Action with type is required." }, 400);
      }

      const result = await executeChatAction(action, state);

      // If session provided, append a system turn documenting the action result
      if (sessionId) {
        const session = await loadChatSession(sessionId);
        if (session) {
          appendTurn(session, {
            role: "system",
            content: result.ok
              ? `Action \`${action.type}\` succeeded: ${JSON.stringify(result.result)}`
              : `Action \`${action.type}\` failed: ${result.error}`,
          });
          await persistChatSession(session);
        }
      }

      return c.json({ ok: result.ok, result: result.result, error: result.error });
    } catch (err) {
      logger.error({ err }, "[Chat] POST /api/chat/action failed");
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
