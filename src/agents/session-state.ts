import type {
  AgentPipelineRecord,
  AgentPipelineState,
  AgentProviderDefinition,
  AgentSessionRecord,
  AgentSessionState,
  AgentSessionTurn,
  IssueEntry,
} from "../types.ts";
import {
  now,
  clamp,
  idToSafePath,
  toNumberValue,
} from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import {
  getAgentSessionResource,
  getAgentPipelineResource,
  isStateNotFoundError,
} from "../persistence/store.ts";

export function buildAgentSessionState(
  issue: IssueEntry,
  attempt: number,
  maxTurns: number,
): AgentSessionState {
  const createdAt = now();
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    attempt,
    status: "running",
    startedAt: createdAt,
    updatedAt: createdAt,
    maxTurns,
    turns: [],
    lastPrompt: "",
    lastPromptFile: "",
    lastOutput: "",
    lastCode: null,
    lastDirectiveStatus: "continue",
    lastDirectiveSummary: "",
    nextPrompt: "",
  };
}

export async function loadAgentSessionState(
  sessionKey: string,
  issue: IssueEntry,
  attempt: number,
  maxTurns: number,
): Promise<{ session: AgentSessionState; key: string }> {
  const agentSessionResource = getAgentSessionResource();
  if (agentSessionResource) {
    try {
      const record = await agentSessionResource.get(sessionKey) as AgentSessionRecord;
      if (
        record?.session
        && record.issueId === issue.id
        && record.attempt === attempt
        && Array.isArray(record.session.turns)
      ) {
        return {
          session: {
            ...buildAgentSessionState(issue, attempt, maxTurns),
            ...record.session,
            maxTurns,
            turns: record.session.turns as AgentSessionTurn[],
            updatedAt: now(),
          },
          key: sessionKey,
        };
      }
    } catch (error) {
      if (!isStateNotFoundError(error)) {
        logger.warn(`Failed to load session state for ${issue.id}: ${String(error)}`);
      }
    }
  }

  return { session: buildAgentSessionState(issue, attempt, maxTurns), key: sessionKey };
}

export async function persistAgentSessionState(
  key: string,
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  cycle: number,
  session: AgentSessionState,
): Promise<void> {
  session.updatedAt = now();
  const agentSessionResource = getAgentSessionResource();
  if (!agentSessionResource) return;

  await agentSessionResource.replace(key, {
    id: key,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    attempt: session.attempt,
    cycle,
    provider: provider.provider,
    role: provider.role,
    updatedAt: session.updatedAt,
    session,
  } satisfies AgentSessionRecord);
}

export function buildProviderSessionKey(issue: IssueEntry, attempt: number, provider: AgentProviderDefinition, cycle: number): string {
  return `${idToSafePath(issue.id)}-a${attempt}-${provider.role}-${provider.provider}-c${cycle}`;
}

export function buildPipelineKey(issue: IssueEntry, attempt: number): string {
  return `${idToSafePath(issue.id)}-a${attempt}`;
}

export function getLatestPipelineAttempt(issue: IssueEntry): number {
  if (issue.state === "Blocked" || issue.state === "Cancelled") {
    return Math.max(1, issue.attempts);
  }
  return Math.max(1, issue.attempts + 1);
}

export function stateConfigMaxTurnsFallback(): number {
  return 4;
}

export async function loadAgentPipelineState(
  issue: IssueEntry,
  attempt: number,
  providers: AgentProviderDefinition[],
): Promise<{ pipeline: AgentPipelineState; key: string }> {
  const pipelineKey = buildPipelineKey(issue, attempt);
  const agentPipelineResource = getAgentPipelineResource();

  if (agentPipelineResource) {
    try {
      const record = await agentPipelineResource.get(pipelineKey) as AgentPipelineRecord;
      if (record?.pipeline && record.issueId === issue.id && record.attempt === attempt) {
        return {
          pipeline: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            attempt,
            cycle: Math.max(1, toNumberValue(record.pipeline.cycle, 1)),
            activeIndex: clamp(toNumberValue(record.pipeline.activeIndex, 0), 0, Math.max(0, providers.length - 1)),
            updatedAt: now(),
            history: Array.isArray(record.pipeline.history)
              ? record.pipeline.history.filter((entry): entry is string => typeof entry === "string")
              : [],
          },
          key: pipelineKey,
        };
      }
    } catch (error) {
      if (!isStateNotFoundError(error)) {
        logger.warn(`Failed to load pipeline state for ${issue.id}: ${String(error)}`);
      }
    }
  }

  return {
    pipeline: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt,
      cycle: 1,
      activeIndex: 0,
      updatedAt: now(),
      history: [],
    },
    key: pipelineKey,
  };
}

export async function persistAgentPipelineState(key: string, pipeline: AgentPipelineState): Promise<void> {
  pipeline.updatedAt = now();
  const agentPipelineResource = getAgentPipelineResource();
  if (!agentPipelineResource) return;

  await agentPipelineResource.replace(key, {
    id: key,
    issueId: pipeline.issueId,
    issueIdentifier: pipeline.issueIdentifier,
    attempt: pipeline.attempt,
    updatedAt: pipeline.updatedAt,
    pipeline,
  } satisfies AgentPipelineRecord);
}

export async function loadAgentPipelineSnapshotForIssue(
  issue: IssueEntry,
  providers: AgentProviderDefinition[],
): Promise<AgentPipelineState | null> {
  const attempt = getLatestPipelineAttempt(issue);
  const agentPipelineResource = getAgentPipelineResource();

  if (agentPipelineResource?.list) {
    try {
      const records = await agentPipelineResource.list({
        partition: "byIssueAttempt",
        partitionValues: { issueId: issue.id, attempt },
        limit: 10,
      });
      const record = records
        .map((entry) => entry as AgentPipelineRecord)
        .find((entry) => entry.issueId === issue.id && entry.attempt === attempt && entry.pipeline);
      if (record?.pipeline) {
        return {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          attempt,
          cycle: Math.max(1, toNumberValue(record.pipeline.cycle, 1)),
          activeIndex: clamp(toNumberValue(record.pipeline.activeIndex, 0), 0, Math.max(0, providers.length - 1)),
          updatedAt: now(),
          history: Array.isArray(record.pipeline.history)
            ? record.pipeline.history.filter((entry): entry is string => typeof entry === "string")
            : [],
        };
      }
    } catch (error) {
      logger.warn(`Failed to load partitioned pipeline snapshot for ${issue.id}: ${String(error)}`);
    }
  }

  const loaded = await loadAgentPipelineState(issue, attempt, providers);
  return loaded.pipeline.history.length > 0 ? loaded.pipeline : null;
}

export async function loadAgentSessionSnapshotsForIssue(
  issue: IssueEntry,
  providers: AgentProviderDefinition[],
  pipeline: AgentPipelineState | null,
  _workflowDefinition: null,
): Promise<Array<{ key: string; session: AgentSessionState; provider: string; role: string; cycle: number }>> {
  if (!pipeline) return [];

  const sessions: Array<{ key: string; session: AgentSessionState; provider: string; role: string; cycle: number }> = [];
  const attempt = pipeline.attempt;
  const agentSessionResource = getAgentSessionResource();
  const maxTurns = stateConfigMaxTurnsFallback();

  if (agentSessionResource?.list) {
    try {
      const records = await agentSessionResource.list({
        partition: "byIssueAttempt",
        partitionValues: { issueId: issue.id, attempt },
        limit: Math.max(12, providers.length * Math.max(1, pipeline.cycle) * 2),
      });
      const loadedSessions = records
        .map((entry) => entry as AgentSessionRecord)
        .filter((entry) => entry.issueId === issue.id && entry.attempt === attempt && entry.session && Array.isArray(entry.session.turns));

      for (const record of loadedSessions) {
        if (!record.session.turns.length) continue;
        sessions.push({
          key: record.id,
          session: {
            ...buildAgentSessionState(issue, attempt, maxTurns),
            ...record.session,
            maxTurns,
            turns: record.session.turns as AgentSessionTurn[],
            updatedAt: now(),
          },
          provider: record.provider,
          role: record.role,
          cycle: record.cycle,
        });
      }

      sessions.sort((a, b) => a.cycle !== b.cycle ? a.cycle - b.cycle : a.key.localeCompare(b.key));
      if (sessions.length > 0) return sessions;
    } catch (error) {
      logger.warn(`Failed to load partitioned session snapshots for ${issue.id}: ${String(error)}`);
    }
  }

  for (let cycle = 1; cycle <= pipeline.cycle; cycle += 1) {
    for (const provider of providers) {
      const key = buildProviderSessionKey(issue, attempt, provider, cycle);
      const loaded = await loadAgentSessionState(key, issue, attempt, maxTurns);
      if (loaded.session.turns.length === 0) continue;
      sessions.push({
        key,
        session: loaded.session,
        provider: provider.provider,
        role: provider.role,
        cycle,
      });
    }
  }

  return sessions;
}
