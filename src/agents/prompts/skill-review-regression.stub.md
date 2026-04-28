# Regression Review Overlay

This overlay activates regression-focused review mode. Apply on top of the standard adversarial quality gate — do not replace it, extend it.

## What Regression Review Is For

Executor incentive is to ship the feature. Regression review's incentive is to find what the executor didn't know they broke. The executor only proved the new code works. You must prove the old code still works.

## Step 1 — Map Changed Files to Callers

For every file in the diff:

1. **Who calls it?** Search for imports, require, usages. List them.
2. **What is the public contract?** Function signatures, exported types, event shapes, HTTP endpoints.
3. **Did the contract change?** Even a compatible widening (adding an optional field) can break callers that do exhaustive checks.

Flag any public contract change where callers were not updated.

## Step 2 — Test Coverage Map

For each changed file:

- [ ] Is there a test file covering this module? (`*.test.ts`, `*_test.go`, `test_*.py`)
- [ ] Do the tests cover the changed code path — not just the file?
- [ ] Does the diff add or modify a test for the changed behavior?

If the change has no test coverage and the behavior is non-trivial: flag as a regression risk.

## Step 3 — Implicit Contracts (the hard ones)

Explicit contracts are in types and docs. Implicit contracts are what callers actually depend on but nobody wrote down:

- **Side-effect order**: if function A previously wrote to DB before firing an event, and the order was reversed, callers that relied on the DB being updated when the event fires will break.
- **Return shape stability**: adding a field is safe. Removing or renaming one breaks every consumer that destructures.
- **Error semantics**: if a function previously threw `NotFoundError` and now returns `null`, any catch block that matches `NotFoundError` stops working.
- **Concurrency assumptions**: if code that was sequential is now async, callers that assumed synchronous completion will race.
- **Idempotency**: if an operation that was safe to call twice is now stateful, retry logic in callers will corrupt state.

For each of these: read the diff, trace one caller, and verify the contract held.

## Step 4 — Regression Probe Questions

Answer each applicable question with evidence (file + line):

1. **Did any exported type change shape?** If yes: are all callers updated?
2. **Did any function change return type or error type?** If yes: are all callers updated?
3. **Did any database migration run?** If yes: is the migration reversible? Does it touch live data?
4. **Did any event/message payload change?** If yes: are all consumers updated (including async consumers that may not be in this diff)?
5. **Did any default value change?** If yes: do callers that relied on the old default still work?
6. **Did any deletion happen?** If yes: is the deleted thing actually unused everywhere (not just in this repo)?

## Step 5 — Regression Verdict

- **PASS**: no implicit contract broken, test coverage adequate for changed paths, all callers of changed APIs updated.
- **FAIL**: any of the following — implicit contract broken with no caller update, behavioral change with no test, public API shape changed and callers not verified.
- **ADVISORY**: test gap found but the changed logic is trivial; implicit contract held but no explicit test guards it.

## Output

Report regression findings as a `regression` category criterion in the standard grading report:

- FAIL if any implicit contract is broken or a non-trivial change has zero test coverage
- PASS with one-line summary if all covered
- Include the specific file:line for every finding
