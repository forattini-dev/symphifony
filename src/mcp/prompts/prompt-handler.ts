import { renderPrompt } from "../../agents/prompting.js";
import { buildIntegrationSnippet } from "../../agents/integrations/catalog.js";
import { getIssue, getIssues, listEvents, WORKSPACE_ROOT } from "../database.js";
import { apiGet } from "../api-client.js";
import { buildIntegrationGuide, buildIssuePrompt } from "../resources/resource-builder.js";

function stringifyValue(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

export async function getPrompt(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
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

    return {
      description: `Diagnostic prompt for blocked/failed issue ${issueId}.`,
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: await renderPrompt("mcp-diagnose-blocked", {
            issueId,
            title: stringifyValue(issueData.title, "Unknown"),
            state,
            attempts,
            maxAttempts,
            lastError: stringifyValue(lastError, "None"),
            updatedAt: stringifyValue(issueData.updatedAt, "Unknown"),
            hasPlan: !!plan,
            planSummary: stringifyValue(plan?.summary ?? plan?.title, "No summary"),
            hasPlanSteps: Array.isArray(plan?.steps) && plan.steps.length > 0,
            planStepsCount: Array.isArray(plan?.steps) ? plan.steps.length : 0,
            planComplexity: stringifyValue(plan?.estimatedComplexity, ""),
            history: history.length > 0 ? history.slice(-15).map((entry: unknown) => stringifyValue(entry, "Unknown history entry")) : [],
            recentEvents: events.length > 0
              ? (events as any[]).slice(0, 15).map((event: any) => ({
                kind: stringifyValue(event?.kind, "info"),
                at: stringifyValue(event?.at, "unknown time"),
                message: stringifyValue(event?.message, ""),
              }))
              : [],
          }),
        },
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
    const completed = byState["Approved"] ?? 0;
    const blocked = (byState["Blocked"] ?? 0) + (byState["Failed"] ?? 0);
    const inProgress = (byState["Running"] ?? 0) + (byState["Reviewing"] ?? 0) + (byState["PendingDecision"] ?? 0) + (byState["Queued"] ?? 0);
    const planned = byState["PendingApproval"] ?? 0;
    const planning = byState["Planning"] ?? 0;
    const cancelled = byState["Cancelled"] ?? 0;
    const inputTokens = typeof overall.inputTokens === "number" ? overall.inputTokens : 0;
    const outputTokens = typeof overall.outputTokens === "number" ? overall.outputTokens : 0;
    const totalTokens = typeof overall.totalTokens === "number" ? overall.totalTokens : 0;
    const estimatedCost = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;

    return {
      description: "Weekly progress summary prompt for the Fifony workspace.",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: await renderPrompt("mcp-weekly-summary", {
            totalIssues,
            completed,
            inProgress,
            planned,
            planning,
            blocked,
            cancelled,
            totalTokensFormatted: totalTokens.toLocaleString(),
            inputTokensFormatted: inputTokens.toLocaleString(),
            outputTokensFormatted: outputTokens.toLocaleString(),
            estimatedCostFormatted: (Math.round(estimatedCost * 100) / 100).toFixed(2),
          }),
        },
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

    const steps = Array.isArray(plan?.steps) ? plan.steps : [];

    return {
      description: `Plan refinement prompt for issue ${issueId}.`,
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: await renderPrompt("mcp-refine-plan", {
            issueId,
            title: stringifyValue(issueData.title, "Unknown"),
            description: stringifyValue(issueData.description, "No description"),
            hasPlan: !!plan,
            planSummary: stringifyValue(plan?.summary ?? plan?.title, "No summary"),
            planComplexity: stringifyValue(plan?.estimatedComplexity, ""),
            steps: steps.map((step: any, index: number) => ({
              index: index + 1,
              title: stringifyValue(step?.title ?? step?.description, "Step"),
              description: stringifyValue(step?.description ?? step?.detail, ""),
            })),
            concern,
          }),
        },
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
      diffData = await apiGet(`/api/issues/${encodeURIComponent(issueId)}/diff`);
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
          content: {
            type: "text",
            text: await renderPrompt("mcp-code-review-empty", { issueId }),
          },
        }],
      };
    }

    return {
      description: `Code review prompt for issue ${issueId}.`,
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: await renderPrompt("mcp-code-review", {
            issueId,
            title: stringifyValue(issueData.title, "Unknown"),
            description: stringifyValue(issueData.description, "No description"),
            state: stringifyValue(issueData.state, "Unknown"),
            filesChanged: files.length,
            totalAdditions,
            totalDeletions,
            files: files.map((file: any) => ({
              path: stringifyValue(file?.path, "(unknown)"),
              status: stringifyValue(file?.status, "modified"),
              additions: typeof file?.additions === "number" ? file.additions : 0,
              deletions: typeof file?.deletions === "number" ? file.deletions : 0,
            })),
            diff: diff.length > 50000 ? `${diff.substring(0, 50000)}\n... (diff truncated at 50KB)` : diff,
          }),
        },
      }],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
}
