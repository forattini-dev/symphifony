import { createHash } from "node:crypto";
import { discoverIntegrations, buildIntegrationSnippet } from "../../agents/integrations/catalog.js";
import { inferCapabilityPaths, resolveTaskCapabilities } from "../../routing/capability-resolver.js";
import {
  initDatabase,
  getResources,
  getIssue,
  listIssues,
  listEvents,
  appendEvent,
  nowIso,
  WORKSPACE_ROOT,
  PERSISTENCE_ROOT,
} from "../database.js";
import { apiGet, apiPost } from "../api-client.js";
import { buildStateSummary } from "../resources/resource-builder.js";
import { parseIssueState } from "../../concerns/helpers.js";

function hashInput(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

export function toolText(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }] };
}

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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
    const state = parseIssueState(args.state) ?? "Planning";
    const baseLabels = Array.isArray(args.labels) ? args.labels.filter((value): value is string => typeof value === "string") : ["fifony", "mcp"];
    const paths = Array.isArray(args.paths) ? args.paths.filter((value): value is string => typeof value === "string") : [];
    const inferredPaths = inferCapabilityPaths({ id: issueId, identifier: issueId, title, description, labels: baseLabels, paths });
    const resolution = resolveTaskCapabilities({ id: issueId, identifier: issueId, title, description, labels: baseLabels, paths });
    const labels = [...new Set([...baseLabels, resolution.category ? `capability:${resolution.category}` : "", ...resolution.overlays.map((overlay) => `overlay:${overlay}`)].filter(Boolean))];

    const record = await issueResource?.insert({
      id: issueId, identifier: issueId, title, description, state, labels, paths, inferredPaths,
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
    const state = parseIssueState(args.state);
    const note = typeof args.note === "string" ? args.note : "";
    if (!issueId || !state) throw new Error("issueId and a valid canonical state are required");

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
      state: issue?.state ?? "PendingApproval",
      message: `Plan approved for ${issueId}. Issue moved to PendingApproval and is ready for execution.`,
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
      topIssues: (topIssues ?? []).slice(0, 10).map((issue) => ({ id: issue.id, totalTokens: issue.totalTokens, inputTokens: issue.inputTokens, outputTokens: issue.outputTokens })),
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
    let diff: Record<string, unknown> | null = null;
    let events: unknown[] = [];
    try { diff = await apiGet(`/api/diff/${encodeURIComponent(issueId)}`); } catch {}
    try { const evResult = await apiGet(`/api/events/feed?issueId=${encodeURIComponent(issueId)}`); events = Array.isArray((evResult as any).events) ? (evResult as any).events : []; } catch {}
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
      return toolText(JSON.stringify({ issueId, state: issue?.state ?? "PendingApproval", message: `Issue ${issueId} has been retried.` }, null, 2));
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
