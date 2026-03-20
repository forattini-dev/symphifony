import type { RuntimeState } from "../types.ts";
import { logger } from "../concerns/logger.ts";
import { toStringValue } from "../concerns/helpers.ts";
import { isAgentStillRunning, pushWorktreeBranch } from "../agents/agent.ts";
import { addEvent } from "../domains/issues.ts";
import { persistState } from "../persistence/store.ts";
import { findIssue, listEvents, parseIssue } from "../routes/helpers.ts";
import { TARGET_ROOT, SOURCE_ROOT, ATTACHMENTS_ROOT } from "../concerns/constants.ts";
import { execSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { now } from "../concerns/helpers.ts";

export function registerMiscRoutes(
  app: any,
  state: RuntimeState,
): void {
  app.post("/api/issues/:id/push", async (c: any) => {
    const issueId = parseIssue(c);
    if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
    const issue = findIssue(state, issueId);
    if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);
    if (issue.state !== "Done") {
      return c.json({ ok: false, error: `Issue ${issue.identifier} must be in Done state to push. Current state: ${issue.state}.` }, 409);
    }
    try {
      const prUrl = pushWorktreeBranch(issue);
      issue.mergedAt = new Date().toISOString();
      addEvent(state, issue.id, "merge", `Branch ${issue.branchName} pushed to origin. PR: ${prUrl}`);
      await persistState(state);
      return c.json({ ok: true, prUrl });
    } catch (error) {
      logger.error({ err: error }, `[API] Failed to push branch for ${issueId}`);
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/live/:id/stream", (c: any) => {
    const issueId = parseIssue(c);
    if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
    const issue = findIssue(state, issueId);
    if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);

    const enc = new TextEncoder();
    const sseMsg = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`);
    const sseComment = () => enc.encode(": keepalive\n\n");

    let intervalId: ReturnType<typeof setInterval>;
    let keepaliveId: ReturnType<typeof setInterval>;

    const stream = new ReadableStream({
      start(ctrl) {
        // Send initial content
        const wp = issue.workspacePath;
        const liveLog = wp ? `${wp}/live-output.log` : null;
        let lastSize = 0;

        if (liveLog && existsSync(liveLog)) {
          try {
            const stat = statSync(liveLog);
            lastSize = stat.size;
            const readSize = Math.min(lastSize, 16_384);
            const fd = openSync(liveLog, "r");
            const buf = Buffer.alloc(readSize);
            readSync(fd, buf, 0, readSize, Math.max(0, lastSize - readSize));
            closeSync(fd);
            ctrl.enqueue(sseMsg({ type: "init", text: buf.toString("utf8"), size: lastSize }));
          } catch {}
        } else {
          ctrl.enqueue(sseMsg({ type: "init", text: "", size: 0 }));
        }

        // Stream new bytes every second
        intervalId = setInterval(() => {
          const currentIssue = findIssue(state, issueId);
          if (!currentIssue || (currentIssue.state !== "Running" && currentIssue.state !== "Reviewing" && currentIssue.state !== "Planning")) {
            ctrl.enqueue(sseMsg({ type: "done", state: currentIssue?.state }));
            clearInterval(intervalId);
            clearInterval(keepaliveId);
            try { ctrl.close(); } catch {}
            return;
          }
          const logPath = currentIssue.workspacePath ? `${currentIssue.workspacePath}/live-output.log` : null;
          if (logPath && existsSync(logPath)) {
            try {
              const stat = statSync(logPath);
              if (stat.size > lastSize) {
                const readSize = stat.size - lastSize;
                const fd = openSync(logPath, "r");
                const buf = Buffer.alloc(readSize);
                readSync(fd, buf, 0, readSize, lastSize);
                closeSync(fd);
                lastSize = stat.size;
                ctrl.enqueue(sseMsg({ type: "chunk", text: buf.toString("utf8"), size: lastSize }));
              }
            } catch {}
          }
        }, 1_000);

        // Keepalive every 15s to prevent proxy timeouts
        keepaliveId = setInterval(() => {
          try { ctrl.enqueue(sseComment()); } catch {}
        }, 15_000);
      },
      cancel() {
        clearInterval(intervalId);
        clearInterval(keepaliveId);
      },
    });

    return c.body(stream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
  });

  app.get("/api/live/:id", async (c: any) => {
    try {
      const issueId = parseIssue(c);
      if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
      const issue = findIssue(state, issueId);
      if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);

      const parseStartedAt = (value: unknown): number | null => {
        const valueText = typeof value === "string" ? value.trim() : "";
        if (!valueText) return null;
        const ts = Date.parse(valueText);
        return Number.isFinite(ts) ? ts : null;
      };

      const startedAtText = toStringValue(issue.startedAt, "");
      const updatedAtText = toStringValue(issue.updatedAt, "");
      const startedAtTs = parseStartedAt(startedAtText) ?? parseStartedAt(updatedAtText);
      const elapsed = startedAtTs ? Date.now() - startedAtTs : 0;

      const wp = issue.workspacePath;
      const liveLog = wp ? `${wp}/live-output.log` : null;
      let logTail = "";
      let logSize = 0;
      if (liveLog && existsSync(liveLog)) {
        try {
          const stat = statSync(liveLog);
          logSize = stat.size;
          // Read last 8KB
          const fd = openSync(liveLog, "r");
          const readSize = Math.min(logSize, 8192);
          const buf = Buffer.alloc(readSize);
          readSync(fd, buf, 0, readSize, Math.max(0, logSize - readSize));
          closeSync(fd);
          logTail = buf.toString("utf8");
        } catch {}
      }
      const agentStatus = isAgentStillRunning(issue);
      return c.json({
        ok: true,
        issueId: issue.id,
        state: issue.state,
        running: issue.state === "Running" || issue.state === "Reviewing",
        agentAlive: agentStatus.alive,
        agentPid: agentStatus.pid?.pid ?? null,
        startedAt: startedAtText || updatedAtText || now(),
        elapsed: Number.isFinite(elapsed) ? elapsed : 0,
        logSize,
        logTail,
        outputTail: issue.commandOutputTail || "",
      });
    } catch (error) {
      const issueId = parseIssue(c);
      logger.error(`Failed to load live issue state for ${issueId || "<unknown>"}: ${String(error)}`);
      return c.json({ ok: false, error: "Failed to load live issue state." }, 500);
    }
  });

  app.get("/api/diff/:id", async (c: any) => {
    try {
      const issueId = parseIssue(c);
      if (!issueId) return c.json({ ok: false, error: "Issue id is required." }, 400);
      const issue = findIssue(state, issueId);
      if (!issue) return c.json({ ok: false, error: "Issue not found." }, 404);
      const wp = issue.workspacePath;
      if (!wp || !existsSync(wp)) {
        return c.json({ ok: true, files: [], diff: "", message: "No workspace found." });
      }
      let raw = "";
      if (issue.branchName && issue.baseBranch) {
        // Git worktree: proper branch diff
        try {
          raw = execSync(
            `git diff --no-color "${issue.baseBranch}"..."${issue.branchName}"`,
            { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000, cwd: TARGET_ROOT, stdio: "pipe" },
          );
        } catch (err: any) {
          raw = err.stdout || "";
        }
      } else {
        // Legacy: no-index diff between SOURCE_ROOT and workspace
        if (!existsSync(SOURCE_ROOT)) {
          return c.json({ ok: true, files: [], diff: "", message: "Source root not found." });
        }
        try {
          raw = execSync(
            `git diff --no-index --no-color -- "${SOURCE_ROOT}" "${wp}"`,
            { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
          );
        } catch (err: any) {
          raw = err.stdout || "";
        }
      }

      if (!raw.trim()) {
        return c.json({ ok: true, files: [], diff: "", message: "No changes" });
      }

      // Clean paths for legacy diff (git worktree diff already uses a/ b/ prefixes)
      let cleaned = raw;
      if (!issue.branchName || !issue.baseBranch) {
        const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const sourcePrefix = SOURCE_ROOT.endsWith("/") ? SOURCE_ROOT : `${SOURCE_ROOT}/`;
        const wpPrefix = wp.endsWith("/") ? wp : `${wp}/`;
        cleaned = raw
          .replace(new RegExp(esc(wpPrefix), "g"), "b/")
          .replace(new RegExp(esc(sourcePrefix), "g"), "a/");
      }

      // Split into per-file chunks and filter internals
      const internalRe = /^(fifony[-_]|\.fifony-|WORKFLOW\.local)/;
      const chunks = cleaned.split(/(?=^diff --git )/m);
      const filtered = chunks.filter((chunk) => {
        const m = chunk.match(/^diff --git a\/(.+?) b\//);
        if (!m) return false;
        const basename = m[1].split("/").pop() || "";
        return !internalRe.test(basename);
      });

      const diff = filtered.join("").trim();

      // Per-file summary (like GitHub PR file list)
      const files = filtered.map((chunk) => {
        const pathMatch = chunk.match(/^diff --git a\/(.+?) b\//);
        const path = pathMatch?.[1] || "unknown";
        const additions = (chunk.match(/^\+[^+]/gm) || []).length;
        const deletions = (chunk.match(/^-[^-]/gm) || []).length;
        const isNew = chunk.includes("new file mode");
        const isDeleted = chunk.includes("deleted file mode");
        const status = isNew ? "added" : isDeleted ? "removed" : "modified";
        return { path, status, additions, deletions };
      });

      const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
      const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

      return c.json({ ok: true, files, diff, totalAdditions, totalDeletions });
    } catch (error) {
      const issueId = parseIssue(c);
      logger.error(`Failed to load issue diff for ${issueId || "<unknown>"}: ${String(error)}`);
      return c.json({ ok: false, error: "Failed to load issue diff." }, 500);
    }
  });

  app.get("/api/git/status", async (c: any) => {
    try {
      const isGit = (() => {
        try { execSync("git rev-parse --git-dir", { cwd: TARGET_ROOT, stdio: "pipe" }); return true; } catch { return false; }
      })();
      if (!isGit) return c.json({ isGit: false, branch: null, hasCommits: false });
      const branch = (() => {
        try { return execSync("git rev-parse --abbrev-ref HEAD", { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe" }).trim(); } catch { return null; }
      })();
      const hasCommits = (() => {
        try { execSync("git rev-parse HEAD", { cwd: TARGET_ROOT, stdio: "pipe" }); return true; } catch { return false; }
      })();
      return c.json({ isGit: true, branch, hasCommits });
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 500);
    }
  });

  app.post("/api/git/init", async (c: any) => {
    try {
      execSync("git init", { cwd: TARGET_ROOT, stdio: "pipe" });
      // Create an empty initial commit so HEAD exists and branching works normally
      execSync('git commit --allow-empty -m "Initial commit"', { cwd: TARGET_ROOT, stdio: "pipe" });
      const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: TARGET_ROOT, encoding: "utf8", stdio: "pipe" }).trim();
      state.config.defaultBranch = branch;
      await persistState(state);
      return c.json({ ok: true, branch });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post("/api/git/branch", async (c: any) => {
    try {
      const { branchName } = await c.req.json() as { branchName?: string };
      if (!branchName || !/^[a-zA-Z0-9/_.-]+$/.test(branchName)) {
        return c.json({ ok: false, error: "Invalid branch name." }, 400);
      }
      execSync(`git checkout -b "${branchName}"`, { cwd: TARGET_ROOT, stdio: "pipe" });
      state.config.defaultBranch = branchName;
      await persistState(state);
      return c.json({ ok: true, defaultBranch: branchName });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.get("/api/events/feed", async (c: any) => {
    const since = c.req.query("since");
    const issueId = c.req.query("issueId");
    const kind = c.req.query("kind");
    const events = await listEvents(state, {
      since: typeof since === "string" ? since : undefined,
      issueId: typeof issueId === "string" && issueId ? issueId : undefined,
      kind: typeof kind === "string" && kind ? kind : undefined,
    });
    return c.json({ events: events.slice(0, 200) });
  });

  app.get("/api/gitignore/status", async (c: any) => {
    try {
      const gitignorePath = join(TARGET_ROOT, ".gitignore");
      if (!existsSync(gitignorePath)) {
        return c.json({ exists: false, hasFifony: false });
      }
      const content = readFileSync(gitignorePath, "utf-8");
      const lines = content.split("\n").map((l: string) => l.trim());
      const hasFifony = lines.some((l: string) => l === ".fifony" || l === ".fifony/" || l === "/.fifony" || l === "/.fifony/");
      return c.json({ exists: true, hasFifony });
    } catch (error) {
      logger.error({ err: error }, "Failed to check .gitignore");
      return c.json({ exists: false, hasFifony: false, error: "Failed to check .gitignore" }, 500);
    }
  });

  app.post("/api/gitignore/add", async (c: any) => {
    try {
      const gitignorePath = join(TARGET_ROOT, ".gitignore");
      if (!existsSync(gitignorePath)) {
        writeFileSync(gitignorePath, "# Fifony state directory\n.fifony/\n", "utf-8");
        return c.json({ ok: true, created: true });
      }
      const content = readFileSync(gitignorePath, "utf-8");
      const lines = content.split("\n").map((l: string) => l.trim());
      const hasFifony = lines.some((l: string) => l === ".fifony" || l === ".fifony/" || l === "/.fifony" || l === "/.fifony/");
      if (hasFifony) {
        return c.json({ ok: true, alreadyPresent: true });
      }
      const suffix = content.endsWith("\n") ? "" : "\n";
      appendFileSync(gitignorePath, `${suffix}\n# Fifony state directory\n.fifony/\n`, "utf-8");
      return c.json({ ok: true, added: true });
    } catch (error) {
      logger.error({ err: error }, "Failed to update .gitignore");
      return c.json({ ok: false, error: "Failed to update .gitignore" }, 500);
    }
  });

  app.post("/api/attachments/upload", async (c: any) => {
    try {
      const payload = await c.req.json() as { files?: Array<{ name: string; data: string; type: string }> };
      if (!Array.isArray(payload.files) || payload.files.length === 0) {
        return c.json({ ok: false, error: "No files provided." }, 400);
      }
      const uploadId = randomUUID();
      const uploadDir = join(ATTACHMENTS_ROOT, "temp", uploadId);
      mkdirSync(uploadDir, { recursive: true });
      const paths: string[] = [];
      for (const file of payload.files) {
        if (typeof file.data !== "string" || !file.name) continue;
        const safeExt = extname(file.name).replace(/[^a-z0-9.]/gi, "").slice(0, 10) || ".bin";
        const safeName = `${randomUUID()}${safeExt}`;
        const dest = join(uploadDir, safeName);
        writeFileSync(dest, Buffer.from(file.data, "base64"));
        paths.push(dest);
      }
      return c.json({ ok: true, paths, uploadId });
    } catch (error) {
      logger.error({ err: error }, "[API] Attachment upload failed");
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}
