# fifo local runtime reference

This repository runs fifo as a pure TypeScript local orchestrator with no external tracker dependency.

## What this package provides

- Filesystem-backed orchestration through the local persistence runtime.
- Durable tracker state that can also start empty and accept work over HTTP.
- Local workspace snapshots for reproducible execution.
- Queue runner with concurrency, retries, retry backoff, and stale-run recovery.
- Local event log, API, and dashboard through the `s3db.js` `ApiPlugin`.
- Multi-agent pipelines with `codex` and `claude`.

## Relevant files

- Workflow template: [WORKFLOW.md](./WORKFLOW.md)
- Published entrypoint: [bin/fifony.js](./bin/fifony.js)
- CLI router: [src/cli.ts](./src/cli.ts)
- Runtime engine: [src/agent/run-local.ts](./src/agent/run-local.ts)
- Dashboard: [app/index.html](./app/index.html)

## Environment variables

```bash
export FIFONY_TRACKER_KIND=filesystem
export FIFONY_WORKSPACE_ROOT=$PWD
export FIFONY_PERSISTENCE=$PWD
export FIFONY_AGENT_COMMAND='codex run --json "$FIFONY_ISSUE_JSON"'
export FIFONY_AGENT_PROVIDER=codex
export FIFONY_WORKER_CONCURRENCY=2
export FIFONY_MAX_ATTEMPTS=3
export FIFONY_AGENT_MAX_TURNS=4
```

`FIFONY_AGENT_COMMAND` is required unless `WORKFLOW.md` provides `codex.command` or `claude.command`.

Node requirement:

- Node.js 23 or newer

## Start examples

```bash
npx fifony
```

Default state location:

```bash
./.fifony/
```

Override the persistence root:

```bash
npx fifony --persistence /path/to/root
```

Run the MCP server:

```bash
npx fifony mcp
```

Run a single cycle:

```bash
npx fifony --once
```

Run with the API and dashboard:

```bash
npx fifony --port 4040 --concurrency 2 --attempts 3
```

## Runtime behavior

- Local bootstrap creates a source snapshot under `./.fifony/source`.
- Workflow is rendered to `./.fifony/WORKFLOW.local.md`.
- Runtime state is stored under `./.fifony/s3db/` by the `s3db.js` `FileSystemClient`.
- Event log is stored in `./.fifony/fifony-local.log`.
- `WORKFLOW.md` front matter and Markdown body define the execution contract when present.
- `hooks.after_create` runs once for a new issue workspace; otherwise the runtime copies the local source snapshot.
- `hooks.before_run` and `hooks.after_run` can wrap each agent turn.
- `agent.provider` can be `codex` or `claude`.
- `agent.providers[]` can mix both in one pipeline.
- `agent.profile` resolves to local profile files from workspace or home directories.
- `routing.enabled` can disable automatic task routing.
- `routing.priorities` can override the default scheduler order by capability category.
- `routing.overrides[]` can override the automatic provider/profile selection for matching tasks.
- `routing.overrides[].match.paths` can force routing based on target directories or files.
- Issue payloads can carry `paths[]` so routing can use the real change surface, not only text and labels.
- When `paths[]` is omitted, fifo infers routing hints from path-like text mentions and from files changed inside an existing persisted workspace.
- fifo derives labels like `capability:<category>` and `overlay:<name>` from the routing result for queue triage and visibility.
- The rendered prompt is written to `fifony-prompt.md` and exported through `FIFONY_PROMPT` and `FIFONY_PROMPT_FILE`.
- Each issue runs as a multi-turn session controlled by `agent.max_turns`.
- Each turn exports `FIFONY_AGENT_PROVIDER`, `FIFONY_AGENT_ROLE`, `FIFONY_AGENT_PROFILE`, `FIFONY_AGENT_PROFILE_FILE`, `FIFONY_AGENT_PROFILE_INSTRUCTIONS`, `FIFONY_SESSION_ID`, `FIFONY_SESSION_KEY`, `FIFONY_TURN_INDEX`, `FIFONY_MAX_TURNS`, `FIFONY_TURN_PROMPT`, `FIFONY_TURN_PROMPT_FILE`, `FIFONY_PREVIOUS_OUTPUT`, and `FIFONY_RESULT_FILE`.
- The agent can continue, finish, block, or fail by printing `FIFONY_STATUS=...` or by writing `fifony-result.json`.
- Session and pipeline state are persisted in `s3db`.
- Workspace JSON artifacts are temporary CLI handoff files, not the source of truth.
- The `s3db` resources are partitioned for the main operational lookups (`state`, `capabilityCategory`, `issueId`, `kind`, `attempt`, `provider/role`).
- The scheduler advances one turn per execution slot and resumes persisted `In Progress` work.
- When issue priority ties, the scheduler prefers more critical capability categories first (`security`, `bugfix`, `backend`, `devops`, `frontend-ui`, `architecture`, `documentation`, `default`) unless `routing.priorities` overrides that order.
- `npx fifony mcp` keeps the scheduler alive even without the dashboard port.
- `npx fifony mcp` starts a stdio MCP server backed by the same durable `s3db` state as the runtime.
- frontend-heavy tasks automatically carry stricter review overlays such as `impeccable` when matched by the capability resolver.

## MCP capabilities

Resources:

- `fifony://guide/overview`
- `fifony://guide/runtime`
- `fifony://guide/integration`
- `fifony://state/summary`
- `fifony://issues`
- `fifony://workspace/workflow`
- `fifony://issue/<id>`

Tools:

- `fifony.status`
- `fifony.list_issues`
- `fifony.create_issue`
- `fifony.update_issue_state`
- `fifony.integration_config`

Prompts:

- `fifony-integrate-client`
- `fifony-plan-issue`
- `fifony-review-workflow`

Recommended MCP client config:

```json
{
  "mcpServers": {
    "fifony": {
      "command": "npx",
      "args": ["fifony", "mcp", "--workspace", "/path/to/workspace", "--persistence", "/path/to/workspace"]
    }
  }
}
```

## HTTP surface

HTTP surface:

- `GET /state` — runtime snapshot with capability counts
- `GET /status` — health check
- `GET /events/feed` with optional `issueId`, `kind`, and `since` query filters
- `GET /issues/:id/pipeline` — pipeline snapshot for one issue
- `GET /issues/:id/sessions` — session history for one issue
- `POST /issues/:id/state` — transition issue state
- `POST /issues/:id/retry` — retry issue
- `POST /issues/:id/cancel` — cancel issue
- `POST /issues/create` — create issue
- `GET /providers` — detected providers with availability
- `GET /parallelism` — parallelism analysis
- `POST /config/concurrency` — set worker concurrency
- `POST /refresh` — request manual refresh event

Generated documentation and native resources:

- `/docs`
- `/runtime_state`
- `/issues`
- `/events`
- `/agent_sessions`
- `/agent_pipelines`
