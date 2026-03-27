#!/usr/bin/env node
import { mkdirSync, readFileSync } from "node:fs";
import { env, exit, argv } from "node:process";
import { CLI_ARGS, STATE_ROOT, TARGET_ROOT } from "./concerns/constants.ts";
import { debugBoot, fail, now, parseIntArg } from "./concerns/helpers.ts";
import { initLogger, logger } from "./concerns/logger.ts";
import { initStateStore, loadPersistedState, persistState, persistStateFull, closeStateStore, loadPersistedServices, loadPersistedMilestones, loadLegacyPersistedServices, replaceAllServices, loadPersistedVariables, upsertPersistedVariable } from "./persistence/store.ts";
import { initQueueWorkers, stopQueueWorkers, recoverState, recoverOrphans, cleanTerminalWorkspaces } from "./persistence/plugins/queue-workers.ts";
import { createContainer } from "./persistence/container.ts";
import {
  applyPersistedSettings,
  loadRuntimeSettings,
  persistDetectedProvidersSetting,
  persistSetting,
  syncRuntimeConfigSettings,
} from "./persistence/settings.ts";
import { initWebPush } from "./domains/web-push.ts";
import { buildQueueTitle, detectProjectName, resolveProjectMetadata } from "./domains/project.ts";
import {
  detectAvailableProviders,
  resolveDefaultProvider,
  getProviderDefaultCommand,
} from "./agents/providers.ts";
import { setSkipSource, detectDefaultBranch, getGitRepoStatus } from "./domains/workspace.ts";
import { deriveConfig, applyWorkflowConfig, buildRuntimeState, computeMetrics, addEvent, validateConfig } from "./domains/issues.ts";
import { startApiServer } from "./persistence/plugins/api-server.ts";
import { startDevFrontend } from "./persistence/plugins/dev-frontend.ts";
import { installGracefulShutdown, hasTerminalQueue } from "./persistence/plugins/scheduler.ts";
import { recoverPlanningSession } from "./agents/planning/issue-planner.ts";
import {
  reconcileManagedServiceStates,
  startAutoConfiguredServices,
  initManagedServiceWatcher,
  listServiceStatuses,
} from "./domains/services.ts";
import {
  reconcileAgentStateTransitions,
  startManagedAgentWatcher,
} from "./domains/agents.ts";
import { broadcastToWebSocketClients } from "./routes/websocket.ts";
import {
  startServiceLogBroadcasting,
  stopServiceLogBroadcasting,
} from "./persistence/plugins/service-log-broadcaster.ts";
import { hydrate as hydrateTokenLedger } from "./domains/tokens.ts";
import { join } from "node:path";
import type { RuntimeState } from "./types.ts";

function parsePort(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--port") {
      const value = args[i + 1];
      if (!value || !/^\d+$/.test(value)) {
        fail(`Invalid value for --port: ${value ?? "<empty>"}`);
      }
      return parseIntArg(value, 4040);
    }
  }
  return undefined;
}

function usage() {
  console.log(
    `Usage: ${argv[1]} [options]\n` +
    "Options:\n" +
    "  --workspace <path>     Target workspace root (default: current directory)\n" +
    "  --persistence <path>   Persistence root (default: current directory)\n" +
    "  --port <n>             Start local dashboard\n" +
    "  --concurrency <n>      Maximum number of local workers\n" +
    "  --attempts <n>         Maximum attempts per issue\n" +
    "  --poll <ms>            Scheduler interval in ms\n" +
    "  --timeout <ms>         Agent command timeout in ms (default: 1800000)\n" +
    "  --dev                   Start Vite dev frontend alongside API (HMR on port+1)\n" +
    "  --no-tls                Disable HTTPS (use plain HTTP)\n" +
    "  --once                  Process once and exit\n" +
    "  --skip-source           Skip source snapshot copy\n" +
    "  --skip-scan             Skip project analysis\n" +
    "  --skip-recovery         Skip orphaned agent recovery\n" +
    "  --fast-boot             Equivalent to --skip-source --skip-scan --skip-recovery\n",
  );
}

async function main() {
  let serviceWatcher: { stop: () => void } | null = null;
  let agentWatcher: { stop: () => void } | null = null;
  debugBoot("main:start");

  const args = CLI_ARGS;
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  mkdirSync(STATE_ROOT, { recursive: true });
  initLogger(STATE_ROOT);
  logger.info("[Boot] Fifony runtime starting");
  logger.info({ stateRoot: STATE_ROOT, cwd: process.cwd() }, "[Boot] State root initialized");

  // Detect available providers
  const detectedProviders = detectAvailableProviders();
  for (const p of detectedProviders) {
    logger.info(`Provider ${p.name}: ${p.available ? `available at ${p.path}` : "not found"}`);
  }

  const interfaceMode = (env.FIFONY_INTERFACE ?? "cli").trim().toLowerCase();
  const runOnce = args.includes("--once");
  const devMode = args.includes("--dev") || env.NODE_ENV === "development";
  const fastBoot = args.includes("--fast-boot");
  const skipSource = fastBoot || args.includes("--skip-source");
  if (skipSource) setSkipSource(true);

  debugBoot("main:state-root-ready");

  const port = parsePort(args);
  let config = applyWorkflowConfig(deriveConfig(args), port);

  // Auto-resolve provider command if not configured
  if (!config.agentCommand.trim()) {
    const defaultProvider = resolveDefaultProvider(detectedProviders);
    if (defaultProvider) {
      const defaultCommand = getProviderDefaultCommand(defaultProvider);
      if (defaultCommand) {
        config = { ...config, agentProvider: defaultProvider, agentCommand: defaultCommand };
        logger.info(`Auto-detected provider: ${defaultProvider} → ${defaultCommand}`);
      }
    }
  }

  const dashboardPort = port ?? (config.dashboardPort ? Number.parseInt(config.dashboardPort, 10) : undefined);
  const skipRecovery = args.includes("--skip-recovery") || args.includes("--fast-boot");
  const detectedProjectName = detectProjectName(TARGET_ROOT);

  // ── Phase B: Parallel initialization ────────────────────────────────────────
  debugBoot("main:phase-b-start");
  logger.debug("[Boot] Initializing state store (s3db)");
  await initStateStore();
  logger.info("[Boot] State store initialized");
  debugBoot("main:store-initialized");

  // ── Early API start: dashboard available while boot continues ─────────────
  // Build a minimal placeholder state for the early API server
  const earlyState: RuntimeState = {
    projectName: detectedProjectName,
    detectedProjectName,
    projectNameSource: detectedProjectName ? "detected" : "missing",
    queueTitle: buildQueueTitle(detectedProjectName),
    startedAt: now(),
    updatedAt: now(),
    trackerKind: "filesystem",
    sourceRepoUrl: TARGET_ROOT,
    sourceRef: "workspace",
    config,
    milestones: [],
    issues: [],
    events: [],
    metrics: { total: 0, planning: 0, queued: 0, inProgress: 0, blocked: 0, done: 0, merged: 0, cancelled: 0, activeWorkers: 0 },
    notes: [],
    variables: [],
    booting: true,
  };

  let apiState = earlyState;
  // Initialize container early so API routes can use commands immediately
  createContainer(apiState);
  debugBoot("main:container-early-init");

  if (dashboardPort) {
    const devPort = devMode ? dashboardPort + 1 : undefined;
    await startApiServer(apiState, dashboardPort, { devPort });
    debugBoot("main:api-server-early-start");

    if (devMode && devPort) {
      await startDevFrontend(dashboardPort, devPort);
    }
  }

  const extractLegacyServicesFromRuntimeState = (value: unknown): import("./types.ts").ServiceEntry[] => {
    if (!value || typeof value !== "object") return [];
    const configValue = (value as { config?: unknown }).config;
    if (!configValue || typeof configValue !== "object") return [];
    const legacyServices = (configValue as Record<string, unknown>).devServers;
    if (!Array.isArray(legacyServices)) return [];
    return legacyServices.filter((entry): entry is import("./types.ts").ServiceEntry =>
      Boolean(entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" && typeof (entry as { command?: unknown }).command === "string")
    );
  };

  // ── Phase C: Parallel state loading ─────────────────────────────────────────
  debugBoot("main:phase-c-start");
  logger.debug("[Boot] Loading persisted state, settings, and recovering sessions");
  const [previous, persistedSettings, persistedServices, legacyPersistedServices, persistedMilestones, persistedVariables] = await Promise.all([
    loadPersistedState(),
    loadRuntimeSettings(),
    loadPersistedServices(),
    loadLegacyPersistedServices(),
    loadPersistedMilestones(),
    loadPersistedVariables(),
    persistDetectedProvidersSetting(detectedProviders),
    recoverPlanningSession(),
  ]);
  logger.info({ hadPreviousState: previous !== null, issueCount: previous?.issues?.length ?? 0, settingsCount: persistedSettings.length }, "[Boot] State loaded from persistence");
  debugBoot("main:state-loaded");

  const runtimeLegacyServices = extractLegacyServicesFromRuntimeState(previous);
  const migratedServices = persistedServices.length > 0
    ? persistedServices
    : legacyPersistedServices.length > 0
      ? legacyPersistedServices
      : runtimeLegacyServices;

  config = applyPersistedSettings(config, persistedSettings);
  if (migratedServices.length > 0) {
    config = { ...config, services: migratedServices };
    if (persistedServices.length === 0) {
      await replaceAllServices(migratedServices);
    }
  }
  await syncRuntimeConfigSettings(config, persistedSettings);
  const projectMetadata = resolveProjectMetadata(persistedSettings, TARGET_ROOT);
  const state = buildRuntimeState(previous, config, projectMetadata, persistedMilestones);

  // Load variables; auto-migrate from legacy serviceEnv + per-service env if table is empty
  state.variables = persistedVariables;
  if (state.variables.length === 0) {
    const migrated = [];
    const globalEnv = config.serviceEnv ?? {};
    for (const [key, value] of Object.entries(globalEnv)) {
      migrated.push({ id: `global:${key}`, key, value: String(value ?? ""), scope: "global", updatedAt: now() });
    }
    for (const svc of config.services ?? []) {
      for (const [key, value] of Object.entries(svc.env ?? {})) {
        migrated.push({ id: `${svc.id}:${key}`, key, value: String(value ?? ""), scope: svc.id, updatedAt: now() });
      }
    }
    if (migrated.length > 0) {
      await Promise.all(migrated.map((v) => upsertPersistedVariable(v)));
      state.variables = migrated;
      logger.info({ count: migrated.length }, "[Boot] Migrated legacy env vars to variables resource");
    }
  }

  debugBoot("main:state-merged");

  state.config.dashboardPort = dashboardPort ? String(dashboardPort) : undefined;
  state.updatedAt = now();
  state.booting = false;

  if (!state.config.defaultBranch) {
    try {
      state.config.defaultBranch = detectDefaultBranch(TARGET_ROOT);
      logger.info({ defaultBranch: state.config.defaultBranch }, "[Boot] Default branch detected");
    } catch { /* not a git repo */ }
  }

  const gitStatus = getGitRepoStatus(TARGET_ROOT);
  if (!gitStatus.isGit) {
    logger.warn({ workspace: TARGET_ROOT }, "[Boot] Target workspace is not a git repository. Issue execution and merge will stay blocked until git is initialized.");
  } else if (!gitStatus.hasCommits) {
    logger.warn({ workspace: TARGET_ROOT, branch: gitStatus.branch }, "[Boot] Target workspace has no commits. Create an initial commit before running issues because git worktree needs a base commit.");
  }

  if (!state.config.testCommand) {
    try {
      const pkg = JSON.parse(readFileSync(join(TARGET_ROOT, "package.json"), "utf8"));
      if (pkg?.scripts?.test && !pkg.scripts.test.includes("no test specified")) {
        state.config.testCommand = "pnpm test";
        logger.info({ testCommand: state.config.testCommand }, "[Boot] Test command auto-detected");
      }
    } catch { /* non-critical */ }
  }

  if (!state.config.agentCommand.trim()) {
    const available = detectedProviders.filter((p) => p.available).map((p) => p.name);
    fail(
      available.length === 0
        ? "No agent command configured and no providers (claude, codex) found in PATH.\nInstall claude or codex, or set FIFONY_AGENT_COMMAND."
        : "No agent command configured. Set FIFONY_AGENT_COMMAND.",
    );
  }

  // Validate config at startup (spec §6.3)
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    for (const err of configErrors) logger.warn(`Config validation: ${err}`);
  }

  cleanTerminalWorkspaces();
  if (!skipRecovery) await recoverOrphans();

  // Agent FSM: reconcile job state files with live PIDs at boot
  try {
    const agentTransitions = reconcileAgentStateTransitions(state.issues, STATE_ROOT);
    if (agentTransitions.length > 0) {
      logger.info({ count: agentTransitions.length }, "[Boot] Agent states reconciled");
    }
  } catch (err) {
    logger.warn({ err }, "[Boot] Agent state reconciliation failed — continuing");
  }

  // Services: reconcile states, auto-start, then launch watcher
  try {
    const services = state.config.services ?? [];
    reconcileManagedServiceStates(services, STATE_ROOT);
    const autoStartTransitions = startAutoConfiguredServices(
      services,
      TARGET_ROOT,
      STATE_ROOT,
      state.config.serviceEnv,
    );
    for (const t of autoStartTransitions) {
      logger.info({ id: t.id, command: t.to }, "[Boot] Service auto-started");
    }
    // Start log broadcaster for every currently-running service
    // (covers both auto-started and services already running from a prior session)
    for (const status of listServiceStatuses(services, STATE_ROOT)) {
      if (status.running) startServiceLogBroadcasting(status.id, STATE_ROOT);
    }
  } catch (err) {
    logger.warn({ err }, "[Boot] Service init failed — continuing");
  }

  state.metrics = computeMetrics(state.issues);

  // Swap state into API server IMMEDIATELY so the dashboard shows real data
  if (dashboardPort) {
    Object.assign(apiState, state);
    debugBoot("main:api-state-swapped");
  }
  createContainer(apiState);
  logger.info("[Boot] DI container initialized with full state");

  await persistStateFull(state);

  // Initialize queue workers (can be slow — dashboard already has real data)
  try {
    await initQueueWorkers(state);
  } catch (error) {
    logger.warn({ err: error }, "[Boot] Queue workers failed to initialize — continuing without queue-based dispatch");
  }

  serviceWatcher = initManagedServiceWatcher(
    () => apiState.config.services ?? [],
    () => apiState.config.serviceEnv ?? {},
    STATE_ROOT,
    TARGET_ROOT,
    (t) => {
      logger.info({ id: t.id, from: t.from, to: t.to, reason: t.reason }, "[Service] FSM transition");
      broadcastToWebSocketClients({
        type: "service",
        id: t.id,
        state: t.to,
        running: t.to === "starting" || t.to === "running",
        pid: t.pid ?? null,
      });
      // Manage log broadcaster lifecycle alongside FSM transitions
      if (t.to === "starting") {
        startServiceLogBroadcasting(t.id, STATE_ROOT);
      } else if (t.to === "stopped" || t.to === "crashed") {
        stopServiceLogBroadcasting(t.id);
      }
    },
  );

  agentWatcher = startManagedAgentWatcher(
    () => apiState.issues,
    STATE_ROOT,
    (t) => {
      logger.info({ issueId: t.issueId, identifier: t.identifier, from: t.from, to: t.to, reason: t.reason }, "[AgentFSM] Transition");
      broadcastToWebSocketClients({
        type: "agent-fsm",
        issueId: t.issueId,
        identifier: t.identifier,
        operation: t.operation,
        state: t.to,
        running: t.to === "running" || t.to === "preparing",
        pid: t.pid ?? null,
      });
    },
  );

  installGracefulShutdown(state);

  // Initialize web push (generates VAPID keys on first run)
  try {
    const settings = await loadRuntimeSettings();
    await initWebPush(
      async (id) => settings.find((s) => s.id === id)?.value,
      async (id, value, scope) => {
        const normalizedScope = scope === "runtime" || scope === "providers" || scope === "ui" || scope === "system"
          ? scope
          : "system";
        await persistSetting(id, value, { scope: normalizedScope, source: "system" });
      },
    );
  } catch (err) {
    logger.warn({ err: String(err) }, "[Boot] Web push init failed — push notifications disabled");
  }

  logger.info("[Boot] Runtime ready");
  hydrateTokenLedger(state.issues);
  logger.info(`Loaded issues: ${state.issues.length}`);
  logger.info(`Worker concurrency: ${state.config.workerConcurrency}`);
  logger.info(`Max attempts: ${state.config.maxAttemptsDefault}`);
  logger.info(`Max turns: ${state.config.maxTurns}`);
  logger.info(`Agent provider: ${state.config.agentProvider}`);
  logger.info(`Interface mode: ${interfaceMode}`);

  try {
    addEvent(state, undefined, "info", `Runtime started in local-only mode (filesystem tracker).`);
    const runForever = !runOnce && (Boolean(dashboardPort) || interfaceMode === "mcp");
    logger.info({ runForever, runOnce, dashboardPort, interfaceMode }, "[Boot] Queue-driven dispatch active");

    // Reconcile FSM state + enqueue in-progress issues
    await recoverState();

    // The unified queue handles: dispatch, stale checks, persist.
    // boot.ts just keeps the process alive (or waits for terminal in batch mode).
    if (runForever) {
      await new Promise<void>(() => {}); // block forever — graceful shutdown handler calls process.exit
    } else {
      // Batch mode: poll until all issues reach terminal states
      while (!hasTerminalQueue(state)) {
        await new Promise((r) => setTimeout(r, state.config.pollIntervalMs));
      }
    }
  } catch (error) {
    console.error("FATAL STACK TRACE:", error);
    addEvent(state, undefined, "error", `Fatal runtime error: ${String(error)}`);
    await persistState(state);
    throw error;
  } finally {
    state.updatedAt = now();
    state.metrics = computeMetrics(state.issues);
    await persistStateFull(state);
    try { serviceWatcher?.stop(); } catch {}
    try { agentWatcher?.stop(); } catch {}
    try { await stopQueueWorkers(); } catch {}
    await closeStateStore();
  }
}

main().catch((error) => {
  logger.error({ err: error }, `Fatal runtime error: ${String(error)}`);
  exit(1);
});
