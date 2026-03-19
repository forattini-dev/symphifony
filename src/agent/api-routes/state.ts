import type { RuntimeState } from "../types.ts";
import { isoWeek, now } from "../helpers.ts";
import { logger } from "../logger.ts";
import { persistState } from "../store.ts";
import { markIssueDirty } from "../dirty-tracker.ts";
import {
  addEvent,
  computeCapabilityCounts,
  computeMetrics,
  createIssueFromPayload,
  handleStatePatch,
  transitionIssueState,
  triggerReplan,
} from "../issues.ts";
import { wakeScheduler } from "../scheduler.ts";
import { ATTACHMENTS_ROOT, TERMINAL_STATES, TARGET_ROOT } from "../constants.ts";
import { isAgentStillRunning, mergeWorkspace } from "../agent.ts";
import { readAgentPid } from "../pid-manager.ts";
import { findIssue, mutateIssueState, parseIssue } from "../api-helpers.ts";
import { cleanWorkspace } from "../workspace-setup.ts";
import { detectAvailableProviders } from "../providers.ts";
import { analyzeParallelizability } from "../scheduler.ts";
import { collectProvidersUsage } from "../providers-usage.ts";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { basename, extname, join } from "node:path";

export function registerStateRoutes(
  app: any,
  state: RuntimeState,
): void {
  app.get("/api/state", async (c: any) => {
    const showAll = c.req.query("all") === "1";
    let issues = state.issues;

    if (!showAll) {
      // Default: active issues + terminal from this week and last week
      const thisWeek = isoWeek();
      const lastWeekDate = new Date();
      lastWeekDate.setUTCDate(lastWeekDate.getUTCDate() - 7);
      const lastWeek = isoWeek(lastWeekDate);
      const recentWeeks = new Set([thisWeek, lastWeek]);

      issues = state.issues.filter((i) => {
        if (!i.terminalWeek) return true; // active issue
        return recentWeeks.has(i.terminalWeek);
      });
    }

    return c.json({
      ...state,
      issues,
      capabilities: computeCapabilityCounts(issues),
      metrics: computeMetrics(issues),
      _filter: showAll ? "all" : "recent",
      _totalIssues: state.issues.length,
    });
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

  app.get("/api/providers/usage", async (c: any) => {
    try {
      const usage = collectProvidersUsage();
      return c.json(usage);
    } catch (error) {
      logger.error({ err: error }, "Failed to collect providers usage");
      return c.json({ providers: [] }, 500);
    }
  });

  app.post("/api/issues/create", async (c: any) => {
    try {
      const payload = await c.req.json();
      logger.info({ title: (payload.title ?? "").toString().slice(0, 80) }, "[API] POST /api/issues/create");
      const issue = createIssueFromPayload(payload, state.issues, state.config.defaultBranch);

      // Move temp attachment files to permanent issue directory
      const tempImages = Array.isArray(payload.images) ? payload.images as string[] : [];
      if (tempImages.length) {
        const issueAttachDir = join(ATTACHMENTS_ROOT, issue.id);
        mkdirSync(issueAttachDir, { recursive: true });
        const finalPaths: string[] = [];
        for (const tempPath of tempImages) {
          if (typeof tempPath === "string" && existsSync(tempPath)) {
            const dest = join(issueAttachDir, basename(tempPath));
            try { renameSync(tempPath, dest); finalPaths.push(dest); } catch { finalPaths.push(tempPath); }
          }
        }
        if (finalPaths.length) issue.images = finalPaths;
      }

      state.issues.push(issue);
      markIssueDirty(issue.id);
      addEvent(state, issue.id, "info", `Issue ${issue.identifier} created via API.`);
      if (issue.plan) {
        addEvent(state, issue.id, "info", `Plan: ${issue.plan.steps.length} steps, complexity: ${issue.plan.estimatedComplexity}.`);
      }
      await persistState(state);
      wakeScheduler();
      return c.json({ ok: true, issue }, 201);
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/issues/:id/state", async (c: any) => {
    const issueId = parseIssue(c);
    if (!issueId) {
      return c.json({ ok: false, error: "Issue id is required." }, 400);
    }

    const issue = findIssue(state, issueId);
    if (!issue) {
      return c.json({ ok: false, error: "Issue not found" }, 404);
    }

    try {
      const payload = await c.req.json();
      logger.info({ issueId, identifier: issue.identifier, targetState: payload.state }, "[API] POST /api/issues/:id/state");
      await handleStatePatch(state, issue, payload);
      await persistState(state);
      wakeScheduler();
      return c.json({ ok: true, issue });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/issues/:id/retry", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/retry");
    return mutateIssueState(state, c, async (issue) => {
      if (TERMINAL_STATES.has(issue.state)) {
        await transitionIssueState(issue, "Queued", "Manual retry requested.");
      } else {
        issue.lastError = undefined;
        issue.nextRetryAt = undefined;
        issue.updatedAt = now();
      }
      addEvent(state, issue.id, "manual", `Manual retry requested for ${issue.id}.`);
    });
  });

  app.post("/api/issues/:id/cancel", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/cancel");
    return mutateIssueState(state, c, async (issue) => {
      // Kill running agent process if one exists
      const pidInfo = issue.workspacePath ? readAgentPid(issue.workspacePath) : null;
      if (pidInfo) {
        try {
          process.kill(-pidInfo.pid, "SIGTERM");
          logger.info({ pid: pidInfo.pid, issueId: issue.id }, "[API] Sent SIGTERM to agent process group");
        } catch {
          try { process.kill(pidInfo.pid, "SIGTERM"); } catch {}
        }
      }
      issue.cancelledReason = "Manually cancelled by user.";
      await transitionIssueState(issue, "Cancelled", "Manual cancel requested.");
      addEvent(state, issue.id, "manual", `Manual cancel requested for ${issue.id}.`);
    });
  });

  app.post("/api/issues/:id/approve", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/approve");
    return mutateIssueState(state, c, async (issue) => {
      if (issue.state !== "Planning") {
        throw new Error(`Cannot approve issue in state ${issue.state}. Must be in Planning.`);
      }
      await transitionIssueState(issue, "Planned", `Plan approved for ${issue.identifier}. Ready for execution.`);
      addEvent(state, issue.id, "state", `Plan approved — ${issue.identifier} moved to Planned.`);
    });
  });

  app.post("/api/issues/:id/execute", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/execute");
    return mutateIssueState(state, c, async (issue) => {
      if (issue.state !== "Planned") {
        throw new Error(`Cannot execute issue in state ${issue.state}. Must be in Planned.`);
      }
      await transitionIssueState(issue, "Queued", `Execution requested for ${issue.identifier}.`);
      addEvent(state, issue.id, "state", `Execute requested — ${issue.identifier} moved to Queued.`);
      wakeScheduler();
    });
  });

  app.post("/api/issues/:id/replan", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/replan");
    return mutateIssueState(state, c, async (issue) => {
      if (issue.planningStatus === "planning") {
        throw new Error("Cannot replan while planning is in progress.");
      }
      if (TERMINAL_STATES.has(issue.state)) {
        throw new Error(`Cannot replan issue in terminal state ${issue.state}.`);
      }
      if (issue.state === "Running" || issue.state === "Reviewing" || issue.state === "Queued") {
        throw new Error(`Cannot replan issue in ${issue.state} state — wait for it to finish or cancel it first.`);
      }
      triggerReplan(issue);
      wakeScheduler();
      addEvent(state, issue.id, "manual", `Replan requested for ${issue.identifier} — now at plan v${issue.planVersion}.`);
    });
  });

  app.post("/api/issues/:id/merge", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/merge");
    try {
      const issueId = parseIssue(c);
      if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
      const issue = findIssue(state, issueId);
      if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);
      if (!["Done", "Reviewing", "Reviewed"].includes(issue.state)) {
        return c.json({ ok: false, error: `Issue ${issue.identifier} is in state ${issue.state}. Merge is only allowed in Reviewing, Reviewed, or Done state.` }, 409);
      }
      // Auto-transition to Done if still in review
      if (issue.state === "Reviewing" || issue.state === "Reviewed") {
        await transitionIssueState(issue, "Done", `Approved and merged by user.`);
        addEvent(state, issue.id, "state", `${issue.identifier} approved — moved to Done before merge.`);
      }
      const wp = issue.worktreePath ?? issue.workspacePath;
      if (!wp || !existsSync(wp)) {
        return c.json({ ok: false, error: "No workspace found for this issue." }, 400);
      }
      // Compute line stats from git diff before merge
      if (issue.branchName && issue.baseBranch) {
        try {
          const stat = execSync(
            `git diff --shortstat "${issue.baseBranch}"..."${issue.branchName}"`,
            { encoding: "utf8", cwd: TARGET_ROOT, stdio: "pipe", timeout: 10_000 },
          );
          const addMatch = stat.match(/(\d+) insertion/);
          const delMatch = stat.match(/(\d+) deletion/);
          const filesMatch = stat.match(/(\d+) file/);
          issue.linesAdded = addMatch ? parseInt(addMatch[1], 10) : 0;
          issue.linesRemoved = delMatch ? parseInt(delMatch[1], 10) : 0;
          issue.filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
        } catch { /* non-critical */ }
      }
      // If a prior "try" squash was applied (staged but not committed), reset it cleanly
      // before the real git merge --no-ff. Only reset if the index is dirty but working tree is clean,
      // which is exactly the state left by git merge --squash.
      try {
        const indexStatus = execSync("git diff --cached --name-only", { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe" }).trim();
        const wtStatus = execSync("git diff --name-only", { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe" }).trim();
        if (indexStatus && !wtStatus) {
          // Staged-only changes → residual squash → hard reset so merge --no-ff can proceed cleanly
          execSync("git reset --hard HEAD", { cwd: TARGET_ROOT, stdio: "pipe" });
          logger.info({ issueId: issue.id }, "[API] Cleared residual squash from index before merge");
        }
      } catch { /* non-critical */ }

      const result = mergeWorkspace(issue);
      issue.mergeResult = {
        copied: result.copied.length,
        deleted: result.deleted.length,
        skipped: result.skipped.length,
        conflicts: result.conflicts.length,
      };
      if (result.conflicts.length === 0) {
        issue.mergedAt = now();
        if (!issue.mergedReason) issue.mergedReason = "Merged by user via PreviewModal.";
        // Cleanup worktree + branch after successful merge
        if (issue.workspacePath) {
          try {
            await cleanWorkspace(issue.id, issue, state);
            issue.workspacePath = undefined as any;
            issue.worktreePath = undefined as any;
          } catch { /* non-critical */ }
        }
      }
      const conflictMsg = result.conflicts.length > 0
        ? ` ${result.conflicts.length} conflict(s): ${result.conflicts.join(", ")}.`
        : "";
      addEvent(state, issue.id, "merge", `Workspace merged: ${result.copied.length} file(s) copied, ${result.deleted.length} deleted.${conflictMsg}`);
      if (result.conflicts.length > 0) {
        addEvent(state, issue.id, "error", `Merge conflicts: ${result.conflicts.join(", ")}`);
      }
      await persistState(state);
      return c.json({ ok: true, ...result });
    } catch (error) {
      const issueId = parseIssue(c);
      logger.error(`Failed to merge workspace for ${issueId || "<unknown>"}: ${String(error)}`);
      return c.json({ ok: false, error: String(error) }, 500);
    }
  });

  app.post("/api/issues/:id/try", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/try");
    return mutateIssueState(state, c, async (issue) => {
      if (!["Reviewing", "Reviewed"].includes(issue.state)) {
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
      addEvent(state, issue.id, "manual", `Test reverted: git reset --hard HEAD && git clean -fd`);
    });
  });

  app.post("/api/issues/:id/rollback", async (c: any) => {
    logger.info({ issueId: parseIssue(c) }, "[API] POST /api/issues/:id/rollback");
    return mutateIssueState(state, c, async (issue) => {
      if (!["Reviewing", "Reviewed", "Done"].includes(issue.state)) {
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
      await transitionIssueState(issue, "Queued", "Rolled back by user — worktree removed.");
      addEvent(state, issue.id, "manual", `${issue.identifier} rolled back. Worktree and branch removed.`);
      wakeScheduler();
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

  app.post("/api/refresh", async (c: any) => {
    addEvent(state, undefined, "manual", "Manual refresh requested via API.");
    await persistState(state);
    return c.json({ queued: true, requestedAt: now() }, 202);
  });
}
