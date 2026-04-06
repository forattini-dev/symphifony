# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Principles

- Always use simple, minimal solutions first. Do not over-engineer. If a one-liner or existing utility exists, use it instead of building a new abstraction.
- All new code must be TypeScript unless modifying an existing JS file. Use strict types, avoid `any`.

## What is fifony

Filesystem-backed local orchestrator with a TypeScript CLI, MCP mode, and multi-agent (Claude/Codex/Gemini) workflows. AI plans, executes, and reviews code — the user approves and merges. State lives in `.fifony/` (SQLite via s3db.js). No cloud, no accounts.

## Commands

```bash
pnpm dev              # API (port 4000) + frontend HMR (port 5173)
pnpm dev:api          # API only
pnpm dev:ui           # Frontend only (Vite, proxies to :4000)
pnpm build            # tsup (backend) + vite (frontend)
pnpm test             # node --import tsx/esm --test 'tests/**/*.test.ts'
pnpm mcp              # MCP server (stdio)
pnpm prompts:generate # Compile .md templates → src/agents/generated/prompts.ts
```

Always use **pnpm**. `prompts:generate` runs automatically before dev/build/start.

## Architecture

Centralize state machine logic in the state machine module. Do not scatter state transitions across services, hooks, or UI components.

**Runtime:** Node.js 23+ ESM. **Backend:** TypeScript + s3db.js + Pino. **Frontend:** React 19 + TanStack Router/Query + Tailwind + DaisyUI. **Build:** tsup (backend) → `dist/`, Vite (frontend) → `app/dist/`.

### Hexagonal (Ports & Adapters)

- **Ports** (`src/ports/index.ts`): `IIssueRepository`, `IEventStore`, `IQueuePort`, `IPersistencePort`
- **Adapters** (`src/persistence/`): s3db-backed implementations with dirty tracking
- **Container** (`src/persistence/container.ts`): wires ports → adapters
- **Commands** (`src/commands/`): use-case handlers that depend on ports, not adapters. Key commands: `transitionIssueCommand` (generic BFS path finder), `approvePlanCommand`, `executeIssueCommand`, `replanIssueCommand`, `retryExecutionCommand`, `requestReworkCommand`, `cancelIssueCommand`, `mergeWorkspaceCommand`, `pushWorkspaceCommand`

### GAN-Inspired Evaluation Loop

The harness uses a **Generator vs. Evaluator** pattern inspired by GANs:

- **Sprint contracts**: The planner emits structured `acceptanceCriteria[]` + `executionContract` before execution starts. Both executor and reviewer reference the same objective ground truth.
- **Adversarial reviewer**: The reviewer is explicitly prompted to be skeptical. It grades each AC as `PASS`/`FAIL`/`SKIP` and emits a machine-readable `grading_report` JSON block.
- **Pre-review validation gate** ("shift feedback left"): `runValidationGate()` runs immediately after execution succeeds, before the reviewer spawns. If `testCommand` is configured and fails, the issue transitions to Blocked (or Cancelled if `maxAttempts` exhausted) without spending a review cycle. Result stored in `issue.preReviewValidation` and injected into the review prompt so the reviewer sees test output.
- **Auto-requeue on FAIL**: `runReviewOnce()` parses the grading report. If verdict is `FAIL` and `reviewAttempt < maxReviewAutoRetries` (default 1), it automatically calls `requestReworkCommand` — no human needed. Budget exhausted → escalates to human via `PendingDecision`.
- **Retry context injection**: `buildRetryContext()` injects the prior grading FAIL details (per-criterion evidence) into the executor's next prompt so it knows exactly what to fix.
- **Auto-replan on stall** (opt-in): When `autoReplanOnStall: true`, stall detection runs in the execution failure path. If the last N attempts share the same `errorType` (from `extractFailureInsights()`), `replanIssueCommand` is triggered instead of re-queuing. Guarded by `planVersion < 4` to prevent infinite replan loops. Config: `autoReplanOnStall` (default `false`), `autoReplanStallThreshold` (default `DEFAULT_AUTO_REPLAN_STALL_THRESHOLD = 2`).
- **Playwright MCP (optional)**: When `enablePlaywrightReview: true` and frontend files changed, the reviewer CLI receives `--mcp-config` pointing to `@playwright/mcp` so it can verify UI changes live. A warning event is logged if no dev servers are configured.

FSM path for auto-requeue loop:
```
Running → [pre-review gate FAIL] → Blocked (or Cancelled)
        → [pre-review gate PASS or no testCommand] → Reviewing
                    → [FAIL + budget left] → Queued (auto, with failure context)
                    → [FAIL + budget exhausted] → PendingDecision (human escalation)
                    → [PASS] → PendingDecision (normal human approval)
```

Key types: `AcceptanceCriterion`, `ExecutionContract`, `GradingReport`, `GradingCriterion`, `ValidationResult` — all in `src/types.ts`.
Key files: `src/agents/prompts/compile-review.stub.md`, `src/agents/adapters/shared.ts` (`normalizeAcceptanceCriteria`, `deriveExecutionContract`), `src/persistence/plugins/fsm-agent.ts` (`extractGradingReport`, `buildGradingFailureSummary`, `ensurePlaywrightMcpConfig`, `resolveMaxTurns`), `src/domains/validation.ts` (`runValidationGate`), `src/agents/failure-analyzer.ts` (`extractFailureInsights`), `src/persistence/settings.ts`.
Config: `state.config.maxReviewAutoRetries` (default `DEFAULT_MAX_REVIEW_AUTO_RETRIES = 1`), `state.config.enablePlaywrightReview` (default `false`), `state.config.autoReplanOnStall` (default `false`), `state.config.autoReplanStallThreshold` (default `2`). Exposed in Settings → Workflow → Review Quality.

### State Machine (Issue Lifecycle)

```
Planning → PendingApproval → Queued → Running → Reviewing → PendingDecision → Approved → Merged
  (AI)       (Human)          (queue)   (AI)      (AI)         (Human)          (Human)
```

10 states. Defined in `src/persistence/plugins/fsm-issue.ts`. Transitions dispatched via s3db StateMachinePlugin using `afterEnter` hooks (not legacy `entry` actions). Hooks enqueue jobs via lazy imports to break circular deps. Terminal states: `Merged`, `Cancelled`. Legacy state names (`Planned`, `Reviewed`, `Done`) auto-migrated via `parseIssueState()`. Diff stats are synced at approval time (PendingDecision → Approved) via `syncIssueDiffStatsToStore()`, not at merge time.

**States by actor:**

| Actor | States | What happens |
|-------|--------|-------------|
| AI | Planning, Queued, Running, Reviewing | Machine is working — no human action needed |
| Human | PendingApproval, PendingDecision, Approved | Waiting for human decision (approve plan / approve+rework+replan / merge) |
| System | Blocked | Failed, waiting for retry or intervention |
| Terminal | Merged, Cancelled | Done |

**Kanban columns** map to actor, not state: Planning, Needs Approval (human), In Progress (AI), Blocked, Done.

#### FSM events

| Event | Transition | Trigger |
|-------|-----------|---------|
| PLANNED | Planning → PendingApproval | Plan generated |
| QUEUE | PendingApproval → Queued | `approvePlanCommand` |
| RUN | Queued → Running | Queue dispatch |
| REVIEW | Running → Reviewing | Execution succeeded |
| REVIEWED | Reviewing → PendingDecision | Review completed |
| APPROVE | PendingDecision → Approved | Reviewer approved |
| MERGE | Approved → Merged | User merges |
| BLOCK | Running/Reviewing → Blocked | Stale timeout or failure |
| UNBLOCK | Blocked → Queued | `retryExecutionCommand` |
| REPLAN | PendingApproval/PendingDecision/Blocked → Planning | `replanIssueCommand` |
| REQUEUE | PendingDecision → Queued | `requestReworkCommand` (reviewer rework) |
| CANCEL | Most states → Cancelled | `cancelIssueCommand` |
| REOPEN | Merged/Cancelled → Planning | Reopen for rework |

#### Retry semantics — plan, execute, and review retries are distinct operations

| Operation | Command | FSM path | Counters affected |
|-----------|---------|----------|-------------------|
| Plan (1st) | auto (`onEnterPlanning`) | `→ Planning` | `planVersion` 0→1 |
| **Replan** | `replanIssueCommand` | `→ Planning` | `planVersion++`, archives plan to `planHistory`, resets `executeAttempt`/`reviewAttempt` |
| **Auto-replan** (stall) | `replanIssueCommand` (harness-driven, opt-in) | `Running → Planning` | Same as replan. Triggered when same `errorType` repeats N times. Guarded: `autoReplanOnStall: true`, `planVersion < 4` |
| Execute (1st) | `executeIssueCommand` | `PendingApproval → Queued` | `executeAttempt` 0→1 (at run time) |
| **Re-execute** | `retryExecutionCommand` | `Blocked → Queued` | `attempts++` (budget), `executeAttempt++` at run time. `onEnterQueued` archives failure to `previousAttemptSummaries`. `buildRetryContext()` injects prior failure insights into prompt |
| Review (1st) | auto (`onEnterReviewing`) | `Running → Reviewing` | `reviewAttempt` 0→1 |
| **Auto-rework** (GAN FAIL) | `requestReworkCommand` (auto, harness-driven) | `Reviewing → Queued` | `reviewAttempt++`, `lastFailedPhase="review"`, `issue.gradingReport` stored. `buildRetryContext()` injects grading FAIL evidence per criterion |
| **Human rework** | `requestReworkCommand` (human-triggered) | `PendingDecision → Queued` | `attempts++`, `lastFailedPhase="review"`. Same FSM path but initiated by user via drawer |

Each variant has its own artifact versioning: `plan.v{N}`, `execute.v{N}a{M}`, `review.v{N}a{M}`.

**Auto-rework budget**: controlled by `state.config.maxReviewAutoRetries` (default `1`). When budget exhausted, harness escalates to `PendingDecision` with FAIL context visible in drawer.

### Key Layers

| Layer | Path | Role |
|-------|------|------|
| Types | `src/types.ts` | All domain types (`IssueEntry`, `RuntimeState`, `IssueState`) |
| Constants | `src/concerns/constants.ts` | Paths, env resolution, `ALLOWED_STATES`, `TERMINAL_STATES`, `DEFAULT_MAX_TURNS`, `DEFAULT_MAX_TURNS_BY_MODE`, `DEFAULT_AUTO_REPLAN_STALL_THRESHOLD` |
| Domains | `src/domains/` | Pure business logic — no I/O (issues, workspace/git, project, config) |
| Persistence | `src/persistence/` | s3db resources, plugins, dirty tracker, store |
| Routes | `src/routes/` | HTTP handlers — registered via `register*Routes(collector, state)` in `api-server.ts` |
| Agents | `src/agents/` | Provider detection, CLI wrapping, prompt rendering, session tracking, usage collection |
| Chat | `src/agents/chat/` | AI operator console — action parsing, execution, session persistence, prompt rendering |
| Sandbox | `src/domains/sandbox.ts` | ai-jail + bubblewrap binary lifecycle, sandbox command wrapping |
| Commands | `src/commands/` | Hexagonal use-case handlers |
| MCP | `src/mcp/` | MCP server (stdio transport, JSON-RPC 2.0) |
| CLI | `src/cli.ts` | Entry point, arg parsing, command dispatch |
| Boot | `src/boot.ts` | Process entry: setup → store → early API → load state → detect → queue init → hold. No scheduler loop — queue is event-driven |

### Provider Usage Collection

`src/agents/providers-usage.ts` — PTY-based CLI interaction via `node-pty` to collect real-time usage/status from provider CLIs.

- **Collection**: Spawns provider CLI, sends slash commands (`/usage`, `/status`, `/stats session`), captures and parses terminal output via `collectProviderStatusText()`.
- **Parsers**: `parseClaudeUsageFromStatus()`, `parseCodexUsageFromStatus()`, `parseGeminiUsageFromStatus()` — extract token counts (all-time/daily/weekly/session), rate limits, reset times, plan, account info.
- **Adapters** (`src/agents/adapters/usage.ts`): Per-provider wrappers (`collectClaudeUsageFromCli`, `collectCodexUsageFromCli`, `collectGeminiUsageFromCli`) that combine collection + parsing.
- **Route**: `GET /api/providers/usage/:provider` — collects usage for a single provider by slug.
- **Data types**: `ProviderUsageSnapshot` (comprehensive snapshot), `RateLimitEntry` (per-limit with scope/period/percentUsed/resetInfo).

### Provider Adapter CLI Flags

| Provider | Usage command | Key CLI flags |
|----------|-------------|---------------|
| Claude | `/usage` | `--bare` (structured output), `--permission-mode plan` (read-only roles) |
| Codex | `/status` | `--skip-git-repo-check`, `--dangerously-bypass-approvals-and-sandbox` |
| Gemini | `/stats session` | `--approval-mode plan` (read-only), `--screen-reader` (text-only), `--output-format json`, `-p ""` (headless) |

### Frontend

File-based routing via TanStack Router in `app/src/routes/`. Home page redirects to `/chat`. Key views: `/chat` (AI operator console), `/chat/:issueId` (issue-focused chat), `/kanban` (board), `/issues` (list), `/agents` (cockpit), `/analytics`, `/settings`. PWA with service worker. Vite proxies `/api` and `/ws` to backend in dev.

#### Keyboard Shortcuts

Uses `react-hotkeys-hook` with `HotkeysProvider` wrapper in `__root.jsx`. All shortcuts registered via `useHotkeys()` with description metadata and group tags for discoverable help.

| Scope | Shortcuts |
|-------|-----------|
| Global | `Esc` (close topmost), `Shift+/` (help), `Ctrl+K` (command palette), `R` (refresh), `E` (toggle events) |
| Navigation | `C` (chat), `N` (new), `K` (kanban), `I` (issues), `A` (agents), `T` (analytics), `S` (settings) |
| Drawer | `]`/`[` (tab nav), `J`/`K` (next/prev issue), `Ctrl+Enter` (primary action), `Ctrl+A` (approve), `Ctrl+M` (merge), `Ctrl+W` (rework), `Ctrl+P` (replan) |
| Kanban | `1`–`5` (jump to column) |
| Issues list | `/` (focus search), `J`/`K` (next/prev), `Enter` (open), `F` (toggle filters), `X` (clear all) |

Shortcuts are context-aware: kanban/issues shortcuts auto-disable when drawer is open. Drawer shortcuts only activate with an open drawer.

#### Command Palette

`app/src/components/CommandPalette.jsx` — fuzzy search modal (`Ctrl+K`) over issues, navigation commands, and action commands. Arrow keys or `Ctrl+J/K` to navigate, `Enter` to execute.

#### Voice Input (Speech-to-Text)

`CreateIssueForm` integrates Web Speech API for voice dictation on title/description fields. Uses browser default language. Mic button per field with visual recording indicator.

#### Settings Tabs

`/settings/project` (Project), `/settings/workflow` (Execution — Review Quality: `maxReviewAutoRetries` slider 0–5, `enablePlaywrightReview` toggle, `autoReplanOnStall` toggle, `autoReplanStallThreshold` slider 2–5; Execution Limits: `maxTurns` slider 5–50; Execution Mode: Host/Sandbox/Docker 3-way radio; Auto-approve trivial/low plans toggle), `/settings/agents` (Agents — 6-stage pipeline config with onboarding-style visual cards: enhance/chat/plan/execute/review/services, each with provider/model/effort), `/settings/preferences` (Preferences — theme), `/settings/general` (System), `/settings/notifications` (Notifications), `/settings/providers` (Providers — usage/rate limits), `/settings/hotkeys` (Hotkeys).

#### Providers View

`ProvidersView` displays per-provider usage snapshots with rate limit breakdowns: `RateLimitBar` shows scope (Global/Session/Model), period (5h/Week/Daily/Session), percent used with color-coded progress bars.

### Persistence (s3db.js)

SQLite at `.fifony/fifony.sqlite`. Resources: `issues`, `events`, `runtime_state`, `settings`, `agent_sessions`, `agent_pipelines`. Plugins: 3 StateMachinePlugins (Issue FSM `state-machine`, Service FSM `service-state-machine`, Agent FSM `agent-state-machine`), S3QueuePlugin (job queue), ApiPlugin (HTTP+WS), EventualConsistencyPlugin (analytics). All FSMs use `afterEnter` hooks and function triggers — no manual watchers. In-memory dirty tracking — only modified issues flush to disk.

### Unified Work Queue

`src/persistence/plugins/queue-workers.ts` — single queue replaces the old 3-queue system and scheduler loop.

- **Phase ordering**: review → execute → plan. Closest-to-done drains first.
- **Semaphore**: shared `workerConcurrency` limit. Planning runs outside (doesn't occupy a slot).
- **Dispatch guards**: `canDispatch()` checks assignedToWorker, terminal states, deps resolved, agent alive — absorbed from the deleted `canRunIssue`.
- **Periodic tasks**: stale check (30s interval), persist (5s interval) — replaces the old boot.ts polling loop.
- **Boot recovery**: `recoverState()` reconciles FSM, enqueues in-progress issues. `recoverOrphans()` handles PID recovery. `cleanTerminalWorkspaces()` cleans merged/cancelled.
- **No scheduler, no polling** — dispatch is event-driven via `enqueue()` → `drain()`.

### Chat (AI Operator Console)

`src/agents/chat/` — fullscreen AI chat interface for orchestrating issues and services.

- **Routes**: `/chat` (global operator console), `/chat/:issueId` (issue-focused with context). Home (`/`) redirects to `/chat`.
- **Backend**: `src/routes/chat.ts` + `src/agents/chat/` modules: `chat-prompt.ts` (system prompt rendering), `chat-session.ts` (session CRUD), `action-parser.ts` (structured action block extraction), `action-executor.ts` (action dispatch — create-issue, start-service, etc.).
- **Session persistence**: JSON files at `.fifony/chat-sessions/issue-{id}.json`. Sessions are per-issue or global.
- **Frontend**: `app/src/routes/chat/index.jsx` (global), `app/src/routes/chat/$issueId.jsx` (issue-focused). Issue sidebar for context selection. Markdown rendering for AI responses. Optimistic UI — user messages appear immediately.
- **Hook**: `useChat()` in `app/src/hooks/useChat.js`.

### 6-Stage Pipeline Configuration

Expanded from 3 stages (plan/execute/review) to 6 independently configurable stages:

| Stage | Role | Type key |
|-------|------|----------|
| Enhance | Issue enrichment before planning | `enhancer` |
| Chat | AI operator console conversations | `chatter` |
| Plan | Plan generation | `planner` |
| Execute | Code execution | `executor` |
| Review | Adversarial review (GAN) | `reviewer` |
| Services | Service analysis | `services-analyst` |

Each stage has its own `PipelineStageConfig` (provider/model/effort). Type: `WorkflowConfig` in `src/types.ts`. Roles: `AgentProviderRole`. Settings UI: onboarding-style visual cards in `/settings/agents`.

### Sandbox Execution (ai-jail)

Lightweight process isolation alternative to Docker for agent execution.

- **Domain**: `src/domains/sandbox.ts` — manages ai-jail + bubblewrap binary lifecycle (auto-download to `~/.fifony/bin/`).
- **3-way config**: `Host` (no isolation), `Sandbox` (ai-jail + bwrap), `Docker` (container). Setting: `state.config.sandboxExecution` (boolean) + `state.config.dockerExecution` (boolean).
- **Flow**: `ensureSandboxBinaries()` downloads platform-specific ai-jail and bubblewrap binaries on first use. `wrapWithSandbox(cmd, worktreePath)` wraps shell commands to run inside ai-jail with the worktree as RW project dir.
- **Integration**: `src/agents/command-executor.ts` checks config and wraps execution commands accordingly.

### Service FSM (s3db StateMachinePlugin)

Service lifecycle is managed via a declarative s3db StateMachinePlugin in `src/persistence/plugins/fsm-service.ts`.

- **States**: `stopped` → `starting` → `running` → `stopping` → `crashed`
- **Hooks**: `afterEnter` hooks on all 5 states (spawnService, sendSigterm, recordCrash, onEnterStopped, onEnterRunning). Machine-level `afterTransition` hook handles WS broadcast + log broadcaster lifecycle.
- **Triggers**: Function triggers (5s interval) handle all automatic transitions: process death detection, startup grace period (3s), SIGKILL timeout (5s), auto-restart with exponential backoff. **No manual watcher** — all driven by s3db.js plugin.
- **Process cleanup**: `cleanupServiceProcesses(pid, port)` kills entire process tree + discovers all bound ports via `lsof`. Runs on every path to "stopped" state.
- **Service dashboard** (`app/src/routes/services.lazy.jsx`): Quick restart button (atomic stop+start), error counter (scans logs for ERROR/Exception/FATAL), health check ping (per-service port polling), compact grid cards with dense stats.
- **Log viewer**: `src/persistence/plugins/service-log-broadcaster.ts` — uses `@logdna/tail-file` for robust file tailing (inode-aware rotation, truncation handling, 250ms poll). Buffers chunks when no WS subscribers. Auto-cleanup on service stop.
- **Log rotation**: Last 3 executions preserved (`.log`, `.log.1`, `.log.2`). API: `GET /log/generations`, `GET /log/history/:gen`. UI: tabbed viewer in service drawer.

### Agent FSM (s3db StateMachinePlugin)

Agent process lifecycle managed via s3db StateMachinePlugin in `src/persistence/plugins/fsm-agent.ts`.

- **States**: `idle` → `preparing` → `running` → `done`/`failed`/`crashed`
- **Hooks**: `afterEnter` hooks on crashed (update job file), done/failed (cleanup job file + stop log broadcaster). Machine-level `afterTransition` broadcasts WS state.
- **Triggers**: Function trigger on "running" (5s) checks if agent PID is alive → fires CRASH on death.
- **Job files**: `agent-{safeId}.job.json` persists agent state across fifony restarts. Boot reconciliation marks dead agents as "crashed".
- **Relationship**: Each Issue FSM phase (plan/execute/review) spawns an Agent FSM instance. Agent completion drives Issue FSM transitions.

### Mesh Traffic Proxy (Experimental)

Inter-service traffic capture via HTTP proxy for observability.

- **Backend**: `src/persistence/plugins/traffic-proxy-server.ts` — HTTP proxy that captures inter-service requests. `src/routes/traffic.ts` — traffic API routes.
- **Frontend**: `app/src/hooks/useMesh.js` — WS-based real-time traffic broadcast hook. Traffic view integrated into services page.
- **Config**: Services restart on proxy toggle (env vars applied). `NO_PROXY` includes all service ports to prevent loop.

### WebSocket Reliability

- **Heartbeat**: Client sends `{ type: "ping" }` every 25s to prevent proxy/NAT idle timeout. Server responds with pong.
- **Direct push**: `broadcastIssueTransition()` in `src/persistence/plugins/fsm-issue.ts` pushes state changes via WS immediately on FSM transitions.
- **Stale poll cancellation**: `applyWsPayload` gated to state messages only (prevents cache pollution). Stale HTTP polls cancelled when WS delivers fresh data.
- **Service log re-subscribe**: Active service log room subscriptions are re-sent on WS reconnect.
- **API state polling**: Disabled when WS is connected — WS push is sufficient.

### Execution Reliability

- **CWD fix**: Executor CWD fixed to worktree (was management dir — root cause of prior failures). Daemon artifacts separated from CWD.
- **Worktree hygiene**: Stale git worktree cleanup before creation.
- **Auto-approve**: Trivial/low complexity plans auto-approve (skip PendingApproval → go straight to Queued). Configurable via Settings → Workflow.
- **Fast mode**: Bug/chore issues use fast mode planning for quicker turnaround.
- **Review skip**: Solo mode skips automated reviewer. Standard mode + trivial complexity skips review (validation gate is sufficient).
- **Simplicity enforcement**: Enhance and planning prompts explicitly enforce simplicity to prevent over-engineering.

## Testing

Uses Node.js native `node:test` module with `assert/strict`. Tests in `tests/`. Temp dirs via `mkdtempSync`, cleanup with `after()` hooks.

## Patterns to Follow

- **Logger**: `import { logger } from "../concerns/logger.ts"` — Pino singleton. Always `logger.error({ err }, "msg")` with the error object.
- **Dirty tracking**: Call `markIssueDirty(id)` after mutating an issue in-memory.
- **Circular deps**: FSM `afterEnter` hooks use lazy `await import()` for queue-workers.
- **Route registration**: Export `register*Routes(collector, state)`, call from `api-server.ts`.
- **Domain purity**: `src/domains/` must not import from `src/persistence/` or do I/O.
- **State transitions**: Go through the state machine (`send()`), never mutate `issue.state` directly.
- **Retry semantics**: Use the specific command for each retry type — `replanIssueCommand` for re-planning, `retryExecutionCommand` for re-execution from Blocked, `requestReworkCommand` for reviewer-requested rework (both auto-GAN and human-triggered). Never conflate them — they have different counter resets, FSM paths, and prompt injection.
- **GAN evaluation loop**: Auto-rework path is harness-driven (`runReviewOnce()` → `requestReworkCommand`). Do not wire review retries through `retryExecutionCommand` or `replanIssueCommand`. `gradingReport` is set by `extractGradingReport()` after each review; `buildRetryContext()` injects per-criterion FAIL evidence automatically.
- **Pre-review gate**: `runValidationGate()` from `src/domains/validation.ts` is called in `runExecuteOnce` success path (same function already used at merge/push time). Result stored as `issue.preReviewValidation`. Gate failure sets `lastFailedPhase="execute"` and transitions to Blocked, not Reviewing. Never call the gate from review code.
- **Auto-replan on stall**: Stall detection lives in `runExecuteOnce` failure path (not in `fsm-issue.ts`) because it needs `state.config` access. Uses `extractFailureInsights()` to get current attempt's `errorType`, compares against last N entries in `previousAttemptSummaries`. Triggers `replanIssueCommand` via dynamic import (circular dep avoidance). Default off — must be explicitly enabled.
- **maxTurns resolution**: Use `resolveMaxTurns(issue, config)` in `fsm-agent.ts` instead of `state.config.maxTurns ?? 10`. Per-mode defaults: solo=10, standard=20, contractual=30. User config override wins. Never hard-code `10`.
- **Acceptance criteria**: `normalizeAcceptanceCriteria(plan)` and `deriveExecutionContract(plan)` in `src/agents/adapters/shared.ts` handle backward compat for old plans (no `acceptanceCriteria` field). Always use these helpers — never access `plan.acceptanceCriteria` directly in adapter code.
- **Queue dispatch**: Use `enqueue(issue, "plan"|"execute"|"review")` — never call `runIssueOnce` or `runPlanningJob` directly. The queue handles concurrency, guards, and ordering.
- **No scheduler**: The unified queue handles stale checks and persist via intervals. `boot.ts` just holds the process alive after queue init.
- **Keyboard shortcuts**: Register via `useHotkeys()` from `react-hotkeys-hook` in `__root.jsx` with `{ description, metadata: { group } }`. Use `enabled` guards to scope shortcuts (e.g., `enabled: noDrawer`). Never add standalone `useEffect` keydown listeners.
- **React hooks**: Never place hooks after early returns. All hooks must be called unconditionally at the top of the component.
- **Provider usage**: Use per-provider collection (`collectClaudeUsageFromCli`, etc.) from `src/agents/adapters/usage.ts`. The legacy aggregate endpoint is a fallback only.
- **Providers usage hook**: `useProvidersUsage()` fetches per-page (in settings/providers), not in global DashboardContext.
- **Chat sessions**: Session files live in `.fifony/chat-sessions/`. Use `src/agents/chat/chat-session.ts` for CRUD — never read/write session JSON directly from routes or frontend.
- **Sandbox wrapping**: Use `wrapWithSandbox()` from `src/domains/sandbox.ts`. Never shell out to ai-jail directly. The domain handles binary download, platform detection, and bwrap path injection.
- **WS broadcast on transitions**: Use `broadcastIssueTransition()` in `fsm-issue.ts` for real-time push. Never rely solely on HTTP polling for state updates — WS push is the primary channel.
- **Pipeline stages**: 6 stages (enhance/chat/plan/execute/review/services). Each has its own `PipelineStageConfig` in `WorkflowConfig`. Use `AgentProviderRole` type for stage roles. Never hard-code the old 3-stage assumption.
- **Service FSM**: Service state transitions go through the s3db StateMachinePlugin `afterEnter` hooks in `fsm-service.ts`. Never mutate service state directly. No manual watcher — function triggers handle all automatic transitions.
- **Agent FSM**: Agent process lifecycle via s3db StateMachinePlugin in `fsm-agent.ts`. Function trigger detects PID death. `afterEnter` hooks handle crash/done/failed cleanup. No manual watcher.
- **FSM hooks**: All 3 FSMs (Issue, Service, Agent) use `afterEnter` hooks instead of legacy `entry` actions. Use `afterTransition` machine-level hooks for cross-cutting concerns (WS broadcast, log broadcaster).
- **Mesh proxy**: Traffic proxy is opt-in. Services restart when proxy is toggled. Always include all service ports in `NO_PROXY` to prevent proxy loops.

## Git Operations

- When `git push` fails due to SSH timeout, retry with HTTPS: `git remote set-url origin https://github.com/<user>/<repo>.git && git push`

## tsup Entry Points

| Entry | Source | Output |
|-------|--------|--------|
| CLI | `src/cli.ts` | `dist/cli.js` |
| Agent runner | `src/boot.ts` | `dist/agent/run-local.js` |
| CLI wrapper | `src/agents/cli-wrapper.ts` | `dist/agent/cli-wrapper.js` |
| MCP server | `src/mcp/server.ts` | `dist/mcp/server.js` |

<!-- FIFONY:START — managed by fifony, do not edit manually -->
## Fifony — Installed Capabilities

This workspace has fifony-managed agents and skills installed.

**Skills**: openspec-apply-change, openspec-archive-change, openspec-bulk-archive-change, openspec-continue-change, openspec-explore, openspec-ff-change, openspec-new-change, openspec-onboard, openspec-sync-specs, openspec-verify-change, commit, debug, impeccable, review-pr, testing, adapt, animate, audit, bolder, clarify, colorize, critique, delight, distill, extract, frontend-design, harden, normalize, onboard, optimize, polish, quieter, teach-impeccable
**Agents**: academic__academic-anthropologist, academic__academic-geographer, academic__academic-historian, academic__academic-narratologist, academic__academic-psychologist, ai-engineer, code-reviewer, continuous-learning-v2__observer-1, continuous-learning-v2__observer-2, continuous-learning-v2__observer, database-optimizer, default__business-logic-reviewer, default__code-reviewer, default__codebase-explorer, default__consequences-reviewer, default__dead-code-reviewer, default__nil-safety-reviewer, default__review-slicer, default__security-reviewer, default__test-reviewer, default__write-plan, design__design-brand-guardian, design__design-image-prompt-engineer, design__design-inclusive-visuals-specialist, design__design-ui-designer, design__design-ux-architect, design__design-ux-researcher, design__design-visual-storyteller, design__design-whimsy-injector, dev-team__backend-engineer-golang, dev-team__backend-engineer-typescript, dev-team__devops-engineer, dev-team__frontend-bff-engineer-typescript, dev-team__frontend-designer, dev-team__frontend-engineer, dev-team__helm-engineer, dev-team__prompt-quality-reviewer, dev-team__qa-analyst-frontend, dev-team__qa-analyst, dev-team__sre, dev-team__ui-engineer, engineering__engineering-ai-data-remediation-engineer, engineering__engineering-ai-engineer, engineering__engineering-autonomous-optimization-architect, engineering__engineering-backend-architect, engineering__engineering-code-reviewer, engineering__engineering-data-engineer, engineering__engineering-database-optimizer, engineering__engineering-devops-automator, engineering__engineering-embedded-firmware-engineer, engineering__engineering-feishu-integration-developer, engineering__engineering-frontend-developer, engineering__engineering-git-workflow-master, engineering__engineering-incident-response-commander, engineering__engineering-mobile-app-builder, engineering__engineering-rapid-prototyper, engineering__engineering-security-engineer, engineering__engineering-senior-developer, engineering__engineering-software-architect, engineering__engineering-solidity-smart-contract-engineer, engineering__engineering-sre, engineering__engineering-technical-writer, engineering__engineering-threat-detection-engineer, engineering__engineering-wechat-mini-program-developer, everything-claude-code__architect, everything-claude-code__build-error-resolver, everything-claude-code__chief-of-staff, everything-claude-code__code-reviewer, everything-claude-code__cpp-build-resolver, everything-claude-code__cpp-reviewer, everything-claude-code__database-reviewer, everything-claude-code__doc-updater, everything-claude-code__docs-lookup, everything-claude-code__e2e-runner, everything-claude-code__flutter-reviewer, everything-claude-code__go-build-resolver, everything-claude-code__go-reviewer, everything-claude-code__harness-optimizer, everything-claude-code__java-build-resolver, everything-claude-code__java-reviewer, everything-claude-code__kotlin-build-resolver, everything-claude-code__kotlin-reviewer, everything-claude-code__loop-operator, everything-claude-code__planner, everything-claude-code__python-reviewer, everything-claude-code__pytorch-build-resolver, everything-claude-code__refactor-cleaner, everything-claude-code__rust-build-resolver, everything-claude-code__rust-reviewer, everything-claude-code__security-reviewer, everything-claude-code__tdd-guide, everything-claude-code__typescript-reviewer, finance-team__accounting-specialist, finance-team__budget-planner, finance-team__financial-analyst, finance-team__financial-modeler, finance-team__metrics-analyst, finance-team__treasury-specialist, finops-team__finops-analyzer, finops-team__finops-automation, finops-team__infrastructure-cost-estimator, fixtures__sample-agent, frontend-developer, game-development__blender__blender-addon-engineer, game-development__game-audio-engineer, game-development__game-designer, game-development__godot__godot-gameplay-scripter, game-development__godot__godot-multiplayer-engineer, game-development__godot__godot-shader-developer, game-development__level-designer, game-development__narrative-designer, game-development__roblox-studio__roblox-avatar-creator, game-development__roblox-studio__roblox-experience-designer, game-development__roblox-studio__roblox-systems-scripter, game-development__technical-artist, game-development__unity__unity-architect, game-development__unity__unity-editor-tool-developer, game-development__unity__unity-multiplayer-engineer, game-development__unity__unity-shader-graph-artist, game-development__unreal-engine__unreal-multiplayer-architect, game-development__unreal-engine__unreal-systems-engineer, game-development__unreal-engine__unreal-technical-artist, game-development__unreal-engine__unreal-world-builder, integrations__mcp-memory__backend-architect-with-memory, ja-jp__architect, ja-jp__build-error-resolver, ja-jp__code-reviewer, ja-jp__database-reviewer, ja-jp__doc-updater, ja-jp__e2e-runner, ja-jp__go-build-resolver, ja-jp__go-reviewer, ja-jp__planner, ja-jp__python-reviewer, ja-jp__refactor-cleaner, ja-jp__security-reviewer, ja-jp__tdd-guide, ko-kr__architect, ko-kr__build-error-resolver, ko-kr__code-reviewer, ko-kr__database-reviewer, ko-kr__doc-updater, ko-kr__e2e-runner, ko-kr__go-build-resolver, ko-kr__go-reviewer, ko-kr__planner, ko-kr__refactor-cleaner, ko-kr__security-reviewer, ko-kr__tdd-guide, marketing__marketing-ai-citation-strategist, marketing__marketing-app-store-optimizer, marketing__marketing-baidu-seo-specialist, marketing__marketing-bilibili-content-strategist, marketing__marketing-book-co-author, marketing__marketing-carousel-growth-engine, marketing__marketing-china-ecommerce-operator, marketing__marketing-content-creator, marketing__marketing-cross-border-ecommerce, marketing__marketing-douyin-strategist, marketing__marketing-growth-hacker, marketing__marketing-instagram-curator, marketing__marketing-kuaishou-strategist, marketing__marketing-linkedin-content-creator, marketing__marketing-livestream-commerce-coach, marketing__marketing-podcast-strategist, marketing__marketing-private-domain-operator, marketing__marketing-reddit-community-builder, marketing__marketing-seo-specialist, marketing__marketing-short-video-editing-coach, marketing__marketing-social-media-strategist, marketing__marketing-tiktok-strategist, marketing__marketing-twitter-engager, marketing__marketing-wechat-official-account, marketing__marketing-weibo-strategist, marketing__marketing-xiaohongshu-specialist, marketing__marketing-zhihu-strategist, ops-team__cloud-cost-optimizer, ops-team__incident-responder, ops-team__infrastructure-architect, ops-team__platform-engineer, ops-team__security-operations, paid-media__paid-media-auditor, paid-media__paid-media-creative-strategist, paid-media__paid-media-paid-social-strategist, paid-media__paid-media-ppc-strategist, paid-media__paid-media-programmatic-buyer, paid-media__paid-media-search-query-analyst, paid-media__paid-media-tracking-specialist, pm-team__best-practices-researcher, pm-team__framework-docs-researcher, pm-team__product-designer, pm-team__repo-research-analyst, pmm-team__gtm-planner, pmm-team__launch-coordinator, pmm-team__market-researcher, pmm-team__messaging-specialist, pmm-team__positioning-strategist, pmm-team__pricing-analyst, pmo-team__delivery-reporter, pmo-team__executive-reporter, pmo-team__governance-specialist, pmo-team__portfolio-manager, pmo-team__resource-planner, pmo-team__risk-analyst, product__product-behavioral-nudge-engine, product__product-feedback-synthesizer, product__product-manager, product__product-sprint-prioritizer, product__product-trend-researcher, project-management__project-management-experiment-tracker, project-management__project-management-jira-workflow-steward, project-management__project-management-project-shepherd, project-management__project-management-studio-operations, project-management__project-management-studio-producer, project-management__project-manager-senior, sales__sales-account-strategist, sales__sales-coach, sales__sales-deal-strategist, sales__sales-discovery-coach, sales__sales-engineer, sales__sales-outbound-strategist, sales__sales-pipeline-analyst, sales__sales-proposal-strategist, spatial-computing__macos-spatial-metal-engineer, spatial-computing__terminal-integration-specialist, spatial-computing__visionos-spatial-engineer, spatial-computing__xr-cockpit-interaction-specialist, spatial-computing__xr-immersive-developer, spatial-computing__xr-interface-architect, specialized__accounts-payable-agent, specialized__agentic-identity-trust, specialized__agents-orchestrator, specialized__automation-governance-architect, specialized__blockchain-security-auditor, specialized__compliance-auditor, specialized__corporate-training-designer, specialized__data-consolidation-agent, specialized__government-digital-presales-consultant, specialized__healthcare-marketing-compliance, specialized__identity-graph-operator, specialized__lsp-index-engineer, specialized__recruitment-specialist, specialized__report-distribution-agent, specialized__sales-data-extraction-agent, specialized__specialized-cultural-intelligence-strategist, specialized__specialized-developer-advocate, specialized__specialized-document-generator, specialized__specialized-french-consulting-market, specialized__specialized-korean-business-navigator, specialized__specialized-mcp-builder, specialized__specialized-model-qa, specialized__specialized-salesforce-architect, specialized__specialized-workflow-architect, specialized__study-abroad-advisor, specialized__supply-chain-strategist, specialized__zk-steward, support__support-analytics-reporter, support__support-executive-summary-generator, support__support-finance-tracker, support__support-infrastructure-maintainer, support__support-legal-compliance-checker, support__support-support-responder, testing__testing-accessibility-auditor, testing__testing-api-tester, testing__testing-evidence-collector, testing__testing-performance-benchmarker, testing__testing-reality-checker, testing__testing-test-results-analyzer, testing__testing-tool-evaluator, testing__testing-workflow-optimizer, tw-team__api-writer, tw-team__docs-reviewer, tw-team__functional-writer, zh-cn__architect, zh-cn__build-error-resolver, zh-cn__chief-of-staff, zh-cn__code-reviewer, zh-cn__cpp-build-resolver, zh-cn__cpp-reviewer, zh-cn__database-reviewer, zh-cn__doc-updater, zh-cn__docs-lookup, zh-cn__e2e-runner, zh-cn__flutter-reviewer, zh-cn__go-build-resolver, zh-cn__go-reviewer, zh-cn__harness-optimizer, zh-cn__java-build-resolver, zh-cn__java-reviewer, zh-cn__kotlin-build-resolver, zh-cn__kotlin-reviewer, zh-cn__loop-operator, zh-cn__planner, zh-cn__python-reviewer, zh-cn__pytorch-build-resolver, zh-cn__refactor-cleaner, zh-cn__rust-build-resolver, zh-cn__rust-reviewer, zh-cn__security-reviewer, zh-cn__tdd-guide, zh-cn__typescript-reviewer, zh-tw__architect, zh-tw__build-error-resolver, zh-tw__code-reviewer, zh-tw__database-reviewer, zh-tw__doc-updater, zh-tw__e2e-runner, zh-tw__go-build-resolver, zh-tw__go-reviewer, zh-tw__planner, zh-tw__refactor-cleaner, zh-tw__security-reviewer, zh-tw__tdd-guide, design-brand-guardian, design-image-prompt-engineer, design-inclusive-visuals-specialist, design-ui-designer, design-ux-architect, design-ux-researcher, design-visual-storyteller, design-whimsy-injector, engineering-ai-engineer, engineering-autonomous-optimization-architect, engineering-backend-architect, engineering-code-reviewer, engineering-data-engineer, engineering-database-optimizer, engineering-devops-automator, engineering-embedded-firmware-engineer, engineering-feishu-integration-developer, engineering-frontend-developer, engineering-git-workflow-master, engineering-incident-response-commander, engineering-mobile-app-builder, engineering-rapid-prototyper, engineering-security-engineer, engineering-senior-developer, engineering-software-architect, engineering-solidity-smart-contract-engineer, engineering-sre, engineering-technical-writer, engineering-threat-detection-engineer, engineering-wechat-mini-program-developer

Use these capabilities when working on tasks. For details:
- Skills: `.claude/skills/*/SKILL.md`
- Agents: `.claude/agents/*.md`
- Commands: `.claude/commands/*.md`
<!-- FIFONY:END -->
