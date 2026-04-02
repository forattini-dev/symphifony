import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IssueEntry } from "../src/types.ts";
import {
  buildInitialAttemptManifest,
  captureWorkspaceDelta,
  ensureTraceDir,
  finalizeAttemptManifest,
  loadAttemptManifest,
  writeAttemptManifest,
  writeTranscriptMirror,
} from "../src/domains/trace-bundle.ts";

function makeIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  return {
    id: "trace-issue-1",
    identifier: "TRACE-1",
    title: "Trace issue",
    description: "Trace persistence",
    state: "Running",
    labels: [],
    blockedBy: [],
    assignedToWorker: false,
    createdAt: "2026-04-02T00:00:00.000Z",
    updatedAt: "2026-04-02T00:00:00.000Z",
    history: [],
    attempts: 0,
    maxAttempts: 3,
    planVersion: 1,
    executeAttempt: 1,
    reviewAttempt: 0,
    ...overrides,
  } as IssueEntry;
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fifony-trace-bundle-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "tests@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Tests"', { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "app.ts"), "export const value = 1;\n", "utf8");
  execSync("git add app.ts", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("trace bundle", () => {
  it("creates trace directory structure and writes/finalizes manifest", () => {
    const repo = initRepo();
    try {
      const traceDirectory = ensureTraceDir(repo, 1, 1);
      assert.ok(traceDirectory, "trace directory should be created");
      assert.ok(existsSync(join(traceDirectory!, "turns")), "turns directory should exist");

      const manifest = buildInitialAttemptManifest(makeIssue(), "claude", "executor");
      writeAttemptManifest(traceDirectory!, manifest);
      finalizeAttemptManifest(traceDirectory!, {
        outcome: "failure",
        nextIssueState: "Blocked",
        exitCode: 1,
        rawOutputs: ["outputs/execute.v1a1.t1.stdout.log"],
      });

      const loaded = loadAttemptManifest(traceDirectory!);
      assert.equal(loaded?.provider, "claude");
      assert.equal(loaded?.outcome, "failure");
      assert.equal(loaded?.nextIssueState, "Blocked");
      assert.deepEqual(loaded?.rawOutputs, ["outputs/execute.v1a1.t1.stdout.log"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("captures workspace delta and persists changed file artifacts", () => {
    const repo = initRepo();
    try {
      const traceDirectory = ensureTraceDir(repo, 1, 1)!;
      writeAttemptManifest(traceDirectory, buildInitialAttemptManifest(makeIssue(), "claude", "executor"));
      writeFileSync(join(repo, "app.ts"), "export const value = 2;\n", "utf8");

      captureWorkspaceDelta(traceDirectory, repo);

      const changedFiles = JSON.parse(readFileSync(join(traceDirectory, "changed-files.json"), "utf8")) as string[];
      const diffStat = readFileSync(join(traceDirectory, "diff.stat"), "utf8");
      const diffPatch = readFileSync(join(traceDirectory, "diff.patch"), "utf8");
      const manifest = loadAttemptManifest(traceDirectory);

      assert.deepEqual(changedFiles, ["app.ts"]);
      assert.match(diffStat, /app\.ts/);
      assert.match(diffPatch, /export const value = 2/);
      assert.equal(manifest?.files.diffPatch, "diff.patch");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writes transcript mirror from canonical transcript entries", () => {
    const repo = initRepo();
    try {
      const traceDirectory = ensureTraceDir(repo, 1, 1)!;
      writeTranscriptMirror(traceDirectory, [
        {
          ts: "2026-04-02T00:00:00.000Z",
          turn: 1,
          role: "executor",
          provider: "claude",
          model: "claude-opus-4.6",
          directiveStatus: "continue",
          directiveSummary: "Need another turn",
          exitCode: 0,
          success: true,
          outputPreview: "working",
          tokens: { input: 100, output: 25, total: 125 },
        },
      ]);

      const lines = readFileSync(join(traceDirectory, "transcript.jsonl"), "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]!) as { provider: string; directiveStatus: string; tokens: { total: number } };
      assert.equal(entry.provider, "claude");
      assert.equal(entry.directiveStatus, "continue");
      assert.equal(entry.tokens.total, 125);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
