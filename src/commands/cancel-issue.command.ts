import type { IssueEntry } from "../types.ts";
import type { IIssueRepository, IEventStore } from "../ports/index.ts";
import { transitionIssueCommand } from "./transition-issue.command.ts";
import { readAgentPid } from "../agents/pid-manager.ts";
import { logger } from "../concerns/logger.ts";

export type CancelIssueInput = {
  issue: IssueEntry;
};

export async function cancelIssueCommand(
  input: CancelIssueInput,
  deps: {
    issueRepository: IIssueRepository;
    eventStore: IEventStore;
  },
): Promise<void> {
  const { issue } = input;

  // Kill running agent process if one exists
  const pidInfo = issue.workspacePath ? readAgentPid(issue.workspacePath) : null;
  if (pidInfo) {
    try {
      process.kill(-pidInfo.pid, "SIGTERM");
      logger.info({ pid: pidInfo.pid, issueId: issue.id }, "[Command] Sent SIGTERM to agent process group");
    } catch {
      try { process.kill(pidInfo.pid, "SIGTERM"); } catch {}
    }
  }

  issue.cancelledReason = "Manually cancelled by user.";

  await transitionIssueCommand(
    { issue, target: "Cancelled", note: "Manual cancel requested." },
    deps,
  );

  deps.eventStore.addEvent(issue.id, "manual", `Manual cancel requested for ${issue.id}.`);
}
