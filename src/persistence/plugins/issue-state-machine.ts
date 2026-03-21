import type { AttemptSummary, IssueEntry, IssueState } from "../../types.ts";
import { S3DB_ISSUE_RESOURCE, TERMINAL_STATES } from "../../concerns/constants.ts";
import { computeDiffStats } from "../../domains/workspace.ts";
import { extractFailureInsights } from "../../agents/failure-analyzer.ts";
import { invalidateMetrics } from "../metrics-cache.ts";
import { markIssueDirty } from "../dirty-tracker.ts";
import { isoWeek, now } from "../../concerns/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── Event emitter callback (set after container init to avoid circular deps) ──
type FsmEventEmitter = (issueId: string, kind: string, message: string) => void;
let fsmEventEmitter: FsmEventEmitter | null = null;

export function setFsmEventEmitter(emitter: FsmEventEmitter | null): void {
  fsmEventEmitter = emitter;
}

/** Emit an event from FSM actions. No-op if container isn't ready yet (early boot). */
function emitFsmEvent(issueId: string, kind: string, message: string): void {
  if (fsmEventEmitter) {
    try { fsmEventEmitter(issueId, kind, message); } catch { /* non-critical */ }
  }
}

// Lazy imports to avoid circular dependency (queue-workers → issue-runner → transition-issue → this)
async function lazyEnqueueForPlanning(issue: IssueEntry): Promise<void> {
  const { enqueueForPlanning } = await import("./queue-workers.ts");
  return enqueueForPlanning(issue);
}

async function lazyEnqueueForExecution(issue: IssueEntry): Promise<void> {
  const { enqueueForExecution } = await import("./queue-workers.ts");
  return enqueueForExecution(issue);
}

async function lazyEnqueueForReview(issue: IssueEntry): Promise<void> {
  const { enqueueForReview } = await import("./queue-workers.ts");
  return enqueueForReview(issue);
}

export const ISSUE_STATE_MACHINE_ID = "issue-lifecycle";

// ── Types ────────────────────────────────────────────────────────────────────

/** Shape injected by StateMachinePlugin into action/guard callbacks. */
type Machine = {
  database: any;
  machineId: string;
  entityId: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function markDirtyAndInvalidate(issueId: string): void {
  markIssueDirty(issueId);
  invalidateMetrics();
}

function resolveIssue(context: Record<string, unknown>): IssueEntry | null {
  return (context.issue as IssueEntry) ?? null;
}

function issueResource(machine: Machine) {
  return machine.database?.resources?.[S3DB_ISSUE_RESOURCE];
}

/** Shared stale-check condition for Running/Reviewing cron triggers. */
const STALE_TIMEOUT_MS = 2_400_000; // 40 minutes
async function isStaleIssue(context: Record<string, unknown>, _entityId: string): Promise<boolean> {
  const issue = resolveIssue(context);
  if (!issue) return false;
  return Date.now() - Date.parse(issue.updatedAt) > STALE_TIMEOUT_MS;
}

// ── FSM config: states, transitions, guards, actions, triggers ──────────────

export const issueStateMachineConfig = {
  persistTransitions: true,
  workerId: `fifony-${process.pid}`,
  lockTimeout: 5_000,
  lockTTL: 30,

  stateMachines: {
    [ISSUE_STATE_MACHINE_ID]: {
      resource: S3DB_ISSUE_RESOURCE,
      stateField: "state",
      initialState: "Planning",
      autoCleanup: false,

      states: {
        Planning: {
          on: { PLANNED: "PendingApproval", CANCEL: "Cancelled" },
          entry: "onEnterPlanning",
        },
        PendingApproval: {
          on: { QUEUE: "Queued", REPLAN: "Planning", CANCEL: "Cancelled" },
          entry: "onEnterPendingApproval",
        },
        Queued: {
          on: { RUN: "Running" },
          entry: "onEnterQueued",
        },
        Running: {
          on: { REVIEW: "Reviewing", REQUEUE: "Queued", BLOCK: "Blocked" },
          guards: { BLOCK: "requireBlockReason" },
          triggers: [{
            type: "cron" as const,
            cron: "*/10 * * * *",
            sendEvent: "BLOCK",
            condition: isStaleIssue,
          }],
        },
        Reviewing: {
          on: { REVIEWED: "PendingDecision", REQUEUE: "Queued", BLOCK: "Blocked" },
          entry: "onEnterReviewing",
          guards: { BLOCK: "requireBlockReason" },
          triggers: [{
            type: "cron" as const,
            cron: "*/10 * * * *",
            sendEvent: "BLOCK",
            condition: isStaleIssue,
          }],
        },
        PendingDecision: {
          on: { APPROVE: "Approved", REQUEUE: "Queued", REPLAN: "Planning", CANCEL: "Cancelled" },
        },
        Blocked: {
          on: { UNBLOCK: "Queued", REPLAN: "Planning", CANCEL: "Cancelled" },
          entry: "onEnterBlocked",
        },
        Approved: {
          on: { MERGE: "Merged", REOPEN: "Planning" },
          entry: "onEnterApproved",
        },
        Merged: {
          on: { REOPEN: "Planning" },
          type: "final" as const,
          entry: "onEnterMerged",
        },
        Cancelled: {
          on: { REOPEN: "Planning" },
          type: "final" as const,
          entry: "onEnterCancelled",
        },
      },
    },
  },

  // ── Actions: (context, event, machine) ──────────────────────────────────
  // context = payload from send()
  // event   = event name ("PLANNED", "BLOCK", etc.)
  // machine = { database, machineId, entityId }
  //
  // Actions only mutate the in-memory issue + fire side effects (enqueue, s3db patch).
  // Dirty tracking + metrics invalidation is done once in executeTransition() after send().

  actions: {
    onEnterPlanning: async (context: Record<string, unknown>, _event: string, _machine: Machine) => {
      const issue = resolveIssue(context);
      if (issue) {
        issue.planningStatus = "idle";
        issue.planningError = undefined;
        issue.nextRetryAt = undefined;
        issue.lastError = undefined;
        emitFsmEvent(issue.id, "state", `${issue.identifier} entered Planning.`);
        lazyEnqueueForPlanning(issue).catch(() => {});
      }
    },

    onEnterPendingApproval: async (context: Record<string, unknown>, _event: string, _machine: Machine) => {
      const issue = resolveIssue(context);
      if (issue) {
        issue.nextRetryAt = undefined;
        issue.lastError = undefined;
        emitFsmEvent(issue.id, "state", `Plan ready — ${issue.identifier} awaiting approval.`);
        // No auto-queue hack — callers (approve command) handle PendingApproval → Queued explicitly
      }
    },

    onEnterQueued: async (context: Record<string, unknown>, _event: string, _machine: Machine) => {
      const issue = resolveIssue(context);
      if (issue) {
        // Archive previous attempt summary before clearing lastError
        if (issue.attempts > 0 && issue.lastError) {
          // Read the full output from the most recent stdout file for better analysis
          let fullOutput = "";
          let outputFile: string | undefined;
          if (issue.workspacePath) {
            try {
              const outputsDir = join(issue.workspacePath, "outputs");
              if (existsSync(outputsDir)) {
                const files = readdirSync(outputsDir)
                  .filter((f: string) => f.endsWith(".stdout.log"))
                  .sort((a: string, b: string) => {
                    try { return statSync(join(outputsDir, b)).mtimeMs - statSync(join(outputsDir, a)).mtimeMs; }
                    catch { return 0; }
                  });
                if (files.length > 0) {
                  outputFile = files[0];
                  try { fullOutput = readFileSync(join(outputsDir, files[0]), "utf8"); } catch {}
                }
              }
            } catch {}
          }

          // Analyze the failure output for structured insights
          const analysisSource = fullOutput || issue.commandOutputTail || issue.lastError || "";
          const failureInsight = extractFailureInsights(analysisSource, issue.commandExitCode);

          const summary: AttemptSummary = {
            planVersion: issue.planVersion ?? 1,
            executeAttempt: issue.executeAttempt ?? 1,
            phase: issue.lastFailedPhase ?? undefined,
            error: failureInsight.rootCause || (issue.lastError ?? "").slice(0, 500),
            outputTail: (issue.commandOutputTail ?? "").slice(0, 500),
            outputFile,
            timestamp: now(),
            insight: {
              errorType: failureInsight.errorType,
              rootCause: failureInsight.rootCause,
              failedCommand: failureInsight.failedCommand,
              filesInvolved: failureInsight.filesInvolved,
              suggestion: failureInsight.suggestion,
            },
          };
          const prev = issue.previousAttemptSummaries ?? [];
          issue.previousAttemptSummaries = [...prev.slice(-(2)), summary].slice(-3);
        }

        issue.nextRetryAt = undefined;
        issue.lastError = undefined;
        issue.lastFailedPhase = undefined;
        logger.info({ issueId: issue.id, identifier: issue.identifier }, "[FSM] onEnterQueued — enqueuing for execution");
        emitFsmEvent(issue.id, "state", `${issue.identifier} queued for execution.`);
        lazyEnqueueForExecution(issue).catch((err) => {
          logger.error({ err, issueId: issue.id }, "[FSM] onEnterQueued — enqueue FAILED");
        });
      }
    },

    onEnterReviewing: async (context: Record<string, unknown>, _event: string, machine: Machine) => {
      const issue = resolveIssue(context);
      const ts = new Date().toISOString();
      if (issue) {
        issue.reviewingAt = ts;
        issue.lastError = undefined;
        emitFsmEvent(issue.id, "state", `${issue.identifier} moved to Reviewing.`);
        lazyEnqueueForReview(issue).catch(() => {});
      }
      const res = issueResource(machine);
      if (res) {
        res.patch(machine.entityId, { reviewingAt: ts }).catch(() => {});
      }
    },

    onEnterBlocked: async (context: Record<string, unknown>, _event: string, _machine: Machine) => {
      const issue = resolveIssue(context);
      const note = typeof context.note === "string" ? context.note : "Blocked";
      if (issue) {
        issue.lastError = note;
        // nextRetryAt is set by the caller before transition (they know the delay)
        emitFsmEvent(issue.id, "error", `${issue.identifier} blocked: ${note}`);
      }
    },

    onEnterApproved: async (context: Record<string, unknown>, _event: string, _machine: Machine) => {
      const issue = resolveIssue(context);
      if (issue) {
        // Approved = waiting for merge. Not terminal yet.
        issue.nextRetryAt = undefined;
        issue.lastError = undefined;
        // Pre-compute diff stats for display (but EC add() happens only on Merged)
        if (!issue.linesAdded && !issue.linesRemoved && issue.baseBranch && issue.branchName) {
          computeDiffStats(issue);
        }
        emitFsmEvent(issue.id, "state", `${issue.identifier} approved — waiting for merge.`);
      }
    },

    onEnterMerged: async (context: Record<string, unknown>, _event: string, machine: Machine) => {
      const issue = resolveIssue(context);
      const ts = new Date().toISOString();
      const week = isoWeek();
      if (issue) {
        // Ensure diff stats are computed
        if (!issue.linesAdded && !issue.linesRemoved && issue.baseBranch && issue.branchName) {
          computeDiffStats(issue);
        }
        issue.completedAt = ts;
        issue.terminalWeek = week;
        if (!issue.mergedAt) issue.mergedAt = ts;
        issue.nextRetryAt = undefined;
        issue.lastError = undefined;
        emitFsmEvent(issue.id, "state", `${issue.identifier} merged.`);
      }
      const res = issueResource(machine);
      if (res) {
        res.patch(machine.entityId, {
          completedAt: ts, terminalWeek: week, mergedAt: issue?.mergedAt ?? ts,
          nextRetryAt: undefined, lastError: undefined,
          linesAdded: issue?.linesAdded, linesRemoved: issue?.linesRemoved, filesChanged: issue?.filesChanged,
          branchName: issue?.branchName, workspacePath: issue?.workspacePath, worktreePath: issue?.worktreePath,
        }).catch(() => {});

        // EC: add() raw diff stats at merge time (the moment code churn is finalized)
        const add = (res as any).add;
        if (typeof add === "function" && issue) {
          try {
            if (issue.linesAdded)   await add.call(res, machine.entityId, "linesAdded", issue.linesAdded);
            if (issue.linesRemoved) await add.call(res, machine.entityId, "linesRemoved", issue.linesRemoved);
            if (issue.filesChanged) await add.call(res, machine.entityId, "filesChanged", issue.filesChanged);
            logger.info({ issueId: issue.id, linesAdded: issue.linesAdded, linesRemoved: issue.linesRemoved, filesChanged: issue.filesChanged }, "[FSM] EC add() for diff stats on merge");
          } catch (err) {
            logger.warn({ err: String(err), issueId: issue?.id }, "[FSM] EC add() failed for diff stats");
          }
        }
      }
    },

    onEnterCancelled: async (context: Record<string, unknown>, _event: string, machine: Machine) => {
      const issue = resolveIssue(context);
      const ts = new Date().toISOString();
      const week = isoWeek();
      if (issue) {
        issue.completedAt = ts;
        issue.terminalWeek = week;
        issue.nextRetryAt = undefined;
        emitFsmEvent(issue.id, "state", `${issue.identifier} cancelled.`);
      }
      const res = issueResource(machine);
      if (res) {
        res.patch(machine.entityId, {
          completedAt: ts, terminalWeek: week, nextRetryAt: undefined,
        }).catch(() => {});
      }
    },
  },

  // ── Guards: (context, event, machine) ───────────────────────────────────

  guards: {
    requireBlockReason: async (context: Record<string, unknown>, _event: string, _machine: Machine) => {
      return typeof context.note === "string" && context.note.trim().length > 0;
    },
  },
};

// ── Event mapping: FSM event name → target state ────────────────────────────

const EVENT_TO_STATE: Record<string, IssueState> = {
  PLANNED: "PendingApproval",
  QUEUE: "Queued",
  RUN: "Running",
  REVIEW: "Reviewing",
  REVIEWED: "PendingDecision",
  APPROVE: "Approved",
  MERGE: "Merged",
  CANCEL: "Cancelled",
  BLOCK: "Blocked",
  UNBLOCK: "Queued",
  REPLAN: "Planning",
  REQUEUE: "Queued",
  REOPEN: "Planning",
};

export function eventToTargetState(event: string): IssueState | undefined {
  return EVENT_TO_STATE[event];
}

// ── State → valid events (for BFS path finding) ─────────────────────────────

function getStatesFromConfig(): Record<string, Record<string, string>> {
  const machine = issueStateMachineConfig.stateMachines[ISSUE_STATE_MACHINE_ID];
  const result: Record<string, Record<string, string>> = {};
  for (const [state, def] of Object.entries(machine.states)) {
    result[state] = (def as { on?: Record<string, string> }).on ?? {};
  }
  return result;
}

/**
 * Returns the state machine transitions map: { state: [reachable target states] }
 * This is the single source of truth — the frontend should consume this.
 */
export function getStateMachineTransitions(): Record<string, string[]> {
  const edges = getStatesFromConfig();
  const result: Record<string, string[]> = {};
  for (const [state, events] of Object.entries(edges)) {
    const targets = [...new Set(Object.values(events))];
    result[state] = targets;
  }
  return result;
}

// ── BFS path finder (event sequence from→to) ────────────────────────────────

export function findIssueStateMachineTransitionPath(
  _machineDefinition: unknown,
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [];

  const edges = getStatesFromConfig();
  if (!edges[from] || !edges[to]) return null;

  const queue: string[] = [from];
  const previousState = new Map<string, string>();
  const previousEvent = new Map<string, string>();
  previousState.set(from, "");

  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i]!;
    const transitions = edges[current];
    if (!transitions) continue;

    for (const [evt, next] of Object.entries(transitions)) {
      if (previousState.has(next)) continue;

      previousState.set(next, current);
      previousEvent.set(next, evt);

      if (next === to) {
        const events: string[] = [];
        let cursor = next;
        while (cursor !== from) {
          const prev = previousState.get(cursor);
          const e = previousEvent.get(cursor);
          if (!prev || !e) return null;
          events.unshift(e);
          cursor = prev;
        }
        return events;
      }

      queue.push(next);
    }
  }

  return null;
}

// ── Resource-level state API accessor ───────────────────────────────────────
// When the plugin is attached with `resource: S3DB_ISSUE_RESOURCE`, the resource
// gains `resource.state.*` shortcuts:
//   resource.state.send(entityId, event, context)
//   resource.state.get(entityId)
//   resource.state.canTransition(entityId, event)
//   resource.state.history(entityId, options?)
//   resource.state.initialize(entityId, context?)
//   resource.state.getValidEvents(entityId)
//   resource.state.delete(entityId)

type ResourceStateApi = {
  send: (entityId: string, event: string, context?: Record<string, unknown>) => Promise<unknown>;
  get: (entityId: string) => Promise<string>;
  canTransition: (entityId: string, event: string) => Promise<boolean>;
  history: (entityId: string, options?: { limit?: number; offset?: number }) => Promise<unknown[]>;
  initialize: (entityId: string, context?: Record<string, unknown>) => Promise<unknown>;
  getValidEvents: (entityId: string) => Promise<string[]>;
  delete: (entityId: string) => Promise<void>;
};

let issueResourceStateApi: ResourceStateApi | null = null;

export function setIssueResourceStateApi(api: ResourceStateApi | null): void {
  issueResourceStateApi = api;
}

export function getIssueResourceStateApi(): ResourceStateApi | null {
  return issueResourceStateApi;
}

// ── Plugin-level accessor (fallback when resource.state is not available) ────

export type IssueStateMachinePluginLike = {
  getMachineDefinition?: (machineId: string) => unknown;
  getState?: (machineId: string, entityId: string) => Promise<string>;
  getValidEvents?: (machineId: string, stateOrEntityId: string) => Promise<string[]>;
  initializeEntity?: (machineId: string, entityId: string, context?: Record<string, unknown>) => Promise<unknown>;
  send?: (machineId: string, entityId: string, event: string, context?: Record<string, unknown>) => Promise<unknown>;
  getTransitionHistory?: (machineId: string, entityId: string, options?: { limit?: number; offset?: number }) => Promise<unknown[]>;
  visualize?: (machineId: string) => string;
  waitForPendingEvents?: (timeout?: number) => Promise<void>;
};

let issueStateMachinePlugin: IssueStateMachinePluginLike | null = null;

export function setIssueStateMachinePlugin(plugin: IssueStateMachinePluginLike | null): void {
  issueStateMachinePlugin = plugin;
}

export function getIssueStateMachinePlugin(): IssueStateMachinePluginLike | null {
  return issueStateMachinePlugin;
}

export function getIssueStateMachineDefinition(): unknown {
  return issueStateMachinePlugin?.getMachineDefinition?.(ISSUE_STATE_MACHINE_ID)
    ?? issueStateMachineConfig.stateMachines[ISSUE_STATE_MACHINE_ID];
}

export function getIssueStateMachineInitialState(): string {
  return issueStateMachineConfig.stateMachines[ISSUE_STATE_MACHINE_ID].initialState;
}

// ── Domain transition executor ──────────────────────────────────────────────
// Primary path:  resource.state.send(entityId, event, context)
// Fallback:      plugin.send(machineId, entityId, event, context)
// Last resort:   local validation + guard + action execution
//
// The plugin handles: lock → validate → guard → persist state/history → entry action
// After send(), we apply universal in-memory effects (state, updatedAt, history, dirty).

export async function executeTransition(
  issue: IssueEntry,
  event: string,
  context: Record<string, unknown> = {},
): Promise<{ previousState: IssueState }> {
  const ts = new Date().toISOString();
  const previous = issue.state;
  const targetState = eventToTargetState(event);

  if (!targetState) {
    throw new Error(`Unknown FSM event '${event}' for issue ${issue.id}.`);
  }

  const resourceApi = getIssueResourceStateApi();
  const plugin = getIssueStateMachinePlugin();
  const sendContext = { ...context, issue };

  if (resourceApi) {
    // ── Primary: resource.state.send(entityId, event, context)
    try {
      await resourceApi.send(issue.id, event, sendContext);
    } catch (err) {
      if (String(err).includes("not found") || String(err).includes("not initialized")) {
        await resourceApi.initialize(issue.id, { issue, state: previous });
        await resourceApi.send(issue.id, event, sendContext);
      } else {
        throw err;
      }
    }
  } else if (plugin?.send) {
    // ── Fallback: plugin.send(machineId, entityId, event, context)
    try {
      await plugin.send(ISSUE_STATE_MACHINE_ID, issue.id, event, sendContext);
    } catch (err) {
      if (plugin.initializeEntity && String(err).includes("not found")) {
        await plugin.initializeEntity(ISSUE_STATE_MACHINE_ID, issue.id, { issue, state: previous });
        await plugin.send(ISSUE_STATE_MACHINE_ID, issue.id, event, sendContext);
      } else {
        throw err;
      }
    }
  } else {
    // ── Last resort: local validation + guard + action (no locking, no history)
    if (previous !== targetState) {
      const edges = getStatesFromConfig();
      const stateTransitions = edges[previous];
      if (!stateTransitions || !stateTransitions[event]) {
        throw new Error(`State machine does not allow event '${event}' from '${previous}' for issue ${issue.id}.`);
      }
    }

    const stateDef = issueStateMachineConfig.stateMachines[ISSUE_STATE_MACHINE_ID]
      .states[previous as keyof typeof issueStateMachineConfig.stateMachines[typeof ISSUE_STATE_MACHINE_ID]["states"]];
    if (stateDef && "guards" in stateDef && (stateDef as any).guards?.[event]) {
      const guardName = (stateDef as any).guards[event] as string;
      const guardFn = (issueStateMachineConfig.guards as Record<string, (ctx: any, evt: any, m: any) => Promise<boolean>>)[guardName];
      if (guardFn) {
        const allowed = await guardFn(sendContext, event, { database: null, machineId: ISSUE_STATE_MACHINE_ID, entityId: issue.id });
        if (!allowed) {
          throw new Error(`Guard '${guardName}' rejected event '${event}' for issue ${issue.id}.`);
        }
      }
    }

    const targetDef = issueStateMachineConfig.stateMachines[ISSUE_STATE_MACHINE_ID]
      .states[targetState as keyof typeof issueStateMachineConfig.stateMachines[typeof ISSUE_STATE_MACHINE_ID]["states"]];
    if (targetDef && "entry" in targetDef && typeof (targetDef as any).entry === "string") {
      const actionName = (targetDef as any).entry as string;
      const actionFn = (issueStateMachineConfig.actions as Record<string, (ctx: any, evt: any, m: any) => Promise<void>>)[actionName];
      if (actionFn) {
        await actionFn(sendContext, event, { database: null, machineId: ISSUE_STATE_MACHINE_ID, entityId: issue.id });
      }
    }
  }

  // ── Universal in-memory effects (applied once, regardless of path taken)
  issue.state = targetState;
  issue.updatedAt = ts;
  const note = typeof context.note === "string" ? context.note : `${event}: ${previous} → ${targetState}`;
  issue.history.push(`[${ts}] ${note}`);

  if (TERMINAL_STATES.has(previous) && !TERMINAL_STATES.has(targetState)) {
    issue.terminalWeek = "";
  }

  markDirtyAndInvalidate(issue.id);

  return { previousState: previous };
}

// ── Convenience: get transition history ─────────────────────────────────────

export async function getIssueTransitionHistory(
  issueId: string,
  options?: { limit?: number; offset?: number },
): Promise<unknown[]> {
  const resourceApi = getIssueResourceStateApi();
  if (resourceApi?.history) {
    try { return await resourceApi.history(issueId, options); } catch { /* fall through */ }
  }
  const plugin = getIssueStateMachinePlugin();
  if (plugin?.getTransitionHistory) {
    try { return await plugin.getTransitionHistory(ISSUE_STATE_MACHINE_ID, issueId, options); } catch { /* */ }
  }
  return [];
}

// ── Convenience: check if transition is valid ───────────────────────────────

export async function canTransitionIssue(issueId: string, event: string): Promise<boolean> {
  const resourceApi = getIssueResourceStateApi();
  if (resourceApi?.canTransition) {
    try { return await resourceApi.canTransition(issueId, event); } catch { /* fall through */ }
  }
  return false;
}

// ── Convenience: visualize the machine as GraphViz DOT ──────────────────────

export function visualizeStateMachine(): string | null {
  const plugin = getIssueStateMachinePlugin();
  if (!plugin?.visualize) return null;
  return plugin.visualize(ISSUE_STATE_MACHINE_ID);
}
