You are helping improve issue metadata for a software execution queue.
Rewrite the title for clarity, actionability, and specificity.

Issue type: {{issueType}}
Current title: {{title}}
Description context: {{description}}
{{#if images}}
Visual evidence (attached screenshots for context):
{{#each images}}
- {{this}}
{{/each}}
{{/if}}

Rules:
- Keep it concise and suitable as a task title.
- Use imperative language when possible.
- If the issue type is "bug", start with "fix: ". If "feature", start with "feat: ". If "refactor", start with "refactor: ". If "docs", start with "docs: ". If "chore", start with "chore: ". For "blank", use no prefix.
- Do not include markdown, quotes, or extra explanation.
- The value should be in Portuguese if the input is in Portuguese; otherwise in English.

Return a single JSON code block as the LAST thing in your output:
```json
{ "field": "title", "value": "<REPLACE_WITH_ACTUAL_TITLE>" }
```
