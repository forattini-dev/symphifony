import { execSync } from "node:child_process";
import type { IssueEntry } from "./types.ts";
import { TARGET_ROOT } from "./constants.ts";

export function inferChangedWorkspacePaths(workspacePath: string, limit = 32, issue?: IssueEntry): string[] {
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

  const internalRe = /fifony[-_]|\.fifony-|WORKFLOW\.local/;
  const fileLines = lines.slice(0, -1).filter((l) => {
    const name = l.trim().split("|")[0]?.trim().split("/").pop() || "";
    return !internalRe.test(name);
  });

  issue.filesChanged = fileLines.length || (filesMatch ? parseInt(filesMatch[1], 10) : 0);
  issue.linesAdded = addMatch ? parseInt(addMatch[1], 10) : 0;
  issue.linesRemoved = delMatch ? parseInt(delMatch[1], 10) : 0;
}
