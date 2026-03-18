import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { env } from "node:process";
import { execSync, spawn } from "node:child_process";
import type {
  AgentDirective,
  AgentDirectiveStatus,
  AgentPipelineRecord,
  AgentPipelineState,
  AgentProviderDefinition,
  AgentProviderRole,
  AgentSessionRecord,
  AgentSessionResult,
  AgentSessionState,
  AgentSessionTurn,
  AgentTokenUsage,
  IssueEntry,
  JsonRecord,
  RuntimeConfig,
  RuntimeState,
  WorkflowConfig,
  WorkflowDefinition,
} from "./types.ts";
import {
  SOURCE_ROOT,
  TARGET_ROOT,
  TERMINAL_STATES,
  WORKSPACE_ROOT,
} from "./constants.ts";
import {
  now,
  sleep,
  toStringValue,
  toNumberValue,
  clamp,
  idToSafePath,
  appendFileTail,
  getNestedRecord,
  getNestedNumber,
} from "./helpers.ts";
import { logger } from "./logger.ts";
import {
  getAgentSessionResource,
  getAgentPipelineResource,
  isStateNotFoundError,
  persistState,
} from "./store.ts";
import { markIssueDirty } from "./dirty-tracker.ts";
import {
  normalizeAgentProvider,
  getEffectiveAgentProviders,
  applyCapabilityMetadata,
} from "./providers.ts";
import {
  addEvent,
  transitionIssueState,
  computeMetrics,
  getNextRetryAt,
} from "./issues.ts";
import {
  inferCapabilityPaths,
  resolveTaskCapabilities,
} from "../routing/capability-resolver.ts";
import { renderPrompt, renderPromptString } from "../prompting.ts";
import { discoverSkills, buildSkillContext } from "./skills.ts";
import { ensureSourceReady } from "./workflow.ts";
import { compileExecution, compileReview, persistCompilationArtifacts, buildExecutionAudit, persistExecutionAudit } from "./adapters/index.ts";
import { getWorkflowConfig, loadRuntimeSettings } from "./settings.ts";
import { record as recordTokens } from "./token-ledger.ts";

/** Check if a directory is inside a git repository. */
function isGitRepo(dir: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function normalizeAgentDirectiveStatus(value: unknown, fallback: AgentDirectiveStatus): AgentDirectiveStatus {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "done" || normalized === "continue" || normalized === "blocked" || normalized === "failed") {
    return normalized;
  }
  return fallback;
}

function addTokenUsage(issue: IssueEntry, usage?: AgentTokenUsage, role?: AgentProviderRole): void {
  if (!usage || usage.totalTokens === 0) return;

  // 1. Aggregate overall tokenUsage summary
  const prev = issue.tokenUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  issue.tokenUsage = {
    inputTokens: prev.inputTokens + usage.inputTokens,
    outputTokens: prev.outputTokens + usage.outputTokens,
    totalTokens: prev.totalTokens + usage.totalTokens,
    model: usage.model || prev.model,
  };

  // 2. Per-phase breakdown (planner / executor / reviewer)
  if (role) {
    if (!issue.tokensByPhase) issue.tokensByPhase = {} as Record<AgentProviderRole, AgentTokenUsage>;
    const prevPhase = issue.tokensByPhase[role] ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    issue.tokensByPhase[role] = {
      inputTokens: prevPhase.inputTokens + usage.inputTokens,
      outputTokens: prevPhase.outputTokens + usage.outputTokens,
      totalTokens: prevPhase.totalTokens + usage.totalTokens,
      model: usage.model || prevPhase.model,
    };
  }

  // 3. Per-model breakdown with full input/output detail
  const model = usage.model || issue.tokenUsage?.model || "unknown";
  if (!issue.tokensByModel) issue.tokensByModel = {};
  const prevModel = issue.tokensByModel[model] ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  issue.tokensByModel[model] = {
    inputTokens: prevModel.inputTokens + usage.inputTokens,
    outputTokens: prevModel.outputTokens + usage.outputTokens,
    totalTokens: prevModel.totalTokens + usage.totalTokens,
    model,
  };

  // 4. Legacy per-model totals for EventualConsistency analytics
  if (!issue.usage) issue.usage = { tokens: {} };
  issue.usage.tokens[model] = (issue.usage.tokens[model] || 0) + usage.totalTokens;
}

function extractOutputMarker(output: string, name: string): string {
  const match = output.match(new RegExp(`^${name}=(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function extractTokenUsage(output: string, jsonObj?: JsonRecord | null): AgentTokenUsage | undefined {
  if (jsonObj) {
    // 1a. Claude --output-format json: modelUsage field (richer — includes cache tokens, per-model breakdown)
    const modelUsage = jsonObj.modelUsage as Record<string, Record<string, unknown>> | undefined;
    if (modelUsage && typeof modelUsage === "object") {
      let totalInput = 0, totalOutput = 0, primaryModel = "", maxTokens = 0;
      for (const [model, data] of Object.entries(modelUsage)) {
        const inp = Number(data?.inputTokens || 0) + Number(data?.cacheReadInputTokens || 0) + Number(data?.cacheCreationInputTokens || 0);
        const out = Number(data?.outputTokens || 0);
        totalInput += inp;
        totalOutput += out;
        if (inp + out > maxTokens) { maxTokens = inp + out; primaryModel = model; }
      }
      if (totalInput > 0 || totalOutput > 0) {
        return {
          inputTokens: totalInput,
          outputTokens: totalOutput,
          totalTokens: totalInput + totalOutput,
          costUsd: typeof jsonObj.cost_usd === "number" ? jsonObj.cost_usd : undefined,
          model: primaryModel || (typeof jsonObj.model === "string" ? jsonObj.model : undefined),
        };
      }
    }

    // 1b. Claude --output-format json: usage field (aggregate totals)
    const usage = jsonObj.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      const inp = Number(usage.input_tokens) || 0;
      const out = Number(usage.output_tokens) || 0;
      if (inp > 0 || out > 0) {
        return {
          inputTokens: inp,
          outputTokens: out,
          totalTokens: inp + out,
          costUsd: typeof jsonObj.cost_usd === "number" ? jsonObj.cost_usd : undefined,
          model: typeof jsonObj.model === "string" ? jsonObj.model : undefined,
        };
      }
    }
  }

  // 2. Codex: "tokens used\n1,681\n" and "model: gpt-5.3" in stdout
  const codexMatch = output.match(/tokens?\s+used\s*\n\s*([\d,]+)/i);
  if (codexMatch) {
    const total = parseInt(codexMatch[1].replace(/,/g, ""), 10);
    if (total > 0) {
      const modelMatch = output.match(/^model:\s*(.+)$/im);
      return {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: total,
        model: modelMatch?.[1]?.trim() || undefined,
      };
    }
  }

  return undefined;
}

function tryParseJsonOutput(output: string): JsonRecord | null {
  const trimmed = output.trim();
  // --output-format json wraps the result in a JSON object with a "result" field
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as JsonRecord;

      // --json-schema puts structured output in .structured_output (not .result)
      if (obj.structured_output && typeof obj.structured_output === "object" && !Array.isArray(obj.structured_output)) {
        return obj.structured_output as JsonRecord;
      }

      // Claude --output-format json returns { result: "..." } — the result may itself be JSON
      if (typeof obj.result === "string") {
        try {
          const inner = JSON.parse(obj.result) as unknown;
          if (inner && typeof inner === "object" && !Array.isArray(inner)) {
            return inner as JsonRecord;
          }
        } catch {
          // result is plain text, not JSON
        }
      }
      // Direct JSON with status field (from --json-schema)
      if (obj.status) return obj;
    }
  } catch {
    // Not JSON output — fall through to legacy parsing
  }
  return null;
}

function readAgentDirective(workspacePath: string, output: string, success: boolean): AgentDirective {
  const fallbackStatus: AgentDirectiveStatus = success ? "done" : "failed";
  const resultFile = join(workspacePath, "fifony-result.json");
  let resultPayload: JsonRecord = {};

  // 1. Try structured JSON from stdout (claude --output-format json --json-schema)
  const fullJson = (() => {
    try { return JSON.parse(output.trim()) as JsonRecord; } catch { return null; }
  })();
  const jsonOutput = tryParseJsonOutput(output);
  const tokenUsage = extractTokenUsage(output, fullJson);

  if (jsonOutput?.status) {
    return {
      status: normalizeAgentDirectiveStatus(jsonOutput.status, fallbackStatus),
      summary: toStringValue(jsonOutput.summary) || toStringValue(jsonOutput.message) || "",
      nextPrompt: toStringValue(jsonOutput.nextPrompt) || toStringValue(jsonOutput.next_prompt) || "",
      tokenUsage,
    };
  }

  // 2. Try fifony-result.json file
  if (existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(readFileSync(resultFile, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        resultPayload = parsed as JsonRecord;
      }
    } catch (error) {
      logger.warn(`Invalid fifony-result.json in ${workspacePath}: ${String(error)}`);
    }
  }

  // 3. Fall back to file + output marker parsing
  const status = normalizeAgentDirectiveStatus(
    resultPayload.status ?? extractOutputMarker(output, "FIFONY_STATUS"),
    fallbackStatus,
  );
  const summary =
    toStringValue(resultPayload.summary)
    || toStringValue(resultPayload.message)
    || extractOutputMarker(output, "FIFONY_SUMMARY");
  const nextPrompt =
    toStringValue(resultPayload.nextPrompt)
    || toStringValue(resultPayload.next_prompt)
    || "";

  return { status, summary, nextPrompt, tokenUsage };
}

// ── Agent PID management ────────────────────────────────────────────────────

type AgentPidInfo = {
  pid: number;
  issueId: string;
  startedAt: string;
  command: string;
};

/** Read PID file from workspace, returns null if missing/invalid. */
export function readAgentPid(workspacePath: string): AgentPidInfo | null {
  const pidFile = join(workspacePath, "fifony-agent.pid");
  if (!existsSync(pidFile)) return null;
  try {
    const data = JSON.parse(readFileSync(pidFile, "utf8")) as AgentPidInfo;
    if (!data?.pid || typeof data.pid !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

/** Check if a process is still running by PID. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/** Check if an issue's agent is still running from a previous session. */
export function isAgentStillRunning(issue: IssueEntry): { alive: boolean; pid: AgentPidInfo | null } {
  const wp = issue.workspacePath;
  if (!wp || !existsSync(wp)) return { alive: false, pid: null };
  const pidInfo = readAgentPid(wp);
  if (!pidInfo) return { alive: false, pid: null };
  return { alive: isProcessAlive(pidInfo.pid), pid: pidInfo };
}

/** Clean stale PID file if the process is dead. */
export function cleanStalePidFile(workspacePath: string): void {
  const pidInfo = readAgentPid(workspacePath);
  if (!pidInfo) return;
  if (!isProcessAlive(pidInfo.pid)) {
    try { rmSync(join(workspacePath, "fifony-agent.pid"), { force: true }); } catch {}
  }
}

export function canRunIssue(issue: IssueEntry, running: Set<string>, state: RuntimeState): boolean {
  if (!issue.assignedToWorker) return false;
  if (running.has(issue.id)) return false;
  if (TERMINAL_STATES.has(issue.state)) return false;

  // Don't spawn a new agent if one is still alive from a previous session
  const { alive } = isAgentStillRunning(issue);
  if (alive) {
    logger.debug({ issueId: issue.id, identifier: issue.identifier }, "[Agent] Skipping issue — agent still alive from previous session");
    return false;
  }

  if (issue.state === "Blocked") {
    if (!issue.nextRetryAt) return false;
    if (issue.attempts >= issue.maxAttempts) {
      logger.debug({ issueId: issue.id, identifier: issue.identifier, attempts: issue.attempts, maxAttempts: issue.maxAttempts }, "[Agent] Skipping blocked issue — max attempts reached");
      return false;
    }
    if (Date.parse(issue.nextRetryAt) > Date.now()) return false;
  }

  if (!issueDepsResolved(issue, state.issues)) {
    logger.debug({ issueId: issue.id, identifier: issue.identifier, blockedBy: issue.blockedBy }, "[Agent] Skipping issue — unresolved dependencies");
    return false;
  }

  if (issue.state === "Todo") return true;
  if (issue.state === "Queued") return true;
  if (issue.state === "Blocked") return true;
  if (issue.state === "Interrupted") return true;
  if (issue.state === "Running" && issueHasResumableSession(issue)) return true;
  if (issue.state === "In Review") return true;

  return false;
}

function issueDepsResolved(issue: IssueEntry, allIssues: IssueEntry[]): boolean {
  if (issue.blockedBy.length === 0) return true;
  const map = new Map(allIssues.map((entry) => [entry.id, entry]));
  return issue.blockedBy.every((depId) => {
    const dep = map.get(depId);
    return dep?.state === "Done";
  });
}

function shouldSkipRoutingPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((segment) => segment === ".git" || segment === "node_modules" || segment === ".fifony")) {
    return true;
  }
  const base = parts.at(-1) ?? "";
  return base === "WORKFLOW.local.md"
    || base === ".fifony-env.sh"
    || base.startsWith("fifony-")
    || base.startsWith("fifony_");
}

function inferChangedWorkspacePaths(workspacePath: string, limit = 32, issue?: IssueEntry): string[] {
  // Git worktree: use git diff --name-only for accuracy
  if (issue?.baseBranch && issue.branchName) {
    try {
      const output = execSync(
        `git diff --name-only "${issue.baseBranch}"..."${issue.branchName}"`,
        { cwd: TARGET_ROOT, encoding: "utf8", timeout: 10_000 },
      );
      return output.trim().split("\n").filter(Boolean).slice(0, limit);
    } catch {}
  }

  // Fallback: filesystem walk comparing workspace vs SOURCE_ROOT
  const codePath = issue?.worktreePath ?? workspacePath;
  if (!codePath || !existsSync(codePath) || !existsSync(SOURCE_ROOT)) return [];

  const changed = new Set<string>();

  const walk = (currentRoot: string, relativeRoot = ""): void => {
    if (changed.size >= limit) return;
    for (const item of readdirSync(currentRoot, { withFileTypes: true })) {
      if (changed.size >= limit) return;
      const nextRelative = relativeRoot ? `${relativeRoot}/${item.name}` : item.name;
      if (shouldSkipRoutingPath(nextRelative)) continue;
      const currentPath = join(currentRoot, item.name);
      if (item.isDirectory()) { walk(currentPath, nextRelative); continue; }
      if (!item.isFile()) continue;
      const sourcePath = join(SOURCE_ROOT, nextRelative);
      if (!existsSync(sourcePath)) { changed.add(nextRelative); continue; }
      const currentStat = statSync(currentPath);
      const sourceStat = statSync(sourcePath);
      if (currentStat.size !== sourceStat.size) { changed.add(nextRelative); continue; }
      const currentFile = readFileSync(currentPath);
      const sourceFile = readFileSync(sourcePath);
      if (!currentFile.equals(sourceFile)) changed.add(nextRelative);
    }
  };

  walk(codePath);
  return [...changed];
}

/** Compute lines added/removed/files changed from workspace diff. */
export function computeDiffStats(issue: IssueEntry): void {
  // Git worktree: diff the branch vs its base
  if (issue.baseBranch && issue.branchName) {
    try {
      let raw = "";
      try {
        raw = execSync(
          `git diff --stat "${issue.baseBranch}"..."${issue.branchName}"`,
          { cwd: TARGET_ROOT, encoding: "utf8", maxBuffer: 512_000, timeout: 10_000 },
        );
      } catch (err: any) {
        raw = err.stdout || "";
      }
      if (raw) parseDiffStats(issue, raw);
    } catch {}
    return;
  }

  // Legacy: git diff --no-index
  const wp = issue.worktreePath ?? issue.workspacePath;
  if (!wp || !existsSync(wp) || !existsSync(SOURCE_ROOT)) return;
  try {
    let raw = "";
    try {
      raw = execSync(
        `git diff --no-index --stat -- "${SOURCE_ROOT}" "${wp}" 2>/dev/null`,
        { encoding: "utf8", maxBuffer: 512_000, timeout: 10_000 },
      );
    } catch (err: any) {
      raw = err.stdout || "";
    }
    if (raw) parseDiffStats(issue, raw);
  } catch {}
}

function parseDiffStats(issue: IssueEntry, raw: string): void {
  const lines = raw.trim().split("\n");
  const summary = lines[lines.length - 1] || "";
  const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
  const addMatch = summary.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/);

  const internalRe = /fifony[-_]|\.fifony-|WORKFLOW\.local/;
  const fileLines = lines.slice(0, -1).filter((l) => {
    const name = l.trim().split("|")[0]?.trim().split("/").pop() || "";
    return !internalRe.test(name);
  });

  issue.filesChanged = fileLines.length || (filesMatch ? parseInt(filesMatch[1], 10) : 0);
  issue.linesAdded = addMatch ? parseInt(addMatch[1], 10) : 0;
  issue.linesRemoved = delMatch ? parseInt(delMatch[1], 10) : 0;
}

export interface MergeResult {
  copied: string[];
  deleted: string[];
  skipped: string[];
  conflicts: string[];
}

/** Merge a worktree branch into TARGET_ROOT using git merge --no-ff. */
function mergeWorktree(issue: IssueEntry, worktreePath: string): MergeResult {
  const result: MergeResult = { copied: [], deleted: [], skipped: [], conflicts: [] };

  // Auto-commit any uncommitted changes the agent left in the worktree
  try {
    execSync("git add -A", { cwd: worktreePath, stdio: "pipe" });
    const status = execSync("git status --porcelain", { cwd: worktreePath, encoding: "utf8" });
    if (status.trim()) {
      execSync(`git commit -m "fifony: agent changes for ${issue.identifier}"`, { cwd: worktreePath, stdio: "pipe" });
    }
  } catch { /* nothing staged or commit failed — continue */ }

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

  // Stash any uncommitted changes in TARGET_ROOT so merge can proceed
  let didStash = false;
  try {
    const stashOut = execSync("git stash", { cwd: TARGET_ROOT, encoding: "utf8" }).trim();
    didStash = !stashOut.includes("No local changes to save");
  } catch { /* ignore stash failure */ }

  try {
    execSync(
      `git merge --no-ff "${issue.branchName}" -m "fifony: merge ${issue.identifier}"`,
      { cwd: TARGET_ROOT, stdio: "pipe" },
    );
  } catch (err: any) {
    // Merge failed — collect conflict files and abort
    try {
      const conflictOut = execSync(
        "git diff --name-only --diff-filter=U",
        { cwd: TARGET_ROOT, encoding: "utf8" },
      );
      result.conflicts.push(...conflictOut.trim().split("\n").filter(Boolean));
    } catch {}
    try { execSync("git merge --abort", { cwd: TARGET_ROOT, stdio: "pipe" }); } catch {}
    logger.warn({ issueId: issue.id, err: String(err) }, "[Agent] Git merge failed, aborted");
  }

  // Restore stashed changes
  if (didStash) {
    try { execSync("git stash pop", { cwd: TARGET_ROOT, stdio: "pipe" }); } catch {}
  }

  return result;
}

/** Check if a file in TARGET_ROOT has been modified by another worker (differs from SOURCE_ROOT). */
function isConflict(relativePath: string): boolean {
  const targetPath = join(TARGET_ROOT, relativePath);
  const sourcePath = join(SOURCE_ROOT, relativePath);

  // File exists in target but not in source → another worker created it
  if (!existsSync(sourcePath)) return existsSync(targetPath);

  // File doesn't exist in target → someone deleted it, not a conflict for us
  if (!existsSync(targetPath)) return false;

  // Both exist → compare target vs source. If different, another worker already changed it.
  const targetStat = statSync(targetPath);
  const sourceStat = statSync(sourcePath);
  if (targetStat.size !== sourceStat.size) return true;
  return !readFileSync(targetPath).equals(readFileSync(sourcePath));
}

/**
 * Merge workspace changes back into TARGET_ROOT.
 * If the issue has a git worktree branch, uses git merge --no-ff.
 * Otherwise falls back to the legacy file-copy approach.
 */
export function mergeWorkspace(issue: IssueEntry): MergeResult {
  const worktreePath = issue.worktreePath;
  const workspacePath = issue.workspacePath;
  const effectivePath = worktreePath ?? workspacePath;

  if (!effectivePath || !existsSync(effectivePath)) {
    throw new Error(`Workspace not found for ${issue.identifier}`);
  }

  // Git worktree path: use git merge
  if (issue.branchName && issue.baseBranch && worktreePath) {
    return mergeWorktree(issue, worktreePath);
  }

  // Legacy: manual file copy
  const result: MergeResult = { copied: [], deleted: [], skipped: [], conflicts: [] };
  const legacyPath = effectivePath;

  // 1. Walk workspace and copy new/modified files to TARGET_ROOT
  const walkWorkspace = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, item.name);
      const relativePath = relative(legacyPath, fullPath);

      if (shouldSkipMergePath(relativePath)) {
        result.skipped.push(relativePath);
        continue;
      }

      if (item.isDirectory()) {
        walkWorkspace(fullPath);
        continue;
      }

      if (!item.isFile()) continue;

      const sourcePath = join(SOURCE_ROOT, relativePath);

      const isNew = !existsSync(sourcePath);
      let isModified = false;
      if (!isNew) {
        const wsStat = statSync(fullPath);
        const srcStat = statSync(sourcePath);
        if (wsStat.size !== srcStat.size) {
          isModified = true;
        } else {
          const wsContent = readFileSync(fullPath);
          const srcContent = readFileSync(sourcePath);
          isModified = !wsContent.equals(srcContent);
        }
      }

      if (isNew || isModified) {
        if (isConflict(relativePath)) {
          result.conflicts.push(relativePath);
          continue;
        }

        const targetDir = join(TARGET_ROOT, relative(legacyPath, dir));
        const targetPath = join(TARGET_ROOT, relativePath);
        mkdirSync(targetDir, { recursive: true });
        cpSync(fullPath, targetPath, { force: true });
        result.copied.push(relativePath);
      }
    }
  };

  // 2. Walk SOURCE_ROOT to find files deleted in workspace
  const walkSource = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, item.name);
      const relativePath = relative(SOURCE_ROOT, fullPath);

      if (shouldSkipMergePath(relativePath)) continue;

      if (item.isDirectory()) {
        walkSource(fullPath);
        continue;
      }

      if (!item.isFile()) continue;

      const wsPath = join(legacyPath, relativePath);
      if (!existsSync(wsPath)) {
        const targetPath = join(TARGET_ROOT, relativePath);
        if (existsSync(targetPath)) {
          if (isConflict(relativePath)) {
            result.conflicts.push(relativePath);
          } else {
            rmSync(targetPath, { force: true });
            result.deleted.push(relativePath);
          }
        }
      }
    }
  };

  walkWorkspace(legacyPath);
  walkSource(SOURCE_ROOT);

  return result;
}

function shouldSkipMergePath(relativePath: string): boolean {
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

export function hydrateIssuePathsFromWorkspace(issue: IssueEntry): string[] {
  const inferredPaths = inferChangedWorkspacePaths(issue.workspacePath ?? "", 32, issue);
  if (inferredPaths.length === 0) return [];
  issue.paths = [...new Set([...(issue.paths ?? []), ...inferredPaths])];
  issue.inferredPaths = [...new Set([...(issue.inferredPaths ?? []), ...inferredPaths])];
  return inferredPaths;
}

export function describeRoutingSignals(issue: IssueEntry, workspaceDerivedPaths: string[]): string {
  const explicitPaths = issue.paths ?? [];
  const textDerivedPaths = inferCapabilityPaths({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    labels: issue.labels,
  }).filter((path) => !explicitPaths.includes(path));

  const parts: string[] = [];
  if (explicitPaths.length > 0) parts.push(`payload paths=${explicitPaths.join(", ")}`);
  if (textDerivedPaths.length > 0) parts.push(`text hints=${textDerivedPaths.join(", ")}`);
  if (workspaceDerivedPaths.length > 0) parts.push(`workspace diff=${workspaceDerivedPaths.join(", ")}`);
  return parts.join(" | ");
}

function buildAgentSessionState(
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

async function loadAgentSessionState(
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

async function persistAgentSessionState(
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

export function issueHasResumableSession(issue: IssueEntry): boolean {
  return Boolean(issue.workspacePath) && (issue.state === "Running" || issue.state === "Interrupted");
}

function buildProviderSessionKey(issue: IssueEntry, attempt: number, provider: AgentProviderDefinition, cycle: number): string {
  return `${idToSafePath(issue.id)}-a${attempt}-${provider.role}-${provider.provider}-c${cycle}`;
}

function buildPipelineKey(issue: IssueEntry, attempt: number): string {
  return `${idToSafePath(issue.id)}-a${attempt}`;
}

function getLatestPipelineAttempt(issue: IssueEntry): number {
  if (issue.state === "Blocked" || issue.state === "Cancelled") {
    return Math.max(1, issue.attempts);
  }
  return Math.max(1, issue.attempts + 1);
}

function stateConfigMaxTurnsFallback(workflowDefinition: WorkflowDefinition | null): number {
  if (!workflowDefinition) return 4;
  return clamp(getNestedNumber(getNestedRecord(workflowDefinition.config, "agent"), "max_turns", 4), 1, 16);
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

async function persistAgentPipelineState(key: string, pipeline: AgentPipelineState): Promise<void> {
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
  workflowDefinition: WorkflowDefinition | null,
): Promise<Array<{ key: string; session: AgentSessionState; provider: string; role: string; cycle: number }>> {
  if (!pipeline) return [];

  const sessions: Array<{ key: string; session: AgentSessionState; provider: string; role: string; cycle: number }> = [];
  const attempt = pipeline.attempt;
  const agentSessionResource = getAgentSessionResource();
  const maxTurns = stateConfigMaxTurnsFallback(workflowDefinition);

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

async function buildPrompt(issue: IssueEntry, workflowDefinition: WorkflowDefinition | null): Promise<string> {
  const template = workflowDefinition?.promptTemplate.trim();
  const rendered = template
    ? await renderPromptString(template, { issue, attempt: issue.attempts || 0 })
    : await renderPrompt("workflow-default", { issue, attempt: issue.attempts || 0 });

  if (!issue.plan?.steps?.length) {
    return rendered;
  }

  const planSection = await renderPrompt("workflow-plan-section", {
    estimatedComplexity: issue.plan.estimatedComplexity,
    summary: issue.plan.summary,
    steps: issue.plan.steps.map((step) => ({
      step: step.step,
      action: step.action,
      files: step.files ?? [],
      details: step.details ?? "",
    })),
  });

  return `${rendered}\n\n${planSection}`;
}

async function buildTurnPrompt(
  issue: IssueEntry,
  basePrompt: string,
  previousOutput: string,
  turnIndex: number,
  maxTurns: number,
  nextPrompt: string,
): Promise<string> {
  if (turnIndex === 1) return basePrompt;

  return renderPrompt("agent-turn", {
    issueIdentifier: issue.identifier,
    turnIndex,
    maxTurns,
    basePrompt,
    continuation: nextPrompt.trim() || "Continue the work, inspect the workspace, and move the issue toward completion.",
    outputTail: previousOutput.trim() || "No previous output captured.",
  });
}

async function buildProviderBasePrompt(
  provider: AgentProviderDefinition,
  issue: IssueEntry,
  basePrompt: string,
  workspacePath: string,
  skillContext: string,
): Promise<string> {
  return renderPrompt("agent-provider-base", {
    isPlanner: provider.role === "planner",
    isReviewer: provider.role === "reviewer",
    hasImpeccableOverlay: provider.overlays?.includes("impeccable") ?? false,
    hasFrontendDesignOverlay: provider.overlays?.includes("frontend-design") ?? false,
    profileInstructions: provider.profileInstructions || "",
    skillContext,
    capabilityCategory: provider.capabilityCategory || "",
    selectionReason: provider.selectionReason ?? "No additional routing reason.",
    overlays: provider.overlays ?? [],
    targetPaths: issue.paths ?? [],
    workspacePath,
    basePrompt,
  });
}

async function runCommandWithTimeout(
  command: string,
  workspacePath: string,
  issue: IssueEntry,
  config: RuntimeConfig,
  promptText: string,
  promptFile: string,
  extraEnv: Record<string, string> = {},
): Promise<{ success: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const resultFile = extraEnv.FIFONY_RESULT_FILE;
    if (resultFile && extraEnv.FIFONY_PRESERVE_RESULT_FILE !== "1") {
      rmSync(resultFile, { force: true });
    }

    // Write all FIFONY_* vars to an env file and source it in the command.
    // This avoids E2BIG: child inherits process.env naturally (no ...env spread),
    // and our custom vars are loaded from a file instead of argv/env.
    const allVars: Record<string, string> = {
      FIFONY_ISSUE_ID: issue.id,
      FIFONY_ISSUE_IDENTIFIER: issue.identifier,
      FIFONY_ISSUE_TITLE: issue.title,
      FIFONY_ISSUE_PRIORITY: String(issue.priority),
      FIFONY_WORKSPACE_PATH: issue.worktreePath ?? workspacePath,
      FIFONY_PROMPT_FILE: promptFile,
    };
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value.length > 4000) {
        const valFile = join(workspacePath, `${key.toLowerCase()}.txt`);
        writeFileSync(valFile, value, "utf8");
        allVars[`${key}_FILE`] = valFile;
      } else {
        allVars[key] = value;
      }
    }

    const envFilePath = join(workspacePath, ".fifony-env.sh");
    const envFileLines = Object.entries(allVars)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("\n");
    writeFileSync(envFilePath, envFileLines, "utf8");

    const wrappedCommand = `. "${envFilePath}" && ${command}`;
    const child = spawn(wrappedCommand, {
      shell: true,
      cwd: issue.worktreePath ?? workspacePath,
      detached: true,  // Survive parent death
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Detach from parent so child survives SIGINT/restart
    child.unref();

    if (child.stdin) {
      child.stdin.end();
    }

    // Write PID file for recovery
    const pidFile = join(workspacePath, "fifony-agent.pid");
    const pid = child.pid;
    if (pid) {
      logger.debug({ issueId: issue.id, pid, command: command.slice(0, 120), cwd: workspacePath }, "[Agent] Process spawned");
      writeFileSync(pidFile, JSON.stringify({
        pid,
        issueId: issue.id,
        startedAt: new Date(started).toISOString(),
        command: command.slice(0, 200),
      }), "utf8");
    }

    let output = "";
    let timedOut = false;
    let outputBytes = 0;
    const liveLogFile = join(workspacePath, "fifony-live-output.log");
    writeFileSync(liveLogFile, "", "utf8");

    const onChunk = (chunk: Buffer | string) => {
      const text = String(chunk);
      output = appendFileTail(output, text, config.logLinesTail);
      outputBytes += text.length;
      try { appendFileSync(liveLogFile, text); } catch {}
      issue.commandOutputTail = output;
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    const AGENT_STALE_OUTPUT_MS = 300_000; // 5 minutes without output growth → stuck

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group (detached child + its children)
      if (pid) { try { process.kill(-pid, "SIGTERM"); } catch {} }
      else { child.kill("SIGTERM"); }
    }, config.commandTimeoutMs);

    // Progress watchdog: check PID alive + output growing every 30s
    let lastWatchdogBytes = 0;
    let lastOutputGrowthAt = Date.now();
    let watchdogKilled = false;
    const watchdog = setInterval(() => {
      // Check if PID is still alive
      if (pid) {
        try { process.kill(pid, 0); } catch {
          // PID died without triggering close — force resolve
          clearInterval(watchdog);
          clearTimeout(timer);
          watchdogKilled = true;
          try { rmSync(pidFile, { force: true }); } catch {}
          resolve({ success: false, code: null, output: appendFileTail(output, `\nAgent process died unexpectedly (PID ${pid}).`, config.logLinesTail) });
          return;
        }
      }
      // Check if output is still growing
      if (outputBytes > lastWatchdogBytes) {
        lastWatchdogBytes = outputBytes;
        lastOutputGrowthAt = Date.now();
      } else if (Date.now() - lastOutputGrowthAt > AGENT_STALE_OUTPUT_MS) {
        clearInterval(watchdog);
        clearTimeout(timer);
        timedOut = true;
        watchdogKilled = true;
        if (pid) { try { process.kill(-pid, "SIGTERM"); } catch {} }
        else { child.kill("SIGTERM"); }
        try { rmSync(pidFile, { force: true }); } catch {}
        resolve({ success: false, code: null, output: appendFileTail(output, `\nAgent process stuck — no output for ${Math.round(AGENT_STALE_OUTPUT_MS / 60_000)} minutes.`, config.logLinesTail) });
      }
    }, 30_000);

    const cleanup = () => {
      clearInterval(watchdog);
      try { rmSync(pidFile, { force: true }); } catch {}
    };

    child.on("error", () => {
      clearTimeout(timer);
      cleanup();
      if (watchdogKilled) return;
      resolve({ success: false, code: null, output: `Command execution failed for issue ${issue.id}.` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      if (watchdogKilled) return;
      if (timedOut) {
        resolve({ success: false, code: null, output: appendFileTail(output, `\nExecution timeout after ${config.commandTimeoutMs}ms.`, config.logLinesTail) });
        return;
      }
      const duration = Math.max(0, Date.now() - started);
      if (code === 0) {
        resolve({ success: true, code, output: appendFileTail(output, `\nExecution succeeded in ${duration}ms.`, config.logLinesTail) });
        return;
      }
      resolve({ success: false, code, output: appendFileTail(output, `\nCommand exit code ${code ?? "unknown"} after ${duration}ms.`, config.logLinesTail) });
    });
  });
}

async function runHook(
  command: string,
  workspacePath: string,
  issue: IssueEntry,
  hookName: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  if (!command.trim()) return;

  const result = await runCommandWithTimeout(command, workspacePath, issue, {
    pollIntervalMs: 0,
    workerConcurrency: 1,
    maxConcurrentByState: {},
    commandTimeoutMs: 300_000,
    maxAttemptsDefault: 1,
    retryDelayMs: 0,
    staleInProgressTimeoutMs: 0,
    logLinesTail: 12_000,
    agentProvider: normalizeAgentProvider(env.FIFONY_AGENT_PROVIDER ?? "codex"),
    agentCommand: command,
    maxTurns: 1,
    runMode: "filesystem",
  }, "", "", { FIFONY_HOOK_NAME: hookName, ...extraEnv });

  if (!result.success) {
    throw new Error(`${hookName} hook failed: ${result.output}`);
  }
}

export async function cleanWorkspace(
  issueId: string,
  issue: IssueEntry | null,
  workflowDefinition: WorkflowDefinition | null,
): Promise<void> {
  const safeId = idToSafePath(issueId);
  const workspacePath = issue?.workspacePath ?? join(WORKSPACE_ROOT, safeId);
  if (!existsSync(workspacePath)) return;

  // Run before_remove hook (failure is logged but ignored)
  if (workflowDefinition?.beforeRemoveHook) {
    try {
      const dummyIssue = issue ?? { id: issueId, identifier: issueId } as IssueEntry;
      await runHook(workflowDefinition.beforeRemoveHook, workspacePath, dummyIssue, "before_remove");
    } catch (error) {
      logger.warn(`before_remove hook failed for ${issueId}: ${String(error)}`);
    }
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

async function prepareWorkspace(
  issue: IssueEntry,
  workflowDefinition: WorkflowDefinition | null,
): Promise<{ workspacePath: string; promptText: string; promptFile: string }> {
  const safeId = idToSafePath(issue.id);
  const workspaceRoot = join(WORKSPACE_ROOT, safeId);    // management dir
  const worktreePath = join(workspaceRoot, "worktree");   // code dir (git worktree)
  const createdNow = !existsSync(worktreePath);

  if (createdNow) {
    mkdirSync(workspaceRoot, { recursive: true });
    logger.debug({ issueId: issue.id, identifier: issue.identifier, workspacePath: workspaceRoot }, "[Agent] Creating workspace");

    if (workflowDefinition?.afterCreateHook) {
      mkdirSync(worktreePath, { recursive: true });
      await runHook(workflowDefinition.afterCreateHook, worktreePath, issue, "after_create");
    } else if (isGitRepo(TARGET_ROOT)) {
      await createGitWorktree(issue, worktreePath);
    } else {
      // Fallback: copy SOURCE_ROOT snapshot
      await ensureSourceReady();
      mkdirSync(worktreePath, { recursive: true });
      cpSync(SOURCE_ROOT, worktreePath, {
        recursive: true,
        force: true,
        filter: (sourcePath) => !sourcePath.startsWith(WORKSPACE_ROOT),
      });
    }

    logger.debug({ issueId: issue.id, workspacePath: workspaceRoot, worktreePath }, "[Agent] Workspace created");
  } else {
    logger.debug({ issueId: issue.id, workspacePath: workspaceRoot }, "[Agent] Reusing existing workspace");
  }

  const metaPath = join(workspaceRoot, "fifony-issue.json");
  const promptText = await buildPrompt(issue, workflowDefinition);
  const promptFile = join(workspaceRoot, "fifony-prompt.md");
  writeFileSync(metaPath, JSON.stringify({ ...issue, runtimeSource: SOURCE_ROOT, bootstrapAt: now() }, null, 2), "utf8");
  writeFileSync(promptFile, `${promptText}\n`, "utf8");

  issue.workspacePath = workspaceRoot;
  issue.worktreePath = worktreePath;
  issue.workspacePreparedAt = now();

  return { workspacePath: workspaceRoot, promptText, promptFile };
}

/** Create a git worktree for the issue at the given path. */
async function createGitWorktree(issue: IssueEntry, worktreePath: string): Promise<void> {
  let baseBranch = "main";
  let headCommitAtStart = "";
  try {
    baseBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: TARGET_ROOT, encoding: "utf8" }).trim();
    headCommitAtStart = execSync("git rev-parse HEAD", { cwd: TARGET_ROOT, encoding: "utf8" }).trim();
  } catch {}

  const branchName = `fifony/${issue.id}`;

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
  issue.baseBranch = baseBranch;
  issue.headCommitAtStart = headCommitAtStart;
  issue.worktreePath = worktreePath;

  logger.debug({ issueId: issue.id, branchName, baseBranch, worktreePath }, "[Agent] Git worktree created");
}

async function runAgentSession(
  state: RuntimeState,
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  cycle: number,
  workspacePath: string,
  basePromptText: string,
  basePromptFile: string,
): Promise<AgentSessionResult> {
  const maxTurns = clamp(state.config.maxTurns, 1, 16);
  const attempt = issue.attempts + 1;
  const sessionLookupKey = buildProviderSessionKey(issue, attempt, provider, cycle);
  const loadedSession = await loadAgentSessionState(sessionLookupKey, issue, attempt, maxTurns);
  const sessionKey = loadedSession.key;
  const session = loadedSession.session;
  let previousOutput = session.lastOutput;
  let nextPrompt = session.nextPrompt;
  let lastCode: number | null = session.lastCode;
  let lastOutput = session.lastOutput;
  const resultFile = join(workspacePath, `fifony-result-${provider.role}-${provider.provider}.json`);

  if (session.status === "done" && session.turns.length > 0) {
    logger.debug({ issueId: issue.id, identifier: issue.identifier, provider: provider.provider, role: provider.role }, "[Agent] Session already completed, returning cached result");
    return { success: true, blocked: false, continueRequested: false, code: session.lastCode, output: session.lastOutput, turns: session.turns.length };
  }

  const turnIndex = session.turns.length + 1;
  if (turnIndex > maxTurns) {
    session.status = "blocked";
    session.lastOutput = appendFileTail(lastOutput, `\nAgent requested additional turns beyond configured limit (${maxTurns}).`, state.config.logLinesTail);
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: true, continueRequested: false, code: lastCode, output: session.lastOutput, turns: session.turns.length };
  }

  const turnPrompt = await buildTurnPrompt(issue, basePromptText, previousOutput, turnIndex, maxTurns, nextPrompt);
  const turnPromptFile = turnIndex === 1
    ? basePromptFile
    : join(workspacePath, `fifony-turn-${String(turnIndex).padStart(2, "0")}.md`);

  if (turnIndex > 1) writeFileSync(turnPromptFile, `${turnPrompt}\n`, "utf8");

  session.status = "running";
  session.lastPrompt = turnPrompt;
  session.lastPromptFile = turnPromptFile;
  session.maxTurns = maxTurns;
  await persistAgentSessionState(sessionKey, issue, provider, cycle, session);

  logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, maxTurns, provider: provider.provider, role: provider.role, cycle, command: provider.command.slice(0, 120) }, "[Agent] Spawning agent command");
  const turnStartedAt = now();
  const turnEnv = {
    FIFONY_AGENT_PROVIDER: provider.provider,
    FIFONY_AGENT_ROLE: provider.role,
    FIFONY_REASONING_EFFORT: provider.reasoningEffort || "",
    FIFONY_SESSION_KEY: sessionKey,
    FIFONY_SESSION_ID: `${issue.id}-attempt-${attempt}`,
    FIFONY_TURN_INDEX: String(turnIndex),
    FIFONY_MAX_TURNS: String(maxTurns),
    FIFONY_TURN_PROMPT: turnPrompt,
    FIFONY_TURN_PROMPT_FILE: turnPromptFile,
    FIFONY_CONTINUE: turnIndex > 1 ? "1" : "0",
    FIFONY_PREVIOUS_OUTPUT: previousOutput,
    FIFONY_RESULT_FILE: resultFile,
    FIFONY_AGENT_PROFILE: provider.profile,
    FIFONY_AGENT_PROFILE_FILE: provider.profilePath,
    FIFONY_AGENT_PROFILE_INSTRUCTIONS: provider.profileInstructions,
  };

  const workflowDefinition = state._workflowDefinition as WorkflowDefinition | null | undefined;
  if (workflowDefinition?.beforeRunHook) {
    await runHook(workflowDefinition.beforeRunHook, workspacePath, issue, "before_run", turnEnv);
  }

  addEvent(state, issue.id, "runner", `Turn ${turnIndex}/${maxTurns} started for ${issue.identifier}.`);

  const turnResult = await runCommandWithTimeout(provider.command, workspacePath, issue, state.config, turnPrompt, turnPromptFile, turnEnv);

  if (workflowDefinition?.afterRunHook) {
    await runHook(workflowDefinition.afterRunHook, workspacePath, issue, "after_run", {
      ...turnEnv,
      FIFONY_LAST_EXIT_CODE: String(turnResult.code ?? ""),
      FIFONY_LAST_OUTPUT: turnResult.output,
      FIFONY_PRESERVE_RESULT_FILE: "1",
    });
  }

  logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, exitCode: turnResult.code, success: turnResult.success, outputBytes: turnResult.output.length }, "[Agent] Agent command finished");
  const directive = readAgentDirective(workspacePath, turnResult.output, turnResult.success);
  lastCode = turnResult.code;
  lastOutput = turnResult.output;
  previousOutput = turnResult.output;
  nextPrompt = directive.nextPrompt;
  if (!directive.tokenUsage) {
    logger.warn({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, role: provider.role, outputBytes: turnResult.output.length }, "[Agent] Token extraction failed — no usage data in CLI output");
  }
  addTokenUsage(issue, directive.tokenUsage, provider.role);
  if (directive.tokenUsage) recordTokens(issue, directive.tokenUsage, provider.role);

  if (directive.tokenUsage) {
    const tu = directive.tokenUsage;
    const parts = [
      `Turn ${turnIndex} (${provider.role})`,
      `${tu.totalTokens.toLocaleString()} tokens`,
      `(in: ${tu.inputTokens.toLocaleString()}, out: ${tu.outputTokens.toLocaleString()})`,
    ];
    if (tu.model) parts.push(`[${tu.model}]`);
    // Running totals
    const cumulative = issue.tokenUsage;
    if (cumulative && cumulative.totalTokens > tu.totalTokens) {
      parts.push(`| cumulative: ${cumulative.totalTokens.toLocaleString()}`);
    }
    addEvent(state, issue.id, "info", parts.join(" "));
  }

  session.turns.push({
    turn: turnIndex,
    role: provider.role,
    model: directive.tokenUsage?.model || provider.model || provider.provider,
    startedAt: turnStartedAt,
    completedAt: now(),
    promptFile: turnPromptFile,
    prompt: turnPrompt,
    output: turnResult.output,
    code: turnResult.code,
    success: turnResult.success,
    directiveStatus: directive.status,
    directiveSummary: directive.summary,
    nextPrompt: directive.nextPrompt,
    tokenUsage: directive.tokenUsage,
  });

  session.lastCode = lastCode;
  session.lastOutput = lastOutput;
  session.lastDirectiveStatus = directive.status;
  session.lastDirectiveSummary = directive.summary;
  session.nextPrompt = nextPrompt;

  const directiveSummary = directive.summary ? ` ${directive.summary}` : "";
  addEvent(state, issue.id, "runner", `Turn ${turnIndex}/${maxTurns} finished with status ${directive.status}.${directiveSummary}`.trim());

  if (!turnResult.success || directive.status === "failed") {
    logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, directiveStatus: directive.status, exitCode: lastCode }, "[Agent] Session turn failed");
    session.status = "failed";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: false, continueRequested: false, code: lastCode, output: lastOutput, turns: turnIndex };
  }

  if (directive.status === "blocked") {
    logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex }, "[Agent] Session turn blocked — manual intervention requested");
    session.status = "blocked";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: true, continueRequested: false, code: lastCode, output: lastOutput, turns: turnIndex };
  }

  if (directive.status === "continue") {
    logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, maxTurns }, "[Agent] Session requests continuation");
    session.status = "running";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: false, continueRequested: true, code: lastCode, output: lastOutput, turns: turnIndex };
  }

  logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex }, "[Agent] Session completed successfully");
  session.status = "done";
  await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
  return { success: true, blocked: false, continueRequested: false, code: lastCode, output: lastOutput, turns: turnIndex };
}

export async function runAgentPipeline(
  state: RuntimeState,
  issue: IssueEntry,
  workspacePath: string,
  basePromptText: string,
  basePromptFile: string,
  workflowDefinition: WorkflowDefinition | null,
  workflowConfig?: WorkflowConfig | null,
): Promise<AgentSessionResult> {
  const providers = getEffectiveAgentProviders(state, issue, workflowDefinition, workflowConfig);
  const attempt = issue.attempts + 1;
  logger.debug({ issueId: issue.id, identifier: issue.identifier, attempt, providers: providers.map((p) => `${p.role}:${p.provider}`) }, "[Agent] Starting pipeline");
  const { pipeline, key: pipelineFile } = await loadAgentPipelineState(issue, attempt, providers);
  const activeProvider = providers[clamp(pipeline.activeIndex, 0, Math.max(0, providers.length - 1))];
  const executorIndex = providers.findIndex((provider) => provider.role === "executor");

  // Discover skills and build context
  const skills = discoverSkills(workspacePath);
  const skillContext = buildSkillContext(skills);

  // Write skills reference to workspace
  if (skillContext) {
    writeFileSync(join(workspacePath, "fifony-skills.md"), skillContext, "utf8");
  }

  // Compile plan-aware execution if plan exists
  const compiled = await compileExecution(issue, activeProvider, state.config, workspacePath, skillContext);

  let providerPrompt: string;
  let effectiveProvider = activeProvider;

  if (compiled) {
    providerPrompt = compiled.prompt;
    effectiveProvider = { ...activeProvider, command: compiled.command };
    // Persist compilation artifacts for audit
    persistCompilationArtifacts(workspacePath, compiled);
    addEvent(state, issue.id, "info",
      `Plan compiled for ${compiled.meta.adapter}: effort=${compiled.meta.reasoningEffort}, skills=[${compiled.meta.skillsActivated.join(",")}], subagents=[${compiled.meta.subagentsRequested.join(",")}].`);

    // Merge compiled env into issue env file
    if (Object.keys(compiled.env).length > 0) {
      const envFile = join(workspacePath, ".fifony-compiled-env.sh");
      const envLines = Object.entries(compiled.env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n");
      writeFileSync(envFile, envLines, "utf8");
    }
  } else {
    providerPrompt = await buildProviderBasePrompt(activeProvider, issue, basePromptText, workspacePath, skillContext);
  }

  if (!effectiveProvider.command.trim()) {
    throw new Error(`No command configured for provider ${effectiveProvider.provider} (${effectiveProvider.role}).`);
  }

  pipeline.history.push(`[${now()}] Running ${effectiveProvider.role}:${effectiveProvider.provider} in cycle ${pipeline.cycle}${compiled ? ` [${compiled.meta.adapter} adapter]` : ""}.`);
  await persistAgentPipelineState(pipelineFile, pipeline);

  // Attach workflowDefinition to state for session hooks
  (state as any)._workflowDefinition = workflowDefinition;

  const result = await runAgentSession(state, issue, effectiveProvider, pipeline.cycle, workspacePath, providerPrompt, basePromptFile);

  if (result.success) {
    if (pipeline.activeIndex < providers.length - 1) {
      pipeline.activeIndex += 1;
      pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} completed; advancing to next provider.`);
      await persistAgentPipelineState(pipelineFile, pipeline);
      return { success: false, blocked: false, continueRequested: true, code: result.code, output: result.output, turns: result.turns };
    }
    pipeline.history.push(`[${now()}] Final provider ${activeProvider.role}:${activeProvider.provider} completed the issue.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  if (result.continueRequested && activeProvider.role === "reviewer" && executorIndex >= 0) {
    pipeline.cycle += 1;
    pipeline.activeIndex = executorIndex;
    pipeline.history.push(`[${now()}] Reviewer requested rework; returning to executor for cycle ${pipeline.cycle}.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  if (result.continueRequested) {
    pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} requested another turn.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  if (result.blocked) {
    pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} blocked the pipeline.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} failed the pipeline.`);
  await persistAgentPipelineState(pipelineFile, pipeline);
  return result;
}

export async function runIssueOnce(
  state: RuntimeState,
  issue: IssueEntry,
  running: Set<string>,
  workflowDefinition: WorkflowDefinition | null,
): Promise<void> {
  const startTs = Date.now();
  const isReview = issue.state === "In Review";
  const isResuming = issue.state === "Running" || issue.state === "Interrupted";
  logger.info({ issueId: issue.id, identifier: issue.identifier, state: issue.state, isReview, isResuming, attempt: issue.attempts + 1, maxAttempts: issue.maxAttempts }, "[Agent] Starting issue execution");
  running.add(issue.id);
  state.metrics.activeWorkers += 1;
  issue.startedAt = issue.startedAt ?? now();

  // Load WorkflowConfig from settings (user's Settings → Workflow configuration)
  let workflowConfig: WorkflowConfig | null = null;
  try {
    const settings = await loadRuntimeSettings();
    workflowConfig = getWorkflowConfig(settings);
  } catch {
    // Fall through — use defaults
  }

  if (isReview) {
    issue.updatedAt = now();
    issue.history.push(`[${issue.updatedAt}] Review stage started for ${issue.identifier}.`);
    addEvent(state, issue.id, "progress", `Review started for ${issue.identifier}.`);
  } else if (isResuming) {
    await transitionIssueState(issue, "Running", `Resuming runner for ${issue.identifier}.`);
    addEvent(state, issue.id, "progress", `Runner resumed for ${issue.identifier}.`);
  } else {
    // Todo / Queued / Blocked → Queued → Running
    if (issue.state !== "Queued") {
      await transitionIssueState(issue, "Queued", `Issue ${issue.identifier} queued for execution.`);
    }
    await transitionIssueState(issue, "Running", `Agent started for ${issue.identifier}.`);
    addEvent(state, issue.id, "progress", `Runner started for ${issue.identifier}.`);
  }

  try {
    const workspaceDerivedPaths = hydrateIssuePathsFromWorkspace(issue);
    if ((issue.paths ?? []).length > 0) {
      issue.inferredPaths = [...new Set([...(issue.inferredPaths ?? []), ...inferCapabilityPaths({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        labels: issue.labels,
        paths: issue.paths,
      })])];
    }

    const { workspacePath, promptText, promptFile } = await prepareWorkspace(issue, workflowDefinition);
    addEvent(state, issue.id, "info", `Workspace ready at ${workspacePath}.`);

    const routedProviders = getEffectiveAgentProviders(state, issue, workflowDefinition, workflowConfig);

    if (isReview) {
      // ── Review stage: run only the reviewer provider ──────────────────
      const reviewer = routedProviders.find((p) => p.role === "reviewer");
      if (!reviewer) {
        // No reviewer configured → auto-approve
        await transitionIssueState(issue, "Done", `No reviewer configured; auto-approved for ${issue.identifier}.`);
        addEvent(state, issue.id, "runner", `Issue ${issue.identifier} auto-approved (no reviewer provider).`);
        issue.completedAt = now();
        issue.lastError = undefined;
        return;
      }

      addEvent(state, issue.id, "info", `Review provider: ${reviewer.role}:${reviewer.provider}${reviewer.model ? `/${reviewer.model}` : ""}${reviewer.profile ? `:${reviewer.profile}` : ""}.`);

      // Get diff summary for the review prompt
      let diffSummary = "";
      try {
        if (issue.baseBranch && issue.branchName) {
          const diffResult = execSync(
            `git diff --stat "${issue.baseBranch}"..."${issue.branchName}"`,
            { cwd: TARGET_ROOT, encoding: "utf8", maxBuffer: 512_000, timeout: 10_000 },
          );
          diffSummary = diffResult.trim();
        } else {
          const diffResult = execSync(
            `git diff --no-index --stat -- "${SOURCE_ROOT}" "${workspacePath}" 2>/dev/null`,
            { encoding: "utf8", maxBuffer: 512_000, timeout: 10_000 },
          );
          diffSummary = diffResult.trim();
        }
      } catch (err: any) {
        diffSummary = (err.stdout || "").trim();
      }

      // Compile a rich review prompt with plan context, diff, and criteria
      const compiled = await compileReview(issue, reviewer, workspacePath, diffSummary);
      const effectiveReviewer = { ...reviewer, command: compiled.command || reviewer.command };

      const reviewPromptFile = join(workspacePath, "fifony-review-prompt.md");
      writeFileSync(reviewPromptFile, `${compiled.prompt}\n`, "utf8");

      (state as any)._workflowDefinition = workflowDefinition;
      const reviewResult = await runAgentSession(state, issue, effectiveReviewer, 1, workspacePath, compiled.prompt, reviewPromptFile);

      issue.durationMs = (issue.durationMs ?? 0) + (Date.now() - startTs);
      issue.commandExitCode = reviewResult.code;
      issue.commandOutputTail = reviewResult.output;

      // Persist review audit
      const reviewAudit = buildExecutionAudit(effectiveReviewer, null, issue, Date.now() - startTs, reviewResult.success ? "approved" : reviewResult.continueRequested ? "rework" : "rejected");
      persistExecutionAudit(workspacePath, reviewAudit);

      if (reviewResult.success) {
        await transitionIssueState(issue, "Done", `Reviewer approved ${issue.identifier} in ${reviewResult.turns} turn(s).`);
        addEvent(state, issue.id, "runner", `Issue ${issue.identifier} approved by reviewer → Done.`);
        issue.completedAt = now();
        issue.lastError = undefined;
      } else if (reviewResult.continueRequested) {
        // Reviewer wants rework → back to Queued for re-execution
        await transitionIssueState(issue, "Queued", `Reviewer requested rework for ${issue.identifier}.`);
        issue.nextRetryAt = new Date(Date.now() + 1000).toISOString();
        issue.lastError = undefined;
        addEvent(state, issue.id, "runner", `Issue ${issue.identifier} sent back for rework by reviewer.`);
      } else {
        // Reviewer blocked or failed
        issue.lastError = reviewResult.output;
        issue.attempts += 1;
        if (issue.attempts >= issue.maxAttempts) {
          await transitionIssueState(issue, "Cancelled", `Review failed, max attempts reached for ${issue.identifier}.`);
          addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled after review failure.`);
        } else {
          issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
          await transitionIssueState(issue, "Blocked", `Review failed for ${issue.identifier}. Retry at ${issue.nextRetryAt}.`);
          addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked after review failure.`);
        }
      }
      return;
    }

    // ── Normal execution (Todo / In Progress / Blocked) ───────────────
    addEvent(state, issue.id, "info",
      `Capability routing selected ${routedProviders.map((p) => `${p.role}:${p.provider}${p.model ? `/${p.model}` : ""}${p.profile ? `:${p.profile}` : ""}${p.reasoningEffort ? ` [${p.reasoningEffort}]` : ""}`).join(", ")}.`);

    const routingSignals = describeRoutingSignals(issue, workspaceDerivedPaths);
    if (routingSignals) {
      addEvent(state, issue.id, "info", `Capability routing signals: ${routingSignals}.`);
    }

    const runResult = await runAgentPipeline(state, issue, workspacePath, promptText, promptFile, workflowDefinition, workflowConfig);

    issue.durationMs = Date.now() - startTs;
    issue.commandExitCode = runResult.code;
    issue.commandOutputTail = runResult.output;

    if (runResult.success) {
      // Compute diff stats before transitioning
      computeDiffStats(issue);
      if (issue.filesChanged) {
        addEvent(state, issue.id, "info", `Diff: ${issue.filesChanged} files, +${issue.linesAdded || 0} -${issue.linesRemoved || 0} lines.`);
      }

      // Merge workspace into TARGET_ROOT so the code is runnable/testable before review
      try {
        const mergeResult = mergeWorkspace(issue);
        issue.mergedAt = now();
        issue.mergeResult = {
          copied: mergeResult.copied.length,
          deleted: mergeResult.deleted.length,
          skipped: mergeResult.skipped.length,
          conflicts: mergeResult.conflicts.length,
        };
        const conflictMsg = mergeResult.conflicts.length > 0
          ? ` ${mergeResult.conflicts.length} conflict(s): ${mergeResult.conflicts.join(", ")}.`
          : "";
        addEvent(state, issue.id, "merge", `Workspace merged to project: ${mergeResult.copied.length} file(s) copied, ${mergeResult.deleted.length} deleted.${conflictMsg} Code is now available in the project root.`);
        if (mergeResult.conflicts.length > 0) {
          addEvent(state, issue.id, "error", `Merge conflicts detected — ${mergeResult.conflicts.length} file(s) modified by another worker: ${mergeResult.conflicts.join(", ")}`);
        }
        logger.info(`Workspace merged for ${issue.identifier}: ${mergeResult.copied.length} copied, ${mergeResult.deleted.length} deleted, ${mergeResult.conflicts.length} conflicts.`);
      } catch (mergeErr) {
        addEvent(state, issue.id, "error", `Merge failed: ${String(mergeErr)}`);
        logger.error(`Merge failed for ${issue.identifier}: ${String(mergeErr)}`);
      }

      // Persist execution audit
      const executor = routedProviders.find((p) => p.role === "executor") || routedProviders[0];
      if (executor && workspacePath) {
        const audit = buildExecutionAudit(executor, null, issue, Date.now() - startTs, "success");
        persistExecutionAudit(workspacePath, audit);
      }

      // Move to In Review — the reviewer will run as a separate scheduler pick
      await transitionIssueState(issue, "In Review", `Agent execution finished in ${runResult.turns} turn(s) for ${issue.identifier}. Awaiting review.`);
      issue.lastError = undefined;
      addEvent(state, issue.id, "runner", `Issue ${issue.identifier} moved to In Review.`);
    } else if (runResult.continueRequested) {
      issue.updatedAt = now();
      issue.commandExitCode = runResult.code;
      issue.commandOutputTail = runResult.output;
      issue.lastError = undefined;
      // Short continuation retry (1s) — spec §7.1, §8.4
      issue.nextRetryAt = new Date(Date.now() + 1000).toISOString();
      issue.history.push(`[${issue.updatedAt}] Agent requested another turn (${runResult.turns}/${state.config.maxTurns}).`);
      addEvent(state, issue.id, "runner", `Issue ${issue.identifier} queued for next turn.`);
    } else {
      issue.lastError = runResult.output;
      issue.attempts += 1;

      if (issue.attempts >= issue.maxAttempts) {
        issue.commandExitCode = runResult.code;
        await transitionIssueState(issue, "Cancelled", `Max attempts reached (${issue.attempts}/${issue.maxAttempts}).`);
        addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled after repeated failures.`);
      } else {
        issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
        await transitionIssueState(issue,
          "Blocked",
          `${runResult.blocked ? "Agent requested manual intervention" : "Failure"} on attempt ${issue.attempts}/${issue.maxAttempts}; retry scheduled at ${issue.nextRetryAt}.`);
        addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked waiting for retry.`);
      }
    }
  } catch (error) {
    issue.attempts += 1;
    issue.lastError = String(error);

    if (issue.attempts >= issue.maxAttempts) {
      await transitionIssueState(issue, "Cancelled", `Issue failed unexpectedly: ${issue.lastError}`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled unexpectedly.`);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await transitionIssueState(issue, "Blocked", `Unexpected failure. Retry scheduled at ${issue.nextRetryAt}.`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked after unexpected failure.`);
    }
  } finally {
    const elapsedMs = Date.now() - startTs;
    logger.info({ issueId: issue.id, identifier: issue.identifier, finalState: issue.state, elapsedMs, attempts: issue.attempts }, "[Agent] Issue execution finished");
    issue.updatedAt = now();
    markIssueDirty(issue.id);
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers - 1, 0);
    running.delete(issue.id);
    state.metrics = computeMetrics(state.issues);
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers, 0);
    state.updatedAt = now();
    await persistState(state);
  }
}
