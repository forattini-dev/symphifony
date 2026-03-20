# Debugging Skill

Follow this systematic approach when debugging issues:

## The RIDVF Method

### 1. Reproduce
- Get exact steps to reproduce the issue
- Note the environment: OS, runtime version, configuration
- Create the minimal reproduction case
- Confirm the issue is consistent, not intermittent

### 2. Isolate
- Narrow down the affected code path
- Use binary search: disable half the system, check if the bug persists
- Check recent changes: `git log --oneline -20` and `git bisect` for regressions
- Verify assumptions: add assertions and logging at boundaries

### 3. Diagnose
- Read the error message carefully, including the full stack trace
- Check logs at all levels: application, framework, system
- Use debugger breakpoints at the suspected failure point
- Trace the data flow: what is the input, what is expected, what is actual?
- Check external dependencies: database state, API responses, file permissions

### 4. Fix
- Fix the root cause, not the symptom
- Consider side effects of the fix on other code paths
- Keep the fix minimal and focused
- Add a test that fails without the fix and passes with it

### 5. Verify
- Run the reproduction steps to confirm the fix
- Run the full test suite to check for regressions
- Test edge cases around the fix
- Document what caused the issue and how it was resolved

## Common Pitfalls

- Do not change multiple things at once; change one thing and test
- Do not assume; verify with data and evidence
- Do not ignore warnings; they often point to the root cause
- Do not fix symptoms; trace to the root cause even if it takes longer
