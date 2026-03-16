<div align="center">

# 🎻 Fifony

### AI agents that actually ship code. You just watch.

Point at a repo. Open the dashboard. AI plans, builds, and reviews — you approve.

One command. Full orchestra.

> Local-first runtime. Browser dashboard. MCP server. All batteries included.

</div>

---

## Quick Start

```bash
npx -y fifony --port 4040
```

Done. Open **http://localhost:4040** — you have a full dashboard.

Current directory = workspace. State lives in `.fifony/`. No setup, no config, no accounts.

---

## How It Works

### 1. Create an Issue
Open the dashboard, click "+", type what you want done. The issue starts in **Planning**.

### 2. AI Plans It
Click "Generate Plan" — an AI analyzes your codebase and creates a structured execution plan with steps, risks, file paths, complexity estimate, and tooling decisions.

### 3. You Approve
Review the plan. Approve it → the issue moves to **Todo** and agents pick it up automatically.

### 4. Agents Execute
The configured executor agent (Claude or Codex) implements the changes in an isolated workspace. You can watch live output in the Agents tab.

### 5. Automated Review
A reviewer agent inspects the diff and either approves (→ Done), requests rework (→ back to execution), or blocks for human intervention.

### 6. You Ship
Review the diff in the dashboard, merge the changes.

```
Planning → Todo → Queued → Running → In Review → Done
    ↑                                      ↓
    └──── Blocked ←── Rework ──────────────┘
```

---

## Dashboard

Start with `--port` and get a full browser UI:

| Page | What you see |
|------|-------------|
| **Kanban** | Issues flowing through the pipeline. Stats bar with token usage sparkline. |
| **Issues** | Searchable grid with engineering metrics: cycle time, lead time, tokens, cost, diff stats. |
| **Agents** | Live cockpit: active worker slots with real-time output, queue, recently completed. |
| **Settings** | Workflow config (provider + model + effort per stage), theme, notifications, providers. |

### Workflow Configuration

In **Settings → Workflow**, configure what runs at each pipeline stage:

| Stage | Default | What it does |
|-------|---------|-------------|
| **Plan** | Claude Sonnet (high effort) | Generates structured execution plan |
| **Execute** | Codex (medium effort) | Implements the code changes |
| **Review** | Claude Sonnet (medium effort) | Reviews the diff and decides pass/rework |

Each stage lets you pick: **provider** (Claude or Codex), **model**, and **reasoning effort** (low → extra-high).

### PWA

Install it as a desktop app. Works offline. Desktop notifications when issues change state.

---

## MCP Server

Turn Fifony into tools for your editor:

```bash
npx -y fifony mcp
```

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

Create issues, check status, review workflows — all without leaving the editor.

---

## API

Full REST + WebSocket API with auto-generated OpenAPI docs:

```
http://localhost:4040/docs
```

Key endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /api/state` | Full runtime state with issues, metrics, config |
| `POST /api/issues/create` | Create a new issue |
| `POST /api/issues/:id/plan` | Generate AI plan for an issue |
| `POST /api/issues/:id/approve` | Approve plan and start execution |
| `GET /api/live/:id` | Live agent output (PID, log tail, elapsed) |
| `GET /api/diff/:id` | Git diff of workspace changes |
| `GET /api/config/workflow` | Get/set pipeline workflow config |
| `GET /api/analytics/tokens` | Token usage analytics |
| `/ws` | WebSocket for real-time state updates |

---

## Run Modes

```bash
# Full experience — dashboard + API + scheduler
npx -y fifony --port 4040

# Dev mode — Vite HMR on port+1
npx -y fifony --port 4040 --dev

# Headless — just the scheduler, no UI
npx -y fifony

# MCP server — stdio for editor integration
npx -y fifony mcp

# Custom workspace
npx -y fifony --workspace /path/to/repo --port 4040
```

---

## Architecture

```
.fifony/           ← all state lives here (gitignore it)
  s3db/                ← durable database (issues, events, sessions, settings)
  source/              ← snapshot of your codebase
  workspaces/          ← one per issue (isolated agent workspace)
```

**Persistence**: [s3db.js](https://github.com/forattini-dev/s3db.js) with FileSystemClient. Issues, events, settings, agent sessions — all persisted and recoverable.

**State Machine**: `Planning → Todo → Queued → Running → Interrupted → In Review → Blocked → Done → Cancelled`

**Agent Protection**: Detached child processes survive server restarts. PID tracking for recovery. Graceful shutdown marks running issues as Interrupted.

**Token Analytics**: EventualConsistency plugin tracks token usage per model with daily/weekly rollups.

---

## License

MIT
