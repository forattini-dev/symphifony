import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IssueEntry } from "../types.ts";
import { logger } from "../concerns/logger.ts";
import { now } from "../concerns/helpers.ts";
import { renderPrompt } from "../agents/prompting.ts";
import { ADAPTERS } from "../agents/adapters/registry.ts";
import { runPlanningProcess } from "../agents/planning/planning-prompts.ts";

export type ConflictResolutionResult = {
  resolved: boolean;
  resolvedFiles: string[];
  output: string;
  provider: string;
  durationMs: number;
  resolvedAt: string;
};

export async function resolveConflictsWithAgent(options: {
  issue: IssueEntry;
  conflictFiles: string[];
  provider: string;
  model?: string;
  targetRoot: string;
}): Promise<ConflictResolutionResult> {
  const { issue, conflictFiles, provider, model, targetRoot } = options;
  const startMs = Date.now();

  const adapter = ADAPTERS[provider];
  if (!adapter) {
    return { resolved: false, resolvedFiles: [], output: `No adapter for provider "${provider}"`, provider, durationMs: 0, resolvedAt: now() };
  }

  // Build command — agent needs full write access to resolve conflict markers
  const command = adapter.buildCommand({ model });
  if (!command) {
    return { resolved: false, resolvedFiles: [], output: `Adapter returned empty command for "${provider}"`, provider, durationMs: 0, resolvedAt: now() };
  }

  // Build prompt
  const prompt = await renderPrompt("merge-conflict-resolver", {
    issueIdentifier: issue.identifier,
    title: issue.title,
    description: issue.description || "",
    baseBranch: issue.baseBranch || "main",
    featureBranch: issue.branchName || "unknown",
    conflictFiles,
  });

  // Write prompt to temp file
  const tempDir = mkdtempSync(join(tmpdir(), "fifony-conflict-"));
  const promptFile = join(tempDir, "fifony-conflict-prompt.md");
  writeFileSync(promptFile, `${prompt}\n`, "utf8");

  let output = "";
  try {
    output = await runPlanningProcess({
      command,
      tempDir: targetRoot, // agent runs in TARGET_ROOT where conflict markers exist
      promptFile,
      provider,
    });
  } catch (err) {
    output = String(err);
    logger.error({ err, issueId: issue.id }, "[ConflictResolver] Agent process failed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  // Verify: are there still unmerged files?
  let remainingConflicts: string[] = [];
  try {
    const unmerged = execSync("git diff --name-only --diff-filter=U", { cwd: targetRoot, encoding: "utf8" }).trim();
    remainingConflicts = unmerged ? unmerged.split("\n").filter(Boolean) : [];
  } catch { /* no unmerged files = success */ }

  const resolved = remainingConflicts.length === 0;
  const resolvedFiles = resolved ? conflictFiles : conflictFiles.filter((f) => !remainingConflicts.includes(f));
  const durationMs = Date.now() - startMs;

  logger.info({
    issueId: issue.id,
    resolved,
    resolvedFiles,
    remainingConflicts,
    durationMs,
    provider,
  }, "[ConflictResolver] Resolution attempt complete");

  return {
    resolved,
    resolvedFiles,
    output: output.slice(-2000), // tail for debugging
    provider,
    durationMs,
    resolvedAt: now(),
  };
}
