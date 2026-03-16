# PR Review Skill

When reviewing pull requests, follow this structured methodology:

## Review Checklist

### 1. Context (before reading code)
- Read the PR description and linked issues
- Understand the goal and acceptance criteria
- Check if the scope matches the stated goal

### 2. Architecture
- Does the change fit the existing architecture?
- Are new patterns introduced? Are they justified?
- Is the code in the right module/service/layer?

### 3. Correctness
- Does the code handle edge cases?
- Are error states handled properly?
- Are there race conditions or concurrency issues?
- Is input validated at the boundary?

### 4. Security
- Is user input sanitized?
- Are there injection vulnerabilities (SQL, XSS, command)?
- Are secrets handled properly?
- Are permissions checked correctly?

### 5. Testing
- Are tests included for new behavior?
- Do tests cover happy path and error cases?
- Are tests testing behavior, not implementation?

### 6. Maintainability
- Is the code readable without comments?
- Are names descriptive and consistent?
- Is there unnecessary complexity?

## Feedback Format

- **Blocker**: Must be fixed before merge (prefix with `[blocker]`)
- **Suggestion**: Improvement that should be considered (prefix with `[suggestion]`)
- **Nit**: Style or minor preference (prefix with `[nit]`)
- **Question**: Clarification needed (prefix with `[question]`)
- **Praise**: Acknowledge good decisions (prefix with `[praise]`)
