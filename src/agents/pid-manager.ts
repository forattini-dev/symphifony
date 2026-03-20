import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IssueEntry } from "../types.ts";

export type AgentPidInfo = {
  pid: number;
  issueId: string;
  startedAt: string;
  command: string;
};

/** Read PID file from workspace, returns null if missing/invalid. */
export function readAgentPid(workspacePath: string): AgentPidInfo | null {
  const pidFile = join(workspacePath, "agent.pid");
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
    try { rmSync(join(workspacePath, "agent.pid"), { force: true }); } catch {}
  }
}
