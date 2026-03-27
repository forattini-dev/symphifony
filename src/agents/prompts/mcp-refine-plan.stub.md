# Plan Refinement for Issue {{issueId}}

## Issue
- **Title**: {{title}}
- **Description**: {{description}}

## Current Plan
{{#if hasPlan}}
- **Summary**: {{planSummary}}
{{#if planComplexity}}
- **Complexity**: {{planComplexity}}
{{/if}}
{{else}}
No plan exists yet.
{{/if}}

### Steps
{{#if steps.length}}
{{#each steps}}
{{index}}. **{{title}}**
   {{description}}
{{/each}}
{{else}}
No steps defined.
{{/if}}

{{#if concern}}
## Specific Concern
{{concern}}
{{/if}}

## Refinement Guidance
Please review the current plan and provide specific, actionable feedback:
1. Are the steps correctly ordered and complete?
2. Are there missing edge cases or error handling steps?
3. Is the complexity estimate accurate?
4. Are the file paths and affected areas correct?
5. Should any steps be split, merged, or removed?

Provide your feedback, and it will be used to refine the plan via `fifony.refine`.
