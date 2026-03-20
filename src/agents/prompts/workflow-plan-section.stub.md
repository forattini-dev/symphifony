## Execution Plan

Complexity: {{estimatedComplexity}}
Summary: {{summary}}

Steps:
{{#each steps}}
{{step}}. {{action}}{{#if files.length}} (files: {{files | join ", "}}){{/if}}{{#if details}} - {{details}}{{/if}}
{{/each}}

Follow this plan. Complete each step in order.
