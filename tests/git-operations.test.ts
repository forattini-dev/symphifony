/**
 * Git operations tests.
 *
 * Covers pure utility functions (parseDiffStats, shouldSkipMergePath) and
 * integration tests with real temporary git repositories for worktree
 * management, diff computation, merge, conflict handling, cleanup,
 * and PR helper functions.
 *
 * Run with: pnpm test
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { IssueEntry, RuntimeState } from "../src/types.ts";

// ── Temp repo bootstrap (BEFORE importing modules that read TARGET_ROOT) ─────

const TEST_ROOT = mkdtempSync(join(tmpdir(), "fifony-git-test-"));
const WORKTREE_BASE = mkdtempSync(join(tmpdir(), "fifony-wt-test-"));
const PERSIST_ROOT = mkdtempSync(join(tmpdir(), "fifony-persist-test-"));

process.env.FIFONY_WORKSPACE_ROOT = TEST_ROOT;
process.env.FIFONY_PERSISTENCE = PERSIST_ROOT;
process.env.FIFONY_LOG_LEVEL = "silent";

// Dynamic import — TARGET_ROOT and WORKSPACE_ROOT now point to our temp dirs
const {
  assertIssueHasGitWorktree,
  parseDiffStats,
  shouldSkipMergePath,
  detectDefaultBranch,
  createGitWorktree,
  createTestWorkspace,
  ensureGitRepoReadyForWorktrees,
  ensureWorktreeCommitted,
  getGitRepoStatus,
  initializeGitRepoForWorktrees,
  inferChangedWorkspacePaths,
  computeDiffStats,
  mergeWorkspace,
  cleanWorkspace,
  dryMerge,
  removeTestWorkspace,
  rebaseWorktree,
} = await import("../src/domains/workspace.ts");

const {
  isGhAvailable,
  getCompareUrl,
} = await import("../src/commands/push-workspace.command.ts");

// ── Helpers ──────────────────────────────────────────────────────────────────

function git(args: string, cwd = TEST_ROOT): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

let issueCounter = 0;
function makeIssue(overrides: Partial<IssueEntry> = {}): IssueEntry {
  return {
    id: `test-${++issueCounter}-${Date.now()}`,
    identifier: overrides.identifier ?? `TEST-${issueCounter}`,
    title: "Test issue",
    description: "Test description",
    state: "Approved",
    labels: [],
    blockedBy: [],
    assignedToWorker: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [],
    attempts: 0,
    maxAttempts: 3,
    planVersion: 0,
    executeAttempt: 0,
    reviewAttempt: 0,
    ...overrides,
  } as IssueEntry;
}

function makeState(): RuntimeState {
  return {
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trackerKind: "filesystem",
    sourceRepoUrl: "",
    sourceRef: "",
    config: {
      pollIntervalMs: 5000,
      workerConcurrency: 1,
      maxConcurrentByState: {},
      commandTimeoutMs: 120_000,
      maxAttemptsDefault: 3,
      maxTurns: 1,
      retryDelayMs: 5000,
      staleInProgressTimeoutMs: 600_000,
      logLinesTail: 100,
      maxPreviousOutputChars: 4000,
      agentProvider: "claude",
      agentCommand: "",
      defaultEffort: { reasoning: "medium" },
      runMode: "filesystem",
      autoReviewApproval: true,
      afterCreateHook: "",
      beforeRunHook: "",
      afterRunHook: "",
      beforeRemoveHook: "",
    },
    issues: [],
    events: [],
    metrics: {
      total: 0, planning: 0, planned: 0, queued: 0, running: 0,
      reviewing: 0, reviewed: 0, blocked: 0, done: 0, merged: 0, cancelled: 0,
    },
    notes: [],
  } as RuntimeState;
}

// ── Initialize test repository ───────────────────────────────────────────────

mkdirSync(join(TEST_ROOT, "src"), { recursive: true });
git("init");
git("config user.email 'test@fifony.dev'");
git("config user.name 'Fifony Test'");
git("remote add origin https://github.com/test-org/test-project.git");
writeFileSync(join(TEST_ROOT, "README.md"), "# Test Project\n");
writeFileSync(join(TEST_ROOT, "src/index.ts"), 'console.log("hello");\n');
writeFileSync(join(TEST_ROOT, "src/utils.ts"), "export const add = (a: number, b: number) => a + b;\n");
git("add -A");
git('commit -m "initial commit"');

// ── Cleanup ──────────────────────────────────────────────────────────────────

after(() => {
  // Remove all worktrees first (git worktree list)
  try {
    const worktreeList = git("worktree list --porcelain");
    for (const line of worktreeList.split("\n")) {
      if (line.startsWith("worktree ") && !line.includes(TEST_ROOT + "\n") && line.trim() !== `worktree ${TEST_ROOT}`) {
        const wtPath = line.replace("worktree ", "").trim();
        if (wtPath !== TEST_ROOT) {
          try { git(`worktree remove --force "${wtPath}"`); } catch { /* best effort */ }
        }
      }
    }
  } catch { /* best effort */ }

  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
  try { rmSync(WORKTREE_BASE, { recursive: true, force: true }); } catch {}
  try { rmSync(PERSIST_ROOT, { recursive: true, force: true }); } catch {}
});


// ══════════════════════════════════════════════════════════════════════════════
// parseDiffStats — pure function, no git needed
// ══════════════════════════════════════════════════════════════════════════════

describe("parseDiffStats", () => {
  it("parses single file with insertions only", () => {
    const issue = makeIssue();
    parseDiffStats(issue, " src/index.ts | 5 +++++\n 1 file changed, 5 insertions(+)");
    assert.equal(issue.filesChanged, 1);
    assert.equal(issue.linesAdded, 5);
    assert.equal(issue.linesRemoved, 0);
  });

  it("parses single file with deletions only", () => {
    const issue = makeIssue();
    parseDiffStats(issue, " src/old.ts | 10 ----------\n 1 file changed, 10 deletions(-)");
    assert.equal(issue.filesChanged, 1);
    assert.equal(issue.linesAdded, 0);
    assert.equal(issue.linesRemoved, 10);
  });

  it("parses singular forms (1 insertion, 1 deletion)", () => {
    const issue = makeIssue();
    parseDiffStats(issue, " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)");
    assert.equal(issue.filesChanged, 1);
    assert.equal(issue.linesAdded, 1);
    assert.equal(issue.linesRemoved, 1);
  });

  it("parses multiple files with mixed changes", () => {
    const issue = makeIssue();
    const raw = [
      " src/index.ts    | 3 ++-",
      " src/utils.ts    | 7 ++++---",
      " tests/foo.test.ts | 20 ++++++++++++++++++++",
      " 3 files changed, 25 insertions(+), 5 deletions(-)",
    ].join("\n");
    parseDiffStats(issue, raw);
    assert.equal(issue.filesChanged, 3);
    assert.equal(issue.linesAdded, 25);
    assert.equal(issue.linesRemoved, 5);
  });

  it("filters internal fifony- prefixed files from file count", () => {
    const issue = makeIssue();
    const raw = [
      " src/index.ts      | 3 +++",
      " fifony-config.json | 2 ++",
      " 2 files changed, 5 insertions(+)",
    ].join("\n");
    parseDiffStats(issue, raw);
    assert.equal(issue.filesChanged, 1, "fifony-config.json should be filtered");
    assert.equal(issue.linesAdded, 5, "line counts come from summary, not filtered");
  });

  it("filters internal .fifony- prefixed files from file count", () => {
    const issue = makeIssue();
    const raw = [
      " src/app.ts    | 2 ++",
      " .fifony-env.sh | 1 +",
      " 2 files changed, 3 insertions(+)",
    ].join("\n");
    parseDiffStats(issue, raw);
    assert.equal(issue.filesChanged, 1, ".fifony-env.sh should be filtered");
  });

  it("filters internal fifony_ prefixed files from file count", () => {
    const issue = makeIssue();
    const raw = [
      " src/app.ts           | 2 ++",
      " fifony_workspace.json | 1 +",
      " 2 files changed, 3 insertions(+)",
    ].join("\n");
    parseDiffStats(issue, raw);
    assert.equal(issue.filesChanged, 1, "fifony_workspace.json should be filtered");
  });

  it("filters WORKFLOW.local files from file count", () => {
    const issue = makeIssue();
    const raw = [
      " src/app.ts      | 2 ++",
      " WORKFLOW.local   | 5 +++++",
      " 2 files changed, 7 insertions(+)",
    ].join("\n");
    parseDiffStats(issue, raw);
    assert.equal(issue.filesChanged, 1, "WORKFLOW.local should be filtered");
  });

  it("handles empty diff output gracefully", () => {
    const issue = makeIssue();
    parseDiffStats(issue, "");
    assert.equal(issue.filesChanged, 0);
    assert.equal(issue.linesAdded, 0);
    assert.equal(issue.linesRemoved, 0);
  });

  it("handles summary-only output (no per-file lines)", () => {
    const issue = makeIssue();
    parseDiffStats(issue, " 2 files changed, 10 insertions(+), 3 deletions(-)");
    assert.equal(issue.filesChanged, 2, "falls back to regex count when no per-file lines");
    assert.equal(issue.linesAdded, 10);
    assert.equal(issue.linesRemoved, 3);
  });

  it("handles large numbers", () => {
    const issue = makeIssue();
    parseDiffStats(issue, " 42 files changed, 1234 insertions(+), 5678 deletions(-)");
    assert.equal(issue.filesChanged, 42);
    assert.equal(issue.linesAdded, 1234);
    assert.equal(issue.linesRemoved, 5678);
  });

  it("handles binary files in diff output", () => {
    const issue = makeIssue();
    const raw = [
      " src/index.ts | 3 +++",
      " logo.png     | Bin 0 -> 1234 bytes",
      " 2 files changed, 3 insertions(+)",
    ].join("\n");
    parseDiffStats(issue, raw);
    assert.equal(issue.filesChanged, 2);
    assert.equal(issue.linesAdded, 3);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// shouldSkipMergePath — pure function, no git needed
// ══════════════════════════════════════════════════════════════════════════════

describe("shouldSkipMergePath", () => {
  // Segment-based skips
  it("skips .git paths", () => {
    assert.ok(shouldSkipMergePath(".git/config"));
    assert.ok(shouldSkipMergePath("deep/path/.git/HEAD"));
  });

  it("skips node_modules paths", () => {
    assert.ok(shouldSkipMergePath("node_modules/lodash/index.js"));
    assert.ok(shouldSkipMergePath("packages/lib/node_modules/foo/bar.js"));
  });

  it("skips .fifony directory paths", () => {
    assert.ok(shouldSkipMergePath(".fifony/state.json"));
    assert.ok(shouldSkipMergePath("nested/.fifony/config.ts"));
  });

  it("skips dist paths", () => {
    assert.ok(shouldSkipMergePath("dist/index.js"));
    assert.ok(shouldSkipMergePath("packages/lib/dist/main.js"));
  });

  it("skips .tanstack paths", () => {
    assert.ok(shouldSkipMergePath(".tanstack/react-router/manifest.json"));
  });

  // Filename-based skips
  it("skips WORKFLOW.local.md", () => {
    assert.ok(shouldSkipMergePath("WORKFLOW.local.md"));
    assert.ok(shouldSkipMergePath("docs/WORKFLOW.local.md"));
  });

  it("skips .fifony-env.sh", () => {
    assert.ok(shouldSkipMergePath(".fifony-env.sh"));
  });

  it("skips .fifony-compiled-env.sh", () => {
    assert.ok(shouldSkipMergePath(".fifony-compiled-env.sh"));
  });

  it("skips .fifony-local-source-ready", () => {
    assert.ok(shouldSkipMergePath(".fifony-local-source-ready"));
  });

  it("skips fifony- prefixed files", () => {
    assert.ok(shouldSkipMergePath("fifony-config.json"));
    assert.ok(shouldSkipMergePath("path/to/fifony-workspace.json"));
  });

  it("skips fifony_ prefixed files", () => {
    assert.ok(shouldSkipMergePath("fifony_meta.json"));
    assert.ok(shouldSkipMergePath("dir/fifony_state.json"));
  });

  // Files that should NOT be skipped
  it("does NOT skip normal source files", () => {
    assert.ok(!shouldSkipMergePath("src/index.ts"));
    assert.ok(!shouldSkipMergePath("README.md"));
    assert.ok(!shouldSkipMergePath("package.json"));
    assert.ok(!shouldSkipMergePath("tests/app.test.ts"));
    assert.ok(!shouldSkipMergePath("src/components/Button.tsx"));
  });

  it("does NOT skip files in a directory named like fifony but not an exact segment match", () => {
    // "my-fifony-app" as a directory — segment-level checks look for .git/node_modules/.fifony/dist/.tanstack
    // none match "my-fifony-app", so it's allowed; the basename "index.ts" also doesn't match
    assert.ok(!shouldSkipMergePath("src/my-fifony-app/index.ts"));
  });

  it("does NOT skip files that contain 'fifony' mid-name", () => {
    // basename "not-fifony-related.ts" starts with "not-", not "fifony-" or "fifony_"
    assert.ok(!shouldSkipMergePath("not-fifony-related.ts"));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// detectDefaultBranch
// ══════════════════════════════════════════════════════════════════════════════

describe("detectDefaultBranch", () => {
  it("detects the current branch of a git repo", () => {
    const expected = git("rev-parse --abbrev-ref HEAD");
    assert.equal(detectDefaultBranch(TEST_ROOT), expected);
  });

  it("returns 'main' for non-git directories", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "non-git-"));
    try {
      assert.equal(detectDefaultBranch(tempDir), "main");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("detects custom branch names", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "custom-branch-"));
    try {
      execSync("git init", { cwd: tempDir, stdio: "pipe" });
      execSync("git config user.email 'test@test.com'", { cwd: tempDir, stdio: "pipe" });
      execSync("git config user.name 'Test'", { cwd: tempDir, stdio: "pipe" });
      writeFileSync(join(tempDir, "file.txt"), "test");
      execSync("git add -A", { cwd: tempDir, stdio: "pipe" });
      execSync('git commit -m "init"', { cwd: tempDir, stdio: "pipe" });
      execSync("git checkout -b develop", { cwd: tempDir, stdio: "pipe" });
      assert.equal(detectDefaultBranch(tempDir), "develop");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("git readiness helpers", () => {
  it("reports non-git directories as not ready", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "git-ready-none-"));
    try {
      assert.deepEqual(getGitRepoStatus(tempDir), {
        isGit: false,
        hasCommits: false,
        branch: null,
      });
      assert.throws(
        () => ensureGitRepoReadyForWorktrees(tempDir, "execute issues"),
        /requires a git repository with at least one commit/i,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports repositories without commits as not ready", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "git-ready-unborn-"));
    try {
      try {
        execSync("git init -b main", { cwd: tempDir, stdio: "pipe" });
      } catch {
        execSync("git init", { cwd: tempDir, stdio: "pipe" });
      }
      const status = getGitRepoStatus(tempDir);
      assert.equal(status.isGit, true);
      assert.equal(status.hasCommits, false);
      assert.ok(status.branch === "main" || status.branch === "master");
      assert.throws(
        () => ensureGitRepoReadyForWorktrees(tempDir, "execute issues"),
        /requires at least one commit/i,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("bootstraps git and the initial commit when requested", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "git-ready-bootstrap-"));
    try {
      const status = initializeGitRepoForWorktrees(tempDir);
      assert.equal(status.isGit, true);
      assert.equal(status.hasCommits, true);
      assert.ok(status.branch === "main" || status.branch === "master");
      assert.doesNotThrow(() => ensureGitRepoReadyForWorktrees(tempDir, "execute issues"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("explains when an issue has no git worktree metadata", () => {
    const issue = makeIssue({ branchName: undefined, baseBranch: "main", worktreePath: undefined });
    assert.throws(
      () => assertIssueHasGitWorktree(issue, "merge"),
      /executed before git was initialized/i,
    );
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Git worktree lifecycle: create → modify → commit → diff → merge → clean
// ══════════════════════════════════════════════════════════════════════════════

describe("git worktree lifecycle", () => {
  const issue = makeIssue({ identifier: "LIFECYCLE-001" });
  const baseBranch = git("rev-parse --abbrev-ref HEAD");
  const workspacePath = join(WORKTREE_BASE, "lifecycle");
  const worktreePath = join(workspacePath, "worktree");

  it("createGitWorktree creates a worktree with correct metadata", async () => {
    mkdirSync(workspacePath, { recursive: true });
    await createGitWorktree(issue, worktreePath, baseBranch);

    // Worktree directory exists with files from base
    assert.ok(existsSync(worktreePath), "worktree directory should exist");
    assert.ok(existsSync(join(worktreePath, "README.md")), "README.md should be in worktree");
    assert.ok(existsSync(join(worktreePath, "src/index.ts")), "src/index.ts should be in worktree");

    // Issue metadata populated correctly
    assert.equal(issue.branchName, `fifony/${issue.id}`);
    assert.equal(issue.baseBranch, baseBranch);
    assert.equal(issue.worktreePath, worktreePath);
    assert.ok(issue.headCommitAtStart, "headCommitAtStart should be set");
    assert.match(issue.headCommitAtStart!, /^[0-9a-f]{40}$/, "should be a valid 40-char SHA");
  });

  it("writes excludes file to worktree git dir with correct patterns", () => {
    // The excludes file is written to $WORKTREE_GIT_DIR/info/exclude
    // Note: git may not honor per-worktree info/exclude (it's per-repo), but
    // we verify the file IS written with correct content at the correct path.
    const gitFileContent = readFileSync(join(worktreePath, ".git"), "utf8").trim();
    const gitDirRel = gitFileContent.replace("gitdir: ", "").trim();
    // Must use resolve() not join() — gitDirRel is typically an absolute path
    const gitDirPath = resolve(worktreePath, gitDirRel);
    const excludesPath = join(gitDirPath, "info", "exclude");

    assert.ok(existsSync(excludesPath), "excludes file should exist at " + excludesPath);
    const content = readFileSync(excludesPath, "utf8");
    assert.ok(content.includes("fifony-"), "excludes should block fifony-*");
    assert.ok(content.includes(".fifony-"), "excludes should block .fifony-*");
    assert.ok(content.includes("fifony_"), "excludes should block fifony_*");
  });

  it("ensureWorktreeCommitted is a no-op when nothing changed", () => {
    ensureWorktreeCommitted(issue);
    const status = git("status --porcelain", worktreePath);
    assert.equal(status, "", "worktree should remain clean");
  });

  it("ensureWorktreeCommitted commits pending changes", () => {
    // Make changes in the worktree
    mkdirSync(join(worktreePath, "src"), { recursive: true });
    writeFileSync(join(worktreePath, "src/new-feature.ts"), 'export function greet() { return "hi"; }\n');
    writeFileSync(join(worktreePath, "src/index.ts"), 'import { greet } from "./new-feature";\nconsole.log(greet());\n');

    ensureWorktreeCommitted(issue);

    const status = git("status --porcelain", worktreePath);
    assert.equal(status, "", "no uncommitted changes should remain");

    const lastMsg = git("log -1 --format=%s", worktreePath);
    assert.ok(lastMsg.includes("fifony:"), "commit message should contain 'fifony:'");
    assert.ok(lastMsg.includes(issue.identifier), "commit message should contain identifier");
  });

  it("inferChangedWorkspacePaths returns changed file list", () => {
    const paths = inferChangedWorkspacePaths(worktreePath, 32, issue);
    assert.ok(paths.length > 0, "should have changed files");
    assert.ok(paths.includes("src/new-feature.ts"), "should include new file");
    assert.ok(paths.includes("src/index.ts"), "should include modified file");
  });

  it("inferChangedWorkspacePaths respects limit parameter", () => {
    const paths = inferChangedWorkspacePaths(worktreePath, 1, issue);
    assert.equal(paths.length, 1, "should return at most 1 path");
  });

  it("inferChangedWorkspacePaths returns empty array when baseBranch is missing", () => {
    const noBase = makeIssue({ baseBranch: undefined });
    assert.deepEqual(inferChangedWorkspacePaths(worktreePath, 32, noBase), []);
  });

  it("inferChangedWorkspacePaths returns empty array when branchName is missing", () => {
    const noBranch = makeIssue({ branchName: undefined, baseBranch: "main" });
    assert.deepEqual(inferChangedWorkspacePaths(worktreePath, 32, noBranch), []);
  });

  it("computeDiffStats populates lines added/removed/files changed", () => {
    computeDiffStats(issue);
    assert.ok(typeof issue.filesChanged === "number" && issue.filesChanged > 0, "filesChanged > 0");
    assert.ok(typeof issue.linesAdded === "number" && issue.linesAdded > 0, "linesAdded > 0");
    assert.ok(typeof issue.linesRemoved === "number", "linesRemoved should be a number");
  });

  it("computeDiffStats is a no-op without baseBranch", () => {
    const noBase = makeIssue();
    computeDiffStats(noBase);
    assert.equal(noBase.filesChanged, undefined);
    assert.equal(noBase.linesAdded, undefined);
  });

  it("mergeWorkspace succeeds with no conflicts", () => {
    issue.workspacePath = workspacePath;
    const result = mergeWorkspace(issue);

    assert.ok(result.copied.length > 0, "should list copied files");
    assert.equal(result.conflicts.length, 0, "no conflicts");

    // Merged file exists in target
    assert.ok(existsSync(join(TEST_ROOT, "src/new-feature.ts")), "new file should appear in target");

    // Verify merge commit
    const currentBranch = git("rev-parse --abbrev-ref HEAD");
    assert.equal(currentBranch, baseBranch, "should stay on base branch");

    const lastMsg = git("log -1 --format=%s");
    assert.ok(lastMsg.includes("fifony: merge"), "merge commit should exist");
  });

  it("merge result includes correct copied and deleted lists", () => {
    // We already have the merge result from the previous test; re-run with a fresh worktree
    const issue2 = makeIssue({ identifier: "RESULT-001" });
    const ws2 = join(WORKTREE_BASE, "result-check");
    const wt2 = join(ws2, "worktree");
    mkdirSync(ws2, { recursive: true });

    createGitWorktree(issue2, wt2, baseBranch);
    // Add a file and delete one
    writeFileSync(join(wt2, "added.txt"), "new content\n");
    rmSync(join(wt2, "README.md"));
    git("add -A", wt2);
    git('commit -m "add and delete files"', wt2);

    issue2.workspacePath = ws2;
    const result = mergeWorkspace(issue2);

    assert.ok(result.copied.some(f => f.includes("added.txt")), "copied should include added.txt");
    assert.ok(result.deleted.some(f => f.includes("README.md")), "deleted should include README.md");
    assert.equal(result.conflicts.length, 0);

    // Clean up
    cleanWorkspace(issue2.id, issue2, makeState());
  });

  it("cleanWorkspace removes worktree and deletes branch", async () => {
    const cleanIssue = makeIssue({ identifier: "CLEAN-001" });
    const cleanWs = join(WORKTREE_BASE, "cleanup");
    const cleanWt = join(cleanWs, "worktree");
    mkdirSync(cleanWs, { recursive: true });
    await createGitWorktree(cleanIssue, cleanWt, baseBranch);
    cleanIssue.workspacePath = cleanWs;

    assert.ok(existsSync(cleanWt), "worktree should exist before cleanup");

    await cleanWorkspace(cleanIssue.id, cleanIssue, makeState());

    assert.ok(!existsSync(cleanWt), "worktree directory should be removed");

    // Branch should be gone
    try {
      git(`rev-parse --verify "${cleanIssue.branchName}"`);
      assert.fail("branch should have been deleted");
    } catch {
      // Expected — branch no longer exists
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Merge conflict handling
// ══════════════════════════════════════════════════════════════════════════════

describe("merge conflict handling", () => {
  it("returns conflicts and aborts merge when files conflict", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "CONFLICT-001" });
    const ws = join(WORKTREE_BASE, "conflict");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    // Modify src/utils.ts in the worktree
    writeFileSync(join(wt, "src/utils.ts"), "export const add = (a: number, b: number) => a + b + 0; // worktree\n");
    git("add -A", wt);
    git('commit -m "worktree: modify utils"', wt);

    // Modify the SAME file on the base branch (creates conflict)
    writeFileSync(join(TEST_ROOT, "src/utils.ts"), "export const add = (a: number, b: number) => a + b + 1; // base\n");
    git("add -A");
    git('commit -m "base: modify utils for conflict"');

    // Merge should result in conflicts
    const result = mergeWorkspace(issue);
    assert.ok(result.conflicts.length > 0, "should have conflicts");
    assert.ok(result.conflicts.some(f => f.includes("utils.ts")), "utils.ts should be in conflicts");

    // Working tree should be clean after abort
    const status = git("status --porcelain");
    assert.equal(status, "", "merge should be aborted, tree clean");

    await cleanWorkspace(issue.id, issue, makeState());
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// mergeWorkspace guards
// ══════════════════════════════════════════════════════════════════════════════

describe("mergeWorkspace guards", () => {
  it("throws when issue has no branchName", () => {
    const issue = makeIssue({ branchName: undefined, baseBranch: "main", worktreePath: "/tmp/x" });
    assert.throws(() => mergeWorkspace(issue), /no git worktree/i);
  });

  it("throws when issue has no baseBranch", () => {
    const issue = makeIssue({ branchName: "fifony/test", baseBranch: undefined, worktreePath: "/tmp/x" });
    assert.throws(() => mergeWorkspace(issue), /no git worktree/i);
  });

  it("throws when issue has no worktreePath", () => {
    const issue = makeIssue({ branchName: "fifony/test", baseBranch: "main", worktreePath: undefined });
    assert.throws(() => mergeWorkspace(issue), /no git worktree/i);
  });

  it("throws when current branch differs from baseBranch", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "WRONG-BR-001" });
    const ws = join(WORKTREE_BASE, "wrong-branch");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "temp.txt"), "test\n");
    git("add -A", wt);
    git('commit -m "add temp file"', wt);

    // Switch TARGET_ROOT to a different branch
    git("checkout -b temp-other-branch");

    try {
      assert.throws(
        () => mergeWorkspace(issue),
        (err: Error) => err.message.includes("current branch is temp-other-branch"),
      );
    } finally {
      git(`checkout ${baseBranch}`);
      try { git("branch -D temp-other-branch"); } catch {}
      await cleanWorkspace(issue.id, issue, makeState());
    }
  });

  it("throws when target repo has uncommitted changes", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "DIRTY-001" });
    const ws = join(WORKTREE_BASE, "dirty");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "another.txt"), "test\n");
    git("add -A", wt);
    git('commit -m "add another"', wt);

    // Create uncommitted file in TARGET_ROOT
    writeFileSync(join(TEST_ROOT, "dirty-file.txt"), "uncommitted");

    try {
      assert.throws(
        () => mergeWorkspace(issue, true, false),
        /uncommitted changes/,
      );
    } finally {
      rmSync(join(TEST_ROOT, "dirty-file.txt"), { force: true });
      await cleanWorkspace(issue.id, issue, makeState());
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// createGitWorktree retry (idempotency via -B flag)
// ══════════════════════════════════════════════════════════════════════════════

describe("createGitWorktree retry", () => {
  it("re-creating a worktree for the same issue succeeds (-B resets branch)", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "RETRY-001" });
    const ws = join(WORKTREE_BASE, "retry");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });

    // First creation
    await createGitWorktree(issue, wt, baseBranch);
    assert.ok(existsSync(wt));

    // Remove worktree but keep branch
    git(`worktree remove --force "${wt}"`);
    assert.ok(!existsSync(wt));

    // Second creation — -B flag should reset the branch
    await createGitWorktree(issue, wt, baseBranch);
    assert.ok(existsSync(wt), "worktree should be recreated");

    issue.workspacePath = ws;
    await cleanWorkspace(issue.id, issue, makeState());
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// isolated test workspace lifecycle
// ══════════════════════════════════════════════════════════════════════════════

describe("isolated test workspace lifecycle", () => {
  it("creates an isolated test workspace without touching TARGET_ROOT", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "TEST-WS-001" });
    const ws = join(WORKTREE_BASE, "test-workspace-lifecycle");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "isolated-feature.ts"), "export const isolated = true;\n");
    git("add -A", wt);
    git('commit -m "add isolated feature"', wt);

    const headBefore = git("rev-parse HEAD");
    const statusBefore = git("status --porcelain");

    const testWt = createTestWorkspace(issue);

    assert.ok(existsSync(testWt), "isolated test workspace should exist");
    assert.equal(issue.testApplied, true, "issue should track active test workspace");
    assert.equal(issue.testWorkspacePath, testWt);
    assert.ok(existsSync(join(testWt, "isolated-feature.ts")), "test workspace should contain issue changes");

    assert.equal(git("rev-parse HEAD"), headBefore, "TARGET_ROOT HEAD must not change");
    assert.equal(git("status --porcelain"), statusBefore, "TARGET_ROOT must stay clean");
    assert.ok(!existsSync(join(TEST_ROOT, "isolated-feature.ts")), "issue file must not appear in TARGET_ROOT");

    removeTestWorkspace(issue);
    assert.equal(issue.testApplied, false, "test workspace flag should be cleared");
    assert.equal(issue.testWorkspacePath, undefined, "test workspace path should be cleared");
    assert.ok(!existsSync(testWt), "isolated test workspace should be removed");

    await cleanWorkspace(issue.id, issue, makeState());
  });

  it("cleanWorkspace removes an active isolated test workspace together with the main worktree", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "TEST-WS-CLEANUP" });
    const ws = join(WORKTREE_BASE, "test-workspace-cleanup");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "cleanup-feature.ts"), "export const cleanup = true;\n");
    git("add -A", wt);
    git('commit -m "add cleanup feature"', wt);

    const testWt = createTestWorkspace(issue);
    assert.ok(existsSync(testWt), "isolated test workspace should exist before cleanup");

    await cleanWorkspace(issue.id, issue, makeState());

    assert.ok(!existsSync(wt), "main issue worktree should be removed");
    assert.ok(!existsSync(testWt), "isolated test workspace should be removed");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// cleanWorkspace edge cases
// ══════════════════════════════════════════════════════════════════════════════

describe("cleanWorkspace edge cases", () => {
  it("is a no-op when workspace path does not exist", async () => {
    // Should not throw
    await cleanWorkspace("nonexistent-id", null, makeState());
  });

  it("handles already-removed worktree directory gracefully", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "ALREADY-GONE-001" });
    const ws = join(WORKTREE_BASE, "already-gone");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    // Manually nuke the worktree directory
    rmSync(wt, { recursive: true, force: true });

    // cleanWorkspace should handle this gracefully
    await cleanWorkspace(issue.id, issue, makeState());

    // Branch should still be cleaned up
    try {
      git(`rev-parse --verify "${issue.branchName}"`);
      assert.fail("branch should have been deleted");
    } catch {
      // Expected
    }
  });

  it("handles issue with no branchName by falling back to rmSync", async () => {
    const ws = join(WORKTREE_BASE, "no-branch");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "sentinel.txt"), "exists");

    const issue = makeIssue({ workspacePath: ws });
    // No branchName or worktreePath — goes through the legacy cleanup path
    await cleanWorkspace(issue.id, issue, makeState());

    assert.ok(!existsSync(ws), "workspace directory should be removed");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// ensureWorktreeCommitted edge cases
// ══════════════════════════════════════════════════════════════════════════════

describe("ensureWorktreeCommitted edge cases", () => {
  it("is a no-op when worktreePath is missing", () => {
    const issue = makeIssue({ worktreePath: undefined });
    // Should not throw
    ensureWorktreeCommitted(issue);
  });

  it("is a no-op when branchName is missing", () => {
    const issue = makeIssue({ branchName: undefined, worktreePath: "/tmp/fake" });
    // Should not throw
    ensureWorktreeCommitted(issue);
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// PR helper functions
// ══════════════════════════════════════════════════════════════════════════════

describe("getCompareUrl", () => {
  it("constructs a URL with /compare/ path and branch parameters", () => {
    const url = getCompareUrl("fifony/test-branch", "main");
    // getCompareUrl uses TARGET_ROOT (may point to real project or test repo).
    // Verify the compare portion regardless of the remote URL format.
    assert.ok(
      url.includes("/compare/main...fifony/test-branch") || url.includes("(branch pushed:"),
      "should contain compare path or fallback",
    );
  });

  it("uses the branch and base parameters in the compare path", () => {
    const url = getCompareUrl("fifony/feat-123", "develop");
    assert.ok(
      url.includes("/compare/develop...fifony/feat-123") || url.includes("(branch pushed:"),
      "should contain correct compare path or fallback",
    );
  });
});

describe("isGhAvailable", () => {
  it("returns a boolean", () => {
    const result = isGhAvailable();
    assert.equal(typeof result, "boolean");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Diff line-level verification (additions and removals via real git diff)
// ══════════════════════════════════════════════════════════════════════════════

describe("diff line-level verification", () => {
  it("correctly counts added and removed lines from a real diff", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "DIFF-LINES-001" });
    const ws = join(WORKTREE_BASE, "diff-lines");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);

    // Add 5 lines in a new file
    writeFileSync(join(wt, "five-lines.txt"), "line1\nline2\nline3\nline4\nline5\n");
    // Remove src/utils.ts content (replace with 1 line, was ~1 line)
    writeFileSync(join(wt, "src/utils.ts"), "// removed\n");

    git("add -A", wt);
    git('commit -m "add and modify"', wt);

    computeDiffStats(issue);

    assert.ok(issue.linesAdded! > 0, "should have lines added");
    assert.ok(typeof issue.linesRemoved === "number", "linesRemoved should be set");
    assert.ok(issue.filesChanged! >= 2, "at least 2 files changed");

    // Also verify inferChangedWorkspacePaths picks up the files
    const changed = inferChangedWorkspacePaths(wt, 32, issue);
    assert.ok(changed.includes("five-lines.txt"), "new file in changed list");
    assert.ok(changed.includes("src/utils.ts"), "modified file in changed list");

    await cleanWorkspace(issue.id, issue, makeState());
  });

  it("parseDiffStats agrees with real git diff --stat output", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "REAL-STAT-001" });
    const ws = join(WORKTREE_BASE, "real-stat");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);

    // Known changes: add a file with 3 lines
    writeFileSync(join(wt, "three.txt"), "a\nb\nc\n");
    git("add -A", wt);
    git('commit -m "add three lines"', wt);

    // Get the real git diff --stat output
    const rawStat = execSync(
      `git diff --stat "${issue.baseBranch}"..."${issue.branchName}"`,
      { cwd: TEST_ROOT, encoding: "utf8", stdio: "pipe" },
    );

    // Parse it
    parseDiffStats(issue, rawStat);
    assert.equal(issue.linesAdded, 3, "exactly 3 lines added");
    assert.equal(issue.linesRemoved, 0, "no lines removed");
    assert.equal(issue.filesChanged, 1, "1 file changed");

    await cleanWorkspace(issue.id, issue, makeState());
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Multi-worktree conflict scenarios
//
// Simulates the real-world situation where multiple issues (agents) work in
// parallel worktrees and their merges interact with each other.
// ══════════════════════════════════════════════════════════════════════════════

describe("multi-worktree: two issues editing the same file", () => {
  it("first merge succeeds, second conflicts because base diverged", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    // Create a shared file on the base branch for both issues to modify
    writeFileSync(join(TEST_ROOT, "src/shared.ts"), "export const config = { version: 1 };\n");
    git("add -A");
    git('commit -m "add shared.ts"');

    // Issue A: modifies shared.ts
    const issueA = makeIssue({ identifier: "MULTI-A" });
    const wsA = join(WORKTREE_BASE, "multi-a");
    const wtA = join(wsA, "worktree");
    mkdirSync(wsA, { recursive: true });
    await createGitWorktree(issueA, wtA, baseBranch);
    issueA.workspacePath = wsA;

    writeFileSync(join(wtA, "src/shared.ts"), "export const config = { version: 2, addedByA: true };\n");
    git("add -A", wtA);
    git('commit -m "issue A: update shared.ts"', wtA);

    // Issue B: also modifies shared.ts (differently)
    const issueB = makeIssue({ identifier: "MULTI-B" });
    const wsB = join(WORKTREE_BASE, "multi-b");
    const wtB = join(wsB, "worktree");
    mkdirSync(wsB, { recursive: true });
    await createGitWorktree(issueB, wtB, baseBranch);
    issueB.workspacePath = wsB;

    writeFileSync(join(wtB, "src/shared.ts"), "export const config = { version: 3, addedByB: true };\n");
    git("add -A", wtB);
    git('commit -m "issue B: update shared.ts"', wtB);

    // Merge A first → should succeed (no base divergence)
    const resultA = mergeWorkspace(issueA);
    assert.equal(resultA.conflicts.length, 0, "A should merge cleanly");
    assert.ok(resultA.copied.some(f => f.includes("shared.ts")));

    // Now base has A's changes. Merge B → should conflict
    const resultB = mergeWorkspace(issueB);
    assert.ok(resultB.conflicts.length > 0, "B should conflict");
    assert.ok(resultB.conflicts.some(f => f.includes("shared.ts")));

    // Base still has A's content (not corrupted by abort)
    const baseContent = readFileSync(join(TEST_ROOT, "src/shared.ts"), "utf8");
    assert.ok(baseContent.includes("addedByA"), "A's changes should persist after B's conflict");
    assert.equal(git("status --porcelain"), "");

    await cleanWorkspace(issueA.id, issueA, makeState());
    await cleanWorkspace(issueB.id, issueB, makeState());
  });
});


describe("multi-worktree: two issues editing different files", () => {
  it("both merge successfully with no conflicts", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    // Issue X: adds a new file
    const issueX = makeIssue({ identifier: "NOCONFLICT-X" });
    const wsX = join(WORKTREE_BASE, "noconflict-x");
    const wtX = join(wsX, "worktree");
    mkdirSync(wsX, { recursive: true });
    await createGitWorktree(issueX, wtX, baseBranch);
    issueX.workspacePath = wsX;

    writeFileSync(join(wtX, "feature-x.ts"), "export const featureX = true;\n");
    git("add -A", wtX);
    git('commit -m "add feature-x.ts"', wtX);

    // Issue Y: adds a different file
    const issueY = makeIssue({ identifier: "NOCONFLICT-Y" });
    const wsY = join(WORKTREE_BASE, "noconflict-y");
    const wtY = join(wsY, "worktree");
    mkdirSync(wsY, { recursive: true });
    await createGitWorktree(issueY, wtY, baseBranch);
    issueY.workspacePath = wsY;

    writeFileSync(join(wtY, "feature-y.ts"), "export const featureY = true;\n");
    git("add -A", wtY);
    git('commit -m "add feature-y.ts"', wtY);

    // Both merge cleanly
    const resultX = mergeWorkspace(issueX);
    assert.equal(resultX.conflicts.length, 0, "X should merge cleanly");

    const resultY = mergeWorkspace(issueY);
    assert.equal(resultY.conflicts.length, 0, "Y should merge cleanly");

    // Both files exist on base
    assert.ok(existsSync(join(TEST_ROOT, "feature-x.ts")));
    assert.ok(existsSync(join(TEST_ROOT, "feature-y.ts")));

    await cleanWorkspace(issueX.id, issueX, makeState());
    await cleanWorkspace(issueY.id, issueY, makeState());
  });
});


describe("multi-worktree: both create the same new file", () => {
  it("first merge succeeds, second conflicts on the new file", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    const issueP = makeIssue({ identifier: "SAMEFILE-P" });
    const wsP = join(WORKTREE_BASE, "samefile-p");
    const wtP = join(wsP, "worktree");
    mkdirSync(wsP, { recursive: true });
    await createGitWorktree(issueP, wtP, baseBranch);
    issueP.workspacePath = wsP;

    mkdirSync(join(wtP, "src"), { recursive: true });
    writeFileSync(join(wtP, "src/new-component.ts"), "// Created by P\nexport const P = 1;\n");
    git("add -A", wtP);
    git('commit -m "P: add new-component.ts"', wtP);

    const issueQ = makeIssue({ identifier: "SAMEFILE-Q" });
    const wsQ = join(WORKTREE_BASE, "samefile-q");
    const wtQ = join(wsQ, "worktree");
    mkdirSync(wsQ, { recursive: true });
    await createGitWorktree(issueQ, wtQ, baseBranch);
    issueQ.workspacePath = wsQ;

    mkdirSync(join(wtQ, "src"), { recursive: true });
    writeFileSync(join(wtQ, "src/new-component.ts"), "// Created by Q\nexport const Q = 2;\n");
    git("add -A", wtQ);
    git('commit -m "Q: add new-component.ts"', wtQ);

    // P merges first
    assert.equal(mergeWorkspace(issueP).conflicts.length, 0);

    // Q conflicts (same file created by both with different content)
    const resultQ = mergeWorkspace(issueQ);
    assert.ok(resultQ.conflicts.length > 0);
    assert.ok(resultQ.conflicts.some(f => f.includes("new-component.ts")));

    // P's content is on base
    assert.ok(readFileSync(join(TEST_ROOT, "src/new-component.ts"), "utf8").includes("Created by P"));

    await cleanWorkspace(issueP.id, issueP, makeState());
    await cleanWorkspace(issueQ.id, issueQ, makeState());
  });
});


describe("multi-worktree: modify vs delete conflict", () => {
  it("detects conflict when worktree modifies a file deleted on base", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    writeFileSync(join(TEST_ROOT, "src/deprecated.ts"), "export const old = true;\n");
    git("add -A");
    git('commit -m "add deprecated.ts"');

    // Worktree modifies it
    const issue = makeIssue({ identifier: "MODVSDEL" });
    const ws = join(WORKTREE_BASE, "modvsdel");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "src/deprecated.ts"), "export const old = true;\nexport const improved = true;\n");
    git("add -A", wt);
    git('commit -m "improve deprecated.ts"', wt);

    // Base deletes it
    rmSync(join(TEST_ROOT, "src/deprecated.ts"));
    git("add -A");
    git('commit -m "remove deprecated.ts"');

    const result = mergeWorkspace(issue);
    assert.ok(result.conflicts.length > 0, "modify vs delete should conflict");
    assert.ok(result.conflicts.some(f => f.includes("deprecated.ts")));
    assert.equal(git("status --porcelain"), "");

    await cleanWorkspace(issue.id, issue, makeState());
  });
});


describe("multi-worktree: multiple conflicting files in one merge", () => {
  it("lists all conflicting files, not just the first one", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    writeFileSync(join(TEST_ROOT, "src/config.ts"), "export const port = 3000;\n");
    writeFileSync(join(TEST_ROOT, "src/routes.ts"), "export const routes = ['/home'];\n");
    git("add -A");
    git('commit -m "add config + routes"');

    const issue = makeIssue({ identifier: "MULTICONFLICT" });
    const ws = join(WORKTREE_BASE, "multiconflict");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "src/config.ts"), "export const port = 4000; // worktree\n");
    writeFileSync(join(wt, "src/routes.ts"), "export const routes = ['/home', '/about']; // worktree\n");
    git("add -A", wt);
    git('commit -m "update config + routes"', wt);

    writeFileSync(join(TEST_ROOT, "src/config.ts"), "export const port = 5000; // base\n");
    writeFileSync(join(TEST_ROOT, "src/routes.ts"), "export const routes = ['/home', '/contact']; // base\n");
    git("add -A");
    git('commit -m "base: update config + routes"');

    const result = mergeWorkspace(issue);
    assert.ok(result.conflicts.length >= 2, `should have >=2 conflicts, got ${result.conflicts.length}`);
    assert.ok(result.conflicts.some(f => f.includes("config.ts")));
    assert.ok(result.conflicts.some(f => f.includes("routes.ts")));
    assert.equal(git("status --porcelain"), "");

    await cleanWorkspace(issue.id, issue, makeState());
  });
});


describe("multi-worktree: sequential merges evolve the base", () => {
  it("three worktrees created simultaneously, merged one by one, each with correct diff stats", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    const entries: Array<{ issue: ReturnType<typeof makeIssue>; ws: string; wt: string }> = [];
    for (const idx of ["seq-1", "seq-2", "seq-3"]) {
      const issue = makeIssue({ identifier: `SEQ-${idx}` });
      const ws = join(WORKTREE_BASE, idx);
      const wt = join(ws, "worktree");
      mkdirSync(ws, { recursive: true });
      await createGitWorktree(issue, wt, baseBranch);
      issue.workspacePath = ws;
      entries.push({ issue, ws, wt });
    }

    // Each worktree adds a unique file with a known line count (no conflicts)
    for (let i = 0; i < entries.length; i++) {
      const lines = Array.from({ length: (i + 1) * 3 }, (_, j) => `line${j + 1}`).join("\n") + "\n";
      writeFileSync(join(entries[i].wt, `seq-file-${i + 1}.ts`), lines);
      git("add -A", entries[i].wt);
      git(`commit -m "seq-${i + 1}: add ${(i + 1) * 3} lines"`, entries[i].wt);
    }

    // Merge each sequentially — all should succeed
    const stats: Array<{ files: number; added: number }> = [];
    for (const { issue } of entries) {
      computeDiffStats(issue);
      stats.push({ files: issue.filesChanged ?? 0, added: issue.linesAdded ?? 0 });
      assert.equal(mergeWorkspace(issue).conflicts.length, 0, `${issue.identifier} should merge cleanly`);
    }

    // All files present
    assert.ok(existsSync(join(TEST_ROOT, "seq-file-1.ts")));
    assert.ok(existsSync(join(TEST_ROOT, "seq-file-2.ts")));
    assert.ok(existsSync(join(TEST_ROOT, "seq-file-3.ts")));

    // Verify per-issue diff stats: each only touched 1 file
    assert.deepEqual(stats, [
      { files: 1, added: 3 },
      { files: 1, added: 6 },
      { files: 1, added: 9 },
    ]);

    for (const { issue } of entries) {
      await cleanWorkspace(issue.id, issue, makeState());
    }
  });
});


describe("multi-worktree: partial conflict aborts fully", () => {
  it("no partial changes leak into base when merge is aborted", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    writeFileSync(join(TEST_ROOT, "src/will-conflict.ts"), "// original\n");
    git("add -A");
    git('commit -m "add will-conflict.ts"');

    const issue = makeIssue({ identifier: "PARTIAL-CONFLICT" });
    const ws = join(WORKTREE_BASE, "partial-conflict");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    // Worktree: adds a safe file + modifies a conflicting file
    writeFileSync(join(wt, "safe-new-file.ts"), "export const safe = true;\n");
    writeFileSync(join(wt, "src/will-conflict.ts"), "// modified by worktree\n");
    git("add -A", wt);
    git('commit -m "safe file + conflicting change"', wt);

    // Base modifies the same conflicting file
    writeFileSync(join(TEST_ROOT, "src/will-conflict.ts"), "// modified by base\n");
    git("add -A");
    git('commit -m "base: modify will-conflict.ts"');

    const result = mergeWorkspace(issue);
    assert.ok(result.conflicts.some(f => f.includes("will-conflict.ts")));
    assert.ok(!result.conflicts.some(f => f.includes("safe-new-file.ts")), "safe file should not conflict");

    // Key assertion: the safe file must NOT exist on base (merge was fully aborted)
    assert.ok(!existsSync(join(TEST_ROOT, "safe-new-file.ts")), "aborted merge must not leak partial changes");
    assert.equal(git("status --porcelain"), "");

    await cleanWorkspace(issue.id, issue, makeState());
  });
});


describe("multi-worktree: diff scoping across parallel worktrees", () => {
  it("each worktree's diff is correctly scoped to its own branch", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    // Issue D and E created simultaneously
    const issueD = makeIssue({ identifier: "SCOPE-D" });
    const wsD = join(WORKTREE_BASE, "scope-d");
    const wtD = join(wsD, "worktree");
    mkdirSync(wsD, { recursive: true });
    await createGitWorktree(issueD, wtD, baseBranch);

    const issueE = makeIssue({ identifier: "SCOPE-E" });
    const wsE = join(WORKTREE_BASE, "scope-e");
    const wtE = join(wsE, "worktree");
    mkdirSync(wsE, { recursive: true });
    await createGitWorktree(issueE, wtE, baseBranch);

    // D changes file-d only, E changes file-e only
    writeFileSync(join(wtD, "file-d.ts"), "// only D\n");
    git("add -A", wtD);
    git('commit -m "D: add file-d"', wtD);

    writeFileSync(join(wtE, "file-e.ts"), "// only E\n");
    git("add -A", wtE);
    git('commit -m "E: add file-e"', wtE);

    // Each diff should only show ITS files
    const pathsD = inferChangedWorkspacePaths(wtD, 32, issueD);
    const pathsE = inferChangedWorkspacePaths(wtE, 32, issueE);

    assert.ok(pathsD.includes("file-d.ts"), "D sees file-d.ts");
    assert.ok(!pathsD.includes("file-e.ts"), "D does NOT see file-e.ts");

    assert.ok(pathsE.includes("file-e.ts"), "E sees file-e.ts");
    assert.ok(!pathsE.includes("file-d.ts"), "E does NOT see file-d.ts");

    // computeDiffStats also scoped correctly
    computeDiffStats(issueD);
    computeDiffStats(issueE);
    assert.equal(issueD.filesChanged, 1);
    assert.equal(issueE.filesChanged, 1);

    await cleanWorkspace(issueD.id, issueD, makeState());
    await cleanWorkspace(issueE.id, issueE, makeState());
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// dryMerge — pre-merge conflict detection
// ══════════════════════════════════════════════════════════════════════════════

describe("dryMerge: pre-merge conflict detection", () => {
  it("reports canMerge=true when merge will be clean", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "DRY-CLEAN" });
    const ws = join(WORKTREE_BASE, "dry-clean");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "dry-clean-file.ts"), "export const clean = true;\n");
    git("add -A", wt);
    git('commit -m "dry clean file"', wt);

    const result = dryMerge(issue);
    assert.equal(result.willConflict, false);
    assert.equal(result.canMerge, true);
    assert.equal(result.conflictFiles.length, 0);
    assert.ok(result.changedFiles >= 1);

    // Base should be unchanged (dry run doesn't modify anything)
    assert.equal(git("status --porcelain"), "", "base must be clean after dry merge");
    assert.ok(!existsSync(join(TEST_ROOT, "dry-clean-file.ts")), "file must NOT appear on base");

    await cleanWorkspace(issue.id, issue, makeState());
  });

  it("reports willConflict=true and lists conflicting files", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    // Create a file that both sides will modify
    writeFileSync(join(TEST_ROOT, "src/dry-target.ts"), "original content\n");
    git("add -A");
    git('commit -m "add dry-target.ts"');

    const issue = makeIssue({ identifier: "DRY-CONFLICT" });
    const ws = join(WORKTREE_BASE, "dry-conflict");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    // Worktree changes the file
    writeFileSync(join(wt, "src/dry-target.ts"), "worktree version\n");
    git("add -A", wt);
    git('commit -m "worktree: change dry-target"', wt);

    // Base changes the same file differently
    writeFileSync(join(TEST_ROOT, "src/dry-target.ts"), "base version\n");
    git("add -A");
    git('commit -m "base: change dry-target"');

    const result = dryMerge(issue);
    assert.equal(result.willConflict, true);
    assert.equal(result.canMerge, false);
    assert.ok(result.conflictFiles.some(f => f.includes("dry-target.ts")));

    // Base must be clean — the dry merge should not leave any state
    assert.equal(git("status --porcelain"), "", "base must be clean after dry merge");
    // Base file should still have base version (not corrupted)
    const content = readFileSync(join(TEST_ROOT, "src/dry-target.ts"), "utf8");
    assert.ok(content.includes("base version"), "base content must be preserved");

    await cleanWorkspace(issue.id, issue, makeState());
  });

  it("does not alter base even when merge would succeed", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "DRY-NOLEAK" });
    const ws = join(WORKTREE_BASE, "dry-noleak");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "dry-noleak-file.ts"), "should not leak\n");
    git("add -A", wt);
    git('commit -m "add noleak file"', wt);

    const headBefore = git("rev-parse HEAD");
    dryMerge(issue);
    const headAfter = git("rev-parse HEAD");

    assert.equal(headBefore, headAfter, "HEAD must not change after dry merge");
    assert.ok(!existsSync(join(TEST_ROOT, "dry-noleak-file.ts")), "file must not leak");
    assert.equal(git("status --porcelain"), "");

    await cleanWorkspace(issue.id, issue, makeState());
  });

  it("throws when issue has no worktree info", () => {
    const issue = makeIssue({ branchName: undefined });
    assert.throws(() => dryMerge(issue), /no git worktree/i);
  });

  it("throws when current branch is not the base branch", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");
    const issue = makeIssue({ identifier: "DRY-WRONGBRANCH" });
    const ws = join(WORKTREE_BASE, "dry-wrongbranch");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "x.ts"), "x\n");
    git("add -A", wt);
    git('commit -m "x"', wt);

    git("checkout -b temp-dry-branch");
    try {
      assert.throws(
        () => dryMerge(issue),
        (err: Error) => err.message.includes("current branch is temp-dry-branch"),
      );
    } finally {
      git(`checkout ${baseBranch}`);
      try { git("branch -D temp-dry-branch"); } catch {}
      await cleanWorkspace(issue.id, issue, makeState());
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// rebaseWorktree — rebase worktree branch onto updated base
// ══════════════════════════════════════════════════════════════════════════════

describe("rebaseWorktree", () => {
  it("successfully rebases when there are no conflicts", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    const issue = makeIssue({ identifier: "REBASE-CLEAN" });
    const ws = join(WORKTREE_BASE, "rebase-clean");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    // Worktree adds a file
    writeFileSync(join(wt, "rebase-feature.ts"), "export const feature = true;\n");
    git("add -A", wt);
    git('commit -m "add rebase-feature.ts"', wt);

    // Base advances with a different file (no conflict)
    writeFileSync(join(TEST_ROOT, "base-advance.ts"), "export const advance = true;\n");
    git("add -A");
    git('commit -m "base: advance with new file"');

    const result = rebaseWorktree(issue);
    assert.equal(result.success, true);
    assert.equal(result.conflictFiles.length, 0);

    // After rebase, the worktree should have BOTH files
    assert.ok(existsSync(join(wt, "rebase-feature.ts")), "worktree file preserved");
    assert.ok(existsSync(join(wt, "base-advance.ts")), "base file available in worktree after rebase");

    // Now a merge should succeed cleanly (worktree is on top of base)
    const mergeResult = mergeWorkspace(issue);
    assert.equal(mergeResult.conflicts.length, 0, "merge after rebase should be clean");

    await cleanWorkspace(issue.id, issue, makeState());
  });

  it("detects conflicts and aborts rebase safely", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    // Create a shared file
    writeFileSync(join(TEST_ROOT, "src/rebase-conflict.ts"), "original\n");
    git("add -A");
    git('commit -m "add rebase-conflict.ts"');

    const issue = makeIssue({ identifier: "REBASE-CONFLICT" });
    const ws = join(WORKTREE_BASE, "rebase-conflict");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    // Worktree modifies the file
    writeFileSync(join(wt, "src/rebase-conflict.ts"), "worktree version\n");
    git("add -A", wt);
    git('commit -m "worktree: modify rebase-conflict"', wt);

    // Base also modifies the same file
    writeFileSync(join(TEST_ROOT, "src/rebase-conflict.ts"), "base version\n");
    git("add -A");
    git('commit -m "base: modify rebase-conflict"');

    const result = rebaseWorktree(issue);
    assert.equal(result.success, false);
    assert.ok(result.conflictFiles.some(f => f.includes("rebase-conflict.ts")));

    // Worktree should be clean after abort (no rebase in progress)
    const status = git("status --porcelain", wt);
    assert.equal(status, "", "worktree should be clean after aborted rebase");

    await cleanWorkspace(issue.id, issue, makeState());
  });

  it("throws when issue has no worktree info", () => {
    const issue = makeIssue({ branchName: undefined });
    assert.throws(() => rebaseWorktree(issue), /no git worktree/i);
  });

  it("rebase then merge: resolves a previously-conflicting merge", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    // Create worktree A and B that both touch different files
    const issueA = makeIssue({ identifier: "REBASE-A" });
    const wsA = join(WORKTREE_BASE, "rebase-a");
    const wtA = join(wsA, "worktree");
    mkdirSync(wsA, { recursive: true });
    await createGitWorktree(issueA, wtA, baseBranch);
    issueA.workspacePath = wsA;

    writeFileSync(join(wtA, "rebase-a-file.ts"), "by A\n");
    git("add -A", wtA);
    git('commit -m "A: add file"', wtA);

    const issueB = makeIssue({ identifier: "REBASE-B" });
    const wsB = join(WORKTREE_BASE, "rebase-b");
    const wtB = join(wsB, "worktree");
    mkdirSync(wsB, { recursive: true });
    await createGitWorktree(issueB, wtB, baseBranch);
    issueB.workspacePath = wsB;

    writeFileSync(join(wtB, "rebase-b-file.ts"), "by B\n");
    git("add -A", wtB);
    git('commit -m "B: add file"', wtB);

    // Merge A first — base advances
    const resultA = mergeWorkspace(issueA);
    assert.equal(resultA.conflicts.length, 0);

    // B's merge would still work (different files), but let's verify rebase helps
    // Rebase B onto the new base (which now includes A's changes)
    const rebaseResult = rebaseWorktree(issueB);
    assert.equal(rebaseResult.success, true, "rebase should succeed (no conflicting files)");

    // After rebase, B's worktree should have A's file too
    assert.ok(existsSync(join(wtB, "rebase-a-file.ts")), "A's file should be in B's worktree after rebase");

    // Merge B — should be clean
    const resultB = mergeWorkspace(issueB);
    assert.equal(resultB.conflicts.length, 0, "merge after rebase should be clean");

    // Both files on base
    assert.ok(existsSync(join(TEST_ROOT, "rebase-a-file.ts")));
    assert.ok(existsSync(join(TEST_ROOT, "rebase-b-file.ts")));

    await cleanWorkspace(issueA.id, issueA, makeState());
    await cleanWorkspace(issueB.id, issueB, makeState());
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// dryMerge + mergeWorkspace consistency
// ══════════════════════════════════════════════════════════════════════════════

describe("dryMerge and mergeWorkspace agree on conflict detection", () => {
  it("dryMerge predicts conflict → mergeWorkspace also conflicts", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    writeFileSync(join(TEST_ROOT, "src/predict.ts"), "original\n");
    git("add -A");
    git('commit -m "add predict.ts"');

    const issue = makeIssue({ identifier: "PREDICT-CONFLICT" });
    const ws = join(WORKTREE_BASE, "predict-conflict");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "src/predict.ts"), "worktree\n");
    git("add -A", wt);
    git('commit -m "worktree predict"', wt);

    writeFileSync(join(TEST_ROOT, "src/predict.ts"), "base\n");
    git("add -A");
    git('commit -m "base predict"');

    // dryMerge says conflict
    const preview = dryMerge(issue);
    assert.equal(preview.willConflict, true);

    // mergeWorkspace also conflicts
    const result = mergeWorkspace(issue);
    assert.ok(result.conflicts.length > 0);

    // Both report the same file
    assert.deepEqual(
      preview.conflictFiles.sort(),
      result.conflicts.sort(),
      "dryMerge and mergeWorkspace should report the same conflict files",
    );

    await cleanWorkspace(issue.id, issue, makeState());
  });

  it("dryMerge predicts clean → mergeWorkspace merges successfully", async () => {
    const baseBranch = git("rev-parse --abbrev-ref HEAD");

    const issue = makeIssue({ identifier: "PREDICT-CLEAN" });
    const ws = join(WORKTREE_BASE, "predict-clean");
    const wt = join(ws, "worktree");
    mkdirSync(ws, { recursive: true });
    await createGitWorktree(issue, wt, baseBranch);
    issue.workspacePath = ws;

    writeFileSync(join(wt, "predict-clean.ts"), "clean\n");
    git("add -A", wt);
    git('commit -m "predict clean"', wt);

    // dryMerge says clean
    const preview = dryMerge(issue);
    assert.equal(preview.canMerge, true);

    // mergeWorkspace also succeeds
    const result = mergeWorkspace(issue);
    assert.equal(result.conflicts.length, 0);

    await cleanWorkspace(issue.id, issue, makeState());
  });
});
