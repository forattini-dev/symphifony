import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptSummary } from "../src/types.ts";
import {
  computeCrossAttemptAnalysis,
  loadCrossAttemptAnalysis,
  persistCrossAttemptAnalysis,
} from "../src/domains/cross-attempt-analysis.ts";
import { ensureTraceDir, writeAttemptManifest } from "../src/domains/trace-bundle.ts";

function attemptSummary(executeAttempt: number, errorType = "typescript"): AttemptSummary {
  return {
    planVersion: 1,
    executeAttempt,
    phase: "execute",
    error: `${errorType} failure`,
    timestamp: `2026-04-02T00:0${executeAttempt}:00.000Z`,
    insight: {
      errorType,
      rootCause: `${errorType} failure`,
      filesInvolved: ["src/app.ts"],
      suggestion: "try another approach",
    },
  };
}

describe("cross-attempt analysis", () => {
  it("detects repeated failures, overlap, and outcome transitions from trace artifacts", () => {
    const workspace = mkdtempSync(join(tmpdir(), "fifony-cross-attempt-"));
    try {
      const traceA1 = ensureTraceDir(workspace, 1, 1)!;
      const traceA2 = ensureTraceDir(workspace, 1, 2)!;
      writeAttemptManifest(traceA1, {
        manifestVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "ISSUE-1",
        planVersion: 1,
        executeAttempt: 1,
        provider: "claude",
        role: "executor",
        startedAt: "2026-04-02T00:01:00.000Z",
        outcome: "failure",
        nextIssueState: "Blocked",
        files: {
          attemptManifest: "attempt.json",
          transcript: "transcript.jsonl",
          turnsDir: "turns",
          changedFiles: "changed-files.json",
          diffStat: "diff.stat",
          rawOutputTemplate: "outputs/execute.v1a1.t{turn}.stdout.log",
        },
        rawOutputs: [],
      });
      writeAttemptManifest(traceA2, {
        manifestVersion: 1,
        issueId: "issue-1",
        issueIdentifier: "ISSUE-1",
        planVersion: 1,
        executeAttempt: 2,
        provider: "claude",
        role: "executor",
        startedAt: "2026-04-02T00:02:00.000Z",
        outcome: "failure",
        nextIssueState: "Blocked",
        files: {
          attemptManifest: "attempt.json",
          transcript: "transcript.jsonl",
          turnsDir: "turns",
          changedFiles: "changed-files.json",
          diffStat: "diff.stat",
          rawOutputTemplate: "outputs/execute.v1a2.t{turn}.stdout.log",
        },
        rawOutputs: [],
      });
      writeFileSync(join(traceA1, "changed-files.json"), JSON.stringify(["src/app.ts", "src/util.ts"], null, 2), "utf8");
      writeFileSync(join(traceA2, "changed-files.json"), JSON.stringify(["src/app.ts", "README.md"], null, 2), "utf8");
      writeFileSync(join(traceA1, "diff.stat"), " src/app.ts | 2 +-\n src/util.ts | 1 +\n", "utf8");
      writeFileSync(join(traceA2, "diff.stat"), " src/app.ts | 5 +++--\n README.md | 1 +\n", "utf8");

      const analysis = computeCrossAttemptAnalysis(workspace, 1, 3, [attemptSummary(1), attemptSummary(2)]);
      assert.deepEqual(analysis.repeatedFailureTypes, ["typescript"]);
      assert.deepEqual(analysis.changedFileOverlap, ["src/app.ts"]);
      assert.equal(analysis.outcomeTransitions.length, 2);
      assert.match(analysis.summary.join("\n"), /Recent outcome transition/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("falls back to previous attempt summaries when trace artifacts are missing", () => {
    const workspace = mkdtempSync(join(tmpdir(), "fifony-cross-fallback-"));
    try {
      const analysis = computeCrossAttemptAnalysis(workspace, 1, 3, [
        attemptSummary(1, "shell"),
        attemptSummary(2, "shell"),
      ]);
      assert.deepEqual(analysis.repeatedFailureTypes, ["shell"]);
      assert.equal(analysis.outcomeTransitions[0]?.outcome, "failure");
      assert.deepEqual(analysis.changedFileOverlap, []);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("returns empty-pattern analysis on first attempt and persists artifacts", () => {
    const workspace = mkdtempSync(join(tmpdir(), "fifony-cross-first-"));
    try {
      const analysis = computeCrossAttemptAnalysis(workspace, 1, 1, []);
      assert.deepEqual(analysis.repeatedFailureTypes, []);
      assert.deepEqual(analysis.changedFileOverlap, []);
      assert.match(analysis.summary[0]!, /No previous attempt artifacts/);

      const traceDirectory = ensureTraceDir(workspace, 1, 1)!;
      persistCrossAttemptAnalysis(traceDirectory, analysis);
      const loaded = loadCrossAttemptAnalysis(traceDirectory);
      assert.deepEqual(loaded?.repeatedFailureTypes, []);
      assert.equal(loaded?.summary[0], analysis.summary[0]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
