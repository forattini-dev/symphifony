# Symphifony local runtime reference

This repository runs Symphifony as a pure TypeScript local orchestrator with no external tracker dependency.

## What this package provides

- Filesystem-backed orchestration through the local persistence runtime.
- Durable tracker state that can also start empty and accept work over HTTP.
- Local workspace snapshots for reproducible execution.
- Queue runner with concurrency, retries, retry backoff, and stale-run recovery.
- Local event log, API, and dashboard through the `s3db.js` `ApiPlugin`.
- Multi-agent pipelines with `codex` and `claude`.

## Relevant files

- Workflow template: [WORKFLOW.md](./WORKFLOW.md)
- Published entrypoint: [bin/symphifony.js](./bin/symphifony.js)
- CLI router: [src/cli.ts](./src/cli.ts)
- Runtime engine: [src/runtime/run-local.ts](./src/runtime/run-local.ts)
- Dashboard: [src/dashboard/index.html](./src/dashboard/index.html)

## Environment variables

```bash
export SYMPHIFONY_TRACKER_KIND=filesystem
export SYMPHIFONY_WORKSPACE_ROOT=$PWD
export SYMPHIFONY_PERSISTENCE=$PWD
export SYMPHIFONY_AGENT_COMMAND='codex run --json "$SYMPHIFONY_ISSUE_JSON"'
export SYMPHIFONY_AGENT_PROVIDER=codex
export SYMPHIFONY_WORKER_CONCURRENCY=2
export SYMPHIFONY_MAX_ATTEMPTS=3
export SYMPHIFONY_AGENT_MAX_TURNS=4
```

`SYMPHIFONY_AGENT_COMMAND` is required unless `WORKFLOW.md` provides `codex.command` or `claude.command`.

Node requirement:

- Node.js 23 or newer

## Start examples

```bash
npx symphifony
```

Default state location:

```bash
./.symphifony/
```

Override the persistence root:

```bash
npx symphifony --persistence /path/to/root
```

Run the MCP server:

```bash
npx symphifony mcp
```

Run a single cycle:

```bash
npx symphifony --once
```

Run with the API and dashboard:

```bash
npx symphifony --port 4040 --concurrency 2 --attempts 3
```

## Runtime behavior

- Local bootstrap creates a source snapshot under `./.symphifony/source`.
- Workflow is rendered to `./.symphifony/WORKFLOW.local.md`.
- Runtime state is stored under `./.symphifony/s3db/` by the `s3db.js` `FileSystemClient`.
- Event log is stored in `./.symphifony/symphifony-local.log`.
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
- When `paths[]` is omitted, Symphifony infers routing hints from path-like text mentions and from files changed inside an existing persisted workspace.
- Symphifony derives labels like `capability:<category>` and `overlay:<name>` from the routing result for queue triage and visibility.
- The rendered prompt is written to `symphifony-prompt.md` and exported through `SYMPHIFONY_PROMPT` and `SYMPHIFONY_PROMPT_FILE`.
- Each issue runs as a multi-turn session controlled by `agent.max_turns`.
- Each turn exports `SYMPHIFONY_AGENT_PROVIDER`, `SYMPHIFONY_AGENT_ROLE`, `SYMPHIFONY_AGENT_PROFILE`, `SYMPHIFONY_AGENT_PROFILE_FILE`, `SYMPHIFONY_AGENT_PROFILE_INSTRUCTIONS`, `SYMPHIFONY_SESSION_ID`, `SYMPHIFONY_SESSION_KEY`, `SYMPHIFONY_TURN_INDEX`, `SYMPHIFONY_MAX_TURNS`, `SYMPHIFONY_TURN_PROMPT`, `SYMPHIFONY_TURN_PROMPT_FILE`, `SYMPHIFONY_PREVIOUS_OUTPUT`, and `SYMPHIFONY_RESULT_FILE`.
- The agent can continue, finish, block, or fail by printing `SYMPHIFONY_STATUS=...` or by writing `symphifony-result.json`.
- Session and pipeline state are persisted in `s3db`.
- Workspace JSON artifacts are temporary CLI handoff files, not the source of truth.
- The `s3db` resources are partitioned for the main operational lookups (`state`, `capabilityCategory`, `issueId`, `kind`, `attempt`, `provider/role`).
- The scheduler advances one turn per execution slot and resumes persisted `In Progress` work.
- When issue priority ties, the scheduler prefers more critical capability categories first (`security`, `bugfix`, `backend`, `devops`, `frontend-ui`, `architecture`, `documentation`, `default`) unless `routing.priorities` overrides that order.
- `npx symphifony mcp` keeps the scheduler alive even without the dashboard port.
- `npx symphifony mcp` starts a stdio MCP server backed by the same durable `s3db` state as the runtime.
- frontend-heavy tasks automatically carry stricter review overlays such as `impeccable` when matched by the capability resolver.

## MCP capabilities

Resources:

- `symphifony://guide/overview`
- `symphifony://guide/runtime`
- `symphifony://guide/integration`
- `symphifony://state/summary`
- `symphifony://issues`
- `symphifony://workspace/workflow`
- `symphifony://issue/<id>`

Tools:

- `symphifony.status`
- `symphifony.list_issues`
- `symphifony.create_issue`
- `symphifony.update_issue_state`
- `symphifony.integration_config`

Prompts:

- `symphifony-integrate-client`
- `symphifony-plan-issue`
- `symphifony-review-workflow`

Recommended MCP client config:

```json
{
  "mcpServers": {
    "symphifony": {
      "command": "npx",
      "args": ["symphifony", "mcp", "--workspace", "/path/to/workspace", "--persistence", "/path/to/workspace"]
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
