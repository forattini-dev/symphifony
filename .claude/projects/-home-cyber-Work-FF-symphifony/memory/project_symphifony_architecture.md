---
name: symphifony-architecture
description: Symphifony project architecture - multi-agent orchestrator with React dashboard, s3db persistence, planning flow, and PWA support
type: project
---

## Architecture Overview

Symphifony is a filesystem-backed multi-agent orchestrator with TypeScript CLI, MCP mode, and a React dashboard.

**Key directories:**
- `src/runtime/` — Backend: scheduler, agent runner, API server, state machine, providers
- `src/dashboard/src/` — Frontend: React 19 + TanStack Router (filesystem routes) + TanStack Query + DaisyUI 5
- `src/routing/` — Capability routing (frontend-ui, backend, security, docs, etc.)
- `dist/` — Compiled JS (tsup) for production

**State machine:** Todo → Queued → Running → In Review → Done (also Interrupted, Blocked, Cancelled)

**Persistence:** s3db.js with FileSystemClient. Resources: runtime_state, issues, events, settings, agent_sessions, agent_pipelines. EventualConsistency plugin for token analytics.

**Agent pipeline:** planner → executor → reviewer. Each role can have different provider (claude/codex) and reasoning effort.

**Planning flow:** User creates issue → AI generates structured plan → User reviews/approves → Issue created with plan → Agent executor follows the plan steps.

**Build:** `tsup` compiles TS→JS, `vite build` compiles React→static. `npx symphifony --port 4000` runs everything.

**API:** All routes under `/api/*`. Frontend served from `/assets/*` (built) or Vite dev server on port+1.

**Why:** Avoids s3db ApiPlugin catch-all collision between frontend routes and API routes.
