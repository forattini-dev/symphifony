/**
 * Pre/Post execution hooks — user-configurable shell scripts.
 *
 * Inspired by Claude Code's PreToolUse/PostToolUse hook pipeline.
 * Pre-hooks can block execution (exit code != 0 unless allowFailure).
 * Post-hooks receive turn result as environment variables.
 */
import { execSync } from "node:child_process";
import { logger } from "../concerns/logger.ts";
import type { ExecutionHook, IssueEntry } from "../types.ts";

export type HookResult = {
  hook: ExecutionHook;
  exitCode: number;
  output: string;
  blocked: boolean;
  durationMs: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

function runSingleHook(
  hook: ExecutionHook,
  cwd: string,
  env: Record<string, string>,
): HookResult {
  const start = Date.now();
  const timeout = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = hook.label || hook.command.slice(0, 60);

  try {
    const output = execSync(hook.command, {
      cwd,
      timeout,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024, // 1MB
    });

    logger.debug({ label, exitCode: 0 }, "[ExecutionHook] Hook passed");
    return {
      hook,
      exitCode: 0,
      output: output.slice(-2000),
      blocked: false,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const execError = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    const exitCode = execError.status ?? 1;
    const output = [execError.stdout || "", execError.stderr || ""].join("\n").trim().slice(-2000);
    const blocked = !hook.allowFailure && exitCode !== 0;

    logger.warn({ label, exitCode, blocked, output: output.slice(0, 200) }, "[ExecutionHook] Hook failed");
    return {
      hook,
      exitCode,
      output,
      blocked,
      durationMs: Date.now() - start,
    };
  }
}

/** Run pre-execution hooks. Returns null if all pass, or the blocking result if one fails. */
export function runPreExecutionHooks(
  hooks: ExecutionHook[] | undefined,
  issue: IssueEntry,
  cwd: string,
  phase: "plan" | "execute" | "review",
  extraEnv: Record<string, string> = {},
): HookResult | null {
  if (!hooks?.length) return null;

  const applicable = hooks.filter((h) => !h.phase || h.phase === phase);
  if (!applicable.length) return null;

  const env: Record<string, string> = {
    ...extraEnv,
    FIFONY_HOOK_PHASE: phase,
    FIFONY_ISSUE_ID: issue.id,
    FIFONY_ISSUE_IDENTIFIER: issue.identifier,
    FIFONY_ISSUE_TITLE: issue.title,
    FIFONY_ISSUE_STATE: issue.state,
    FIFONY_PLAN_VERSION: String(issue.planVersion ?? 1),
    FIFONY_EXECUTE_ATTEMPT: String(issue.executeAttempt ?? 0),
  };

  for (const hook of applicable) {
    const result = runSingleHook(hook, cwd, env);
    if (result.blocked) {
      return result;
    }
  }

  return null;
}

/** Run post-execution hooks. Always runs all hooks (non-blocking). Returns results. */
export function runPostExecutionHooks(
  hooks: ExecutionHook[] | undefined,
  issue: IssueEntry,
  cwd: string,
  phase: "plan" | "execute" | "review",
  turnResult: { code: number | null; success: boolean; output: string },
  extraEnv: Record<string, string> = {},
): HookResult[] {
  if (!hooks?.length) return [];

  const applicable = hooks.filter((h) => !h.phase || h.phase === phase);
  if (!applicable.length) return [];

  const env: Record<string, string> = {
    ...extraEnv,
    FIFONY_HOOK_PHASE: phase,
    FIFONY_ISSUE_ID: issue.id,
    FIFONY_ISSUE_IDENTIFIER: issue.identifier,
    FIFONY_ISSUE_TITLE: issue.title,
    FIFONY_ISSUE_STATE: issue.state,
    FIFONY_PLAN_VERSION: String(issue.planVersion ?? 1),
    FIFONY_EXECUTE_ATTEMPT: String(issue.executeAttempt ?? 0),
    FIFONY_EXIT_CODE: String(turnResult.code ?? ""),
    FIFONY_SUCCESS: turnResult.success ? "1" : "0",
    FIFONY_OUTPUT_TAIL: turnResult.output.slice(-2000),
  };

  return applicable.map((hook) => runSingleHook(hook, cwd, env));
}
