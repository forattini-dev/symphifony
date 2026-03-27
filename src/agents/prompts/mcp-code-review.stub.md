# Code Review for Issue {{issueId}}

## Issue Context
- **Title**: {{title}}
- **Description**: {{description}}
- **State**: {{state}}

## Change Summary
- **Files Changed**: {{filesChanged}}
- **Total Additions**: +{{totalAdditions}}
- **Total Deletions**: -{{totalDeletions}}

### Files
| Path | Status | Additions | Deletions |
|------|--------|-----------|-----------|
{{#each files}}
| {{path}} | {{status}} | +{{additions}} | -{{deletions}} |
{{/each}}

## Diff
```diff
{{diff}}
```

## Review Checklist
Please review the changes and evaluate:
1. **Correctness**: Do the changes correctly implement what the issue describes?
2. **Code Quality**: Is the code clean, readable, and follows project conventions?
3. **Error Handling**: Are edge cases and errors properly handled?
4. **Security**: Are there any security concerns (hardcoded secrets, SQL injection, XSS)?
5. **Performance**: Are there any performance concerns or inefficiencies?
6. **Tests**: Are changes adequately covered by tests?
7. **Breaking Changes**: Do any changes break backward compatibility?
