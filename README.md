<div align="center">

# 🎻 Symphifony

### AI agents that actually ship code. You just watch.

Point at a repo. Open the dashboard. Claude plans, Codex builds, Claude reviews.
<br>
Mixed-agent pipelines with durable state. Zero config to start.
<br>
One command. Full orchestra.

**Local-first runtime. Browser dashboard. MCP server. All batteries included.**

[![npm version](https://img.shields.io/npm/v/symphifony.svg?style=flat-square&color=8b5cf6)](https://www.npmjs.com/package/symphifony)
[![npm downloads](https://img.shields.io/npm/dm/symphifony.svg?style=flat-square&color=34C759)](https://www.npmjs.com/package/symphifony)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-23+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/symphifony.svg?style=flat-square&color=007AFF)](LICENSE)

[🚀 Quick Start](#quick-start) · [🎯 Highlights](#highlights) · [🖥️ Dashboard](#dashboard) · [🔌 MCP](#mcp-server) · [📖 API Docs](#api-docs)

</div>

---

## Quick Start

```bash
npx -y symphifony --port 4040
```

Done. Open `http://localhost:4040` — you have a full dashboard.
<br>
Open `http://localhost:4040/docs` — you have interactive API docs.

Current directory = workspace. State lives in `.symphifony/`. No setup, no config, no accounts.

---

## Highlights

### 🎭 Mixed-Agent Pipelines

The whole point: **chain different AI providers in a single pipeline**.

```yaml
# WORKFLOW.md
agent:
  providers:
    - provider: claude
      role: planner
    - provider: codex
      role: executor
    - provider: claude
      role: reviewer
```

Claude thinks. Codex builds. Claude reviews. Each agent gets a hydrated profile, structured handoff, and full session context. Retries are automatic.

### 🧠 Smart Routing

Symphifony reads your issue's labels, file paths, and description to automatically pick the best providers and agent profiles.

```yaml
routing:
  priorities:
    security: 0
    bugfix: 1
    frontend: 2
  overrides:
    - match:
        labels: ["frontend", "design"]
        paths: ["src/dashboard"]
      providers:
        - provider: claude
          role: planner
          profile: agency-ui-designer
        - provider: codex
          role: executor
          profile: agency-frontend-developer
        - provider: claude
          role: reviewer
          profile: agency-accessibility-auditor
```

Frontend issue? Gets routed to design-savvy agents. Security bug? Jumps the queue.

### ⚡ Create Issues From Anywhere

Dashboard, curl, or MCP — your choice:

```bash
curl -X POST http://localhost:4040/issues/create \
  -H 'content-type: application/json' \
  -d '{
    "title": "Harden websocket reconnect flow",
    "labels": ["backend", "protocol"],
    "paths": ["src/protocol/session.ts"]
  }'
```

### 🔮 Project Scanner

Symphifony can scan your codebase and auto-generate issues based on TODOs, tech debt, missing tests, and improvement opportunities:

```bash
curl http://localhost:4040/scan
```

---

## What's Inside

| Category | What you get |
|:---------|:-------------|
| **Runtime** | Issue scheduler with retries, concurrency control, graceful shutdown, durable `s3db.js` state |
| **Agents** | Runs `claude` and `codex` with profile hydration, multi-turn sessions, structured results |
| **Routing** | Label + path + overlay matching, priority queues, capability-aware provider selection |
| **Dashboard** | Kanban board, issue detail, event timeline, session inspector, runtime health, provider stats |
| **API** | Full REST + WebSocket surface with auto-generated OpenAPI docs via `s3db.js` ApiPlugin |
| **MCP** | 6 tools + 7 resources + 3 prompts for Claude Code, Cursor, Windsurf, or any MCP client |
| **Scanner** | Codebase analysis and automatic issue generation |
| **Settings** | Runtime configuration, provider management, notification preferences |

---

## Dashboard

Start with `--port` and get a full browser UI:

```bash
npx -y symphifony --port 4040
```

**What you see:**

- **Kanban board** — issues flowing through `open → queued → running → review → done`
- **Issue detail** — full pipeline view, session history, agent output, event timeline
- **Runtime view** — scheduler state, worker count, uptime, provider availability
- **Stats bar** — issue counts by state, capability breakdown, agent session metrics
- **Settings** — provider config, notification preferences, runtime tuning
- **PWA** — install it, works offline, push notifications

---

## MCP Server

Turn Symphifony into tools for your editor:

```bash
npx -y symphifony mcp
```

```json
{
  "mcpServers": {
    "symphifony": {
      "command": "npx",
      "args": ["-y", "symphifony", "mcp", "--workspace", "/path/to/repo"]
    }
  }
}
```

**Tools:** `symphifony.status` `symphifony.list_issues` `symphifony.create_issue` `symphifony.update_issue_state` `symphifony.integration_config` `symphifony.resolve_capabilities`

**Resources:** `symphifony://guide/overview` `symphifony://state/summary` `symphifony://issues` `symphifony://issue/<id>` `symphifony://workspace/workflow`

**Prompts:** `symphifony-integrate-client` `symphifony-plan-issue` `symphifony-review-workflow`

Create issues, check status, review workflows — all without leaving the editor.

---

## API Docs

The API documentation at `/docs` is **auto-generated** from the `s3db.js` `ApiPlugin` resource definitions. It's always in sync with the actual routes and schemas. No hand-maintained OpenAPI spec to go stale.

```bash
npx -y symphifony --port 4040
open http://localhost:4040/docs
```

Native `s3db` resources powering the API:

| Resource | Partitions |
|:---------|:-----------|
| `issues` | `byState` · `byCapabilityCategory` · `byStateAndCapability` |
| `events` | `byIssueId` · `byKind` · `byIssueIdAndKind` |
| `agent_sessions` | `byIssueId` · `byIssueAttempt` · `byProviderRole` |
| `agent_pipelines` | `byIssueId` · `byIssueAttempt` |
| `runtime_state` | singleton runtime snapshot |

---

## WORKFLOW.md

Drop one file in your repo and Symphifony knows exactly how to run:

```yaml
---
agent:
  providers:
    - provider: claude
      role: planner
    - provider: codex
      role: executor
    - provider: claude
      role: reviewer
  max_concurrent_agents: 2
  max_attempts: 3
  max_turns: 4

routing:
  priorities:
    security: 0
    bugfix: 1
    backend: 2

server:
  port: 4040

hooks:
  after_create: "./scripts/notify.sh"
---

You are an expert engineer working on this codebase.
Follow the existing patterns and write tests for everything.
```

The YAML frontmatter configures the runtime. The Markdown body becomes the system prompt for every agent, available via `SYMPHIFONY_PROMPT`.

No `WORKFLOW.md`? No problem — Symphifony auto-detects providers and uses sensible defaults.

---

## Run Modes

```bash
# Full experience — dashboard + API + scheduler
npx -y symphifony --port 4040

# Headless — just the scheduler, no UI
npx -y symphifony

# MCP server — stdio for editor integration
npx -y symphifony mcp

# Custom state directory
npx -y symphifony --persistence /path/to/state

# Dev mode — hot reload, verbose logging
npx -y symphifony --port 4040 --dev
```

---

## License

MIT © [Forattini](https://github.com/filipeforattini)
