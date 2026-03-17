<div align="center">

# Fifony

**AI agents that actually ship code. You just watch.**

Point at a repo. Open the dashboard. AI plans, builds, and reviews — you approve.

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D23-brightgreen.svg)]()

</div>

---

## Quick Start

```bash
npx -y fifony --port 4040
```

Open **http://localhost:4040**. The first run launches the onboarding wizard — it detects your CLIs, scans your project, and configures everything in six steps. State lives in `.fifony/`. No accounts, no cloud, no external database.

---

## How It Works

Fifony breaks every task into three stages, each independently configurable:

```
  Plan             Execute          Review
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Claude       │─▶│ Codex        │─▶│ Claude       │
│ Opus 4.5     │  │              │  │ Sonnet 4.5   │
│ effort: high │  │ effort: med  │  │ effort: med  │
└──────────────┘  └──────────────┘  └──────────────┘
```

You set the provider, model, and reasoning effort for each stage. Claude plans, Codex executes, Claude reviews — or any combination you prefer. Configure it in the Settings UI or drop a `WORKFLOW.md` in your project root.

### Issue Lifecycle

```
Planning → Todo → Queued → Running → In Review → Done
                                ↓            ↓
                           Interrupted    Blocked → (retry with backoff)
```

1. **Create** — Describe what you want done. Fifony AI-enhances the title and description before planning.
2. **Plan** — The planner agent generates a structured execution plan: phases, steps, target files, complexity, risks.
3. **Approve** — You review the plan. Optionally chat with the AI to refine it before approving.
4. **Execute** — Agents run in an isolated workspace (a copy of your project). Live output streams to the dashboard.
5. **Review** — The reviewer agent inspects the diff and either approves, requests rework, or blocks.
6. **Merge** — You review the diff and merge the workspace back to your project root.

Agents run as detached child processes, tracked by PID. If the server restarts mid-run, Fifony recovers on the next boot.

---

## Onboarding Wizard

The first run walks you through six steps:

| Step | What happens |
|------|-------------|
| CLI Detection | Finds `claude`, `codex`, `git`, `node`, `docker`, and other tools on your system |
| Project Scan | Detects language, stack, and build system — 18+ ecosystems supported |
| AI Analysis | Uses the detected CLI to extract domain context from your codebase |
| Domains | 21 options across Technical / Industry / Role, pre-selected by the AI |
| Agents & Skills | Catalog of 15 agents and 5 skills, auto-recommended for your domains |
| Effort & Workers | Per-stage reasoning effort, worker concurrency, and visual theme |

Settings are saved progressively and can be re-run from Settings at any time.

Supported build files include: `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `build.gradle`, `Gemfile`, `mix.exs`, `pubspec.yaml`, `CMakeLists.txt`, `composer.json`, `Package.swift`, `deno.json`, `pom.xml`, `Dockerfile`, and more.

---

## Dashboard

| Route | What you see |
|-------|-------------|
| `/kanban` | Drag-and-drop board. Cards flow through pipeline stages. Desktop click+drag, mobile long-press. |
| `/issues` | Searchable list with state, label, and capability filters. Shows token usage and duration per issue. |
| `/agents` | Live cockpit: worker slots, queue depth, real-time log tail, token sparklines per agent. |
| `/discover` | Import TODOs from your codebase, GitHub issues, or AI-suggested tasks. |
| `/analytics` | Token usage trends, daily and weekly rollups, top issues by cost, per-model breakdown. |
| `/settings` | General, Workflow pipeline config, Notifications, Providers. |

The **Issue Detail Drawer** shows the full plan (phases and steps), all execution sessions, the workspace diff, and a per-phase token breakdown — Plan / Execute / Review — with input and output counts per model.

### PWA

Install as a desktop app. Works offline. Desktop notifications when issues change state. Service worker with stale-while-revalidate caching.

---

## Agent & Skill Catalog

Fifony ships with 15 specialist agents:

| Agent | Focus |
|-------|-------|
| Frontend Developer | React, Vue, CSS, responsive design |
| Backend Architect | APIs, microservices, scalable systems |
| Database Optimizer | Schema design, query optimization, indexing |
| Security Engineer | OWASP, threat modeling, secure code review |
| DevOps Automator | CI/CD, Docker, Kubernetes, cloud infrastructure |
| Mobile App Builder | iOS, Android, React Native, Flutter |
| AI Engineer | ML models, LLM integration, data pipelines |
| UI Designer | Visual design, component libraries, design systems |
| UX Architect | UX patterns, accessibility, information architecture |
| Code Reviewer | Code quality, best practices, constructive feedback |
| Technical Writer | Docs, READMEs, API references, tutorials |
| SRE | Reliability, observability, incident response |
| Data Engineer | ETL, data warehousing, analytics infrastructure |
| Software Architect | System design, DDD, architectural patterns |
| Game Designer | Game mechanics, level design, cross-engine |

And 5 skills: `commit`, `review-pr`, `debug`, `testing`, `impeccable` (frontend design system).

Agents install to `.claude/agents/` and `.codex/agents/` during onboarding. Skills load from `SKILL.md` files in `.claude/skills/`, `.codex/skills/`, or your home directory. Fifony infers the right agent from the issue description and target file paths — capability routing is automatic.

---

## CLI Reference

```bash
# Dashboard + API + scheduler
npx -y fifony --port 4040

# With Vite HMR for frontend development
npx -y fifony --port 4040 --dev

# Headless — scheduler only, no UI
npx -y fifony

# MCP server (stdio)
npx -y fifony mcp

# Different workspace
npx -y fifony --workspace /path/to/repo --port 4040

# Run one scheduler cycle and exit
npx -y fifony --once

# Fine-grained control
npx -y fifony --concurrency 2 --attempts 3 --poll 500
```

---

## MCP Server

Use Fifony as tools inside your editor:

```bash
npx -y fifony mcp --workspace /path/to/repo
```

Add to `claude_desktop_config.json` or VS Code settings:

```json
{
  "mcpServers": {
    "fifony": {
      "command": "npx",
      "args": ["-y", "fifony", "mcp", "--workspace", "/path/to/repo"]
    }
  }
}
```

**Resources**: state summary, all issues, workflow config, runtime guide, per-issue detail

**Tools**: `fifony.status`, `fifony.list_issues`, `fifony.create_issue`, `fifony.update_issue_state`, `fifony.integration_config`

**Prompts**: `fifony-integrate-client`, `fifony-plan-issue`, `fifony-review-workflow`

---

## REST API

Interactive docs at `http://localhost:4040/docs`.

| Endpoint | Description |
|----------|-------------|
| `GET /api/state` | Full runtime state: issues, metrics, config |
| `POST /api/issues/create` | Create an issue |
| `POST /api/issues/enhance` | AI-enhance title and description |
| `POST /api/issues/:id/plan` | Generate execution plan |
| `POST /api/issues/:id/plan/refine` | Refine plan with chat feedback |
| `POST /api/issues/:id/approve` | Approve plan, start execution |
| `POST /api/issues/:id/merge` | Merge workspace to project root |
| `GET /api/live/:id` | Live agent output: PID, log tail, elapsed time |
| `GET /api/diff/:id` | Git diff of workspace changes |
| `GET /api/config/workflow` | Pipeline workflow configuration |
| `GET /api/analytics/tokens` | Token usage summary |
| `GET /api/analytics/hourly` | Hourly usage buckets (48h retention) |
| `GET /api/providers` | Detected providers and availability |
| `GET /api/catalog/agents` | Agent catalog, filterable by domain |
| `POST /api/install/agents` | Install agents to project |
| `/ws` | WebSocket for real-time state updates |

---

## Configuration

Fifony reads a `WORKFLOW.md` in your project root if present. Front matter configures the pipeline; the Markdown body defines the execution contract. Settings from the UI write to `.fifony/s3db/`.

**Environment variables** (all optional when using the UI or WORKFLOW.md):

```bash
FIFONY_WORKSPACE_ROOT=/path/to/repo
FIFONY_PERSISTENCE=/path/to/state     # defaults to $FIFONY_WORKSPACE_ROOT
FIFONY_AGENT_PROVIDER=codex           # codex | claude
FIFONY_WORKER_CONCURRENCY=2
FIFONY_MAX_ATTEMPTS=3
FIFONY_AGENT_MAX_TURNS=4
```

---

## Architecture

```
.fifony/
  s3db/           ← durable database (issues, events, sessions, settings)
  source/         ← project snapshot used for workspace seeding
  workspaces/     ← isolated per-issue execution directories
```

**Persistence**: [s3db.js](https://github.com/forattini-dev/s3db.js) — filesystem-backed key-value store. No external database. All state is fully recoverable across restarts.

**State machine**: The `StateMachinePlugin` enforces valid state transitions. Invalid moves are rejected at the API layer.

**Token tracking**: O(1) in-memory ledger, no I/O on the hot path. Per-phase and per-model breakdown. Daily and hourly rollups via the `EventualConsistencyPlugin`. Cost estimates when the provider reports them.

**Capability routing**: Fifony infers task type from the issue description and target file paths. It derives `capability:<category>` and `overlay:<name>` labels for queue triage. When `paths[]` is omitted, routing falls back to path mentions in the issue text and files changed in an existing workspace.

**Graceful shutdown**: Running issues are marked `Interrupted` on SIGTERM. They resume from the last completed turn on the next boot.

---

## Requirements

- Node.js 23 or newer
- At least one of: `claude` CLI, `codex` CLI

---

## Credits

Fifony is built on the shoulders of:

- **[OpenAI Codex CLI](https://github.com/openai/codex)** — Original foundation (Apache 2.0). See [NOTICE](NOTICE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- **[Agency Agents](https://github.com/msitarzewski/agency-agents)** — Inspiration for the agent catalog.
- **[Impeccable](https://github.com/pbakaus/impeccable)** — Frontend design skill by Paul Bakaus.
- **[s3db.js](https://github.com/forattini-dev/s3db.js)** — Filesystem persistence layer.
- **[DaisyUI](https://daisyui.com)** — Dashboard component library.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

This project includes code from OpenAI Codex CLI. See [NOTICE](NOTICE) for attribution.
