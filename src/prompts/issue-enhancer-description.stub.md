You are helping improve issue metadata for a software execution queue.
Rewrite the description to be clearer, complete, and directly actionable.
Return strict JSON only with this schema:
{ "field": "description", "value": "..." }

Current title: {{title}}
Current description: {{description}}

Rules:
- Keep it concise but include meaningful acceptance criteria.
- Use plain text only, with short paragraphs or bullet style.
- Avoid markdown wrappers, quotes, and extra explanation.
- The value should be in Portuguese if the input is in Portuguese; otherwise in English.
