# Diagnostic Report for Issue {{issueId}}

## Issue Details
- **Title**: {{title}}
- **State**: {{state}}
- **Attempts**: {{attempts}} / {{maxAttempts}}
- **Last Error**: {{lastError}}
- **Updated At**: {{updatedAt}}

## Plan
{{#if hasPlan}}
- **Summary**: {{planSummary}}
{{#if hasPlanSteps}}
- **Steps**: {{planStepsCount}} step(s)
{{/if}}
{{#if planComplexity}}
- **Estimated Complexity**: {{planComplexity}}
{{/if}}
{{else}}
No plan generated.
{{/if}}

## History
{{#if history.length}}
{{#each history}}
- {{this}}
{{/each}}
{{else}}
No history entries.
{{/if}}

## Recent Events
{{#if recentEvents.length}}
{{#each recentEvents}}
- [{{kind}}] {{at}}: {{message}}
{{/each}}
{{else}}
No events found.
{{/if}}

## Diagnostic Questions
Based on the information above, please analyze:
1. What is the root cause of the issue being in "{{state}}" state?
2. Is the error recoverable? If so, what steps should be taken?
3. Does the plan need modification before retrying?
4. Are there any dependency or configuration issues that need resolution?
5. What is the recommended next action?
