You are resolving git merge conflicts in a software project.

## Context

Issue: {{issueIdentifier}} — {{title}}
{{#if description}}
Description: {{description}}
{{/if}}
Merging branch `{{featureBranch}}` into `{{baseBranch}}`.

## Conflicting Files

The following files have conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) that you must resolve:

{{#each conflictFiles}}
- {{this}}
{{/each}}

## Instructions

1. Read each conflicting file and understand the intent of BOTH sides.
2. Resolve the conflict markers by choosing the correct combination of changes. Prefer keeping both sides' intent when possible.
3. After resolving, stage each file with `git add <file>`.
4. Do NOT commit — the merge commit will be created automatically after you finish.
5. Do NOT modify files that are not in the conflict list.
6. Verify there are no remaining conflict markers (`<<<<<<<`) in any resolved file.
