import type { IssuePlan } from "../../types.ts";
import { now } from "../../concerns/helpers.ts";
import { replacePersistedSetting, getSettingStateResource } from "../../persistence/store.ts";
import { logger } from "../../concerns/logger.ts";

// ── Planning session persistence ─────────────────────────────────────────────

export type PlanningSessionStatus = "input" | "planning" | "done" | "error" | "interrupted";

export type PlanningSessionUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  promptChars: number;
  outputChars: number;
  durationMs: number;
};

export type PlanningSession = {
  title: string;
  description: string;
  status: PlanningSessionStatus;
  plan: IssuePlan | null;
  error: string | null;
  pid: number | null;
  provider: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  /** Live progress: output bytes received so far (updated during planning) */
  outputBytes: number;
  /** Token usage extracted after planning completes */
  usage: PlanningSessionUsage | null;
};

const PLANNING_SETTING_ID = "planning:active";

function emptySession(): PlanningSession {
  return {
    title: "", description: "", status: "input",
    plan: null, error: null, pid: null, provider: null,
    startedAt: null, completedAt: null, updatedAt: now(),
    outputBytes: 0, usage: null,
  };
}

export async function persistSession(session: PlanningSession): Promise<void> {
  session.updatedAt = now();
  try {
    await replacePersistedSetting({
      id: PLANNING_SETTING_ID,
      scope: "runtime",
      value: session,
      source: "system",
      updatedAt: session.updatedAt,
    });
  } catch (error) {
    logger.warn(`Failed to persist planning session: ${String(error)}`);
  }
}

export async function loadPlanningSession(): Promise<PlanningSession | null> {
  const resource = getSettingStateResource();
  if (!resource) return null;
  try {
    const record = await resource.get(PLANNING_SETTING_ID);
    if (record?.value && typeof record.value === "object") {
      return record.value as PlanningSession;
    }
  } catch {
    // not found
  }
  return null;
}

export async function clearPlanningSession(): Promise<void> {
  await persistSession(emptySession());
}

/** Check on boot if a planning process is still alive. */
export async function recoverPlanningSession(): Promise<void> {
  const session = await loadPlanningSession();
  if (!session || session.status !== "planning") return;

  if (session.pid) {
    let alive = false;
    try { process.kill(session.pid, 0); alive = true; } catch {}

    if (alive) {
      logger.info(`Planning process still alive (PID ${session.pid}), keeping status.`);
      return;
    }
  }

  // Process died — mark as interrupted
  session.status = "interrupted";
  session.error = "Planning process was interrupted by server restart.";
  session.pid = null;
  await persistSession(session);
  logger.info("Planning session marked as interrupted (process not found).");
}
