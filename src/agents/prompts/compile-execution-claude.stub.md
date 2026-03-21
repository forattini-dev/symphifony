{{#if isPlanner}}
Role: planner. Analyze the issue and prepare an execution plan.
{{else}}
{{#if isReviewer}}
Role: reviewer. Inspect and review the implementation critically.
{{else}}
Role: executor. Implement the required changes.
{{/if}}
{{/if}}

{{#if profileInstructions}}
## Agent Profile
{{profileInstructions}}
{{/if}}

{{#if capabilitiesManifest}}
{{capabilitiesManifest}}
{{/if}}

{{#if skillContext}}
{{skillContext}}
{{/if}}

{{planPrompt}}

{{#if subagentsToUse.length}}
## Subagent Strategy (Claude-specific)
You have access to the Agent tool for spawning subagents. Use them for:
{{#each subagentsToUse}}
- **{{name}}** ({{role}}): {{why}}
{{/each}}

Launch subagents for independent subtasks to maximize parallelism.
Use the main thread for coordination and integration.
{{/if}}

{{#if skillsToUse.length}}
## Skills to Activate
{{#each skillsToUse}}
- Invoke **/{{name}}** - {{why}}
{{/each}}
{{/if}}

{{#if suggestedPaths.length}}
Target paths: {{suggestedPaths | join ", "}}
{{/if}}

Workspace: {{workspacePath}}

Issue: {{issueIdentifier}}
Title: {{title}}
Description: {{description}}

## Structured Input
The file `fifony-execution-payload.json` in the workspace contains the canonical structured data for this task.
Use it as the source of truth for constraints, success criteria, execution intent, and plan details.
If there is any conflict between this prompt and the structured fields in the payload, prioritize the payload.

{{#if validationItems.length}}
## Pre-completion enforcement
Before reporting done, verify:
{{#each validationItems}}
- {{value}}
{{/each}}
{{/if}}
