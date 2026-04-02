import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueEntry } from "../src/types.ts";
import { buildRetryContext } from "../src/agents/prompt-builder.ts";
import { computeCrossAttemptAnalysis, persistCrossAttemptAnalysis } from "../src/domains/cross-attempt-analysis.ts";
import {
  buildInitialAttemptManifest,
  ensureTraceDir,
  finalizeAttemptForIssue,
  loadAttemptManifest,
  writeAttemptManifest,
  writeTranscriptMirror,
} from "../src/domains/trace-bundle.ts";

function makeIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  return {
    id: "trace-int-1",
    identifier: "TRACE-INT-1",
    title: "Persist traces across retries",
    description: "exercise trace persistence",
    state: "Running",
    labels: [],
    blockedBy: [],
    assignedToWorker: false,
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    history: [],
    attempts: 1,
    maxAttempts: 3,
    planVersion: 1,
    executeAttempt: 1,
    reviewAttempt: 0,
    ...overrides,
  } as IssueEntry;
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fifony-trace-int-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "tests@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Tests"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "src.ts"), "export const status = 'old';\n", "utf8");
  execSync("git add src.ts", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("trace persistence integration", () => {
  it("persists attempt artifacts and enriches retry context with trace references", () => {
    const repo = initRepo();
    try {
      const firstAttempt = makeIssue({ executeAttempt: 1, attempts: 1 });
      const traceA1 = ensureTraceDir(repo, 1, 1)!;
      writeAttemptManifest(traceA1, buildInitialAttemptManifest(firstAttempt, "claude", "executor"));
      writeFileSync(join(traceA1, "turns", "01.directive.json"), JSON.stringify({ status: "failed" }, null, 2), "utf8");
      mkdirSync(join(repo, "outputs"), { recursive: true });
      writeFileSync(join(repo, "outputs", "execute.v1a1.t1.stdout.log"), "compile failed", "utf8");
      writeFileSync(join(repo, "src.ts"), "export const status = 'new';\n", "utf8");
      writeTranscriptMirror(traceA1, [{
        ts: "2026-04-02T00:00:10.000Z",
        turn: 1,
        role: "executor",
        provider: "claude",
        model: "claude-opus-4.6",
        directiveStatus: "failed",
        directiveSummary: "compile failed",
        exitCode: 1,
        success: false,
        outputPreview: "compile failed",
      }]);
      finalizeAttemptForIssue(repo, firstAttempt, {
        outcome: "failure",
        nextIssueState: "Blocked",
        exitCode: 1,
        error: "TypeScript compilation failed",
        rawOutputs: ["outputs/execute.v1a1.t1.stdout.log"],
      });

      const manifest = loadAttemptManifest(traceA1);
      assert.equal(manifest?.outcome, "failure");
      assert.equal(manifest?.nextIssueState, "Blocked");
      assert.ok(existsSync(join(traceA1, "diff.patch")), "diff patch should exist");
      assert.match(readFileSync(join(traceA1, "changed-files.json"), "utf8"), /src\.ts/);

      const retryIssue = makeIssue({
        executeAttempt: 2,
        attempts: 2,
        previousAttemptSummaries: [
          {
            planVersion: 1,
            executeAttempt: 1,
            phase: "execute",
            error: "TypeScript compilation failed",
            timestamp: "2026-04-02T00:00:30.000Z",
            insight: {
              errorType: "typescript",
              rootCause: "TypeScript compilation failed",
              filesInvolved: ["src.ts"],
              suggestion: "inspect the previous patch before retrying",
            },
          },
        ],
      });
      const traceA2 = ensureTraceDir(repo, 1, 2)!;
      writeAttemptManifest(traceA2, buildInitialAttemptManifest(retryIssue, "claude", "executor"));
      const analysis = computeCrossAttemptAnalysis(repo, 1, 2, retryIssue.previousAttemptSummaries);
      persistCrossAttemptAnalysis(traceA2, analysis);

      const retryContext = buildRetryContext(retryIssue, repo);
      assert.match(retryContext, /Cross-Attempt Patterns/);
      assert.match(retryContext, /traces\/v1a1\/attempt\.json/);
      assert.match(retryContext, /traces\/v1a1\/turns\/01\.directive\.json/);
      assert.match(retryContext, /traces\/v1a1\/diff\.patch/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
