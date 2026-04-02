import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { IssueEntry, IssueState } from "../types.ts";
import { logger } from "../concerns/logger.ts";
import { now } from "../concerns/helpers.ts";
import { readTranscript, type TranscriptEntry } from "../agents/transcript.ts";

export type AttemptOutcome = "success" | "failure" | "timeout" | "crash";

export type AttemptManifest = {
  manifestVersion: number;
  issueId: string;
  issueIdentifier: string;
  planVersion: number;
  executeAttempt: number;
  provider: string;
  role: string;
  startedAt: string;
  endedAt?: string;
  outcome?: AttemptOutcome;
  nextIssueState?: IssueState;
  exitCode?: number | null;
  error?: string;
  files: {
    attemptManifest: string;
    transcript: string;
    turnsDir: string;
    changedFiles: string;
    diffStat: string;
    diffPatch?: string;
    bootstrap?: string;
    checkpoint?: string;
    handoff?: string;
    rails?: string;
    similarTraces?: string;
    rawOutputTemplate: string;
  };
  rawOutputs: string[];
};

export type AttemptManifestPatch = {
  endedAt?: string;
  outcome?: AttemptOutcome;
  nextIssueState?: IssueState;
  exitCode?: number | null;
  error?: string;
  rawOutputs?: string[];
  files?: Partial<AttemptManifest["files"]>;
};

export type TraceBundle = {
  dir: string;
  manifestFile: string;
  transcriptFile: string;
  turnsDir: string;
};

export type CrossAttemptAnalysis = {
  generatedAt: string;
  repeatedFailureTypes: string[];
  changedFileOverlap: string[];
  outcomeTransitions: Array<{
    attempt: number;
    outcome: AttemptOutcome;
    nextIssueState?: string;
  }>;
  summary: string[];
};

export const TRACE_DIR = "traces";

const ATTEMPT_MANIFEST_FILE = "attempt.json";
const TRANSCRIPT_MIRROR_FILE = "transcript.jsonl";
const CHANGED_FILES_FILE = "changed-files.json";
const DIFF_STAT_FILE = "diff.stat";
const DIFF_PATCH_FILE = "diff.patch";
const CHECKPOINT_FILE = "checkpoint.json";
const HANDOFF_FILE = "handoff.md";
const RAILS_FILE = "rails.json";
const SIMILAR_TRACES_FILE = "similar-traces.json";

type CheckpointArtifact = {
  generatedAt: string;
  issue: {
    id: string;
    identifier: string;
    title: string;
  };
  attempt: {
    planVersion: number;
    executeAttempt: number;
    role: string;
    provider: string;
    outcome?: AttemptOutcome;
    nextIssueState?: IssueState;
    error?: string;
  };
  lastTurn: null | {
    turn: number;
    directiveStatus?: string;
    directiveSummary?: string;
    exitCode?: number | null;
    outputPreview?: string;
  };
  changedFiles: string[];
  diffStatExcerpt: string[];
  reviewBlockers: Array<{
    id: string;
    category?: string;
    description?: string;
    evidence?: string;
  }>;
  priorAttemptSuggestion?: string;
  remainingWork: string[];
  resumeArtifacts: {
    attemptManifest: string;
    checkpoint: string;
    handoff: string;
    rails?: string;
    similarTraces?: string;
    transcript: string;
    changedFiles: string;
    diffStat: string;
    diffPatch?: string;
    bootstrap?: string;
    lastDirective?: string;
  };
};

type RailsArtifact = {
  generatedAt: string;
  issue: {
    id: string;
    identifier: string;
  };
  attempt: {
    planVersion: number;
    executeAttempt: number;
    role: string;
    provider: string;
  };
  harness: {
    mode: string;
    checkpointPolicy: string;
    checkpointStatus?: string;
    contractNegotiationStatus?: string;
  };
  budget: {
    retryBudget: {
      used: number;
      max: number;
      remaining: number;
    };
    executeAttempt: number;
    reviewAttempt: number;
    checkpointAttempt: number;
    contractNegotiationAttempt: number;
    budgetPolicy: unknown;
  };
  runtimeRails: {
    contextResetCount: number;
    lastHandoffFile?: string;
    lastFailedPhase?: string;
  };
  policyDecisions: Array<{
    id: string;
    kind: string;
    scope: string;
    basis: string;
    from?: string;
    to: string;
    rationale: string;
    recordedAt: string;
  }>;
};

type SimilarTraceSelectionArtifact = {
  generatedAt?: string;
  hits?: Array<{
    issueId?: string;
    issueIdentifier?: string;
    score?: number;
    reasons?: string[];
    files?: {
      attempt?: string;
    };
  }>;
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

function traceManifestPath(traceDirectory: string): string {
  return join(traceDirectory, ATTEMPT_MANIFEST_FILE);
}

function traceTranscriptPath(traceDirectory: string): string {
  return join(traceDirectory, TRANSCRIPT_MIRROR_FILE);
}

function traceTurnsPath(traceDirectory: string): string {
  return join(traceDirectory, "turns");
}

function safeReadChangedFiles(traceDirectory: string): string[] {
  try {
    const raw = readFileSync(join(traceDirectory, CHANGED_FILES_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function safeReadDiffStatExcerpt(traceDirectory: string): string[] {
  try {
    return readFileSync(join(traceDirectory, DIFF_STAT_FILE), "utf8")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(0, 6);
  } catch {
    return [];
  }
}

function safeReadJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function findLastDirectiveArtifact(traceDirectory: string): string | undefined {
  const turnsDir = traceTurnsPath(traceDirectory);
  if (!existsSync(turnsDir)) return undefined;
  try {
    const directives = readdirSync(turnsDir)
      .filter((entry) => entry.endsWith(".directive.json"))
      .sort((left, right) => left.localeCompare(right));
    return directives.length > 0 ? `turns/${directives[directives.length - 1]}` : undefined;
  } catch {
    return undefined;
  }
}

function collectReviewBlockers(issue: IssueEntry): CheckpointArtifact["reviewBlockers"] {
  const criteria = issue.gradingReport?.criteria ?? [];
  return criteria
    .filter((criterion) => criterion.result === "FAIL" && criterion.blocking)
    .slice(0, 5)
    .map((criterion) => ({
      id: criterion.id,
      category: criterion.category,
      description: criterion.description,
      evidence: criterion.evidence,
    }));
}

function deriveRemainingWork(
  issue: IssueEntry,
  patch: AttemptManifestPatch,
  changedFiles: string[],
  reviewBlockers: CheckpointArtifact["reviewBlockers"],
): string[] {
  const items: string[] = [];

  if (reviewBlockers.length > 0) {
    items.push(`Address ${reviewBlockers.length} blocking review criteria before resubmitting.`);
  }
  if (patch.outcome === "failure" || patch.outcome === "timeout" || patch.outcome === "crash") {
    if (changedFiles.length > 0) {
      items.push("Inspect `diff.patch` and `changed-files.json` before retrying the same implementation path.");
    } else {
      items.push("The previous attempt left no workspace diff. Take a materially different execution strategy.");
    }
  }
  if (patch.nextIssueState === "Blocked") {
    items.push("Unblock the current execution path or adjust the plan before resuming.");
  }
  const priorSuggestion = issue.previousAttemptSummaries?.[issue.previousAttemptSummaries.length - 1]?.insight?.suggestion;
  if (priorSuggestion) {
    items.push(`Prior heuristic suggestion: ${priorSuggestion}`);
  }

  return Array.from(new Set(items)).slice(0, 5);
}

function buildRailsArtifact(
  worktreePath: string,
  issue: IssueEntry,
  manifest: AttemptManifest,
): RailsArtifact {
  const relevantDecisions = (issue.policyDecisions ?? [])
    .filter((decision) => (decision.planVersion ?? manifest.planVersion) === manifest.planVersion)
    .slice(0, 8)
    .map((decision) => ({
      id: decision.id,
      kind: decision.kind,
      scope: decision.scope,
      basis: decision.basis,
      from: decision.from,
      to: decision.to,
      rationale: decision.rationale,
      recordedAt: decision.recordedAt,
    }));

  return {
    generatedAt: now(),
    issue: {
      id: issue.id,
      identifier: issue.identifier,
    },
    attempt: {
      planVersion: manifest.planVersion,
      executeAttempt: manifest.executeAttempt,
      role: manifest.role,
      provider: manifest.provider,
    },
    harness: {
      mode: issue.plan?.harnessMode ?? "standard",
      checkpointPolicy: issue.plan?.executionContract?.checkpointPolicy ?? "final_only",
      checkpointStatus: issue.checkpointStatus,
      contractNegotiationStatus: issue.contractNegotiationStatus,
    },
    budget: {
      retryBudget: {
        used: issue.attempts ?? 0,
        max: issue.maxAttempts ?? 0,
        remaining: Math.max(0, (issue.maxAttempts ?? 0) - (issue.attempts ?? 0)),
      },
      executeAttempt: issue.executeAttempt ?? manifest.executeAttempt,
      reviewAttempt: issue.reviewAttempt ?? 0,
      checkpointAttempt: issue.checkpointAttempt ?? 0,
      contractNegotiationAttempt: issue.contractNegotiationAttempt ?? 0,
      budgetPolicy: issue.plan?.executionContract?.budgetPolicy ?? null,
    },
    runtimeRails: {
      contextResetCount: issue.contextResetCount ?? 0,
      lastHandoffFile: issue.lastHandoffFile
        ? relative(worktreePath, issue.lastHandoffFile)
        : undefined,
      lastFailedPhase: issue.lastFailedPhase,
    },
    policyDecisions: relevantDecisions,
  };
}

function finalizeSimilarTraceSelectionArtifact(
  traceDirectory: string,
  worktreePath: string,
  patch: AttemptManifestPatch,
): Partial<AttemptManifest["files"]> {
  const artifactPath = join(traceDirectory, SIMILAR_TRACES_FILE);
  if (!existsSync(artifactPath)) return {};

  try {
    const artifact = safeReadJsonFile<SimilarTraceSelectionArtifact>(artifactPath);
    if (!artifact) return {};

    const changedFiles = safeReadChangedFiles(traceDirectory);
    let likelyFollowedHit: NonNullable<SimilarTraceSelectionArtifact["postAttemptAnalysis"]>["likelyFollowedHit"] = null;
    let bestOverlapScore = 0;

    for (const hit of artifact.hits ?? []) {
      const relativeAttemptPath = hit.files?.attempt;
      if (!relativeAttemptPath) continue;
      const candidateAttemptPath = join(worktreePath, relativeAttemptPath);
      const candidateChangedFilesPath = join(dirname(candidateAttemptPath), CHANGED_FILES_FILE);
      const candidateChangedFiles = safeReadJsonFile<unknown>(candidateChangedFilesPath);
      const candidateFiles = Array.isArray(candidateChangedFiles)
        ? candidateChangedFiles.filter((value): value is string => typeof value === "string" && value.length > 0)
        : [];
      const overlapFiles = candidateFiles.filter((file) => changedFiles.includes(file));
      if (overlapFiles.length === 0) continue;

      const overlapScore = overlapFiles.length * 10 + (hit.score ?? 0);
      if (overlapScore <= bestOverlapScore) continue;
      bestOverlapScore = overlapScore;
      likelyFollowedHit = {
        issueId: hit.issueId ?? "",
        issueIdentifier: hit.issueIdentifier ?? "",
        score: hit.score ?? 0,
        overlapFiles,
        reasons: hit.reasons ?? [],
      };
    }

    artifact.postAttemptAnalysis = {
      analyzedAt: now(),
      attemptOutcome: patch.outcome,
      attemptChangedFiles: changedFiles,
      likelyFollowedHit,
    };
    writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return { similarTraces: SIMILAR_TRACES_FILE };
  } catch (error) {
    logger.warn({ error: String(error), traceDirectory }, "[TraceBundle] Failed to finalize similar trace selection artifact");
    return {};
  }
}

function writeRailsArtifact(
  traceDirectory: string,
  worktreePath: string,
  issue: IssueEntry,
): Partial<AttemptManifest["files"]> {
  const manifest = readExistingManifest(traceDirectory);
  if (!manifest) return {};

  try {
    const rails = buildRailsArtifact(worktreePath, issue, manifest);
    writeFileSync(join(traceDirectory, RAILS_FILE), `${JSON.stringify(rails, null, 2)}\n`, "utf8");
    return { rails: RAILS_FILE };
  } catch (error) {
    logger.warn({ error: String(error), traceDirectory, issueId: issue.id }, "[TraceBundle] Failed to write rails artifact");
    return {};
  }
}

function renderHandoffMarkdown(checkpoint: CheckpointArtifact): string {
  const lines = [
    "# Attempt Handoff",
    "",
    `- Issue: ${checkpoint.issue.identifier} — ${checkpoint.issue.title}`,
    `- Attempt: v${checkpoint.attempt.planVersion}a${checkpoint.attempt.executeAttempt}`,
    `- Outcome: ${checkpoint.attempt.outcome ?? "unknown"}`,
    `- Next state: ${checkpoint.attempt.nextIssueState ?? "unknown"}`,
    "",
    "## Resume Order",
    "- Start with `handoff.md` for the concise summary.",
    "- Read `checkpoint.json` for structured resume state.",
    "- Open `attempt.json`, the last `directive.json`, and `diff.patch` only if they are relevant to the failure mode.",
    "",
  ];

  if (checkpoint.changedFiles.length > 0) {
    lines.push("## Changed Files");
    lines.push(...checkpoint.changedFiles.map((file) => `- \`${file}\``));
    lines.push("");
  }

  if (checkpoint.diffStatExcerpt.length > 0) {
    lines.push("## Diff Summary");
    lines.push("```text");
    lines.push(...checkpoint.diffStatExcerpt);
    lines.push("```");
    lines.push("");
  }

  if (checkpoint.lastTurn) {
    lines.push("## Last Turn");
    lines.push(`- Turn: ${checkpoint.lastTurn.turn}`);
    if (checkpoint.lastTurn.directiveStatus) lines.push(`- Directive status: ${checkpoint.lastTurn.directiveStatus}`);
    if (checkpoint.lastTurn.directiveSummary) lines.push(`- Directive summary: ${checkpoint.lastTurn.directiveSummary}`);
    if (checkpoint.lastTurn.outputPreview) lines.push(`- Output preview: ${checkpoint.lastTurn.outputPreview}`);
    lines.push("");
  }

  if (checkpoint.reviewBlockers.length > 0) {
    lines.push("## Blocking Review Evidence");
    for (const blocker of checkpoint.reviewBlockers) {
      lines.push(`- **${blocker.id}**${blocker.category ? ` [${blocker.category}]` : ""}: ${blocker.description ?? "Blocking review failure"}`);
      if (blocker.evidence) {
        lines.push(`  Evidence: ${blocker.evidence}`);
      }
    }
    lines.push("");
  }

  if (checkpoint.remainingWork.length > 0) {
    lines.push("## Remaining Work");
    lines.push(...checkpoint.remainingWork.map((item) => `- ${item}`));
    lines.push("");
  }

  lines.push("## Key Artifacts");
  lines.push(`- \`${checkpoint.resumeArtifacts.checkpoint}\``);
  if (checkpoint.resumeArtifacts.rails) lines.push(`- \`${checkpoint.resumeArtifacts.rails}\``);
  if (checkpoint.resumeArtifacts.similarTraces) lines.push(`- \`${checkpoint.resumeArtifacts.similarTraces}\``);
  lines.push(`- \`${checkpoint.resumeArtifacts.attemptManifest}\``);
  if (checkpoint.resumeArtifacts.lastDirective) lines.push(`- \`${checkpoint.resumeArtifacts.lastDirective}\``);
  if (checkpoint.resumeArtifacts.diffPatch) lines.push(`- \`${checkpoint.resumeArtifacts.diffPatch}\``);
  lines.push(`- \`${checkpoint.resumeArtifacts.transcript}\``);
  lines.push(`- \`${checkpoint.resumeArtifacts.changedFiles}\``);
  lines.push(`- \`${checkpoint.resumeArtifacts.diffStat}\``);
  if (checkpoint.resumeArtifacts.bootstrap) lines.push(`- \`${checkpoint.resumeArtifacts.bootstrap}\``);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function writeHandoffArtifacts(
  traceDirectory: string,
  issue: IssueEntry,
  patch: AttemptManifestPatch,
  transcriptEntries: TranscriptEntry[],
): Partial<AttemptManifest["files"]> {
  const manifest = readExistingManifest(traceDirectory);
  if (!manifest) return {};

  try {
    const changedFiles = safeReadChangedFiles(traceDirectory);
    const reviewBlockers = collectReviewBlockers(issue);
    const checkpoint: CheckpointArtifact = {
      generatedAt: now(),
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      },
      attempt: {
        planVersion: manifest.planVersion,
        executeAttempt: manifest.executeAttempt,
        role: manifest.role,
        provider: manifest.provider,
        outcome: patch.outcome,
        nextIssueState: patch.nextIssueState,
        error: patch.error,
      },
      lastTurn: transcriptEntries.length > 0
        ? {
          turn: transcriptEntries[transcriptEntries.length - 1]!.turn,
          directiveStatus: transcriptEntries[transcriptEntries.length - 1]!.directiveStatus,
          directiveSummary: transcriptEntries[transcriptEntries.length - 1]!.directiveSummary,
          exitCode: transcriptEntries[transcriptEntries.length - 1]!.exitCode,
          outputPreview: transcriptEntries[transcriptEntries.length - 1]!.outputPreview,
        }
        : null,
      changedFiles,
      diffStatExcerpt: safeReadDiffStatExcerpt(traceDirectory),
      reviewBlockers,
      priorAttemptSuggestion: issue.previousAttemptSummaries?.[issue.previousAttemptSummaries.length - 1]?.insight?.suggestion,
      remainingWork: deriveRemainingWork(issue, patch, changedFiles, reviewBlockers),
      resumeArtifacts: {
        attemptManifest: ATTEMPT_MANIFEST_FILE,
        checkpoint: CHECKPOINT_FILE,
        handoff: HANDOFF_FILE,
        rails: existsSync(join(traceDirectory, RAILS_FILE)) ? RAILS_FILE : undefined,
        similarTraces: existsSync(join(traceDirectory, SIMILAR_TRACES_FILE)) ? SIMILAR_TRACES_FILE : undefined,
        transcript: TRANSCRIPT_MIRROR_FILE,
        changedFiles: CHANGED_FILES_FILE,
        diffStat: DIFF_STAT_FILE,
        diffPatch: existsSync(join(traceDirectory, DIFF_PATCH_FILE)) ? DIFF_PATCH_FILE : undefined,
        bootstrap: existsSync(join(traceDirectory, "bootstrap.md")) ? "bootstrap.md" : undefined,
        lastDirective: findLastDirectiveArtifact(traceDirectory),
      },
    };

    writeFileSync(join(traceDirectory, CHECKPOINT_FILE), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
    writeFileSync(join(traceDirectory, HANDOFF_FILE), renderHandoffMarkdown(checkpoint), "utf8");
    return { checkpoint: CHECKPOINT_FILE, handoff: HANDOFF_FILE };
  } catch (error) {
    logger.warn({ error: String(error), traceDirectory, issueId: issue.id }, "[TraceBundle] Failed to write handoff artifacts");
    return {};
  }
}

/** Trace directory for an execution attempt: traces/v{plan}a{attempt}. */
export function traceDir(worktreePath: string, planVersion: number, executeAttempt: number): string {
  return join(workspaceSafePath(worktreePath), TRACE_DIR, `v${planVersion}a${executeAttempt}`);
}

function workspaceSafePath(workspacePath: string): string {
  return workspacePath.replace(/\\/g, "/");
}

/** Create trace directory and turns subdirectory. */
export function ensureTraceDir(worktreePath: string, planVersion: number, executeAttempt: number): string | null {
  const dir = traceDir(worktreePath, planVersion, executeAttempt);
  try {
    mkdirSync(traceTurnsPath(dir), { recursive: true });
    return dir;
  } catch (error) {
    logger.warn({ error: String(error), issueWorkspace: worktreePath, planVersion, executeAttempt }, "[TraceBundle] Failed to create trace directory");
    return null;
  }
}

/** Build a trace bundle descriptor from directory path. */
export function toTraceBundle(traceDirectory: string): TraceBundle {
  return {
    dir: traceDirectory,
    manifestFile: ATTEMPT_MANIFEST_FILE,
    transcriptFile: TRANSCRIPT_MIRROR_FILE,
    turnsDir: "turns",
  };
}

function readExistingManifest(traceDirectory: string): AttemptManifest | null {
  const path = traceManifestPath(traceDirectory);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as AttemptManifest;
    return parsed;
  } catch (error) {
    logger.warn({ error: String(error), traceDirectory }, "[TraceBundle] Failed to read existing attempt manifest");
    return null;
  }
}

export function loadAttemptManifest(traceDirectory: string): AttemptManifest | null {
  return readExistingManifest(traceDirectory);
}

/** Write the initial attempt manifest with known state and placeholders. */
export function writeAttemptManifest(traceDirectory: string, manifest: AttemptManifest): void {
  const path = traceManifestPath(traceDirectory);
  try {
    writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");
  } catch (error) {
    logger.warn({ error: String(error), traceDirectory }, "[TraceBundle] Failed to write attempt manifest");
  }
}

/** Merge end-of-attempt fields back into the manifest. */
export function finalizeAttemptManifest(traceDirectory: string, patch: AttemptManifestPatch): void {
  const path = traceManifestPath(traceDirectory);
  const existing = readExistingManifest(traceDirectory);
  if (!existing) {
    logger.warn({ traceDirectory }, "[TraceBundle] Attempt manifest missing — skip finalization");
    return;
  }

  const finalized: AttemptManifest = {
    ...existing,
    ...patch,
    files: {
      ...existing.files,
      ...(patch.files ?? {}),
    },
  };
  if (patch.rawOutputs) {
    finalized.rawOutputs = Array.from(new Set([...(existing.rawOutputs ?? []), ...patch.rawOutputs]));
  }

  writeAttemptManifest(traceDirectory, finalized);
}

/** Build a default initial attempt manifest used at run start. */
export function buildInitialAttemptManifest(
  issue: IssueEntry,
  provider: string,
  role: string,
): AttemptManifest {
  const planVersion = issue.planVersion ?? 1;
  const executeAttempt = issue.executeAttempt ?? 1;
  return {
    manifestVersion: 1,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    planVersion,
    executeAttempt,
    provider,
    role,
    startedAt: now(),
    files: {
      attemptManifest: ATTEMPT_MANIFEST_FILE,
      transcript: TRANSCRIPT_MIRROR_FILE,
      turnsDir: "turns",
      changedFiles: CHANGED_FILES_FILE,
      diffStat: DIFF_STAT_FILE,
      rawOutputTemplate: `outputs/execute.v${planVersion}a${executeAttempt}.t{turn}.stdout.log`,
    },
    rawOutputs: [],
  };
}

/** Capture git delta artifacts for the worktree after an attempt. */
export function captureWorkspaceDelta(traceDirectory: string, worktreePath: string): void {
  try {
    const changedOutput = execSync("git diff --name-only", { cwd: worktreePath, encoding: "utf8", maxBuffer: 1_000_000 });
    const changedFiles = (changedOutput || "").split("\n").map((f) => f.trim()).filter(Boolean);
    writeFileSync(join(traceDirectory, CHANGED_FILES_FILE), JSON.stringify(changedFiles, null, 2), "utf8");

    const diffStat = execSync("git diff --stat", { cwd: worktreePath, encoding: "utf8", maxBuffer: 1_000_000 });
    writeFileSync(join(traceDirectory, DIFF_STAT_FILE), diffStat || "", "utf8");

    if (changedFiles.length > 0) {
      const diffOutput = execSync("git diff", { cwd: worktreePath, encoding: "utf8", maxBuffer: 4_000_000 });
      writeFileSync(join(traceDirectory, DIFF_PATCH_FILE), diffOutput || "", "utf8");
      finalizeAttemptManifest(traceDirectory, { files: { diffPatch: DIFF_PATCH_FILE } });
    } else {
      // No workspace changes: explicitly skip diff.patch per spec and keep changed-files list.
      logger.debug({ traceDirectory, issuePath: worktreePath }, "[TraceBundle] No changed files, skipping diff.patch");
    }
  } catch (error) {
    logger.warn({ error: String(error), traceDirectory, worktreePath }, "[TraceBundle] Failed to capture workspace delta");
    writeFileSync(join(traceDirectory, CHANGED_FILES_FILE), "[]", "utf8");
    writeFileSync(join(traceDirectory, DIFF_STAT_FILE), "", "utf8");
  }
}

/** Mirror canonical transcript entries to issue worktree traces. */
export function writeTranscriptMirror(traceDirectory: string, transcriptEntries: TranscriptEntry[]): void {
  try {
    const lines = transcriptEntries.map((entry) => JSON.stringify({
      ts: entry.ts,
      turn: entry.turn,
      role: entry.role,
      model: entry.model,
      provider: entry.provider,
      directiveStatus: entry.directiveStatus,
      directiveSummary: entry.directiveSummary,
      exitCode: entry.exitCode,
      success: entry.success,
      tokens: entry.tokens,
      toolsUsed: entry.toolsUsed,
      skillsUsed: entry.skillsUsed,
      agentsUsed: entry.agentsUsed,
      commandsRun: entry.commandsRun,
      durationMs: entry.durationMs,
      contextPct: entry.contextPct,
      outputPreview: entry.outputPreview,
    }));
    const path = traceTranscriptPath(traceDirectory);
    writeFileSync(path, lines.join("\n") + (lines.length > 0 ? "\n" : ""), "utf8");
  } catch (error) {
    logger.warn({ error: String(error), traceDirectory }, "[TraceBundle] Failed to write transcript mirror");
  }
}

/** Finalize trace bundle after attempt completion. */
export function finalizeAttemptForIssue(
  worktreePath: string,
  issue: IssueEntry,
  patch: AttemptManifestPatch,
): void {
  const planVersion = issue.planVersion ?? 1;
  const executeAttempt = issue.executeAttempt ?? 1;
  const dir = traceDir(worktreePath, planVersion, executeAttempt);

  if (!existsSync(dir)) return;

  captureWorkspaceDelta(dir, worktreePath);
  const transcriptEntries = readTranscript(issue.id, planVersion, executeAttempt);
  writeTranscriptMirror(dir, transcriptEntries);
  const railsFiles = writeRailsArtifact(dir, worktreePath, issue);
  const similarTraceFiles = finalizeSimilarTraceSelectionArtifact(dir, worktreePath, patch);
  const handoffFiles = writeHandoffArtifacts(dir, issue, patch, transcriptEntries);
  finalizeAttemptManifest(dir, {
    ...patch,
    files: {
      ...(patch.files ?? {}),
      ...railsFiles,
      ...similarTraceFiles,
      ...handoffFiles,
    },
  });
}
