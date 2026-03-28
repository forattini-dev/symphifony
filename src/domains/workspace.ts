import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import type { IssueEntry, RuntimeState } from "../types.ts";
import {
  SOURCE_ROOT,
  SOURCE_MARKER,
  TARGET_ROOT,
  WORKSPACE_ROOT,
} from "../concerns/constants.ts";
import {
  now,
  idToSafePath,
} from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { runHook } from "../agents/command-executor.ts";
import { buildPrompt } from "../agents/prompt-builder.ts";
import { ensureWorkspaceMemoryFiles, recordWorkspaceMemoryEvent } from "../agents/memory-engine.ts";

// ── Source bootstrap ────────────────────────────────────────────────────────

export type GitRepoStatus = {
  isGit: boolean;
  hasCommits: boolean;
  branch: string | null;
  /** Working tree is clean (no uncommitted or untracked changes). Null if not a git repo. */
  isClean?: boolean;
  /** Number of untracked files. */
  untrackedCount?: number;
};

const SKIP_DIRS = new Set([
  ".git", ".fifony", "node_modules", ".venv", "data",
  "dist", "build", ".turbo", ".next", ".nuxt", ".tanstack",
  "coverage", "artifacts", "captures", "tmp", "temp",
]);

function shouldSkipPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((segment) => SKIP_DIRS.has(segment))) return true;
  const base = parts.at(-1) ?? "";
  if (base.startsWith("map_scan_") && extname(base) === ".json") return true;
  if (extname(base) === ".xlsx") return true;
  return false;
}

export function bootstrapSource(): void {
  if (existsSync(SOURCE_MARKER)) return;

  logger.info("Creating local source snapshot for Fifony (local-only runtime)...");

  const copyRecursive = (source: string, target: string, rel = "") => {
    mkdirSync(target, { recursive: true });
    const items = readdirSync(source, { withFileTypes: true });

    for (const item of items) {
      const nextRel = rel ? `${rel}/${item.name}` : item.name;
      if (shouldSkipPath(nextRel)) continue;

      const sourcePath = `${source}/${item.name}`;
      const targetPath = `${target}/${item.name}`;
      const itemStat = statSync(sourcePath);

      if (item.isDirectory()) {
        copyRecursive(sourcePath, targetPath, nextRel);
        continue;
      }

      if (item.isSymbolicLink() || itemStat.isSymbolicLink()) continue;

      if (itemStat.isFile() || itemStat.isFIFO()) {
        try {
          const file = readFileSync(sourcePath);
          writeFileSync(targetPath, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            logger.debug(`Skipped missing source file: ${sourcePath}`);
          } else {
            throw error;
          }
        }
      }
    }
  };

  mkdirSync(SOURCE_ROOT, { recursive: true });
  copyRecursive(TARGET_ROOT, SOURCE_ROOT);
  writeFileSync(SOURCE_MARKER, `${now()}\n`, "utf8");
}

let sourceReadyPromise: Promise<void> | null = null;
let skipSourceFlag = false;

export function setSkipSource(skip: boolean): void {
  skipSourceFlag = skip;
}

/**
 * Async, lazy version of bootstrapSource().
 * Only runs the copy once, on first call. Subsequent calls resolve immediately.
 * Emits progress via optional callback.
 */
export async function ensureSourceReady(
  onProgress?: (status: "copying" | "ready") => void,
): Promise<void> {
  if (skipSourceFlag) {
    onProgress?.("ready");
    return;
  }
  if (existsSync(SOURCE_MARKER)) {
    onProgress?.("ready");
    return;
  }

  // Deduplicate concurrent calls
  if (sourceReadyPromise) return sourceReadyPromise;

  sourceReadyPromise = (async () => {
    onProgress?.("copying");
    logger.info("Creating local source snapshot (async) for Fifony...");

    const copyRecursiveAsync = async (source: string, target: string, rel = "") => {
      await mkdir(target, { recursive: true });
      const items = await readdir(source, { withFileTypes: true });

      for (const item of items) {
        const nextRel = rel ? `${rel}/${item.name}` : item.name;
        if (shouldSkipPath(nextRel)) continue;

        const sourcePath = `${source}/${item.name}`;
        const targetPath = `${target}/${item.name}`;
        const itemStat = await stat(sourcePath);

        if (item.isDirectory()) {
          await copyRecursiveAsync(sourcePath, targetPath, nextRel);
          continue;
        }

        if (item.isSymbolicLink() || itemStat.isSymbolicLink()) continue;

        if (itemStat.isFile() || itemStat.isFIFO()) {
          try {
            await copyFile(sourcePath, targetPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              logger.debug(`Skipped missing source file: ${sourcePath}`);
            } else {
              throw error;
            }
          }
        }
      }
    };

    await mkdir(SOURCE_ROOT, { recursive: true });
    await copyRecursiveAsync(TARGET_ROOT, SOURCE_ROOT);
    await writeFile(SOURCE_MARKER, `${now()}\n`, "utf8");
    onProgress?.("ready");
    logger.info("Source snapshot ready (async).");
  })();

  return sourceReadyPromise;
}

// ── Workspace setup ─────────────────────────────────────────────────────────

export function getGitRepoStatus(dir: string): GitRepoStatus {
  const isGit = (() => {
    try {
      execSync("git rev-parse --git-dir", { cwd: dir, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  if (!isGit) {
    return { isGit: false, hasCommits: false, branch: null };
  }

  const branch = (() => {
    try {
      return execSync("git symbolic-ref --short HEAD", { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim() || null;
    } catch {
      try {
        return execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim() || null;
      } catch {
        return null;
      }
    }
  })();

  const hasCommits = (() => {
    try {
      execSync("git rev-parse --verify HEAD", { cwd: dir, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();

  let isClean = true;
  let untrackedCount = 0;
  if (hasCommits) {
    try {
      const porcelain = execSync("git status --porcelain", { cwd: dir, encoding: "utf8", timeout: 5_000 }).trim();
      isClean = porcelain.length === 0;
      untrackedCount = porcelain.split("\n").filter((l) => l.startsWith("??")).length;
    } catch { /* non-critical */ }
  }

  return { isGit: true, hasCommits, branch, isClean, untrackedCount };
}

function gitRequirementMessage(action: string): string {
  return `fifony requires a git repository with at least one commit to ${action}. Initialize git in this project and create an initial commit, or use the onboarding Setup step.`;
}

export function ensureGitRepoReadyForWorktrees(dir: string, action = "run issue worktrees"): GitRepoStatus {
  const status = getGitRepoStatus(dir);

  if (!status.isGit) {
    throw new Error(gitRequirementMessage(action));
  }

  if (!status.hasCommits) {
    throw new Error(`fifony requires at least one commit to ${action} because git worktree needs a base commit. Create an initial commit, then retry.`);
  }

  return status;
}

export function initializeGitRepoForWorktrees(dir: string): GitRepoStatus {
  let status = getGitRepoStatus(dir);

  if (!status.isGit) {
    try {
      execSync("git init -b main", { cwd: dir, stdio: "pipe" });
    } catch {
      execSync("git init", { cwd: dir, stdio: "pipe" });
    }
    status = getGitRepoStatus(dir);
  }

  if (!status.hasCommits) {
    execSync(
      'git -c user.name="fifony" -c user.email="fifony@local.invalid" commit --allow-empty -m "Initial commit"',
      { cwd: dir, stdio: "pipe" },
    );
    status = getGitRepoStatus(dir);
  }

  return status;
}

export function assertIssueHasGitWorktree(
  issue: IssueEntry,
  action: string,
): asserts issue is IssueEntry & { branchName: string; baseBranch: string; worktreePath: string } {
  if (!issue.branchName || !issue.baseBranch || !issue.worktreePath) {
    throw new Error(
      `Issue ${issue.identifier} has no git worktree — cannot ${action}. This usually means the issue was executed before git was initialized for the project. Initialize git, then re-run the issue.`,
    );
  }
}

/** Detect the default branch for a git repo using multiple fallback strategies. */
export function detectDefaultBranch(dir: string): string {
  try {
    const current = execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf8" }).trim();
    if (current && current !== "HEAD") return current;
    // HEAD = detached state, fall through to remote detection
    const remote = execSync("git symbolic-ref refs/remotes/origin/HEAD", { cwd: dir, encoding: "utf8" }).trim();
    return remote.replace("refs/remotes/origin/", "");
  } catch {
    return "main";
  }
}

/** CLI config directories to copy from project root to worktree (typically gitignored). */
const CLI_CONFIG_DIRS = [".claude", ".codex", ".gemini"];
/** Project-root files to copy (CLAUDE.md provides project instructions to the agent). */
const CLI_CONFIG_FILES = ["CLAUDE.md"];

/**
 * Copy CLI config dirs and files from project root into the worktree.
 * git worktree only checks out tracked files — .gitignored config dirs like .claude/
 * would be missing, causing the agent to lose skills, commands, and CLAUDE.md.
 */
function copyCliConfigDirs(sourceRoot: string, worktreePath: string): void {
  for (const dir of CLI_CONFIG_DIRS) {
    const src = join(sourceRoot, dir);
    const dst = join(worktreePath, dir);
    if (existsSync(src) && statSync(src).isDirectory() && !existsSync(dst)) {
      try {
        execSync(`cp -R "${src}" "${dst}"`, { stdio: "pipe", timeout: 10_000 });
        logger.debug({ dir, worktreePath }, "[Workspace] Copied CLI config dir to worktree");
      } catch (err) {
        logger.warn({ err: String(err), dir }, "[Workspace] Failed to copy CLI config dir");
      }
    }
  }
  for (const file of CLI_CONFIG_FILES) {
    const src = join(sourceRoot, file);
    const dst = join(worktreePath, file);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        execSync(`cp "${src}" "${dst}"`, { stdio: "pipe", timeout: 5_000 });
        logger.debug({ file, worktreePath }, "[Workspace] Copied CLI config file to worktree");
      } catch (err) {
        logger.warn({ err: String(err), file }, "[Workspace] Failed to copy CLI config file");
      }
    }
  }
}

function isGitWorkingTree(dir: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd: dir, stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function resolveTestWorkspacePath(issue: IssueEntry): string {
  const workspaceRoot = issue.workspacePath ?? join(WORKSPACE_ROOT, idToSafePath(issue.id));
  return join(workspaceRoot, "test-worktree");
}

export function createTestWorkspace(issue: IssueEntry): string {
  ensureGitRepoReadyForWorktrees(TARGET_ROOT, "create isolated test workspaces");
  assertIssueHasGitWorktree(issue, "create a test workspace");

  const workspaceRoot = issue.workspacePath ?? join(WORKSPACE_ROOT, idToSafePath(issue.id));
  const testWorkspacePath = issue.testWorkspacePath ?? resolveTestWorkspacePath(issue);
  mkdirSync(workspaceRoot, { recursive: true });

  if (existsSync(testWorkspacePath)) {
    if (isGitWorkingTree(testWorkspacePath)) {
      issue.testWorkspacePath = testWorkspacePath;
      issue.testApplied = true;
      return testWorkspacePath;
    }
    rmSync(testWorkspacePath, { recursive: true, force: true });
  }

  try {
    execSync(`git worktree add --detach "${testWorkspacePath}" "${issue.branchName}"`, {
      cwd: TARGET_ROOT,
      stdio: "pipe",
      timeout: 30_000,
    });
  } catch (err: any) {
    const msg = err.stderr || err.stdout || String(err);
    throw new Error(`Failed to create isolated test workspace: ${msg}`);
  }

  copyCliConfigDirs(TARGET_ROOT, testWorkspacePath);
  issue.testWorkspacePath = testWorkspacePath;
  issue.testApplied = true;
  return testWorkspacePath;
}

export function removeTestWorkspace(issue: IssueEntry): void {
  const testWorkspacePath = issue.testWorkspacePath;
  issue.testApplied = false;
  issue.testWorkspacePath = undefined;

  if (!testWorkspacePath) return;

  try {
    execSync(`git worktree remove --force "${testWorkspacePath}"`, {
      cwd: TARGET_ROOT,
      stdio: "pipe",
      timeout: 30_000,
    });
    logger.info({ issueId: issue.id, testWorkspacePath }, "[Workspace] Removed isolated test workspace");
    return;
  } catch (error) {
    logger.warn({ issueId: issue.id, testWorkspacePath, err: String(error) }, "[Workspace] Failed to remove isolated test workspace via git worktree");
  }

  try {
    rmSync(testWorkspacePath, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ issueId: issue.id, testWorkspacePath, err: String(error) }, "[Workspace] Failed to remove isolated test workspace directory");
  }
}

/** Create a git worktree for the issue at the given path. */
export async function createGitWorktree(issue: IssueEntry, worktreePath: string, baseBranch?: string): Promise<void> {
  let headCommitAtStart = "";
  const resolvedBaseBranch = baseBranch ?? detectDefaultBranch(TARGET_ROOT);
  try {
    headCommitAtStart = execSync("git rev-parse HEAD", { cwd: TARGET_ROOT, encoding: "utf8" }).trim();
  } catch {}

  const branchName = `fifony/${issue.id}`;

  // Clean up stale worktree entries before creating (handles crashed/incomplete previous runs)
  try { execSync("git worktree prune", { cwd: TARGET_ROOT, stdio: "pipe" }); } catch {}

  // If the worktree path already exists, remove it first
  if (existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, { cwd: TARGET_ROOT, stdio: "pipe" });
    } catch {
      // If git worktree remove fails, force-delete the directory and prune again
      rmSync(worktreePath, { recursive: true, force: true });
      try { execSync("git worktree prune", { cwd: TARGET_ROOT, stdio: "pipe" }); } catch {}
    }
  }

  // If the branch is still locked by a stale worktree entry after prune + directory cleanup,
  // scan worktree list and force-remove any entry holding our branch.
  try {
    const wtList = execSync("git worktree list --porcelain", { cwd: TARGET_ROOT, encoding: "utf8" });
    for (const block of wtList.split("\n\n").filter(Boolean)) {
      if (block.includes(`branch refs/heads/${branchName}`)) {
        const m = block.match(/^worktree (.+)$/m);
        if (m) {
          try {
            execSync(`git worktree remove --force "${m[1]}"`, { cwd: TARGET_ROOT, stdio: "pipe" });
          } catch {
            rmSync(m[1], { recursive: true, force: true });
            try { execSync("git worktree prune", { cwd: TARGET_ROOT, stdio: "pipe" }); } catch {}
          }
        }
      }
    }
  } catch {}

  // -B creates or resets the branch (handles retry scenarios)
  execSync(`git worktree add "${worktreePath}" -B "${branchName}"`, {
    cwd: TARGET_ROOT,
    stdio: "pipe",
  });

  // Register fifony runtime files as ignored in the worktree's local excludes
  try {
    const gitFileContent = readFileSync(join(worktreePath, ".git"), "utf8").trim();
    const gitDirRel = gitFileContent.replace("gitdir: ", "").trim();
    const gitDirPath = resolve(worktreePath, gitDirRel);
    mkdirSync(join(gitDirPath, "info"), { recursive: true });
    writeFileSync(join(gitDirPath, "info", "exclude"), "fifony-*\n.fifony-*\nfifony_*\n", "utf8");
  } catch (err) {
    logger.warn({ err: String(err) }, "[Agent] Failed to write worktree excludes");
  }

  issue.branchName = branchName;
  issue.baseBranch = resolvedBaseBranch;
  issue.headCommitAtStart = headCommitAtStart;
  issue.worktreePath = worktreePath;

  // Copy CLI config dirs that are typically gitignored (.claude/, .codex/, .gemini/)
  // Without these, the agent loses CLAUDE.md, skills, commands, and project-level config
  copyCliConfigDirs(TARGET_ROOT, worktreePath);

  logger.debug({ issueId: issue.id, branchName, baseBranch: resolvedBaseBranch, worktreePath }, "[Agent] Git worktree created");
}

export async function prepareWorkspace(
  issue: IssueEntry,
  state: RuntimeState,
  defaultBranch?: string,
): Promise<{ workspacePath: string; promptText: string; promptFile: string }> {
  const safeId = idToSafePath(issue.id);
  const workspaceRoot = join(WORKSPACE_ROOT, safeId);    // management dir
  const worktreePath = join(workspaceRoot, "worktree");   // code dir (git worktree)
  const createdNow = !existsSync(worktreePath);

  if (createdNow) {
    mkdirSync(workspaceRoot, { recursive: true });
    logger.debug({ issueId: issue.id, identifier: issue.identifier, workspacePath: workspaceRoot }, "[Agent] Creating workspace");
    ensureGitRepoReadyForWorktrees(TARGET_ROOT, "execute issues");

    if (state.config.afterCreateHook) {
      mkdirSync(worktreePath, { recursive: true });
      await runHook(state.config.afterCreateHook, worktreePath, issue, "after_create");
    } else {
      await createGitWorktree(issue, worktreePath, defaultBranch);
    }

    logger.debug({ issueId: issue.id, workspacePath: workspaceRoot, worktreePath }, "[Agent] Workspace created");
  } else {
    logger.debug({ issueId: issue.id, workspacePath: workspaceRoot }, "[Agent] Reusing existing workspace");
  }

  const metaPath = join(workspaceRoot, "issue.json");
  const promptText = await buildPrompt(issue, null);
  const promptFile = join(workspaceRoot, "prompt.md");
  ensureWorkspaceMemoryFiles(issue, workspaceRoot);
  if (createdNow) {
    recordWorkspaceMemoryEvent(issue, workspaceRoot, {
      id: `bootstrap-v${issue.planVersion ?? 0}`,
      kind: "bootstrap",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      title: "Workspace bootstrap",
      summary: "Issue workspace prepared with worktree, prompt scaffold, and durable memory files.",
      source: "runtime",
      createdAt: now(),
      planVersion: issue.planVersion,
      persistLongTerm: false,
      tags: ["workspace", "bootstrap"],
    });
  }
  writeFileSync(metaPath, JSON.stringify({ ...issue, runtimeSource: SOURCE_ROOT, bootstrapAt: now() }, null, 2), "utf8");
  writeFileSync(promptFile, `${promptText}\n`, "utf8");

  issue.workspacePath = workspaceRoot;
  issue.worktreePath = worktreePath;
  issue.workspacePreparedAt = now();

  return { workspacePath: workspaceRoot, promptText, promptFile };
}

export async function cleanWorkspace(
  issueId: string,
  issue: IssueEntry | null,
  state: RuntimeState,
): Promise<void> {
  const safeId = idToSafePath(issueId);
  const workspacePath = issue?.workspacePath ?? join(WORKSPACE_ROOT, safeId);
  if (!existsSync(workspacePath)) return;

  // Run before_remove hook (failure is logged but ignored)
  if (state.config.beforeRemoveHook) {
    try {
      const dummyIssue = issue ?? { id: issueId, identifier: issueId } as IssueEntry;
      await runHook(state.config.beforeRemoveHook, workspacePath, dummyIssue, "before_remove");
    } catch (error) {
      logger.warn(`before_remove hook failed for ${issueId}: ${String(error)}`);
    }
  }

  if (issue?.testWorkspacePath) {
    removeTestWorkspace(issue);
  }

  // Git worktree cleanup
  if (issue?.branchName && issue.worktreePath) {
    try {
      execSync(`git worktree remove --force "${issue.worktreePath}"`, { cwd: TARGET_ROOT, stdio: "pipe" });
      logger.info(`Removed worktree for ${issueId}: ${issue.worktreePath}`);
    } catch (error) {
      logger.warn(`Failed to remove worktree for ${issueId}: ${String(error)}`);
      try { rmSync(issue.worktreePath, { recursive: true, force: true }); } catch {}
    }
    try {
      execSync(`git branch -D "${issue.branchName}"`, { cwd: TARGET_ROOT, stdio: "pipe" });
    } catch { /* branch may already be gone */ }
    // Also remove the management dir
    try { rmSync(workspacePath, { recursive: true, force: true }); } catch {}
    return;
  }

  // Legacy: remove the whole workspace dir
  try {
    rmSync(workspacePath, { recursive: true, force: true });
    logger.info(`Cleaned workspace for ${issueId}: ${workspacePath}`);
  } catch (error) {
    logger.warn(`Failed to clean workspace for ${issueId}: ${String(error)}`);
  }
}

// ── Workspace diff ──────────────────────────────────────────────────────────

export function inferChangedWorkspacePaths(_workspacePath: string, limit = 32, issue?: IssueEntry): string[] {
  if (!issue?.baseBranch || !issue.branchName) return [];
  try {
    const output = execSync(
      `git diff --name-only "${issue.baseBranch}"..."${issue.branchName}"`,
      { cwd: TARGET_ROOT, encoding: "utf8", timeout: 10_000, stdio: "pipe" },
    );
    return output.trim().split("\n").filter(Boolean).slice(0, limit);
  } catch {
    return [];
  }
}

/** Compute lines added/removed/files changed from workspace diff. */
export function computeDiffStats(issue: IssueEntry): void {
  if (!issue.baseBranch || !issue.branchName) return;
  try {
    let raw = "";
    try {
      raw = execSync(
        `git diff --stat "${issue.baseBranch}"..."${issue.branchName}"`,
        { cwd: TARGET_ROOT, encoding: "utf8", maxBuffer: 512_000, timeout: 10_000, stdio: "pipe" },
      );
    } catch (err: any) {
      raw = err.stdout || "";
    }
    if (raw) parseDiffStats(issue, raw);
  } catch {}
}

export function parseDiffStats(issue: IssueEntry, raw: string): void {
  const lines = raw.trim().split("\n");
  const summary = lines[lines.length - 1] || "";
  const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
  const addMatch = summary.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/);

  // Filter internal files from --stat output (not present in --shortstat)
  const internalRe = /fifony[-_]|\.fifony-|WORKFLOW\.local/;
  const fileLines = lines.slice(0, -1).filter((l) => {
    const name = l.trim().split("|")[0]?.trim().split("/").pop() || "";
    return !internalRe.test(name);
  });

  // Use filtered file count from --stat when available, fall back to regex for --shortstat
  const regexFiles = filesMatch ? parseInt(filesMatch[1], 10) : 0;
  issue.filesChanged = fileLines.length > 0 ? fileLines.length : regexFiles;
  issue.linesAdded = addMatch ? parseInt(addMatch[1], 10) : 0;
  issue.linesRemoved = delMatch ? parseInt(delMatch[1], 10) : 0;
}

export async function syncIssueDiffStatsToStore(issue: IssueEntry): Promise<void> {
  if (!issue?.id) return;

  const { getIssueStateResource } = await import("../persistence/store.ts");
  const issueResource = getIssueStateResource();
  if (!issueResource) return;

  const toNumber = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const nextLinesAdded = toNumber(issue.linesAdded);
  const nextLinesRemoved = toNumber(issue.linesRemoved);
  const nextFilesChanged = toNumber(issue.filesChanged);

  if (nextLinesAdded === 0 && nextLinesRemoved === 0 && nextFilesChanged === 0 && !issue.branchName) {
    return;
  }

  // Read current resource values to compute delta for EC add/sub
  const current = await (issueResource as any).get?.(issue.id).catch(() => null) as
    | null
    | { linesAdded?: unknown; linesRemoved?: unknown; filesChanged?: unknown };

  const previousLinesAdded = toNumber(current?.linesAdded);
  const previousLinesRemoved = toNumber(current?.linesRemoved);
  const previousFilesChanged = toNumber(current?.filesChanged);

  // Always patch the resource with the latest values
  await (issueResource as any).patch(issue.id, {
    linesAdded: nextLinesAdded,
    linesRemoved: nextLinesRemoved,
    filesChanged: nextFilesChanged,
    branchName: issue.branchName,
  });

  // EC delta tracking: only call add/sub when there's an actual change
  const add = (issueResource as any).add;
  const sub = (issueResource as any).sub;
  if (typeof add !== "function" || typeof sub !== "function") {
    logger.debug({ issueId: issue.id }, "[DiffStats] resource.add/sub not available — EC plugin may not be installed");
    return;
  }

  const deltaAdded = nextLinesAdded - previousLinesAdded;
  const deltaRemoved = nextLinesRemoved - previousLinesRemoved;
  const deltaFiles = nextFilesChanged - previousFilesChanged;

  if (deltaAdded === 0 && deltaRemoved === 0 && deltaFiles === 0) {
    logger.debug({ issueId: issue.id, nextLinesAdded, previousLinesAdded }, "[DiffStats] No delta to send to EC (values already synced)");
    return;
  }

  logger.debug({ issueId: issue.id, deltaAdded, deltaRemoved, deltaFiles }, "[DiffStats] Sending deltas to EC");

  const applyDelta = async (field: string, delta: number): Promise<void> => {
    if (delta > 0) {
      await add.call(issueResource, issue.id, field, delta);
    } else if (delta < 0) {
      await sub.call(issueResource, issue.id, field, Math.abs(delta));
    }
  };

  await Promise.all([
    applyDelta("linesAdded", deltaAdded),
    applyDelta("linesRemoved", deltaRemoved),
    applyDelta("filesChanged", deltaFiles),
  ]);
}

// ── Workspace merge ─────────────────────────────────────────────────────────

export interface MergeResult {
  copied: string[];
  deleted: string[];
  skipped: string[];
  conflicts: string[];
}

function ensureWorktreeCommitted(issue: IssueEntry): void {
  const worktreePath = issue.worktreePath;
  if (!worktreePath || !issue.branchName) return;

  execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });
  const statusBeforeCommit = execSync("git status --porcelain", { cwd: worktreePath, encoding: "utf8" }).trim();
  if (!statusBeforeCommit) return;

  try {
    execSync(`git commit -m "fifony: agent changes for ${issue.identifier}"`, { cwd: worktreePath, stdio: "pipe" });
  } catch (error) {
    const remaining = execSync("git status --porcelain", { cwd: worktreePath, encoding: "utf8" }).trim();
    if (remaining) {
      throw new Error(`Failed to commit agent changes for ${issue.identifier}: ${String(error)}`);
    }
  }

  const statusAfterCommit = execSync("git status --porcelain", { cwd: worktreePath, encoding: "utf8" }).trim();
  if (statusAfterCommit) {
    throw new Error(`Worktree for ${issue.identifier} still has uncommitted changes after commit.`);
  }
}

export { ensureWorktreeCommitted };

/** Auto-commit dirty TARGET_ROOT state before merge operations so the merge isn't blocked. */
function autoCommitTargetIfDirty(): void {
  const status = execSync("git status --porcelain", { cwd: TARGET_ROOT, encoding: "utf8" }).trim();
  if (!status) return;
  try {
    execSync("git add -A", { cwd: TARGET_ROOT, stdio: "pipe" });
    execSync('git commit -m "chore: auto-commit uncommitted changes before fifony merge"', { cwd: TARGET_ROOT, stdio: "pipe" });
    logger.info("[Workspace] Auto-committed dirty TARGET_ROOT before merge");
  } catch (err) {
    logger.warn({ err: String(err) }, "[Workspace] Failed to auto-commit TARGET_ROOT");
  }
}

/** Merge a worktree branch into TARGET_ROOT using git merge --no-ff.
 *  When abortOnConflict is false, conflict markers are left in place for agent resolution. */
function mergeWorktree(issue: IssueEntry, abortOnConflict = true, autoCommit = true): MergeResult {
  const result: MergeResult = { copied: [], deleted: [], skipped: [], conflicts: [] };
  ensureWorktreeCommitted(issue);

  const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: TARGET_ROOT, encoding: "utf8" }).trim();
  if (currentBranch !== issue.baseBranch) {
    throw new Error(`Cannot merge ${issue.identifier}: current branch is ${currentBranch}, expected ${issue.baseBranch}.`);
  }

  const targetStatus = execSync("git status --porcelain", { cwd: TARGET_ROOT, encoding: "utf8" }).trim();
  if (targetStatus) {
    if (autoCommit) {
      autoCommitTargetIfDirty();
    } else {
      throw new Error(`Cannot merge ${issue.identifier}: target repository has uncommitted changes. Enable 'Auto-commit before merge' in Settings or commit manually.`);
    }
  }

  // Collect changed files before merging (for the result summary)
  try {
    const diffOut = execSync(
      `git diff --name-status "${issue.baseBranch}"..."${issue.branchName}"`,
      { cwd: TARGET_ROOT, encoding: "utf8" },
    );
    for (const line of diffOut.trim().split("\n").filter(Boolean)) {
      const [statusChar, ...parts] = line.split("\t");
      const filePath = parts.join("\t");
      if (statusChar === "D") result.deleted.push(filePath);
      else result.copied.push(filePath);
    }
  } catch { /* best-effort */ }

  try {
    execSync(
      `git merge --no-ff "${issue.branchName}" -m "fifony: merge ${issue.identifier}"`,
      { cwd: TARGET_ROOT, stdio: "pipe" },
    );
  } catch (err: any) {
    // Merge failed — collect conflict files
    try {
      const conflictOut = execSync(
        "git diff --name-only --diff-filter=U",
        { cwd: TARGET_ROOT, encoding: "utf8" },
      );
      result.conflicts.push(...conflictOut.trim().split("\n").filter(Boolean));
    } catch {}
    if (abortOnConflict) {
      try { execSync("git merge --abort", { cwd: TARGET_ROOT, stdio: "pipe" }); } catch {}
      logger.warn({ issueId: issue.id, err: String(err) }, "[Agent] Git merge failed, aborted");
    } else {
      logger.info({ issueId: issue.id, conflicts: result.conflicts }, "[Agent] Git merge has conflicts — leaving markers for agent resolution");
    }
  }

  return result;
}

export function shouldSkipMergePath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((s) => s === ".git" || s === "node_modules" || s === ".fifony" || s === "dist" || s === ".tanstack")) {
    return true;
  }
  const base = parts.at(-1) ?? "";
  return base === "WORKFLOW.local.md"
    || base === ".fifony-env.sh"
    || base === ".fifony-compiled-env.sh"
    || base === ".fifony-local-source-ready"
    || base.startsWith("fifony-")
    || base.startsWith("fifony_");
}

/** Merge a worktree branch into TARGET_ROOT. */
export function mergeWorkspace(issue: IssueEntry, abortOnConflict = true, autoCommit = true): MergeResult {
  ensureGitRepoReadyForWorktrees(TARGET_ROOT, "merge issues");
  assertIssueHasGitWorktree(issue, "merge");
  return mergeWorktree(issue, abortOnConflict, autoCommit);
}

// ── Dry merge (pre-merge conflict detection) ────────────────────────────────

export type DryMergeResult = {
  willConflict: boolean;
  conflictFiles: string[];
  canMerge: boolean;
  changedFiles: number;
};

/** Run a no-commit merge to detect conflicts without modifying the working tree. */
export function dryMerge(issue: IssueEntry, autoCommit = true): DryMergeResult {
  ensureGitRepoReadyForWorktrees(TARGET_ROOT, "preview merges");
  assertIssueHasGitWorktree(issue, "preview merge");

  ensureWorktreeCommitted(issue);

  const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: TARGET_ROOT, encoding: "utf8" }).trim();
  if (currentBranch !== issue.baseBranch) {
    throw new Error(`Cannot preview merge: current branch is ${currentBranch}, expected ${issue.baseBranch}.`);
  }

  const targetStatus = execSync("git status --porcelain", { cwd: TARGET_ROOT, encoding: "utf8" }).trim();
  if (targetStatus) {
    if (autoCommit) {
      autoCommitTargetIfDirty();
    } else {
      throw new Error(`Cannot preview merge: target repository has uncommitted changes. Enable 'Auto-commit before merge' in Settings or commit manually.`);
    }
  }

  let conflictFiles: string[] = [];
  let willConflict = false;

  try {
    execSync(
      `git merge --no-commit --no-ff "${issue.branchName}"`,
      { cwd: TARGET_ROOT, stdio: "pipe" },
    );
  } catch {
    willConflict = true;
    try {
      const conflictOut = execSync(
        "git diff --name-only --diff-filter=U",
        { cwd: TARGET_ROOT, encoding: "utf8" },
      );
      conflictFiles = conflictOut.trim().split("\n").filter(Boolean);
    } catch {}
  }

  // Always clean up without destructive resets or cleaning untracked files.
  try {
    execSync("git merge --abort", { cwd: TARGET_ROOT, stdio: "pipe" });
  } catch {
    try {
      execSync("git reset --merge ORIG_HEAD", { cwd: TARGET_ROOT, stdio: "pipe" });
    } catch {
      try {
        execSync("git reset --merge", { cwd: TARGET_ROOT, stdio: "pipe" });
      } catch (error) {
        logger.warn({ issueId: issue.id, err: String(error) }, "[Workspace] Failed to safely clean dry-merge state");
      }
    }
  }

  let changedFiles = 0;
  try {
    const diffOut = execSync(
      `git diff --name-only "${issue.baseBranch}"..."${issue.branchName}"`,
      { cwd: TARGET_ROOT, encoding: "utf8" },
    );
    changedFiles = diffOut.trim().split("\n").filter(Boolean).length;
  } catch {}

  return { willConflict, conflictFiles, canMerge: !willConflict, changedFiles };
}

// ── Rebase worktree onto updated base ────────────────────────────────────────

export type RebaseResult = {
  success: boolean;
  conflictFiles: string[];
};

/** Rebase the worktree branch onto the latest base branch. Aborts on conflicts. */
export function rebaseWorktree(issue: IssueEntry): RebaseResult {
  ensureGitRepoReadyForWorktrees(TARGET_ROOT, "rebase worktrees");
  assertIssueHasGitWorktree(issue, "rebase");

  ensureWorktreeCommitted(issue);

  try {
    execSync(
      `git rebase "${issue.baseBranch}"`,
      { cwd: issue.worktreePath, stdio: "pipe" },
    );
    return { success: true, conflictFiles: [] };
  } catch {
    let conflictFiles: string[] = [];
    try {
      const conflictOut = execSync(
        "git diff --name-only --diff-filter=U",
        { cwd: issue.worktreePath, encoding: "utf8" },
      );
      conflictFiles = conflictOut.trim().split("\n").filter(Boolean);
    } catch {}
    try { execSync("git rebase --abort", { cwd: issue.worktreePath, stdio: "pipe" }); } catch {}
    return { success: false, conflictFiles };
  }
}

export function hydrateIssuePathsFromWorkspace(issue: IssueEntry): string[] {
  const inferredPaths = inferChangedWorkspacePaths(issue.workspacePath ?? "", 32, issue);
  if (inferredPaths.length === 0) return [];
  issue.paths = [...new Set([...(issue.paths ?? []), ...inferredPaths])];
  return inferredPaths;
}

/** Write versioned review artifacts to workspace (also used for execute artifacts). */
export function writeVersionedArtifacts(
  workspacePath: string,
  prefix: string,
  planVersion: number,
  attempt: number,
  sources: Array<{ srcFile: string; destSuffix: string }>,
): void {
  const { writeFileSync: _wfs, readFileSync: _rfs, existsSync: _es } = { writeFileSync, readFileSync, existsSync };
  for (const { srcFile, destSuffix } of sources) {
    const src = join(workspacePath, srcFile);
    if (_es(src)) {
      _wfs(join(workspacePath, `${prefix}.v${planVersion}a${attempt}.${destSuffix}`), _rfs(src, "utf8"), "utf8");
    }
  }
}
