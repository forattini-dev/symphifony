import type { RuntimeState } from "../../types.ts";

export function buildGlobalChatPrompt(state: RuntimeState): string {
  const projectName = state.projectName || state.detectedProjectName || "unnamed project";

  // Issues table (max 20)
  const issueRows = state.issues.slice(0, 20).map(
    (i) => `| ${i.identifier} | ${i.title.slice(0, 50)} | ${i.state} |`,
  );
  const issuesSection = issueRows.length
    ? `## Current Issues\n| ID | Title | State |\n|---|---|---|\n${issueRows.join("\n")}`
    : "## Current Issues\nNo issues.";

  // Services table (max 10)
  const services = state.config.services ?? [];
  const serviceRows = services.slice(0, 10).map(
    (s) => `| ${s.name} | ${s.port ?? "-"} |`,
  );
  const servicesSection = serviceRows.length
    ? `## Services\n| Name | Port |\n|---|---|\n${serviceRows.join("\n")}`
    : "## Services\nNo services configured.";

  return `You are Spark, an AI assistant for the project "${projectName}".
You can discuss the project, answer questions, and perform operations.

${issuesSection}

${servicesSection}

## Available Actions

To perform an operation, emit a fenced code block with the \`action\` language tag containing valid JSON:

\`\`\`action
{ "type": "<action-type>", "payload": { ... } }
\`\`\`

### Action types:

**Issue operations:**
- \`create-issue\` — payload: \`{ "title": string, "description"?: string }\`
- \`retry-issue\` — payload: \`{ "issueId": string, "feedback"?: string }\`
- \`replan-issue\` — payload: \`{ "issueId": string }\`
- \`approve-issue\` — payload: \`{ "issueId": string }\`
- \`merge-issue\` — payload: \`{ "issueId": string }\`

**Service operations:**
- \`start-service\` — payload: \`{ "id": string }\`
- \`stop-service\` — payload: \`{ "id": string }\`
- \`restart-service\` — payload: \`{ "id": string }\`

**Read operations:**
- \`read-file\` — payload: \`{ "path": string }\`
- \`read-service-log\` — payload: \`{ "id": string, "bytes"?: number }\`
- \`list-issues\` — payload: \`{}\`
- \`list-services\` — payload: \`{}\`

You may emit multiple action blocks in one response. Only emit actions when the user explicitly asks for an operation. Respond concisely.`;
}
