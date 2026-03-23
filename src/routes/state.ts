import type { IssueEntry, RuntimeMetrics, RuntimeState } from "../types.ts";
import { isoWeek, now, toStringValue } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { persistState } from "../persistence/store.ts";
import { markIssueDirty } from "../persistence/dirty-tracker.ts";
import { addEvent, computeMetrics } from "../domains/issues.ts";
import { ATTACHMENTS_ROOT, TARGET_ROOT } from "../concerns/constants.ts";
import { findIssue, mutateIssueState, parseIssue } from "../routes/helpers.ts";
import { cleanWorkspace } from "../domains/workspace.ts";
import { detectAvailableProviders } from "../agents/providers.ts";
import { analyzeParallelizability } from "../persistence/plugins/scheduler.ts";
import {
  collectProviderUsage,
  collectProvidersUsage,
} from "../agents/providers-usage.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { basename, extname, join } from "node:path";

// Hexagonal architecture
import { getContainer } from "../persistence/container.ts";
import { approvePlanCommand } from "../commands/approve-plan.command.ts";
import { executeIssueCommand } from "../commands/execute-issue.command.ts";
import { replanIssueCommand } from "../commands/replan-issue.command.ts";
import { mergeWorkspaceCommand } from "../commands/merge-workspace.command.ts";
import { pushWorkspaceCommand } from "../commands/push-workspace.command.ts";
import { transitionIssueCommand } from "../commands/transition-issue.command.ts";

type GetStateResult = RuntimeState & {
  metrics: RuntimeMetrics;
  _filter: "all" | "recent";
  _totalIssues: number;
};

function getStateQuery(
  state: RuntimeState,
  showAll = false,
): GetStateResult {
  let issues: IssueEntry[] = state.issues;

  if (!showAll) {
    const thisWeek = isoWeek();
    const lastWeekDate = new Date();
    lastWeekDate.setUTCDate(lastWeekDate.getUTCDate() - 7);
    const lastWeek = isoWeek(lastWeekDate);
    const recentWeeks = new Set([thisWeek, lastWeek]);

    issues = state.issues.filter((i) => {
      if (!i.terminalWeek) return true;
      return recentWeeks.has(i.terminalWeek);
    });
  }

  return {
    ...state,
    issues,
    metrics: computeMetrics(issues),
    _filter: showAll ? "all" : "recent",
    _totalIssues: state.issues.length,
  };
}

function getWorkspaceActionErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("requires a git repository")
    || message.includes("requires at least one commit")
    || message.includes("has no git worktree")
    || message.includes("No mergeable workspace found")
    || message.includes("target repository has uncommitted changes")
    || message.includes("current branch is")
  ) {
    return 409;
  }
  return 500;
}

export function registerStateRoutes(
  app: any,
  state: RuntimeState,
): void {
  app.get("/api/state", async (c: any) => {
    const showAll = c.req.query("all") === "1";
    return c.json(getStateQuery(state, showAll));
  });

  app.get("/api/status", async (c: any) =>
    c.json({
      status: "ok",
      updatedAt: state.updatedAt,
      config: state.config,
      trackerKind: state.trackerKind,
    }),
  );

  app.get("/api/providers", async (c: any) => {
    const providers = detectAvailableProviders();
    return c.json({ providers });
  });

  app.get("/api/parallelism", async (c: any) => {
    return c.json(analyzeParallelizability(state.issues));
  });

  // RESTful: /api/providers/:slug/usage
  app.get("/api/providers/:slug/usage", async (c: any) => {
    const provider = c.req.param("slug") || "";
    try {
      const usage = await collectProviderUsage(provider);
      return c.json({
        providers: usage ? [usage] : [],
        collectedAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.error({ err: error, provider }, "Failed to collect provider usage");
      return c.json({ providers: [] }, 500);
    }
  });

  // Aggregate: /api/providers/usage (all providers)
  app.get("/api/providers/usage", async (c: any) => {
    try {
      const usage = await collectProvidersUsage();
      return c.json(usage);
    } catch (error) {
      logger.error({ err: error }, "Failed to collect providers usage");
      return c.json({ providers: [] }, 500);
    }
  });

  // NOTE: create, state, retry, cancel routes live in issues.resource.ts (s3db resource routes).
  // They have priority over collector routes. Do NOT duplicate them here.

  app.post("/api/issues/:id/approve", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/approve");
    return mutateIssueState(state, c, async (issue) => {
      const container = getContainer();
      await approvePlanCommand({ issue }, container);
    });
  });

  app.post("/api/issues/:id/execute", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/execute");
    return mutateIssueState(state, c, async (issue) => {
      const container = getContainer();
      await executeIssueCommand({ issue }, container);
    });
  });

  app.post("/api/issues/:id/replan", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/replan");
    return mutateIssueState(state, c, async (issue) => {
      const container = getContainer();
      await replanIssueCommand({ issue }, container);
    });
  });

  app.post("/api/issues/:id/merge", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/merge");
    try {
      const issueId = parseIssue(c);
      if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
      const issue = findIssue(state, issueId);
      if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);
      const container = getContainer();
      if (state.config.mergeMode === "push-pr") {
        const result = await pushWorkspaceCommand({ issue, state }, container);
        return c.json({ ok: true, prUrl: result.prUrl, ghAvailable: result.ghAvailable });
      }
      const result = await mergeWorkspaceCommand({ issue, state, squashAlreadyApplied: issue.testApplied ?? false }, container);
      return c.json({ ok: true, ...result });
    } catch (error) {
      const issueId = parseIssue(c);
      logger.error(`Failed to merge workspace for ${issueId || "<unknown>"}: ${String(error)}`);
      return c.json({ ok: false, error: String(error) }, getWorkspaceActionErrorStatus(error));
    }
  });

  app.get("/api/issues/:id/merge-preview", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] GET /api/issues/:id/merge-preview");
    try {
      const issueId = parseIssue(c);
      if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
      const issue = findIssue(state, issueId);
      if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);
      const { dryMerge } = await import("../domains/workspace.ts");
      const result = dryMerge(issue);
      return c.json({ ok: true, ...result });
    } catch (error) {
      logger.error(`Failed to preview merge for ${parseIssue(c) || "<unknown>"}: ${String(error)}`);
      return c.json({ ok: false, error: String(error) }, getWorkspaceActionErrorStatus(error));
    }
  });

  app.post("/api/issues/:id/rebase", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/rebase");
    try {
      const issueId = parseIssue(c);
      if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
      const issue = findIssue(state, issueId);
      if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);
      const { rebaseWorktree } = await import("../domains/workspace.ts");
      const result = rebaseWorktree(issue);
      if (result.success) {
        addEvent(state, issue.id, "info", `Branch ${issue.branchName} rebased onto ${issue.baseBranch}.`);
      }
      await persistState(state);
      return c.json({ ok: true, ...result });
    } catch (error) {
      logger.error(`Failed to rebase for ${parseIssue(c) || "<unknown>"}: ${String(error)}`);
      return c.json({ ok: false, error: String(error) }, getWorkspaceActionErrorStatus(error));
    }
  });

  app.post("/api/issues/:id/try", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/try");
    return mutateIssueState(state, c, async (issue) => {
      if (!["Reviewing", "PendingDecision"].includes(issue.state)) {
        throw new Error(`Cannot apply test for issue in state ${issue.state}.`);
      }
      if (!issue.branchName) {
        throw new Error("No branch name found for this issue.");
      }
      try {
        execSync(
          `git merge --squash "${issue.branchName}"`,
          { encoding: "utf8", cwd: TARGET_ROOT, stdio: "pipe", timeout: 30_000 },
        );
      } catch (err: any) {
        const msg = err.stderr || err.stdout || String(err);
        throw new Error(`git merge --squash failed: ${msg}`);
      }
      issue.testApplied = true;
      markIssueDirty(issue.id);
      addEvent(state, issue.id, "manual", `Test squash applied to workspace: git merge --squash ${issue.branchName}`);
    });
  });

  app.post("/api/issues/:id/revert-try", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/revert-try");
    return mutateIssueState(state, c, async (issue) => {
      try {
        execSync("git reset --hard HEAD", { cwd: TARGET_ROOT, stdio: "pipe", timeout: 15_000 });
        execSync("git clean -fd", { cwd: TARGET_ROOT, stdio: "pipe", timeout: 15_000 });
      } catch (err: any) {
        const msg = err.stderr || err.stdout || String(err);
        throw new Error(`git reset/clean failed: ${msg}`);
      }
      issue.testApplied = false;
      markIssueDirty(issue.id);
      addEvent(state, issue.id, "manual", `Test reverted: git reset --hard HEAD && git clean -fd`);
    });
  });

  app.post("/api/issues/:id/rollback", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/rollback");
    return mutateIssueState(state, c, async (issue) => {
      if (!["Reviewing", "PendingDecision", "Approved"].includes(issue.state)) {
        throw new Error(`Cannot rollback issue in state ${issue.state}. Must be in Reviewing, Reviewed, or Done.`);
      }
      if (issue.workspacePath) {
        try {
          await cleanWorkspace(issue.id, issue, state);
          issue.workspacePath = undefined as any;
          issue.worktreePath = undefined as any;
        } catch (error) {
          logger.warn({ err: error }, `[API] Workspace cleanup failed during rollback for ${issue.id}`);
        }
      }
      const container = getContainer();
      await transitionIssueCommand(
        { issue, target: "Queued", note: "Rolled back by user — worktree removed." },
        container,
      );
      addEvent(state, issue.id, "manual", `${issue.identifier} rolled back. Worktree and branch removed.`);
    });
  });

  app.post("/api/issues/:id/images", async (c: any) => {
    try {
      const issueId = parseIssue(c);
      if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
      const issue = findIssue(state, issueId);
      if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);

      const payload = await c.req.json() as { files?: Array<{ name: string; data: string; type: string }> };
      if (!Array.isArray(payload.files) || payload.files.length === 0) {
        return c.json({ ok: false, error: "No files provided." }, 400);
      }

      const issueAttachDir = join(ATTACHMENTS_ROOT, issue.id);
      mkdirSync(issueAttachDir, { recursive: true });
      const newPaths: string[] = [];
      for (const file of payload.files) {
        if (typeof file.data !== "string" || !file.name) continue;
        const safeExt = extname(file.name).replace(/[^a-z0-9.]/gi, "").slice(0, 10) || ".bin";
        const safeName = `${randomUUID()}${safeExt}`;
        const dest = join(issueAttachDir, safeName);
        writeFileSync(dest, Buffer.from(file.data, "base64"));
        newPaths.push(dest);
      }

      issue.images = [...(issue.images ?? []), ...newPaths];
      issue.updatedAt = now();
      markIssueDirty(issue.id);
      await persistState(state);
      return c.json({ ok: true, paths: newPaths, issue });
    } catch (error) {
      logger.error({ err: error }, "[API] Issue image upload failed");
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/issues/:id/images/:filename", async (c: any) => {
    try {
      const issueId = parseIssue(c);
      if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
      const filename = c.req.param?.("filename") ?? c.req.params?.filename ?? "";
      if (!filename) return c.json({ ok: false, error: "Filename is required." }, 400);
      const safeName = basename(filename);
      const filePath = join(ATTACHMENTS_ROOT, issueId, safeName);
      if (!existsSync(filePath)) return c.json({ ok: false, error: "Image not found." }, 404);
      const ext = extname(safeName).toLowerCase();
      const mimeMap: Record<string, string> = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      };
      const mime = mimeMap[ext] ?? "application/octet-stream";
      const { readFileSync } = await import("node:fs");
      const data = readFileSync(filePath);
      return new Response(data, { headers: { "Content-Type": mime, "Cache-Control": "private, max-age=86400" } });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/issues/:id/history", async (c: any) => {
    const issueId = parseIssue(c);
    if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
    const issue = findIssue(state, issueId);
    if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);
    try {
      const { getIssueTransitionHistory } = await import("../persistence/plugins/issue-state-machine.ts");
      const limit = parseInt(c.req.query("limit") ?? "50", 10);
      const offset = parseInt(c.req.query("offset") ?? "0", 10);
      const transitions = await getIssueTransitionHistory(issue.id, { limit, offset });
      return c.json({ ok: true, issueId: issue.id, transitions, localHistory: issue.history });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/state-machine/transitions", async (c: any) => {
    try {
      const { getStateMachineTransitions } = await import("../persistence/plugins/issue-state-machine.ts");
      return c.json({ ok: true, transitions: getStateMachineTransitions() });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/state-machine/visualize", async (c: any) => {
    try {
      const { visualizeStateMachine } = await import("../persistence/plugins/issue-state-machine.ts");
      const dot = visualizeStateMachine();
      if (!dot) return c.json({ ok: false, error: "Visualization not available." }, 404);
      return c.json({ ok: true, dot });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/refresh", async (c: any) => {
    addEvent(state, undefined, "manual", "Manual refresh requested via API.");
    await persistState(state);
    return c.json({ queued: true, requestedAt: now() }, 202);
  });
}
