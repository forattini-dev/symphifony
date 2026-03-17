import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { renderPrompt } from "../prompting.ts";
import { buildIntegrationSnippet, discoverIntegrations } from "../integrations/catalog.ts";
import { inferCapabilityPaths, resolveTaskCapabilities } from "../routing/capability-resolver.ts";
import {
  type IssueRecord,
  initDatabase,
  getDatabase,
  getResources,
  getIssues,
  getIssue,
  listIssues,
  listEvents,
  listRecords,
  getRuntimeSnapshot,
  appendEvent,
  nowIso,
  safeRead,
  WORKSPACE_ROOT,
  PERSISTENCE_ROOT,
  STATE_ROOT,
} from "./database.ts";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "../..");
const WORKFLOW_PATH = join(WORKSPACE_ROOT, "WORKFLOW.md");
const README_PATH = join(PACKAGE_ROOT, "README.md");
const FIFONY_GUIDE_PATH = join(PACKAGE_ROOT, "FIFONY.md");
const DEBUG_BOOT = env.FIFONY_DEBUG_BOOT === "1";

let incomingBuffer = Buffer.alloc(0);

function debugBoot(message: string): void {
  if (!DEBUG_BOOT) return;
  process.stderr.write(`[FIFONY_DEBUG_BOOT] ${message}\n`);
}

function hashInput(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

async function buildIntegrationGuide(): Promise<string> {
  return renderPrompt("mcp-integration-guide", {
    workspaceRoot: WORKSPACE_ROOT,
    persistenceRoot: PERSISTENCE_ROOT,
    stateRoot: STATE_ROOT,
  });
}

function computeCapabilityCounts(issues: IssueRecord[]): Record<string, number> {
  return issues.reduce<Record<string, number>>((accumulator, issue) => {
    const key = typeof issue.capabilityCategory === "string" && issue.capabilityCategory.trim()
      ? issue.capabilityCategory.trim()
      : "default";
    accumulator[key] = (accumulator[key] ?? 0) + 1;
    return accumulator;
  }, {});
}

async function buildStateSummary(): Promise<string> {
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
    workflowPresent: existsSync(WORKFLOW_PATH),
    runtimeUpdatedAt: runtime.updatedAt ?? null,
    issueCount: issues.length,
    issuesByState: byState,
    issuesByCapability: byCapability,
    sessionCount: sessions.length,
    pipelineCount: pipelines.length,
    recentEventCount: events.length,
  }, null, 2);
}

async function buildIssuePrompt(issue: IssueRecord, provider: string, role: string): Promise<string> {
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
    state: issue.state ?? "Todo",
    capabilityCategory: resolution.category,
    overlays: resolution.overlays,
    paths: Array.isArray(issue.paths) ? issue.paths.filter((value): value is string => typeof value === "string") : [],
    description: issue.description || "No description provided.",
  });
}

async function listResourcesMcp(): Promise<Array<Record<string, unknown>>> {
  const issues = await getIssues();
  const resources: Array<Record<string, unknown>> = [
    { uri: "fifony://guide/overview", name: "Fifony overview", description: "High-level overview and local integration guide.", mimeType: "text/markdown" },
    { uri: "fifony://guide/runtime", name: "Fifony runtime guide", description: "Detailed local runtime reference for the package.", mimeType: "text/markdown" },
    { uri: "fifony://guide/integration", name: "Fifony MCP integration guide", description: "How to wire an MCP client to this Fifony workspace.", mimeType: "text/markdown" },
    { uri: "fifony://state/summary", name: "Fifony state summary", description: "Compact summary of the current runtime, issue, and pipeline state.", mimeType: "application/json" },
    { uri: "fifony://issues", name: "Fifony issues", description: "Full issue list from the durable Fifony store.", mimeType: "application/json" },
    { uri: "fifony://integrations", name: "Fifony integrations", description: "Discovered local integrations such as agency-agents and impeccable skills.", mimeType: "application/json" },
    { uri: "fifony://capabilities", name: "Fifony capability routing", description: "How Fifony would route current issues to providers, profiles, and overlays.", mimeType: "application/json" },
  ];

  if (existsSync(WORKFLOW_PATH)) {
    resources.push({ uri: "fifony://workspace/workflow", name: "Workspace workflow", description: "The active WORKFLOW.md from the target workspace.", mimeType: "text/markdown" });
  }

  resources.push(
    { uri: "fifony://analytics", name: "Token usage analytics", description: "Token usage analytics snapshot including totals, cost estimates, and per-model breakdown.", mimeType: "application/json" },
    { uri: "fifony://workflow/config", name: "Workflow config", description: "Current pipeline workflow configuration (plan/execute/review providers, models, and effort).", mimeType: "application/json" },
    { uri: "fifony://agents/catalog", name: "Agent catalog", description: "Available agents from the Fifony catalog.", mimeType: "application/json" },
    { uri: "fifony://skills/catalog", name: "Skill catalog", description: "Available skills from the Fifony catalog.", mimeType: "application/json" },
    { uri: "fifony://events/recent", name: "Recent events", description: "Last 50 events across all issues.", mimeType: "application/json" },
  );

  for (const issue of issues.slice(0, 100)) {
    resources.push(
      { uri: `fifony://issue/${encodeURIComponent(issue.id)}`, name: `Issue ${issue.id}`, description: issue.title, mimeType: "application/json" },
      { uri: `fifony://issue/${encodeURIComponent(issue.id)}/plan`, name: `Issue ${issue.id} plan`, description: `Plan for: ${issue.title}`, mimeType: "application/json" },
      { uri: `fifony://issue/${encodeURIComponent(issue.id)}/diff`, name: `Issue ${issue.id} diff`, description: `Git diff for: ${issue.title}`, mimeType: "application/json" },
      { uri: `fifony://issue/${encodeURIComponent(issue.id)}/events`, name: `Issue ${issue.id} events`, description: `Events for: ${issue.title}`, mimeType: "application/json" },
    );
  }

  return resources;
}

async function readResource(uri: string): Promise<Array<Record<string, unknown>>> {
  if (uri === "fifony://guide/overview") return [{ uri, mimeType: "text/markdown", text: safeRead(README_PATH) }];
  if (uri === "fifony://guide/runtime") return [{ uri, mimeType: "text/markdown", text: safeRead(FIFONY_GUIDE_PATH) }];
  if (uri === "fifony://guide/integration") return [{ uri, mimeType: "text/markdown", text: await buildIntegrationGuide() }];
  if (uri === "fifony://state/summary") return [{ uri, mimeType: "application/json", text: await buildStateSummary() }];
  if (uri === "fifony://issues") return [{ uri, mimeType: "application/json", text: JSON.stringify(await getIssues(), null, 2) }];

  if (uri === "fifony://integrations") {
    return [{ uri, mimeType: "application/json", text: JSON.stringify(discoverIntegrations(WORKSPACE_ROOT), null, 2) }];
  }

  if (uri === "fifony://capabilities") {
    const issues = await getIssues();
    return [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        issues.map((issue) => ({
          issueId: issue.id,
          title: issue.title,
          paths: Array.isArray(issue.paths) ? issue.paths.filter((value): value is string => typeof value === "string") : [],
          inferredPaths: inferCapabilityPaths({
            id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description,
            labels: Array.isArray(issue.labels) ? issue.labels.filter((value): value is string => typeof value === "string") : [],
            paths: Array.isArray(issue.paths) ? issue.paths.filter((value): value is string => typeof value === "string") : [],
          }),
          resolution: resolveTaskCapabilities({
            id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description,
            labels: Array.isArray(issue.labels) ? issue.labels.filter((value): value is string => typeof value === "string") : [],
            paths: Array.isArray(issue.paths) ? issue.paths.filter((value): value is string => typeof value === "string") : [],
          }),
        })),
        null, 2,
      ),
    }];
  }

  if (uri === "fifony://workspace/workflow") return [{ uri, mimeType: "text/markdown", text: safeRead(WORKFLOW_PATH) }];

  if (uri === "fifony://analytics") {
    try {
      const result = await apiGet("/api/analytics/tokens");
      return [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }];
    } catch (error) {
      return [{ uri, mimeType: "application/json", text: JSON.stringify({ error: String(error) }, null, 2) }];
    }
  }

  if (uri === "fifony://workflow/config") {
    try {
      const result = await apiGet("/api/config/workflow");
      return [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }];
    } catch (error) {
      return [{ uri, mimeType: "application/json", text: JSON.stringify({ error: String(error) }, null, 2) }];
    }
  }

  if (uri === "fifony://agents/catalog") {
    try {
      const result = await apiGet("/api/catalog/agents");
      return [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }];
    } catch (error) {
      return [{ uri, mimeType: "application/json", text: JSON.stringify({ error: String(error) }, null, 2) }];
    }
  }

  if (uri === "fifony://skills/catalog") {
    try {
      const result = await apiGet("/api/catalog/skills");
      return [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }];
    } catch (error) {
      return [{ uri, mimeType: "application/json", text: JSON.stringify({ error: String(error) }, null, 2) }];
    }
  }

  if (uri === "fifony://events/recent") {
    try {
      const result = await apiGet("/api/events/feed");
      const events = Array.isArray((result as any).events) ? (result as any).events.slice(0, 50) : [];
      return [{ uri, mimeType: "application/json", text: JSON.stringify({ events }, null, 2) }];
    } catch (error) {
      const events = await listEvents({ limit: 50 });
      return [{ uri, mimeType: "application/json", text: JSON.stringify({ events }, null, 2) }];
    }
  }

  if (uri.startsWith("fifony://issue/")) {
    const remainder = uri.substring("fifony://issue/".length);

    // fifony://issue/{id}/plan
    const planMatch = remainder.match(/^(.+)\/plan$/);
    if (planMatch) {
      const issueId = decodeURIComponent(planMatch[1]);
      const issue = await getIssue(issueId);
      if (!issue) throw new Error(`Issue not found: ${issueId}`);
      const plan = (issue as any).plan ?? null;
      return [{ uri, mimeType: "application/json", text: JSON.stringify({ issueId, plan }, null, 2) }];
    }

    // fifony://issue/{id}/diff
    const diffMatch = remainder.match(/^(.+)\/diff$/);
    if (diffMatch) {
      const issueId = decodeURIComponent(diffMatch[1]);
      try {
        const result = await apiGet(`/api/diff/${encodeURIComponent(issueId)}`);
        return [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }];
      } catch (error) {
        return [{ uri, mimeType: "application/json", text: JSON.stringify({ error: String(error) }, null, 2) }];
      }
    }

    // fifony://issue/{id}/events
    const eventsMatch = remainder.match(/^(.+)\/events$/);
    if (eventsMatch) {
      const issueId = decodeURIComponent(eventsMatch[1]);
      try {
        const result = await apiGet(`/api/events/feed?issueId=${encodeURIComponent(issueId)}`);
        return [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }];
      } catch (error) {
        const events = await listEvents({ limit: 100 });
        const filtered = events.filter((event: any) => event.issueId === issueId);
        return [{ uri, mimeType: "application/json", text: JSON.stringify({ events: filtered }, null, 2) }];
      }
    }

    // fifony://issue/{id} (base case)
    const issueId = decodeURIComponent(remainder);
    const issue = await getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    return [{ uri, mimeType: "application/json", text: JSON.stringify(issue, null, 2) }];
  }

  throw new Error(`Unknown resource: ${uri}`);
}

function listPrompts(): Array<Record<string, unknown>> {
  return [
    { name: "fifony-integrate-client", description: "Generate setup instructions for connecting an MCP-capable client to Fifony.", arguments: [{ name: "client", description: "Client name, e.g. codex or claude.", required: true }, { name: "goal", description: "What the client should do with Fifony.", required: false }] },
    { name: "fifony-plan-issue", description: "Generate a planning prompt for a specific issue in the Fifony store.", arguments: [{ name: "issueId", description: "Issue identifier.", required: true }, { name: "provider", description: "Agent provider name.", required: false }] },
    { name: "fifony-review-workflow", description: "Review the current WORKFLOW.md and propose improvements for orchestration quality.", arguments: [{ name: "provider", description: "Reviewing model or client.", required: false }] },
    { name: "fifony-use-integration", description: "Generate a concrete integration prompt for agency-agents or impeccable.", arguments: [{ name: "integration", description: "Integration id: agency-agents or impeccable.", required: true }] },
    { name: "fifony-route-task", description: "Explain which providers, profiles, and overlays Fifony would choose for a task.", arguments: [{ name: "title", description: "Task title.", required: true }, { name: "description", description: "Task description.", required: false }, { name: "labels", description: "Comma-separated labels.", required: false }, { name: "paths", description: "Comma-separated target paths or files.", required: false }] },
    { name: "fifony-diagnose-blocked", description: "Help diagnose why an issue is blocked or failing, analyzing the issue plan, last error, history, and events.", arguments: [{ name: "issueId", description: "Issue identifier to diagnose.", required: true }] },
    { name: "fifony-weekly-summary", description: "Generate a weekly progress summary including issues created, completed, blocked, and token usage.", arguments: [] },
    { name: "fifony-refine-plan", description: "Guided plan refinement prompt that shows the current plan and helps provide specific feedback.", arguments: [{ name: "issueId", description: "Issue identifier whose plan to refine.", required: true }, { name: "concern", description: "Optional specific concern to address in refinement.", required: false }] },
    { name: "fifony-code-review", description: "Review code changes for an issue by analyzing its git diff.", arguments: [{ name: "issueId", description: "Issue identifier to review.", required: true }] },
  ];
}

async function getPrompt(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (name === "fifony-integrate-client") {
    const client = typeof args.client === "string" && args.client.trim() ? args.client.trim() : "mcp-client";
    const goal = typeof args.goal === "string" && args.goal.trim() ? args.goal.trim() : "integrate with the local Fifony workspace";
    const integrationGuide = await buildIntegrationGuide();
    return {
      description: "Client integration prompt for Fifony.",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: await renderPrompt("mcp-integrate-client", { client, goal, integrationGuide }),
        },
      }],
    };
  }

  if (name === "fifony-plan-issue") {
    const issueId = typeof args.issueId === "string" ? args.issueId : "";
    const provider = typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : "codex";
    const issue = issueId ? await getIssue(issueId) : null;
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    return {
      description: "Issue planning prompt grounded in the Fifony issue store.",
      messages: [{
        role: "user",
        content: { type: "text", text: await buildIssuePrompt(issue, provider, "planner") },
      }],
    };
  }

  if (name === "fifony-review-workflow") {
    const provider = typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : "claude";
    return {
      description: "Workflow review prompt for Fifony orchestration.",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: await renderPrompt("mcp-review-workflow", {
            provider,
            workspaceRoot: WORKSPACE_ROOT,
            workflowPresent: existsSync(WORKFLOW_PATH) ? "yes" : "no",
          }),
        },
      }],
    };
  }

  if (name === "fifony-use-integration") {
    const integration = typeof args.integration === "string" ? args.integration : "";
    return {
      description: "Integration guidance for a discovered Fifony extension.",
      messages: [{
        role: "user",
        content: { type: "text", text: await buildIntegrationSnippet(integration, WORKSPACE_ROOT) },
      }],
    };
  }

  if (name === "fifony-route-task") {
    const title = typeof args.title === "string" ? args.title : "";
    const description = typeof args.description === "string" ? args.description : "";
    const labels = typeof args.labels === "string" ? args.labels.split(",").map((label) => label.trim()).filter(Boolean) : [];
    const paths = typeof args.paths === "string" ? args.paths.split(",").map((value) => value.trim()).filter(Boolean) : [];
    const resolution = resolveTaskCapabilities({ title, description, labels, paths });
    return {
      description: "Task routing prompt produced by the Fifony capability resolver.",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: await renderPrompt("mcp-route-task", {
            resolutionJson: JSON.stringify(resolution, null, 2),
          }),
        },
      }],
    };
  }

  if (name === "fifony-diagnose-blocked") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    const issue = await getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const issueData = issue as any;
    let events: unknown[] = [];
    try {
      const evResult = await apiGet(`/api/events/feed?issueId=${encodeURIComponent(issueId)}`);
      events = Array.isArray((evResult as any).events) ? (evResult as any).events.slice(0, 30) : [];
    } catch {
      const localEvents = await listEvents({ limit: 100 });
      events = localEvents.filter((event: any) => event.issueId === issueId).slice(0, 30);
    }
    const plan = issueData.plan ?? null;
    const history = Array.isArray(issueData.history) ? issueData.history : [];
    const lastError = issueData.lastError ?? null;
    const state = issueData.state ?? "Unknown";
    const attempts = issueData.attempts ?? 0;
    const maxAttempts = issueData.maxAttempts ?? 3;

    const diagnosticText = [
      `# Diagnostic Report for Issue ${issueId}`,
      ``,
      `## Issue Details`,
      `- **Title**: ${issueData.title ?? "Unknown"}`,
      `- **State**: ${state}`,
      `- **Attempts**: ${attempts} / ${maxAttempts}`,
      `- **Last Error**: ${lastError ?? "None"}`,
      `- **Updated At**: ${issueData.updatedAt ?? "Unknown"}`,
      ``,
      `## Plan`,
      plan ? `- **Summary**: ${plan.summary ?? plan.title ?? "No summary"}` : "No plan generated.",
      plan?.steps ? `- **Steps**: ${plan.steps.length} step(s)` : "",
      plan?.estimatedComplexity ? `- **Estimated Complexity**: ${plan.estimatedComplexity}` : "",
      ``,
      `## History`,
      ...(history.length > 0 ? history.slice(-15).map((entry: string) => `- ${entry}`) : ["No history entries."]),
      ``,
      `## Recent Events`,
      ...(events.length > 0 ? (events as any[]).slice(0, 15).map((event: any) => `- [${event.kind ?? "info"}] ${event.at ?? ""}: ${event.message ?? ""}`) : ["No events found."]),
      ``,
      `## Diagnostic Questions`,
      `Based on the information above, please analyze:`,
      `1. What is the root cause of the issue being in "${state}" state?`,
      `2. Is the error recoverable? If so, what steps should be taken?`,
      `3. Does the plan need modification before retrying?`,
      `4. Are there any dependency or configuration issues that need resolution?`,
      `5. What is the recommended next action?`,
    ].filter((line) => line !== undefined).join("\n");

    return {
      description: `Diagnostic prompt for blocked/failed issue ${issueId}.`,
      messages: [{
        role: "user",
        content: { type: "text", text: diagnosticText },
      }],
    };
  }

  if (name === "fifony-weekly-summary") {
    const issues = await getIssues();
    let analytics: Record<string, unknown> = {};
    try { analytics = await apiGet("/api/analytics/tokens"); } catch {}
    const overall = (analytics as any).overall ?? {};
    const byState = issues.reduce<Record<string, number>>((accumulator, issue: any) => {
      const key = issue.state ?? "Unknown";
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});
    const totalIssues = issues.length;
    const completed = byState["Done"] ?? 0;
    const blocked = (byState["Blocked"] ?? 0) + (byState["Failed"] ?? 0);
    const inProgress = (byState["Running"] ?? 0) + (byState["In Review"] ?? 0) + (byState["Queued"] ?? 0);
    const todo = byState["Todo"] ?? 0;
    const planning = byState["Planning"] ?? 0;
    const cancelled = byState["Cancelled"] ?? 0;
    const inputTokens = typeof overall.inputTokens === "number" ? overall.inputTokens : 0;
    const outputTokens = typeof overall.outputTokens === "number" ? overall.outputTokens : 0;
    const totalTokens = typeof overall.totalTokens === "number" ? overall.totalTokens : 0;
    const estimatedCost = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;

    const summaryText = [
      `# Fifony Weekly Progress Summary`,
      ``,
      `## Issue Statistics`,
      `| Status | Count |`,
      `|--------|-------|`,
      `| Total Issues | ${totalIssues} |`,
      `| Completed (Done) | ${completed} |`,
      `| In Progress | ${inProgress} |`,
      `| Todo | ${todo} |`,
      `| Planning | ${planning} |`,
      `| Blocked/Failed | ${blocked} |`,
      `| Cancelled | ${cancelled} |`,
      ``,
      `## Token Usage`,
      `- **Total Tokens**: ${totalTokens.toLocaleString()}`,
      `- **Input Tokens**: ${inputTokens.toLocaleString()}`,
      `- **Output Tokens**: ${outputTokens.toLocaleString()}`,
      `- **Estimated Cost**: $${(Math.round(estimatedCost * 100) / 100).toFixed(2)}`,
      ``,
      `## Analysis Request`,
      `Based on these metrics, please provide:`,
      `1. A brief summary of overall progress this week`,
      `2. Identification of any bottlenecks (blocked/failed issues)`,
      `3. Token usage efficiency assessment`,
      `4. Recommendations for improving throughput`,
      `5. Priority items for next week`,
    ].join("\n");

    return {
      description: "Weekly progress summary prompt for the Fifony workspace.",
      messages: [{
        role: "user",
        content: { type: "text", text: summaryText },
      }],
    };
  }

  if (name === "fifony-refine-plan") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    const concern = typeof args.concern === "string" ? args.concern.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    const issue = await getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const issueData = issue as any;
    const plan = issueData.plan ?? null;

    const steps = plan?.steps ?? [];
    const stepsText = steps.length > 0
      ? steps.map((step: any, index: number) => `${index + 1}. **${step.title ?? step.description ?? "Step"}**\n   ${step.description ?? step.detail ?? ""}`).join("\n")
      : "No steps defined.";

    const refinementText = [
      `# Plan Refinement for Issue ${issueId}`,
      ``,
      `## Issue`,
      `- **Title**: ${issueData.title ?? "Unknown"}`,
      `- **Description**: ${issueData.description ?? "No description"}`,
      ``,
      `## Current Plan`,
      plan ? `- **Summary**: ${plan.summary ?? plan.title ?? "No summary"}` : "No plan exists yet.",
      plan?.estimatedComplexity ? `- **Complexity**: ${plan.estimatedComplexity}` : "",
      ``,
      `### Steps`,
      stepsText,
      ``,
      concern ? `## Specific Concern\n${concern}\n` : "",
      `## Refinement Guidance`,
      `Please review the current plan and provide specific, actionable feedback:`,
      `1. Are the steps correctly ordered and complete?`,
      `2. Are there missing edge cases or error handling steps?`,
      `3. Is the complexity estimate accurate?`,
      `4. Are the file paths and affected areas correct?`,
      `5. Should any steps be split, merged, or removed?`,
      ``,
      `Provide your feedback, and it will be used to refine the plan via \`fifony.refine\`.`,
    ].filter((line) => line !== undefined).join("\n");

    return {
      description: `Plan refinement prompt for issue ${issueId}.`,
      messages: [{
        role: "user",
        content: { type: "text", text: refinementText },
      }],
    };
  }

  if (name === "fifony-code-review") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    const issue = await getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    const issueData = issue as any;

    let diffData: Record<string, unknown> = {};
    try {
      diffData = await apiGet(`/api/diff/${encodeURIComponent(issueId)}`);
    } catch (error) {
      throw new Error(`Cannot fetch diff for issue ${issueId}. Is the runtime running? ${String(error)}`);
    }

    const files = Array.isArray((diffData as any).files) ? (diffData as any).files : [];
    const diff = typeof (diffData as any).diff === "string" ? (diffData as any).diff : "";
    const totalAdditions = typeof (diffData as any).totalAdditions === "number" ? (diffData as any).totalAdditions : 0;
    const totalDeletions = typeof (diffData as any).totalDeletions === "number" ? (diffData as any).totalDeletions : 0;

    if (!diff.trim()) {
      return {
        description: `Code review prompt for issue ${issueId} (no changes).`,
        messages: [{
          role: "user",
          content: { type: "text", text: `# Code Review for ${issueId}\n\nNo code changes found for this issue. The workspace may not have been created yet or no modifications were made.` },
        }],
      };
    }

    const filesTable = files.map((file: any) => `| ${file.path} | ${file.status} | +${file.additions} | -${file.deletions} |`).join("\n");

    const reviewText = [
      `# Code Review for Issue ${issueId}`,
      ``,
      `## Issue Context`,
      `- **Title**: ${issueData.title ?? "Unknown"}`,
      `- **Description**: ${issueData.description ?? "No description"}`,
      `- **State**: ${issueData.state ?? "Unknown"}`,
      ``,
      `## Change Summary`,
      `- **Files Changed**: ${files.length}`,
      `- **Total Additions**: +${totalAdditions}`,
      `- **Total Deletions**: -${totalDeletions}`,
      ``,
      `### Files`,
      `| Path | Status | Additions | Deletions |`,
      `|------|--------|-----------|-----------|`,
      filesTable,
      ``,
      `## Diff`,
      "```diff",
      diff.length > 50000 ? diff.substring(0, 50000) + "\n... (diff truncated at 50KB)" : diff,
      "```",
      ``,
      `## Review Checklist`,
      `Please review the changes and evaluate:`,
      `1. **Correctness**: Do the changes correctly implement what the issue describes?`,
      `2. **Code Quality**: Is the code clean, readable, and follows project conventions?`,
      `3. **Error Handling**: Are edge cases and errors properly handled?`,
      `4. **Security**: Are there any security concerns (hardcoded secrets, SQL injection, XSS)?`,
      `5. **Performance**: Are there any performance concerns or inefficiencies?`,
      `6. **Tests**: Are changes adequately covered by tests?`,
      `7. **Breaking Changes**: Do any changes break backward compatibility?`,
    ].join("\n");

    return {
      description: `Code review prompt for issue ${issueId}.`,
      messages: [{
        role: "user",
        content: { type: "text", text: reviewText },
      }],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
}

function listTools(): Array<Record<string, unknown>> {
  return [
    { name: "fifony.status", description: "Return a compact status summary for the current Fifony workspace.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "fifony.list_issues", description: "List issues from the Fifony durable store.", inputSchema: { type: "object", properties: { state: { type: "string" }, capabilityCategory: { type: "string" }, category: { type: "string" } }, additionalProperties: false } },
    { name: "fifony.create_issue", description: "Create a new issue directly in the Fifony durable store.", inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "number" }, state: { type: "string" }, labels: { type: "array", items: { type: "string" } }, paths: { type: "array", items: { type: "string" } } }, required: ["title"], additionalProperties: false } },
    { name: "fifony.update_issue_state", description: "Update an issue state in the Fifony store and append an event.", inputSchema: { type: "object", properties: { issueId: { type: "string" }, state: { type: "string" }, note: { type: "string" } }, required: ["issueId", "state"], additionalProperties: false } },
    { name: "fifony.plan", description: "Generate an AI plan for an issue. The issue must be in Planning state. Returns the plan summary and step count.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "The issue identifier to plan." }, fast: { type: "boolean", description: "Use fast planning mode (less thorough but quicker)." } }, required: ["issueId"], additionalProperties: false } },
    { name: "fifony.refine", description: "Refine an existing plan with feedback. The issue must already have a plan.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "The issue identifier whose plan to refine." }, feedback: { type: "string", description: "Feedback to guide the plan refinement." } }, required: ["issueId", "feedback"], additionalProperties: false } },
    { name: "fifony.approve", description: "Approve a plan and move the issue to Todo for execution.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "The issue identifier to approve." } }, required: ["issueId"], additionalProperties: false } },
    { name: "fifony.merge", description: "Merge workspace changes back into the project root. Copies new/modified files from the issue workspace to TARGET_ROOT and removes files that were deleted. Skips fifony internal files, node_modules, .git, and dist.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "The issue identifier whose workspace to merge." } }, required: ["issueId"], additionalProperties: false } },
    { name: "fifony.analytics", description: "Get token usage analytics including overall totals, cost estimates, and top issues by token consumption.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "fifony.integration_config", description: "Generate a ready-to-paste MCP client configuration snippet for this Fifony workspace.", inputSchema: { type: "object", properties: { client: { type: "string" } }, additionalProperties: false } },
    { name: "fifony.list_integrations", description: "List discovered local integrations such as agency-agents profiles and impeccable skills.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "fifony.integration_snippet", description: "Generate a workflow or prompt snippet for a discovered integration.", inputSchema: { type: "object", properties: { integration: { type: "string" } }, required: ["integration"], additionalProperties: false } },
    { name: "fifony.resolve_capabilities", description: "Resolve which providers, roles, profiles, and overlays Fifony should use for a task.", inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, labels: { type: "array", items: { type: "string" } }, paths: { type: "array", items: { type: "string" } } }, required: ["title"], additionalProperties: false } },
    { name: "fifony.get_issue", description: "Get full detail of a single issue including plan, history, events, and diff status.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "The issue identifier." } }, required: ["issueId"], additionalProperties: false } },
    { name: "fifony.cancel_issue", description: "Cancel an issue, moving it to Cancelled state.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "The issue identifier to cancel." } }, required: ["issueId"], additionalProperties: false } },
    { name: "fifony.retry_issue", description: "Retry a failed or blocked issue, resetting it to Todo state.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "The issue identifier to retry." } }, required: ["issueId"], additionalProperties: false } },
    { name: "fifony.enhance", description: "AI-enhance an issue title or description. Provide either an issueId to enhance an existing issue, or title+description for standalone enhancement.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "Issue identifier (optional, for existing issues)." }, title: { type: "string", description: "Issue title (for standalone enhancement)." }, description: { type: "string", description: "Issue description (for standalone enhancement)." }, field: { type: "string", enum: ["title", "description"], description: "Which field to enhance." } }, required: ["field"], additionalProperties: false } },
    { name: "fifony.get_diff", description: "Get git diff for an issue's workspace, including per-file summary and full diff text.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "The issue identifier." } }, required: ["issueId"], additionalProperties: false } },
    { name: "fifony.get_live", description: "Get live agent output for a running issue, including log tail, PID, elapsed time, and status.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "The issue identifier." } }, required: ["issueId"], additionalProperties: false } },
    { name: "fifony.get_events", description: "Get event feed, optionally filtered by issue, kind, or limited.", inputSchema: { type: "object", properties: { issueId: { type: "string", description: "Filter events by issue identifier." }, kind: { type: "string", description: "Filter events by kind (info, error, state, manual, progress)." }, limit: { type: "number", description: "Maximum number of events to return (default 50)." } }, additionalProperties: false } },
    { name: "fifony.get_workflow", description: "Get the current pipeline workflow configuration including providers, models, and effort for plan/execute/review stages.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "fifony.set_workflow", description: "Update the pipeline workflow configuration. Each stage (plan, execute, review) needs provider, model, and effort.", inputSchema: { type: "object", properties: { plan: { type: "object", properties: { provider: { type: "string" }, model: { type: "string" }, effort: { type: "string" } }, required: ["provider", "model", "effort"] }, execute: { type: "object", properties: { provider: { type: "string" }, model: { type: "string" }, effort: { type: "string" } }, required: ["provider", "model", "effort"] }, review: { type: "object", properties: { provider: { type: "string" }, model: { type: "string" }, effort: { type: "string" } }, required: ["provider", "model", "effort"] } }, required: ["plan", "execute", "review"], additionalProperties: false } },
    { name: "fifony.scan_project", description: "Scan the target project structure, returning files, directories, and detected technologies.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "fifony.install_agents", description: "Install agents from the Fifony catalog into the target workspace.", inputSchema: { type: "object", properties: { agents: { type: "array", items: { type: "string" }, description: "List of agent names to install." } }, required: ["agents"], additionalProperties: false } },
    { name: "fifony.install_skills", description: "Install skills from the Fifony catalog into the target workspace.", inputSchema: { type: "object", properties: { skills: { type: "array", items: { type: "string" }, description: "List of skill names to install." } }, required: ["skills"], additionalProperties: false } },
  ];
}

function toolText(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }] };
}

async function resolveApiBaseUrl(): Promise<string> {
  const envPort = env.FIFONY_API_PORT;
  if (envPort) return `http://localhost:${envPort}`;

  const runtime = await getRuntimeSnapshot();
  const config = runtime.config as Record<string, unknown> | undefined;
  const port = config?.dashboardPort;
  if (port) return `http://localhost:${port}`;

  // Fallback: try common ports
  for (const candidate of [4000, 3000, 8080]) {
    try {
      const res = await fetch(`http://localhost:${candidate}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return `http://localhost:${candidate}`;
    } catch {}
  }

  throw new Error("Fifony runtime API is not reachable. Start the runtime with --port to enable plan/refine/approve/analytics tools.");
}

async function apiPost(path: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const base = await resolveApiBaseUrl();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok || json.ok === false) {
    throw new Error(typeof json.error === "string" ? json.error : `API request failed: ${res.status}`);
  }
  return json;
}

async function apiGet(path: string): Promise<Record<string, unknown>> {
  const base = await resolveApiBaseUrl();
  const res = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok || json.ok === false) {
    throw new Error(typeof json.error === "string" ? json.error : `API request failed: ${res.status}`);
  }
  return json;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (name === "fifony.status") return toolText(await buildStateSummary());

  if (name === "fifony.list_issues") {
    const stateFilter = typeof args.state === "string" && args.state.trim() ? args.state.trim() : "";
    const capabilityCategory = typeof args.capabilityCategory === "string" && args.capabilityCategory.trim()
      ? args.capabilityCategory.trim()
      : typeof args.category === "string" && args.category.trim() ? args.category.trim() : "";
    return toolText(JSON.stringify(await listIssues({ state: stateFilter || undefined, capabilityCategory: capabilityCategory || undefined }), null, 2));
  }

  if (name === "fifony.create_issue") {
    await initDatabase();
    const { issueResource } = getResources();
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) throw new Error("title is required");

    const explicitId = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "";
    const issueId = explicitId || `LOCAL-${hashInput(`${title}:${nowIso()}`)}`.toUpperCase();
    const description = typeof args.description === "string" ? args.description : "";
    const priority = typeof args.priority === "number" ? args.priority : 2;
    const state = typeof args.state === "string" && args.state.trim() ? args.state.trim() : "Todo";
    const baseLabels = Array.isArray(args.labels) ? args.labels.filter((value): value is string => typeof value === "string") : ["fifony", "mcp"];
    const paths = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === "string") : [];
    const inferredPaths = inferCapabilityPaths({ id: issueId, identifier: issueId, title, description, labels: baseLabels, paths });
    const resolution = resolveTaskCapabilities({ id: issueId, identifier: issueId, title, description, labels: baseLabels, paths });
    const labels = [...new Set([...baseLabels, resolution.category ? `capability:${resolution.category}` : "", ...resolution.overlays.map((overlay) => `overlay:${overlay}`)].filter(Boolean))];

    const record = await issueResource?.insert({
      id: issueId, identifier: issueId, title, description, priority, state, labels, paths, inferredPaths,
      capabilityCategory: resolution.category, capabilityOverlays: resolution.overlays, capabilityRationale: resolution.rationale,
      blockedBy: [], assignedToWorker: false, createdAt: nowIso(), url: `fifony://local/${issueId}`,
      updatedAt: nowIso(), history: [`[${nowIso()}] Issue created via MCP.`], attempts: 0, maxAttempts: 3,
    });

    await appendEvent("info", `Issue ${issueId} created through MCP.`, { title, state, labels, paths, inferredPaths, capabilityCategory: resolution.category }, issueId);
    return toolText(JSON.stringify(record ?? { id: issueId }, null, 2));
  }

  if (name === "fifony.update_issue_state") {
    await initDatabase();
    const { issueResource } = getResources();
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    const state = typeof args.state === "string" ? args.state.trim() : "";
    const note = typeof args.note === "string" ? args.note : "";
    if (!issueId || !state) throw new Error("issueId and state are required");

    const current = await issueResource?.get(issueId);
    if (!current) throw new Error(`Issue not found: ${issueId}`);

    const updated = await issueResource?.update(issueId, { state, updatedAt: nowIso() });
    await appendEvent("info", note || `Issue ${issueId} moved to ${state} through MCP.`, { state }, issueId);
    return toolText(JSON.stringify(updated ?? { id: issueId, state }, null, 2));
  }

  if (name === "fifony.plan") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    const fast = args.fast === true;
    const result = await apiPost(`/api/issues/${encodeURIComponent(issueId)}/plan`, { fast });
    const issue = result.issue as Record<string, unknown> | undefined;
    const plan = issue?.plan as Record<string, unknown> | undefined;
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    return toolText(JSON.stringify({
      issueId,
      state: issue?.state ?? "Planning",
      planSummary: plan?.summary ?? plan?.title ?? "Plan generation started in background.",
      stepCount: steps.length,
      estimatedComplexity: plan?.estimatedComplexity ?? null,
      message: steps.length > 0
        ? `Plan generated with ${steps.length} step(s). Use fifony.approve to start execution or fifony.refine to adjust.`
        : "Plan generation started in background. Poll the issue status to check progress.",
    }, null, 2));
  }

  if (name === "fifony.refine") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    const feedback = typeof args.feedback === "string" ? args.feedback.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    if (!feedback) throw new Error("feedback is required");
    const result = await apiPost(`/api/issues/${encodeURIComponent(issueId)}/plan/refine`, { feedback });
    const issue = result.issue as Record<string, unknown> | undefined;
    const plan = issue?.plan as Record<string, unknown> | undefined;
    const steps = Array.isArray(plan?.steps) ? plan.steps : [];
    return toolText(JSON.stringify({
      issueId,
      planSummary: plan?.summary ?? plan?.title ?? "Plan refinement started in background.",
      stepCount: steps.length,
      estimatedComplexity: plan?.estimatedComplexity ?? null,
      message: "Plan refinement started in background. The plan will be updated via WebSocket when complete.",
    }, null, 2));
  }

  if (name === "fifony.approve") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    const result = await apiPost(`/api/issues/${encodeURIComponent(issueId)}/approve`);
    const issue = result.issue as Record<string, unknown> | undefined;
    return toolText(JSON.stringify({
      issueId,
      state: issue?.state ?? "Todo",
      message: `Plan approved for ${issueId}. Issue moved to Todo and is ready for execution.`,
    }, null, 2));
  }

  if (name === "fifony.merge") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    const result = await apiPost(`/api/issues/${encodeURIComponent(issueId)}/merge`);
    return toolText(JSON.stringify({
      issueId,
      copied: result.copied,
      deleted: result.deleted,
      skipped: result.skipped,
      message: `Merged ${(result.copied as string[])?.length ?? 0} files into project root. ${(result.deleted as string[])?.length ?? 0} files removed.`,
    }, null, 2));
  }

  if (name === "fifony.analytics") {
    const result = await apiGet("/api/analytics/tokens");
    const overall = result.overall as Record<string, unknown> | undefined;
    const topIssues = result.topIssues as Array<Record<string, unknown>> | undefined;
    const byModel = result.byModel as Record<string, Record<string, unknown>> | undefined;

    // Compute cost estimate (rough: $3/M input, $15/M output for Claude-class models)
    const inputTokens = typeof overall?.inputTokens === "number" ? overall.inputTokens : 0;
    const outputTokens = typeof overall?.outputTokens === "number" ? overall.outputTokens : 0;
    const totalTokens = typeof overall?.totalTokens === "number" ? overall.totalTokens : 0;
    const estimatedCost = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;

    return toolText(JSON.stringify({
      overall: { inputTokens, outputTokens, totalTokens },
      estimatedCostUsd: Math.round(estimatedCost * 100) / 100,
      modelBreakdown: byModel ?? {},
      topIssues: (topIssues ?? []).slice(0, 10).map((issue) => ({
        id: issue.id,
        totalTokens: issue.totalTokens,
        inputTokens: issue.inputTokens,
        outputTokens: issue.outputTokens,
      })),
    }, null, 2));
  }

  if (name === "fifony.integration_config") {
    const client = typeof args.client === "string" && args.client.trim() ? args.client.trim() : "client";
    return toolText(JSON.stringify({ client, mcpServers: { fifony: { command: "npx", args: ["fifony", "mcp", "--workspace", WORKSPACE_ROOT, "--persistence", PERSISTENCE_ROOT] } } }, null, 2));
  }

  if (name === "fifony.list_integrations") return toolText(JSON.stringify(discoverIntegrations(WORKSPACE_ROOT), null, 2));

  if (name === "fifony.integration_snippet") {
    const integration = typeof args.integration === "string" ? args.integration : "";
    return toolText(await buildIntegrationSnippet(integration, WORKSPACE_ROOT));
  }

  if (name === "fifony.resolve_capabilities") {
    const title = typeof args.title === "string" ? args.title : "";
    const description = typeof args.description === "string" ? args.description : "";
    const labels = Array.isArray(args.labels) ? args.labels.filter((value): value is string => typeof value === "string") : [];
    const paths = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === "string") : [];
    return toolText(JSON.stringify({ inferredPaths: inferCapabilityPaths({ title, description, labels, paths }), resolution: resolveTaskCapabilities({ title, description, labels, paths }) }, null, 2));
  }

  if (name === "fifony.get_issue") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    const issue = await getIssue(issueId);
    if (!issue) throw new Error(`Issue not found: ${issueId}`);
    // Enrich with diff status and events from API when available
    let diff: Record<string, unknown> | null = null;
    let events: unknown[] = [];
    try { diff = await apiGet(`/api/diff/${encodeURIComponent(issueId)}`); } catch {}
    try {
      const evResult = await apiGet(`/api/events/feed?issueId=${encodeURIComponent(issueId)}`);
      events = Array.isArray((evResult as any).events) ? (evResult as any).events : [];
    } catch {}
    const issueObj = issue as Record<string, unknown>;
    const mergeInfo = issueObj.mergedAt
      ? { mergedAt: issueObj.mergedAt, mergeResult: issueObj.mergeResult, message: `Code merged to project root at ${issueObj.mergedAt}. Available for testing.` }
      : null;
    return toolText(JSON.stringify({
      issue,
      mergeStatus: mergeInfo,
      diffSummary: diff ? { files: (diff as any).files, totalAdditions: (diff as any).totalAdditions, totalDeletions: (diff as any).totalDeletions } : null,
      recentEvents: (events as any[]).slice(0, 20),
    }, null, 2));
  }

  if (name === "fifony.cancel_issue") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    try {
      const result = await apiPost(`/api/issues/${encodeURIComponent(issueId)}/cancel`);
      const issue = result.issue as Record<string, unknown> | undefined;
      return toolText(JSON.stringify({ issueId, state: issue?.state ?? "Cancelled", message: `Issue ${issueId} has been cancelled.` }, null, 2));
    } catch (error) {
      throw new Error(`Failed to cancel issue ${issueId}: ${String(error)}`);
    }
  }

  if (name === "fifony.retry_issue") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    try {
      const result = await apiPost(`/api/issues/${encodeURIComponent(issueId)}/retry`);
      const issue = result.issue as Record<string, unknown> | undefined;
      return toolText(JSON.stringify({ issueId, state: issue?.state ?? "Todo", message: `Issue ${issueId} has been retried and reset to Todo.` }, null, 2));
    } catch (error) {
      throw new Error(`Failed to retry issue ${issueId}: ${String(error)}`);
    }
  }

  if (name === "fifony.enhance") {
    const field = typeof args.field === "string" ? args.field.trim() : "";
    if (field !== "title" && field !== "description") throw new Error('field must be "title" or "description"');
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    let title = typeof args.title === "string" ? args.title.trim() : "";
    let description = typeof args.description === "string" ? args.description.trim() : "";
    // If issueId given, fetch issue data to fill in title/description
    if (issueId && (!title || !description)) {
      const issue = await getIssue(issueId);
      if (!issue) throw new Error(`Issue not found: ${issueId}`);
      if (!title) title = (issue as any).title ?? "";
      if (!description) description = (issue as any).description ?? "";
    }
    try {
      const result = await apiPost("/api/issues/enhance", { field, title, description });
      return toolText(JSON.stringify({ field: (result as any).field, value: (result as any).value, provider: (result as any).provider, issueId: issueId || undefined }, null, 2));
    } catch (error) {
      throw new Error(`Failed to enhance ${field}: ${String(error)}`);
    }
  }

  if (name === "fifony.get_diff") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    try {
      const result = await apiGet(`/api/diff/${encodeURIComponent(issueId)}`);
      return toolText(JSON.stringify(result, null, 2));
    } catch (error) {
      throw new Error(`Failed to get diff for ${issueId}: ${String(error)}`);
    }
  }

  if (name === "fifony.get_live") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    if (!issueId) throw new Error("issueId is required");
    try {
      const result = await apiGet(`/api/live/${encodeURIComponent(issueId)}`);
      return toolText(JSON.stringify(result, null, 2));
    } catch (error) {
      throw new Error(`Failed to get live output for ${issueId}: ${String(error)}`);
    }
  }

  if (name === "fifony.get_events") {
    const issueId = typeof args.issueId === "string" ? args.issueId.trim() : "";
    const kind = typeof args.kind === "string" ? args.kind.trim() : "";
    const limit = typeof args.limit === "number" ? args.limit : 50;
    const params = new URLSearchParams();
    if (issueId) params.set("issueId", issueId);
    if (kind) params.set("kind", kind);
    const query = params.toString();
    try {
      const result = await apiGet(`/api/events/feed${query ? `?${query}` : ""}`);
      const events = Array.isArray((result as any).events) ? (result as any).events.slice(0, limit) : [];
      return toolText(JSON.stringify({ events, count: events.length }, null, 2));
    } catch (error) {
      // Fallback to local events
      const events = await listEvents({ limit: limit });
      const filtered = events.filter((event: any) => {
        if (issueId && event.issueId !== issueId) return false;
        if (kind && event.kind !== kind) return false;
        return true;
      }).slice(0, limit);
      return toolText(JSON.stringify({ events: filtered, count: filtered.length }, null, 2));
    }
  }

  if (name === "fifony.get_workflow") {
    try {
      const result = await apiGet("/api/config/workflow");
      return toolText(JSON.stringify(result, null, 2));
    } catch (error) {
      throw new Error(`Failed to get workflow config: ${String(error)}`);
    }
  }

  if (name === "fifony.set_workflow") {
    const plan = args.plan as Record<string, unknown> | undefined;
    const execute = args.execute as Record<string, unknown> | undefined;
    const review = args.review as Record<string, unknown> | undefined;
    if (!plan || !execute || !review) throw new Error("plan, execute, and review are all required");
    try {
      const result = await apiPost("/api/config/workflow", { workflow: { plan, execute, review } });
      return toolText(JSON.stringify({ message: "Workflow configuration updated successfully.", workflow: (result as any).workflow }, null, 2));
    } catch (error) {
      throw new Error(`Failed to set workflow config: ${String(error)}`);
    }
  }

  if (name === "fifony.scan_project") {
    try {
      const result = await apiGet("/api/scan/project");
      return toolText(JSON.stringify(result, null, 2));
    } catch (error) {
      throw new Error(`Failed to scan project: ${String(error)}`);
    }
  }

  if (name === "fifony.install_agents") {
    const agents = Array.isArray(args.agents) ? args.agents.filter((value): value is string => typeof value === "string") : [];
    if (agents.length === 0) throw new Error("At least one agent name is required");
    try {
      const result = await apiPost("/api/install/agents", { agents });
      return toolText(JSON.stringify(result, null, 2));
    } catch (error) {
      throw new Error(`Failed to install agents: ${String(error)}`);
    }
  }

  if (name === "fifony.install_skills") {
    const skills = Array.isArray(args.skills) ? args.skills.filter((value): value is string => typeof value === "string") : [];
    if (skills.length === 0) throw new Error("At least one skill name is required");
    try {
      const result = await apiPost("/api/install/skills", { skills });
      return toolText(JSON.stringify(result, null, 2));
    } catch (error) {
      throw new Error(`Failed to install skills: ${String(error)}`);
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── JSON-RPC transport ───────────────────────────────────────────────────────

function sendMessage(message: JsonRpcResponse): void {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  stdout.write(payload);
}

function sendResult(id: JsonRpcId, result: unknown): void {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message, data } });
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  const id = request.id ?? null;
  try {
    switch (request.method) {
      case "initialize":
        sendResult(id, { protocolVersion: "2024-11-05", capabilities: { resources: {}, tools: {}, prompts: {} }, serverInfo: { name: "fifony", version: "0.1.0" } });
        return;
      case "notifications/initialized": return;
      case "ping": sendResult(id, {}); return;
      case "resources/list": sendResult(id, { resources: await listResourcesMcp() }); return;
      case "resources/read": sendResult(id, { contents: await readResource(String(request.params?.uri ?? "")) }); return;
      case "tools/list": sendResult(id, { tools: listTools() }); return;
      case "tools/call": sendResult(id, await callTool(String(request.params?.name ?? ""), (request.params?.arguments as Record<string, unknown> | undefined) ?? {})); return;
      case "prompts/list": sendResult(id, { prompts: listPrompts() }); return;
      case "prompts/get": sendResult(id, await getPrompt(String(request.params?.name ?? ""), (request.params?.arguments as Record<string, unknown> | undefined) ?? {})); return;
      default: sendError(id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    sendError(id, -32000, String(error));
  }
}

function processIncomingBuffer(): void {
  while (true) {
    const separatorIndex = incomingBuffer.indexOf("\r\n\r\n");
    if (separatorIndex === -1) return;

    const headerText = incomingBuffer.subarray(0, separatorIndex).toString("utf8");
    const contentLengthHeader = headerText.split("\r\n").find((line) => line.toLowerCase().startsWith("content-length:"));
    if (!contentLengthHeader) { incomingBuffer = Buffer.alloc(0); return; }

    const contentLength = Number.parseInt(contentLengthHeader.split(":")[1]?.trim() ?? "0", 10);
    const messageStart = separatorIndex + 4;
    const messageEnd = messageStart + contentLength;
    if (incomingBuffer.length < messageEnd) return;

    const messageBody = incomingBuffer.subarray(messageStart, messageEnd).toString("utf8");
    incomingBuffer = incomingBuffer.subarray(messageEnd);

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(messageBody) as JsonRpcRequest;
    } catch (error) {
      sendError(null, -32700, `Invalid JSON: ${String(error)}`);
      continue;
    }

    void handleRequest(request);
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  debugBoot("mcp:bootstrap:start");
  await initDatabase();
  debugBoot("mcp:bootstrap:database-ready");
  await appendEvent("info", "Fifony MCP server started.", { workspaceRoot: WORKSPACE_ROOT, persistenceRoot: PERSISTENCE_ROOT });

  stdin.on("data", (chunk: Buffer) => {
    incomingBuffer = Buffer.concat([incomingBuffer, chunk]);
    processIncomingBuffer();
  });

  stdin.resume();
  debugBoot("mcp:bootstrap:stdin-ready");
}

bootstrap().catch((error) => {
  sendError(null, -32001, `Failed to start Fifony MCP server: ${String(error)}`);
  process.exit(1);
});

process.on("SIGINT", async () => {
  const db = getDatabase();
  if (db) await db.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  const db = getDatabase();
  if (db) await db.disconnect();
  process.exit(0);
});
