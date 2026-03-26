Continue working on {{issueIdentifier}}.
Turn {{turnIndex}} of {{maxTurns}}.

{{#if isFinalTurns}}
⚠️ **Turn budget warning: {{turnsRemaining}} turn(s) remaining.**
This is one of your last turns. Prioritize delivering working, testable code over perfection.
If the issue cannot be completed in {{turnsRemaining}} turn(s), write a `fifony-result.json` with `"status": "blocked"` and a clear summary of what remains.
{{/if}}
{{#if isContextPressure}}
⚠️ **Context pressure: ~{{contextWindowPct}}% of context window used.**
Avoid loading large files unnecessarily. Prefer targeted edits over full rewrites. If helpful, write a checkpoint file summarizing progress so far.
{{/if}}

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
