import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { IssueEntry } from "../types.ts";
import { finalizeAttemptManifest, loadAttemptManifest } from "./trace-bundle.ts";

type SimilarTraceCheckpoint = {
  lastTurn?: {
    directiveSummary?: string;
    outputPreview?: string;
  };
  reviewBlockers?: Array<{
    id?: string;
  }>;
  remainingWork?: string[];
};

type SimilarTraceRails = {
  harness?: {
    mode?: string;
    checkpointPolicy?: string;
    checkpointStatus?: string;
    contractNegotiationStatus?: string;
  };
  budget?: {
    retryBudget?: {
      used?: number;
      max?: number;
      remaining?: number;
    };
  };
  runtimeRails?: {
    contextResetCount?: number;
    lastFailedPhase?: string;
  };
  policyDecisions?: Array<{
    kind?: string;
  }>;
};

export type SimilarTraceHit = {
  issueId: string;
  issueIdentifier: string;
  score: number;
  reasons: string[];
  files: {
    handoff?: string;
    checkpoint?: string;
    attempt: string;
    diffPatch?: string;
  };
};

type SimilarTraceSelectionArtifact = {
  generatedAt: string;
  issue: {
    id: string;
    identifier: string;
    planVersion: number;
    executeAttempt: number;
  };
  query: {
    errorType: string;
    files: string[];
    blockerIds: string[];
    harnessMode: string;
    checkpointPolicy: string;
    checkpointFailed: boolean;
    contractBlocked: boolean;
    contextResetCount: number;
    nearRetryBudget: boolean;
    lastFailedPhase: string;
    policyDecisionKinds: string[];
  };
  hits: SimilarTraceHit[];
  postAttemptAnalysis?: {
    analyzedAt: string;
    attemptOutcome?: string;
    attemptChangedFiles: string[];
    likelyFollowedHit: null | {
      issueId: string;
      issueIdentifier: string;
      score: number;
      overlapFiles: string[];
      reasons: string[];
    };
  };
};

const TRACE_DIR_NAME = "traces";
const TRACE_NAME_PATTERN = /^v(\d+)a(\d+)$/;
const MAX_WORKSPACES = 48;
const MAX_ATTEMPTS_PER_WORKSPACE = 4;
const MAX_RESULTS = 3;
const MIN_SCORE = 4;
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "while",
  "when",
  "then",
  "failed",
  "failure",
  "error",
  "issue",
  "review",
  "execution",
  "attempt",
  "previous",
  "before",
  "after",
  "should",
  "would",
  "could",
  "must",
  "need",
  "file",
  "files",
]);

type QuerySignal = {
  errorType: string;
  tokens: Set<string>;
  files: Set<string>;
  blockerIds: Set<string>;
  harnessMode: string;
  checkpointPolicy: string;
  checkpointFailed: boolean;
  contractBlocked: boolean;
  contextResetCount: number;
  nearRetryBudget: boolean;
  lastFailedPhase: string;
  policyDecisionKinds: Set<string>;
};

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function tokenize(text: string): Set<string> {
  const matches = text
    .toLowerCase()
    .match(/[a-z0-9_.-]{3,}/g) ?? [];
  return new Set(
    matches.filter((token) =>
      !STOP_WORDS.has(token) &&
      !/^\d+$/.test(token),
    ),
  );
}

function buildQuerySignal(issue: IssueEntry): QuerySignal {
  const summaries = issue.previousAttemptSummaries ?? [];
  const latest = summaries.length > 0 ? summaries[summaries.length - 1] : null;
  const blockerIds = new Set(
    (issue.gradingReport?.criteria ?? [])
      .filter((criterion) => criterion.result === "FAIL" && criterion.blocking)
      .map((criterion) => criterion.id)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );

  const files = new Set(
    latest?.insight?.filesInvolved?.filter((value): value is string => typeof value === "string" && value.length > 0) ?? [],
  );
  const errorType = (latest?.insight?.errorType ?? "").trim().toLowerCase();
  const errorText = [
    latest?.insight?.rootCause ?? "",
    latest?.error ?? "",
    latest?.outputTail ?? "",
    issue.lastError ?? "",
  ].join(" ");

  return {
    errorType,
    tokens: tokenize(errorText),
    files,
    blockerIds,
    harnessMode: issue.plan?.harnessMode ?? "standard",
    checkpointPolicy: issue.plan?.executionContract?.checkpointPolicy ?? "final_only",
    checkpointFailed: issue.checkpointStatus === "failed",
    contractBlocked: Boolean(issue.contractNegotiationStatus && issue.contractNegotiationStatus !== "approved"),
    contextResetCount: issue.contextResetCount ?? 0,
    nearRetryBudget: (issue.maxAttempts ?? 0) > 0
      ? Math.max(0, (issue.maxAttempts ?? 0) - (issue.attempts ?? 0)) <= 1
      : false,
    lastFailedPhase: (issue.lastFailedPhase ?? latest?.phase ?? "").trim().toLowerCase(),
    policyDecisionKinds: new Set(
      (issue.policyDecisions ?? [])
        .map((decision) => decision.kind)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  };
}

function parseTraceName(name: string): { planVersion: number; executeAttempt: number } | null {
  const match = name.match(TRACE_NAME_PATTERN);
  if (!match) return null;
  return {
    planVersion: Number.parseInt(match[1] ?? "0", 10),
    executeAttempt: Number.parseInt(match[2] ?? "0", 10),
  };
}

function compareTraceNames(left: string, right: string): number {
  const leftParsed = parseTraceName(left);
  const rightParsed = parseTraceName(right);
  if (!leftParsed || !rightParsed) return right.localeCompare(left);
  if (leftParsed.planVersion !== rightParsed.planVersion) {
    return rightParsed.planVersion - leftParsed.planVersion;
  }
  return rightParsed.executeAttempt - leftParsed.executeAttempt;
}

function readChangedFiles(tracePath: string): string[] {
  const parsed = readJsonFile<unknown>(join(tracePath, "changed-files.json"));
  return Array.isArray(parsed)
    ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
}

function contextResetBucket(count: number): "none" | "low" | "high" {
  if (count <= 0) return "none";
  if (count === 1) return "low";
  return "high";
}

function scoreCandidate(
  query: QuerySignal,
  candidateText: string,
  changedFiles: string[],
  blockerIds: string[],
  rails?: SimilarTraceRails | null,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (query.errorType && candidateText.includes(query.errorType)) {
    score += 5;
    reasons.push(`shared error signal \`${query.errorType}\``);
  }

  const candidateTokens = tokenize(candidateText);
  const sharedTokens = [...query.tokens].filter((token) => candidateTokens.has(token)).slice(0, 3);
  if (sharedTokens.length > 0) {
    score += sharedTokens.length;
    reasons.push(`shared terms ${sharedTokens.map((token) => `\`${token}\``).join(", ")}`);
  }

  const overlappingFiles = changedFiles.filter((file) => query.files.has(file)).slice(0, 2);
  if (overlappingFiles.length > 0) {
    score += overlappingFiles.length * 3;
    reasons.push(`shared files ${overlappingFiles.map((file) => `\`${file}\``).join(", ")}`);
  }

  const overlappingBlockers = blockerIds.filter((id) => query.blockerIds.has(id)).slice(0, 2);
  if (overlappingBlockers.length > 0) {
    score += overlappingBlockers.length * 4;
    reasons.push(`shared review blockers ${overlappingBlockers.map((id) => `\`${id}\``).join(", ")}`);
  }

  const harnessMode = rails?.harness?.mode?.trim().toLowerCase() ?? "";
  if (query.harnessMode && harnessMode === query.harnessMode) {
    score += 2;
    reasons.push(`same harness mode \`${query.harnessMode}\``);
  }

  const checkpointPolicy = rails?.harness?.checkpointPolicy?.trim().toLowerCase() ?? "";
  if (query.checkpointPolicy && checkpointPolicy === query.checkpointPolicy) {
    score += 2;
    reasons.push(`same checkpoint policy \`${query.checkpointPolicy}\``);
  }

  const candidateContextResetCount = rails?.runtimeRails?.contextResetCount ?? 0;
  if (query.contextResetCount > 0 && candidateContextResetCount > 0) {
    score += contextResetBucket(candidateContextResetCount) === contextResetBucket(query.contextResetCount) ? 2 : 1;
    reasons.push("similar context reset pressure");
  }

  const candidateRemaining = rails?.budget?.retryBudget?.remaining;
  if (query.nearRetryBudget && typeof candidateRemaining === "number" && candidateRemaining <= 1) {
    score += 2;
    reasons.push("similar retry budget pressure");
  }

  const candidateLastFailedPhase = rails?.runtimeRails?.lastFailedPhase?.trim().toLowerCase() ?? "";
  if (query.lastFailedPhase && candidateLastFailedPhase === query.lastFailedPhase) {
    score += 1;
    reasons.push(`same failed phase \`${query.lastFailedPhase}\``);
  }

  if (query.checkpointFailed && rails?.harness?.checkpointStatus === "failed") {
    score += 2;
    reasons.push("shared checkpoint failure state");
  }

  if (query.contractBlocked && rails?.harness?.contractNegotiationStatus && rails.harness.contractNegotiationStatus !== "approved") {
    score += 2;
    reasons.push("shared contract negotiation blocker");
  }

  const candidateDecisionKinds = new Set(
    (rails?.policyDecisions ?? [])
      .map((decision) => decision.kind)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const overlappingDecisionKinds = [...query.policyDecisionKinds]
    .filter((kind) => candidateDecisionKinds.has(kind))
    .slice(0, 2);
  if (overlappingDecisionKinds.length > 0) {
    score += overlappingDecisionKinds.length;
    reasons.push(`shared policy decisions ${overlappingDecisionKinds.map((kind) => `\`${kind}\``).join(", ")}`);
  }

  return { score, reasons };
}

export function persistSimilarTraceSelection(
  traceDirectory: string,
  issue: IssueEntry,
  hits: SimilarTraceHit[],
): string | null {
  if (!existsSync(traceDirectory) || hits.length === 0) return null;

  const query = buildQuerySignal(issue);
  const artifact: SimilarTraceSelectionArtifact = {
    generatedAt: new Date().toISOString(),
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      planVersion: issue.planVersion ?? 1,
      executeAttempt: issue.executeAttempt ?? 1,
    },
    query: {
      errorType: query.errorType,
      files: [...query.files],
      blockerIds: [...query.blockerIds],
      harnessMode: query.harnessMode,
      checkpointPolicy: query.checkpointPolicy,
      checkpointFailed: query.checkpointFailed,
      contractBlocked: query.contractBlocked,
      contextResetCount: query.contextResetCount,
      nearRetryBudget: query.nearRetryBudget,
      lastFailedPhase: query.lastFailedPhase,
      policyDecisionKinds: [...query.policyDecisionKinds],
    },
    hits,
  };

  const fileName = "similar-traces.json";
  try {
    writeFileSync(join(traceDirectory, fileName), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    finalizeAttemptManifest(traceDirectory, {
      files: {
        similarTraces: fileName,
      },
    });
    return fileName;
  } catch {
    return null;
  }
}

export function findSimilarIssueTraces(
  issue: IssueEntry,
  workspacePath: string,
  options: {
    maxResults?: number;
  } = {},
): SimilarTraceHit[] {
  const query = buildQuerySignal(issue);
  if (!query.errorType && query.tokens.size === 0 && query.files.size === 0 && query.blockerIds.size === 0) {
    return [];
  }

  const workspaceRoot = dirname(workspacePath);
  let workspaces: string[] = [];
  try {
    workspaces = readdirSync(workspaceRoot)
      .map((name) => join(workspaceRoot, name))
      .filter((path) => path !== workspacePath && existsSync(join(path, TRACE_DIR_NAME)))
      .sort((left, right) => right.localeCompare(left))
      .slice(0, MAX_WORKSPACES);
  } catch {
    return [];
  }

  const hits: SimilarTraceHit[] = [];

  for (const candidateWorkspace of workspaces) {
    const tracesRoot = join(candidateWorkspace, TRACE_DIR_NAME);
    let traceNames: string[] = [];
    try {
      traceNames = readdirSync(tracesRoot)
        .filter((name) => TRACE_NAME_PATTERN.test(name))
        .sort(compareTraceNames)
        .slice(0, MAX_ATTEMPTS_PER_WORKSPACE);
    } catch {
      continue;
    }

    for (const traceName of traceNames) {
      const tracePath = join(tracesRoot, traceName);
      const manifest = loadAttemptManifest(tracePath);
      if (!manifest || manifest.issueId === issue.id) continue;

      const checkpoint = readJsonFile<SimilarTraceCheckpoint>(join(tracePath, "checkpoint.json"));
      const rails = readJsonFile<SimilarTraceRails>(join(tracePath, "rails.json"));
      const changedFiles = readChangedFiles(tracePath);
      const blockerIds = (checkpoint?.reviewBlockers ?? [])
        .map((entry) => entry.id)
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      const candidateText = [
        manifest.error ?? "",
        checkpoint?.lastTurn?.directiveSummary ?? "",
        checkpoint?.lastTurn?.outputPreview ?? "",
        ...(checkpoint?.remainingWork ?? []),
      ].join(" ").toLowerCase();
      const { score, reasons } = scoreCandidate(query, candidateText, changedFiles, blockerIds, rails);
      if (score < MIN_SCORE) continue;

      hits.push({
        issueId: manifest.issueId,
        issueIdentifier: manifest.issueIdentifier,
        score,
        reasons,
        files: {
          handoff: existsSync(join(tracePath, "handoff.md"))
            ? relative(workspacePath, join(tracePath, "handoff.md"))
            : undefined,
          checkpoint: existsSync(join(tracePath, "checkpoint.json"))
            ? relative(workspacePath, join(tracePath, "checkpoint.json"))
            : undefined,
          attempt: relative(workspacePath, join(tracePath, "attempt.json")),
          diffPatch: existsSync(join(tracePath, "diff.patch"))
            ? relative(workspacePath, join(tracePath, "diff.patch"))
            : undefined,
        },
      });
    }
  }

  return hits
    .sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score;
      return left.issueIdentifier.localeCompare(right.issueIdentifier);
    })
    .slice(0, options.maxResults ?? MAX_RESULTS);
}
