# Symphony setup for AoZO / Black Citadel (Codex-only local fork)

This repository runs a local TypeScript runtime for Symphony orchestration without Linear and without the Elixir stack.

## What this fork provides

- Memory tracker as the only tracker implementation.
- Local issue source file in JSON (`scripts/symphony-local-issues.json`).
- Local workspace snapshots for reproducible local execution.
- Queue runner with worker concurrency, retries, retry backoff and stale-run recovery.
- Local event log + dashboard with issue transitions, manual actions and health API.
- Optional external Codex command via `SYMPHONY_AGENT_COMMAND`.

## Files to check

- Workflow template: [WORKFLOW.md](./WORKFLOW.md)
- Bootstrap runtime: [scripts/run-symphony-local.ts](./scripts/run-symphony-local.ts)
- Start wrapper: [scripts/start-symphony.sh](./scripts/start-symphony.sh)
- Dashboard: [scripts/symphony-dashboard/index.html](./scripts/symphony-dashboard/index.html)

## Environment variables

```bash
export SYMPHONY_TRACKER_KIND=memory
export SYMPHONY_BOOTSTRAP_ROOT=$HOME/.local/share/symphony-aozo
export SYMPHONY_MEMORY_ISSUES_FILE=/path/to/issues.json
export SYMPHONY_MEMORY_ISSUES_JSON='[{"id":"LOCAL-1","title":"...","description":"...","state":"Todo"}]'
export SYMPHONY_AGENT_COMMAND='codex run --json "$SYMPHONY_ISSUE_JSON"'
export SYMPHONY_WORKER_CONCURRENCY=2
export SYMPHONY_MAX_ATTEMPTS=3
```

> `SYMPHONY_AGENT_COMMAND` is optional. If not defined, the runner will execute a deterministic local simulator.

## Start examples

```bash
pnpm exec tsx ./scripts/run-symphony-local.ts --once
# or
./scripts/start-symphony.sh --once
```

### With dashboard

```bash
./scripts/start-symphony.sh --port 4040 --concurrency 2 --attempts 3
```

## Runtime behavior

- Local bootstrap creates a source snapshot under `~/.local/share/symphony-aozo/aozo-source`.
- Issues are loaded from the configured JSON source.
- Workflow file is rendered to `~/.local/share/symphony-aozo/WORKFLOW.local.md`.
- Runtime state is stored in `~/.local/share/symphony-aozo/symphony-memory-state.json`.
- Event log is stored in `~/.local/share/symphony-aozo/symphony-local.log`.
- Dashboard endpoint serves:
  - `/api/state`
  - `/api/issues`
  - `/api/events`
  - `/api/health`

