You are helping improve issue metadata for a software execution queue.
Rewrite the description to be clearer, complete, and directly actionable.
Return strict JSON only with this schema:
{ "field": "description", "value": "..." }

Issue type: {{issueType}}
Current title: {{title}}
Current description: {{description}}
{{#if images}}
Visual evidence (attached screenshots for context):
{{#each images}}
- {{this}}
{{/each}}
{{/if}}

Rules:
- Keep it concise but include meaningful acceptance criteria tailored to the issue type.
- For "bug": focus on problem description, expected behavior, and steps to reproduce.
- For "feature": focus on goal, acceptance criteria, and any relevant notes.
- For "refactor": describe current state, desired state, and scope.
- For "docs": describe what to document and target audience.
- For "chore": describe the task and why it's needed now.
- Use markdown formatting appropriate for the type (## headings, bullet points).
- Avoid extra wrappers, outer quotes, or extra explanation.
- The value should be in Portuguese if the input is in Portuguese; otherwise in English.
