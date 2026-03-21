import { renderPrompt } from "../../agents/prompting.js";
import { buildIntegrationSnippet } from "../../agents/integrations/catalog.js";
import { resolveTaskCapabilities } from "../../routing/capability-resolver.js";
import { getIssue, getIssues, listEvents, WORKSPACE_ROOT } from "../database.js";
import { apiGet, apiPost } from "../api-client.js";
import { buildIntegrationGuide, buildIssuePrompt } from "../resources/resource-builder.js";

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

    const summaryText = [
      `# Fifony Weekly Progress Summary`,
      ``,
      `## Issue Statistics`,
      `| Status | Count |`,
      `|--------|-------|`,
      `| Total Issues | ${totalIssues} |`,
      `| Completed (Done) | ${completed} |`,
      `| In Progress | ${inProgress} |`,
      `| Planned | ${planned} |`,
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
