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

  for (const issue of issues.slice(0, 100)) {
    resources.push({ uri: `fifony://issue/${encodeURIComponent(issue.id)}`, name: `Issue ${issue.id}`, description: issue.title, mimeType: "application/json" });
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

  if (uri.startsWith("fifony://issue/")) {
    const issueId = decodeURIComponent(uri.substring("fifony://issue/".length));
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

  throw new Error(`Unknown prompt: ${name}`);
}

function listTools(): Array<Record<string, unknown>> {
  return [
    { name: "fifony.status", description: "Return a compact status summary for the current Fifony workspace.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "fifony.list_issues", description: "List issues from the Fifony durable store.", inputSchema: { type: "object", properties: { state: { type: "string" }, capabilityCategory: { type: "string" }, category: { type: "string" } }, additionalProperties: false } },
    { name: "fifony.create_issue", description: "Create a new issue directly in the Fifony durable store.", inputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "number" }, state: { type: "string" }, labels: { type: "array", items: { type: "string" } }, paths: { type: "array", items: { type: "string" } } }, required: ["title"], additionalProperties: false } },
    { name: "fifony.update_issue_state", description: "Update an issue state in the Fifony store and append an event.", inputSchema: { type: "object", properties: { issueId: { type: "string" }, state: { type: "string" }, note: { type: "string" } }, required: ["issueId", "state"], additionalProperties: false } },
    { name: "fifony.integration_config", description: "Generate a ready-to-paste MCP client configuration snippet for this Fifony workspace.", inputSchema: { type: "object", properties: { client: { type: "string" } }, additionalProperties: false } },
    { name: "fifony.list_integrations", description: "List discovered local integrations such as agency-agents profiles and impeccable skills.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "fifony.integration_snippet", description: "Generate a workflow or prompt snippet for a discovered integration.", inputSchema: { type: "object", properties: { integration: { type: "string" } }, required: ["integration"], additionalProperties: false } },
    { name: "fifony.resolve_capabilities", description: "Resolve which providers, roles, profiles, and overlays Fifony should use for a task.", inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, labels: { type: "array", items: { type: "string" } }, paths: { type: "array", items: { type: "string" } } }, required: ["title"], additionalProperties: false } },
  ];
}

function toolText(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }] };
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
