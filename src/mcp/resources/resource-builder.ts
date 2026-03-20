import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPrompt } from "../../agents/prompting.js";
import { resolveTaskCapabilities } from "../../routing/capability-resolver.js";
import {
  type IssueRecord,
  getIssues,
  getResources,
  listEvents,
  listRecords,
  getRuntimeSnapshot,
  WORKSPACE_ROOT,
  PERSISTENCE_ROOT,
  STATE_ROOT,
} from "../database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const PACKAGE_ROOT = resolve(__dirname, "../../..");
export const README_PATH = join(PACKAGE_ROOT, "README.md");
export const FIFONY_GUIDE_PATH = join(PACKAGE_ROOT, "FIFONY.md");

export async function buildIntegrationGuide(): Promise<string> {
  return renderPrompt("mcp-integration-guide", {
    workspaceRoot: WORKSPACE_ROOT,
    persistenceRoot: PERSISTENCE_ROOT,
    stateRoot: STATE_ROOT,
  });
}

export function computeCapabilityCounts(issues: IssueRecord[]): Record<string, number> {
  return issues.reduce<Record<string, number>>((accumulator, issue) => {
    const key = typeof issue.capabilityCategory === "string" && issue.capabilityCategory.trim()
      ? issue.capabilityCategory.trim()
      : "default";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

export async function buildStateSummary(): Promise<string> {
  const runtime = await getRuntimeSnapshot();
  const issues = await getIssues();
  const { sessionResource, pipelineResource } = getResources();
  const sessions = await listRecords(sessionResource, 500);
  const pipelines = await listRecords(pipelineResource, 500);
  const events = await listEvents({ limit: 100 });

  const byState = issues.reduce<Record<string, number>>((accumulator, issue) => {
    const key = issue.state ?? "Unknown";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
  const byCapability = computeCapabilityCounts(issues);

  return JSON.stringify({
    workspaceRoot: WORKSPACE_ROOT,
    persistenceRoot: PERSISTENCE_ROOT,
    stateRoot: STATE_ROOT,
    runtimeUpdatedAt: runtime.updatedAt ?? null,
    issueCount: issues.length,
    issuesByState: byState,
    issuesByCapability: byCapability,
    sessionCount: sessions.length,
    pipelineCount: pipelines.length,
    recentEventCount: events.length,
  }, null, 2);
}

export async function buildIssuePrompt(issue: IssueRecord, provider: string, role: string): Promise<string> {
  const resolution = resolveTaskCapabilities({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: typeof issue.description === "string" ? issue.description : "",
    labels: Array.isArray(issue.labels) ? issue.labels.filter((value): value is string => typeof value === "string") : [],
    paths: Array.isArray(issue.paths) ? issue.paths.filter((value): value is string => typeof value === "string") : [],
  });
  return renderPrompt("mcp-issue", {
    role,
    provider,
    id: issue.id,
    title: issue.title,
    state: issue.state ?? "Planning",
    capabilityCategory: resolution.category,
    overlays: resolution.overlays,
    paths: Array.isArray(issue.paths) ? issue.paths.filter((value): value is string => typeof value === "string") : [],
    description: issue.description || "No description provided.",
  });
}
