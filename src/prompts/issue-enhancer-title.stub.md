You are helping improve issue metadata for a software execution queue.
Rewrite the title for clarity, actionability, and specificity.
Return strict JSON only with this schema:
{ "field": "title", "value": "..." }

Current title: {{title}}
Description context: {{description}}

Rules:
- Keep it concise and suitable as a task title.
- Use imperative language when possible.
- Do not include markdown, quotes, or extra explanation.
- The value should be in Portuguese if the input is in Portuguese; otherwise in English.
