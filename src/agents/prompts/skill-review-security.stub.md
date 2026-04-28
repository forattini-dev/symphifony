# Security Review Overlay

This overlay activates security-focused review mode. Apply it on top of the standard adversarial quality gate — do not replace the standard review, add to it.

## Threat Model First

Before checking individual issues, identify what this change is:

- **Trust boundary change?** New input accepted from users / external systems / env vars
- **Auth surface change?** Routes, middleware, tokens, sessions, permissions
- **Data access change?** New queries, new tables, new exports
- **Execution change?** Shell commands, subprocess, eval, dynamic imports

If none of the above apply, the security surface is minimal — note it and skip to the checklist.

## Security Checklist

Grade each applicable item as **PASS**, **FAIL**, or **N/A** (with reason for N/A):

### Input Validation

- [ ] All user-supplied data is validated at the system boundary before use
- [ ] Validation uses an allow-list (specific types/lengths), not a deny-list (block known bad)
- [ ] File paths constructed from user input are sanitized against path traversal (`../`)
- [ ] URL parameters are validated before use in queries, commands, or file ops

### Injection

- [ ] No SQL string interpolation — all queries use parameterized statements or a query builder
- [ ] No shell command construction from user data — `exec`, `spawn`, template strings in shell calls
- [ ] No `eval`, `new Function()`, or dynamic `require`/`import` built from user input
- [ ] No XSS surface: user content rendered to HTML is escaped or passed through a sanitizer

### Secrets and Credentials

- [ ] No credentials, tokens, keys, or passwords in source code or config files
- [ ] No secrets logged at any log level (including debug)
- [ ] Env vars used for secrets — not hardcoded defaults like `"secret"` or `"password"`
- [ ] Secrets are not included in error messages returned to clients

### Authentication and Authorization

- [ ] New routes/endpoints have explicit auth checks — no unprotected public endpoint added by accident
- [ ] Authorization checks verify the caller owns the resource — not just that they are logged in
- [ ] JWT / session tokens are validated on every protected request (not just at login)
- [ ] Role escalation paths (admin actions) require re-verification

### Dependency Surface

- [ ] No new dependency adds a known CVE (check `pnpm audit` / `uv audit` / `go mod audit`)
- [ ] Dynamic dependency loading is from a controlled list, not from user input

### Error Handling

- [ ] Error responses do not expose stack traces, internal paths, or DB schema to the client
- [ ] Error messages distinguish "not found" from "unauthorized" only when appropriate (avoid oracle)

## Severity Scale

When a finding exists, classify it:

| Severity | Meaning |
|----------|---------|
| **Critical** | Arbitrary code execution, credential exfiltration, auth bypass — block immediately |
| **High** | Injection, IDOR, broken access control — must fix before merge |
| **Medium** | Missing validation, weak defaults, information leakage — fix before merge on production-bound code |
| **Low** | Defense-in-depth gap, advisory hardening — advisory finding |

## Output

Report findings in the standard grading report under a dedicated `security` category criterion:

- If any Critical or High finding: mark the criterion FAIL with severity and exact location
- If only Medium or Low: advisory finding, do not fail the overall verdict unless the issue is security-focused
- No findings: PASS with a one-line "no security surface touched" or "checklist passed"
