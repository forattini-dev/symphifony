import { discoverIntegrations } from "../../agents/integrations/catalog.js";
import { inferCapabilityPaths, resolveTaskCapabilities } from "../../routing/capability-resolver.js";
import {
  getIssues,
  getIssue,
  listEvents,
  safeRead,
  WORKSPACE_ROOT,
} from "../database.js";
import { apiGet } from "../api-client.js";
import {
  buildIntegrationGuide,
  buildStateSummary,
  README_PATH,
  FIFONY_GUIDE_PATH,
} from "./resource-builder.js";

export async function listResourcesMcp(): Promise<Array<Record<string, unknown>>> {
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

export async function readResource(uri: string): Promise<Array<Record<string, unknown>>> {
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
