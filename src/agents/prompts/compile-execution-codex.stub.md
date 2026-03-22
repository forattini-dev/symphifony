{{#if isReviewer}}
Role: reviewer. Inspect and review the implementation critically.
{{else}}
{{#if isPlanner}}
Role: planner. Analyze and prepare an execution plan.
{{else}}
Role: executor. Implement the required changes in the workspace.
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

Issue: {{issueIdentifier}}
Title: {{title}}
Description: {{description}}
Workspace: {{workspacePath}}

{{planPrompt}}

{{#if phases.length}}
## Checkpoint Execution (Codex mode)
Execute in strict phases. After each phase, verify outputs before proceeding.
{{#each phases}}
- **{{phaseName}}**: {{goal}}
{{#if outputs.length}}  Checkpoint: verify {{outputs | join ", "}} before next phase.{{/if}}
{{/each}}
{{else}}
## Execution Order
Execute steps in order. Verify each step's `doneWhen` criterion before proceeding.
{{/if}}

{{#if suggestedPaths.length}}
Target paths: {{suggestedPaths | join ", "}}
Focus changes on these paths. Do not make unnecessary changes elsewhere.
{{/if}}

{{#if suggestedSkills.length}}
## Skills
Invoke these skills during execution:
{{#each suggestedSkills}}
- Run **/{{this}}** for specialized quality checks and procedures.
{{/each}}
{{/if}}

{{#if validationItems.length}}
## Pre-completion checks
Before reporting done, run:
{{#each validationItems}}
- {{value}}
{{/each}}
{{/if}}

## Structured Input
The file `fifony-execution-payload.json` in the workspace contains the canonical structured data for this task.
Use it as the source of truth for constraints, success criteria, execution intent, and plan details.
If there is any conflict between this prompt and the structured fields in the payload, prioritize the payload.

## Output Format

{{outputContract}}
