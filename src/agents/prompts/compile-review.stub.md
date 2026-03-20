Review the work done for {{issueIdentifier}}.

Title: {{title}}
Description: {{description}}
Workspace: {{workspacePath}}

{{#if planPrompt}}
# Original Execution Plan

{{planPrompt}}
{{/if}}

{{#if successCriteria.length}}
# Success Criteria (evaluate against these)
{{#each successCriteria}}
- [ ] {{value}}
{{/each}}
{{/if}}

{{#if deliverables.length}}
# Expected Deliverables
{{#each deliverables}}
- [ ] {{value}}
{{/each}}
{{/if}}

{{#if diffSummary}}
# Changes Made (diff summary)
```
{{diffSummary}}
```
{{/if}}

# Structured Context
If `fifony-execution-payload.json` exists in the workspace, read it for the canonical structured task data.
Use the `successCriteria`, `constraints`, and `deliverables` fields as your evaluation checklist.

# Review Instructions

1. Verify each success criterion from the plan is met.
2. Check that all expected deliverables are present.
3. Review the diff for correctness, security issues, and code quality.
4. Verify validation checks pass (run commands if specified in the plan).
5. Check for unintended side effects or regressions.

If the work is acceptable, emit FIFONY_STATUS=done.
If rework is needed, emit FIFONY_STATUS=continue and provide actionable feedback in nextPrompt.
If the work is fundamentally broken, emit FIFONY_STATUS=blocked.
