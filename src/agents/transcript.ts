/**
 * Transcript recording — JSONL per execution attempt.
 *
 * Inspired by Claude Code's sidechain transcript system.
 * Each agent turn appends a line to `.fifony/transcripts/{issueId}/v{plan}a{attempt}.jsonl`.
 * Useful for debugging, auditing, and intelligent retry context selection.
 */
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "../concerns/constants.ts";
import { logger } from "../concerns/logger.ts";
import type { AgentSessionTurn, IssueEntry } from "../types.ts";

const TRANSCRIPTS_ROOT = join(STATE_ROOT, "transcripts");

export type TranscriptEntry = {
  ts: string;
  turn: number;
  role: string;
  model?: string;
  provider?: string;
  directiveStatus?: string;
  directiveSummary?: string;
  exitCode: number | null;
  success: boolean;
  durationMs?: number;
  tokens?: {
    input: number;
    output: number;
    total: number;
  };
  toolsUsed?: string[];
  skillsUsed?: string[];
  agentsUsed?: string[];
  commandsRun?: string[];
  outputPreview: string;
  contextPct?: number | null;
};

function transcriptDir(issueId: string): string {
  return join(TRANSCRIPTS_ROOT, issueId);
}

function transcriptFile(issueId: string, planVersion: number, attempt: number): string {
  return join(transcriptDir(issueId), `v${planVersion}a${attempt}.jsonl`);
}

/** Append a single turn entry to the transcript JSONL file. */
export function recordTranscriptTurn(
  issue: IssueEntry,
  turn: AgentSessionTurn,
  provider?: string,
): void {
  try {
    const dir = transcriptDir(issue.id);
    mkdirSync(dir, { recursive: true });

    const pv = issue.planVersion ?? 1;
    const ea = issue.executeAttempt ?? 1;
    const filePath = transcriptFile(issue.id, pv, ea);

    const outputPreview = turn.output.length > 500
      ? turn.output.slice(-500)
      : turn.output;

    const entry: TranscriptEntry = {
      ts: turn.completedAt || turn.startedAt,
      turn: turn.turn,
      role: turn.role || "unknown",
      model: turn.model,
      provider,
      directiveStatus: turn.directiveStatus,
      directiveSummary: turn.directiveSummary,
      exitCode: turn.code,
      success: turn.success,
      tokens: turn.tokenUsage
        ? {
            input: turn.tokenUsage.inputTokens,
            output: turn.tokenUsage.outputTokens,
            total: turn.tokenUsage.totalTokens,
          }
        : undefined,
      toolsUsed: turn.toolsUsed,
      skillsUsed: turn.skillsUsed,
      agentsUsed: turn.agentsUsed,
      commandsRun: turn.commandsRun,
      outputPreview,
    };

    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    logger.warn({ err: String(err), issueId: issue.id }, "[Transcript] Failed to record turn");
  }
}

/** Read all transcript entries for a specific execution attempt. */
export function readTranscript(
  issueId: string,
  planVersion: number,
  attempt: number,
): TranscriptEntry[] {
  const filePath = transcriptFile(issueId, planVersion, attempt);
  if (!existsSync(filePath)) return [];
  try {
    const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    return lines.map((line) => JSON.parse(line) as TranscriptEntry);
  } catch (err) {
    logger.warn({ err: String(err), issueId }, "[Transcript] Failed to read transcript");
    return [];
  }
}

/** Read all transcripts for an issue (all plan versions and attempts). */
export function readAllTranscripts(issueId: string): Record<string, TranscriptEntry[]> {
  const dir = transcriptDir(issueId);
  if (!existsSync(dir)) return {};
  try {
    const { readdirSync } = require("node:fs");
    const files = (readdirSync(dir) as string[]).filter((f: string) => f.endsWith(".jsonl"));
    const result: Record<string, TranscriptEntry[]> = {};
    for (const file of files) {
      const key = file.replace(".jsonl", "");
      const lines = readFileSync(join(dir, file), "utf8").trim().split("\n").filter(Boolean);
      result[key] = lines.map((line) => JSON.parse(line) as TranscriptEntry);
    }
    return result;
  } catch (err) {
    logger.warn({ err: String(err), issueId }, "[Transcript] Failed to read all transcripts");
    return {};
  }
}

/** Get a summary of all transcripts for an issue (for API consumption). */
export function getTranscriptSummary(issueId: string): {
  attempts: Array<{
    key: string;
    turns: number;
    totalTokens: number;
    success: boolean;
    lastRole?: string;
  }>;
} {
  const all = readAllTranscripts(issueId);
  const attempts = Object.entries(all).map(([key, entries]) => {
    const totalTokens = entries.reduce((sum, e) => sum + (e.tokens?.total ?? 0), 0);
    const last = entries[entries.length - 1];
    return {
      key,
      turns: entries.length,
      totalTokens,
      success: last?.success ?? false,
      lastRole: last?.role,
    };
  });
  return { attempts };
}
