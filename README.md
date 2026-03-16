<div align="center">

# Symphifony

### Local multi-agent orchestration for real codebases

Run `codex` and `claude` against a workspace, persist everything locally, and
watch the whole pipeline in a browser UI or through MCP.

**One local runtime for issues, sessions, routing, reviews, and state.**

</div>

---

## Quick Start

Symphifony requires Node.js 23+.

```bash
pnpm install --ignore-workspace
npx -y symphifony --port 4040
```

Then open:

- `http://localhost:4040`
- `http://localhost:4040/docs`

Default behavior:

- the current directory is treated as the workspace root
- state is stored under `./.symphifony/`
- runtime starts with zero issues when no persisted state exists

## Why Symphifony

- Local-first orchestration with durable state in `s3db.js`
- Mixed-agent workflows with `codex` and `claude`
- Capability routing based on labels, paths, and workflow rules
- Browser dashboard with issues, events, runtime state, sessions, and provider visibility
- MCP server for editor and assistant integrations
- No external tracker required to get started

## Run Modes

### Local runtime

Run the scheduler in the current workspace:

```bash
npx -y symphifony
```

### Dashboard and API

Start the HTTP API and UI on a local port:

```bash
npx -y symphifony --port 4040
```

### MCP server

Run Symphifony as an MCP server over stdio:

```bash
npx -y symphifony mcp
```

### Custom persistence root

Store runtime state outside the current repo:

```bash
npx -y symphifony --persistence /path/to/root
```

## The Flow

1. Start Symphifony in the repo you want to orchestrate.
2. Create an issue in the dashboard or call `POST /issues/create`.
3. Add `labels` and `paths` when you want better routing and provider selection.
4. Let the scheduler run the issue through planning, execution, review, retries, and completion.
5. Inspect events, sessions, pipeline state, output tails, and provider usage from the UI.

Minimal issue payload:

```json
{
  "title": "Build release workflow",
  "description": "Prepare the first stable npm release",
  "labels": ["devops", "release"],
  "paths": [".github/workflows/ci.yml", "package.json"]
}
```

Create it over HTTP:

```bash
curl -X POST http://localhost:4040/issues/create \
  -H 'content-type: application/json' \
  -d '{
    "title":"Prepare release notes",
    "labels":["documentation","release"],
    "paths":["README.md","RELEASE.md"]
  }'
```

Read filtered events:

```bash
curl 'http://localhost:4040/events/feed?kind=info&issueId=LOCAL-1'
```

## What You Get

| Area | What it does |
|:-----|:-------------|
| Runtime | Schedules issues, tracks retries, persists state, and handles graceful shutdown |
| Routing | Uses labels, paths, overlays, and workflow rules to choose providers and roles |
| Agents | Runs `codex` and `claude` with profile hydration and structured result handling |
| Dashboard | Shows queue state, issue details, sessions, events, runtime health, and provider data |
| API | Exposes issue lifecycle, state snapshots, sessions, pipelines, and event feeds |
| MCP | Makes Symphifony available as tools for editor and assistant workflows |

## Useful Routes

- `/` — dashboard
- `/docs` — OpenAPI docs from `ApiPlugin`
- `/state` — runtime snapshot with capability counts
- `/issues/:id/pipeline` — pipeline snapshot for one issue
- `/issues/:id/sessions` — session history for one issue
- `/issues/create` — create issue
- `/issues/:id/state` — transition issue state
- `/issues/:id/retry` — retry issue
- `/issues/:id/cancel` — cancel issue
- `/events/feed` — filtered event feed with `?since=&kind=&issueId=`

## Package Layout

- `bin/symphifony.js` — published CLI entrypoint
- `src/cli.ts` — command router built on `cli-args-parser`
- `src/mcp/server.ts` — stdio MCP server
- `src/runtime/run-local.ts` — local runtime entrypoint
- `src/runtime/store.ts` — `s3db.js` persistence and plugin wiring
- `src/runtime/issues.ts` — issue CRUD, transitions, metrics, and events
- `src/runtime/agent.ts` — agent session and pipeline execution
- `src/runtime/scheduler.ts` — scheduling, retries, and concurrency
- `src/runtime/api-server.ts` — HTTP API, WebSocket updates, and dashboard serving
- `src/runtime/providers.ts` — provider detection and runtime provider selection
- `src/runtime/issue-state-machine.ts` — issue lifecycle state machine helpers
- `src/integrations/catalog.ts` — agent and integration discovery
- `src/dashboard/` — browser app sources and generated assets

## Workflow contract

If the target workspace contains `WORKFLOW.md`, Symphifony reads its YAML front matter and Markdown body.

Supported fields:

- `tracker.kind`
- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `poll.interval_ms`
- `agent.provider`
- `agent.providers[]`
- `agent.profile`
- `agent.max_concurrent_agents`
- `agent.max_attempts`
- `agent.max_turns`
- `codex.command`
- `claude.command`
- `codex.timeout_ms`
- `server.port`
- `routing.enabled`
- `routing.priorities`
- `routing.overrides[]`
- `routing.overrides[].match.paths`

The Markdown body is rendered as the issue prompt and exported through:

- `SYMPHIFONY_PROMPT`
- `SYMPHIFONY_PROMPT_FILE`

If no command is configured, Symphifony auto-detects available providers (`claude`, `codex`) and uses sensible defaults.

## Agent runtime contract

Each agent turn receives:

- `SYMPHIFONY_AGENT_PROVIDER`
- `SYMPHIFONY_AGENT_ROLE`
- `SYMPHIFONY_AGENT_PROFILE`
- `SYMPHIFONY_AGENT_PROFILE_FILE`
- `SYMPHIFONY_AGENT_PROFILE_INSTRUCTIONS`
- `SYMPHIFONY_SESSION_ID`
- `SYMPHIFONY_SESSION_KEY`
- `SYMPHIFONY_TURN_INDEX`
- `SYMPHIFONY_MAX_TURNS`
- `SYMPHIFONY_TURN_PROMPT`
- `SYMPHIFONY_TURN_PROMPT_FILE`
- `SYMPHIFONY_PREVIOUS_OUTPUT`
- `SYMPHIFONY_RESULT_FILE`

The agent can advance the session by:

- printing `SYMPHIFONY_STATUS=continue|done|blocked|failed`
- writing `symphifony-result.json` with `status`, `summary`, and optional `nextPrompt`

Session and pipeline state are persisted in the local `s3db` store.
Workspace JSON files are temporary CLI handoff artifacts only.

Agent profiles can be resolved from:

- `./.codex/agents/<name>.md`
- `./agents/<name>.md`
- `~/.codex/agents/<name>.md`
- `~/.claude/agents/<name>.md`

Command resolution order:

1. `SYMPHIFONY_AGENT_COMMAND`
2. provider-specific workflow command: `codex.command` or `claude.command`
3. provider binary name: `codex` or `claude`

Example mixed pipeline:

```yaml
agent:
  max_turns: 4
  providers:
    - provider: claude
      role: planner
    - provider: codex
      role: executor
    - provider: claude
      role: reviewer
```

Example routing override:

```yaml
routing:
  priorities:
    security: 0
    bugfix: 1
    backend: 2
  overrides:
    - match:
        labels: ["frontend", "marketing"]
        paths: ["src/web", "src/dashboard"]
      overlays: ["impeccable", "frontend-design"]
      providers:
        - provider: claude
          role: planner
          profile: agency-ui-designer
          reason: Marketing frontend needs stronger design planning.
        - provider: codex
          role: executor
          profile: agency-frontend-developer
          reason: Frontend implementation.
        - provider: claude
          role: reviewer
          profile: agency-accessibility-auditor
          reason: Review with stronger UX and accessibility standards.
```

Issue payloads can include `paths` so the resolver can classify by target files and directories, not only title and labels:

```json
{
  "title": "Harden websocket reconnect flow",
  "labels": ["backend", "protocol"],
  "paths": ["src/protocol/session.ts", "src/api/ws-handler.ts"]
}
```

If `paths` is omitted, Symphifony still tries to infer routing signals from:

- path-like mentions in the title and description
- changed files already present in the persisted issue workspace

Symphifony also derives queue labels such as `capability:<category>` and `overlay:<name>` from the resolver output.
The scheduler uses capability priority as a tie-breaker after issue priority, and `routing.priorities` can override the default category order.

## Durable local state

- `./.symphifony/WORKFLOW.local.md`
- `./.symphifony/s3db/`
- `./.symphifony/symphifony-local.log`

## HTTP surface

Primary REST endpoints:

- `GET /runtime_state` — runtime state mirror resource
- `GET /issues` — issue list resource
- `GET /events` — event records resource
- `GET /agent_sessions` — agent sessions resource
- `GET /agent_pipelines` — agent pipelines resource

Custom endpoints:

- `GET /state` — runtime snapshot with capability counts
- `GET /status` — health check
- `GET /events/feed?since=&kind=&issueId=` — filtered event feed
- `GET /issues/:id/pipeline` — pipeline snapshot for one issue
- `GET /issues/:id/sessions` — session history for one issue
- `POST /issues/:id/state` — transition issue state
- `POST /issues/:id/retry` — retry issue
- `POST /issues/:id/cancel` — cancel issue
- `GET /providers` — detected providers with availability
- `GET /parallelism` — parallelizability analysis
- `POST /config/concurrency` — update worker concurrency
- `POST /refresh` — request immediate state persistence

The built-in dashboard filters issues by both runtime state and capability category, and mirrors the scheduler's capability-aware ordering.
`GET /state` and the MCP status summary also expose aggregated capability counts.
The live events panel filters by `kind` and `issueId`, backed by the partitioned `/events/feed` route.

Native `ApiPlugin` resources:

- `runtime_state`
- `issues`
- `events`
- `agent_sessions`
- `agent_pipelines`

These resources also define `s3db` partitions for the main operational access patterns:

- issues: `byState`, `byCapabilityCategory`, `byStateAndCapability`
- events: `byIssueId`, `byKind`, `byIssueIdAndKind`
- sessions: `byIssueId`, `byIssueAttempt`, `byProviderRole`
- pipelines: `byIssueId`, `byIssueAttempt`

The issue inspection routes use these partitions directly, including pipeline/session lookups by `issueId + attempt`.

## MCP surface

`npx -y symphifony mcp` starts a stdio MCP server backed by the same `s3db` filesystem store as the runtime.

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
- `symphifony.list_issues` with optional `state`, `capabilityCategory`, or `category`
- `symphifony.create_issue`
- `symphifony.update_issue_state`
- `symphifony.integration_config`
- `symphifony.resolve_capabilities`

Prompts:

- `symphifony-integrate-client`
- `symphifony-plan-issue`
- `symphifony-review-workflow`

Minimal MCP client configuration:

```json
{
  "mcpServers": {
    "symphifony": {
      "command": "npx",
      "args": ["-y", "symphifony", "mcp", "--workspace", "/path/to/workspace", "--persistence", "/path/to/workspace"]
    }
  }
}
```

## GitHub Actions release flow

- `pull_request`: runs the quality gate
- `push` to `main`: runs quality and publishes `symphifony@next`
- tag `v*`: runs quality, publishes stable, and creates a GitHub Release

Required repository secret:

- `NPM_TOKEN` for `pnpm publish`

## Ship v1 yourself

1. Confirm `NPM_TOKEN` is configured in GitHub Actions
2. Make sure `package.json` has the version you want to release
3. Push `main`
4. Wait for the `@next` publish to pass
5. Create and push the stable tag

Commands:

```bash
git push origin main
git tag v0.1.0
git push origin v0.1.0
```

After publish:

```bash
npx -y symphifony@latest --port 4040
npx -y symphifony@latest mcp
```

Release checklist:

- [RELEASE.md](./RELEASE.md)
