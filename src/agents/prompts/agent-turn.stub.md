Continue working on {{issueIdentifier}}.
Turn {{turnIndex}} of {{maxTurns}}.

{{#if isFinalTurns}}
⚠️ **Turn budget warning: {{turnsRemaining}} turn(s) remaining.**
This is one of your last turns. Prioritize delivering working, testable code over perfection.
If the issue cannot be completed in {{turnsRemaining}} turn(s), write `fifony-result.json` with:
```json
{
  "status": "blocked",
  "summary": "<one sentence: what was accomplished>",
  "nextPrompt": "<what the next executor must do — be specific: which file, which function, what error>",
  "errorType": "<one of: test_failure | build_failure | logic_error | scope_too_large | missing_context | permission_denied | external_dependency>",
  "completedSteps": [1, 2],
  "remainingSteps": [3, 4]
}
```
The `nextPrompt` is injected directly into the next retry — write it as a directive, not a summary. Name the exact blocker.
{{/if}}
{{#if isContextPressure}}
⚠️ **Context pressure: ~{{contextWindowPct}}% of context window used.**
Avoid loading large files unnecessarily. Prefer targeted edits over full rewrites. If helpful, write a checkpoint file summarizing progress so far.
{{/if}}

## Turn Guidance

- **Go straight to the point.** Try the simplest approach first.
- **Diagnose before retrying.** If your previous approach failed, read the error carefully and understand WHY before trying again. Do not retry the identical action.
- **Pivot on repeated failure.** If you have seen the same error type twice in a row, abandon the current approach entirely and try a fundamentally different strategy. Persistence without diagnosis is not a virtue.
- **Build on partial progress.** If you made some progress last turn, build on it — do not restart from scratch.
- **Keep output concise.** Lead with what you did and what happened, not reasoning or preamble.
- **Verify before claiming done.** Run tests, check the build, inspect output. Report outcomes faithfully. Never claim "all tests pass" when output shows failures.

## Acceptance Criteria (source of truth)

Read `execution-payload.json` in the workspace. The `acceptanceCriteria` array is the exact checklist the reviewer will grade. Use it to stay on scope and know when you are done — the criterion `doneWhen` on each plan step is your gate before moving to the next step.

Base objective:
{{basePrompt}}

Continuation guidance:
{{continuation}}

Previous command output tail:
```text
{{outputTail}}
```

Before exiting successfully, emit one of the following control markers:
- `FIFONY_STATUS=continue` if more turns are required.
- `FIFONY_STATUS=done` if the issue is complete.
- `FIFONY_STATUS=blocked` if manual intervention is required.
You may also write `fifony-result.json` with `{ "status": "...", "summary": "...", "nextPrompt": "..." }`.
