import type { ChatSessionMeta, ChatTurn } from "../../types.ts";
import { getAgentSessionResource } from "../../persistence/store.ts";
import { now } from "../../concerns/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { randomUUID } from "node:crypto";

const CHAT_PREFIX = "chat-";

function newSessionId(): string {
  return `${CHAT_PREFIX}${randomUUID()}`;
}

export async function createChatSession(
  provider: string,
  name?: string,
): Promise<ChatSessionMeta> {
  const id = newSessionId();
  const ts = now();
  const session: ChatSessionMeta = {
    id,
    name: name || `Chat ${new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
    status: "active",
    provider,
    turns: [],
    createdAt: ts,
    updatedAt: ts,
  };

  const resource = getAgentSessionResource();
  if (!resource) throw new Error("Agent session resource not initialized.");

  await resource.replace(id, {
    id,
    issueId: "",
    issueIdentifier: "",
    attempt: 0,
    cycle: 0,
    provider,
    role: "chat",
    updatedAt: ts,
    session: session as unknown as Record<string, unknown>,
  });

  logger.debug({ id, name: session.name }, "[Chat] Session created");
  return session;
}

export async function loadChatSession(id: string): Promise<ChatSessionMeta | null> {
  const resource = getAgentSessionResource();
  if (!resource) return null;

  try {
    const record = await resource.get(id) as Record<string, unknown> | null;
    if (!record?.session) return null;
    const meta = record.session as unknown as ChatSessionMeta;
    // Ensure the id field is consistent
    meta.id = id;
    return meta;
  } catch {
    return null;
  }
}

export async function persistChatSession(session: ChatSessionMeta): Promise<void> {
  const resource = getAgentSessionResource();
  if (!resource) return;

  session.updatedAt = now();

  await resource.replace(session.id, {
    id: session.id,
    issueId: "",
    issueIdentifier: "",
    attempt: 0,
    cycle: 0,
    provider: session.provider,
    role: "chat",
    updatedAt: session.updatedAt,
    session: session as unknown as Record<string, unknown>,
  });
}

export async function listChatSessions(): Promise<ChatSessionMeta[]> {
  const resource = getAgentSessionResource();
  if (!resource?.list) return [];

  try {
    const records = await resource.list({ limit: 100 });
    return records
      .filter((r: Record<string, unknown>) =>
        typeof r.id === "string" && r.id.startsWith(CHAT_PREFIX) && r.session,
      )
      .map((r: Record<string, unknown>) => {
        const meta = r.session as unknown as ChatSessionMeta;
        meta.id = r.id as string;
        return meta;
      })
      .sort((a: ChatSessionMeta, b: ChatSessionMeta) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (err) {
    logger.warn({ err }, "[Chat] Failed to list sessions");
    return [];
  }
}

export async function deleteChatSession(id: string): Promise<boolean> {
  const resource = getAgentSessionResource();
  if (!resource) return false;

  try {
    // Replace with a tombstone (s3db doesn't have a delete — replace with empty)
    await resource.replace(id, {
      id,
      issueId: "",
      issueIdentifier: "",
      attempt: 0,
      cycle: 0,
      provider: "",
      role: "chat",
      updatedAt: now(),
      session: { id, status: "archived", turns: [], deleted: true } as unknown as Record<string, unknown>,
    });
    return true;
  } catch {
    return false;
  }
}

export function appendTurn(session: ChatSessionMeta, turn: Omit<ChatTurn, "timestamp">): void {
  session.turns.push({
    ...turn,
    timestamp: now(),
  });
}
