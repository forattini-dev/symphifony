import type { ChatAction, ChatActionType } from "../../types.ts";

const VALID_ACTION_TYPES = new Set<ChatActionType>([
  "create-issue", "retry-issue", "replan-issue", "approve-issue", "merge-issue",
  "start-service", "stop-service", "restart-service",
  "read-file", "read-service-log", "list-issues", "list-services",
]);

const ACTION_BLOCK_RE = /```action\n([\s\S]*?)```/g;

export function parseActionsFromResponse(text: string): ChatAction[] {
  const actions: ChatAction[] = [];

  for (const match of text.matchAll(ACTION_BLOCK_RE)) {
    const raw = match[1]?.trim();
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const type = parsed.type as string;
      if (!VALID_ACTION_TYPES.has(type as ChatActionType)) continue;

      actions.push({
        type: type as ChatActionType,
        payload: (parsed.payload as Record<string, unknown>) ?? {},
      });
    } catch {
      // Skip unparseable blocks
    }
  }

  return actions;
}
