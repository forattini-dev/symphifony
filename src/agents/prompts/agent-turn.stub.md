Continue working on {{issueIdentifier}}.
Turn {{turnIndex}} of {{maxTurns}}.

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
