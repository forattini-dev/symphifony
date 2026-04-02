import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptSummary } from "../types.ts";
import { now } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import {
  loadAttemptManifest,
  traceDir,
  type AttemptOutcome,
  type CrossAttemptAnalysis,
} from "./trace-bundle.ts";

const CROSS_ATTEMPT_FILE = "cross-attempt.json";

type AttemptRecord = {
  planVersion: number;
  executeAttempt: number;
  summary?: AttemptSummary;
  failureType?: string;
  changedFiles: string[];
  diffStatSize: number;
  outcome: AttemptOutcome;
  nextIssueState?: string;
};

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    logger.debug({ err: String(error), filePath }, "[CrossAttempt] Failed to parse JSON file");
    return null;
  }
}

function diffStatSizeFor(traceDirectory: string): number {
  const filePath = join(traceDirectory, "diff.stat");
  if (!existsSync(filePath)) return 0;
  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

function changedFilesFor(traceDirectory: string): string[] {
  return readJsonFile<string[]>(join(traceDirectory, "changed-files.json")) ?? [];
}

function buildAttemptRecords(
  worktreePath: string,
  previousAttemptSummaries: AttemptSummary[] | undefined,
): AttemptRecord[] {
  const deduped = new Map<string, AttemptSummary>();
  for (const summary of previousAttemptSummaries ?? []) {
    deduped.set(`${summary.planVersion}:${summary.executeAttempt}`, summary);
  }

  return [...deduped.values()]
    .sort((left, right) =>
      left.planVersion !== right.planVersion
        ? left.planVersion - right.planVersion
        : left.executeAttempt - right.executeAttempt,
    )
    .map((summary) => {
      const directory = traceDir(worktreePath, summary.planVersion, summary.executeAttempt);
      const manifest = loadAttemptManifest(directory);
      return {
        planVersion: summary.planVersion,
        executeAttempt: summary.executeAttempt,
        summary,
        failureType: summary.insight?.errorType,
        changedFiles: changedFilesFor(directory),
        diffStatSize: diffStatSizeFor(directory),
        outcome: manifest?.outcome ?? "failure",
        nextIssueState: manifest?.nextIssueState,
      };
    });
}

export function persistCrossAttemptAnalysis(traceDirectory: string, analysis: CrossAttemptAnalysis): void {
  try {
    writeFileSync(join(traceDirectory, CROSS_ATTEMPT_FILE), JSON.stringify(analysis, null, 2), "utf8");
  } catch (error) {
    logger.warn({ err: String(error), traceDirectory }, "[CrossAttempt] Failed to write cross-attempt analysis");
  }
}

export function loadCrossAttemptAnalysis(traceDirectory: string): CrossAttemptAnalysis | null {
  return readJsonFile<CrossAttemptAnalysis>(join(traceDirectory, CROSS_ATTEMPT_FILE));
}

export function findLastTurnDirectivePath(traceDirectory: string): string | null {
  const turnsDirectory = join(traceDirectory, "turns");
  if (!existsSync(turnsDirectory)) return null;
  try {
    const directives = readdirSync(turnsDirectory)
      .filter((entry) => entry.endsWith(".directive.json"))
      .sort((left, right) => left.localeCompare(right));
    return directives.length > 0 ? join(turnsDirectory, directives[directives.length - 1]!) : null;
  } catch {
    return null;
  }
}

export function computeCrossAttemptAnalysis(
  worktreePath: string,
  currentPV: number,
  currentEA: number,
  previousAttemptSummaries: AttemptSummary[] | undefined,
): CrossAttemptAnalysis {
  const records = buildAttemptRecords(worktreePath, previousAttemptSummaries)
    .filter((record) => record.planVersion < currentPV || record.executeAttempt < currentEA);

  const failureCounts = new Map<string, number>();
  for (const record of records) {
    if (!record.failureType || record.failureType === "unknown") continue;
    failureCounts.set(record.failureType, (failureCounts.get(record.failureType) ?? 0) + 1);
  }

  const repeatedFailureTypes = [...failureCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([failureType]) => failureType)
    .sort((left, right) => left.localeCompare(right));

  const overlap = new Set<string>();
  for (let index = 1; index < records.length; index += 1) {
    const previous = new Set(records[index - 1]!.changedFiles);
    for (const filePath of records[index]!.changedFiles) {
      if (previous.has(filePath)) overlap.add(filePath);
    }
  }

  const outcomeTransitions = records.map((record) => ({
    attempt: record.executeAttempt,
    outcome: record.outcome,
    nextIssueState: record.nextIssueState,
  }));

  const summary: string[] = [];
  if (records.length === 0) {
    summary.push("No previous attempt artifacts were available; retry should rely on summary-only context.");
  }
  if (repeatedFailureTypes.length > 0) {
    summary.push(`Repeated failure types: ${repeatedFailureTypes.join(", ")}.`);
  }
  if (overlap.size > 0) {
    summary.push(`Repeated file edits across adjacent attempts: ${[...overlap].slice(0, 8).join(", ")}.`);
  }
  if (records.length >= 2) {
    const previous = records[records.length - 2]!;
    const latest = records[records.length - 1]!;
    summary.push(
      `Recent outcome transition: a${previous.executeAttempt} ${previous.outcome}/${previous.nextIssueState ?? "unknown"} -> a${latest.executeAttempt} ${latest.outcome}/${latest.nextIssueState ?? "unknown"}.`,
    );
    summary.push(
      `Diff footprint changed from ${previous.diffStatSize} diff.stat line(s) to ${latest.diffStatSize} diff.stat line(s).`,
    );
  }
  if (summary.length === 0) {
    summary.push("No strong cross-attempt pattern detected.");
  }

  return {
    generatedAt: now(),
    repeatedFailureTypes,
    changedFileOverlap: [...overlap].sort((left, right) => left.localeCompare(right)),
    outcomeTransitions,
    summary,
  };
}
