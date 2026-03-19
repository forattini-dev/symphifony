#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { env, exit, argv } from "node:process";
import { CLI_ARGS, STATE_ROOT, TARGET_ROOT } from "./constants.ts";
import { debugBoot, fail, now, sleep } from "./helpers.ts";
import { initLogger, logger } from "./logger.ts";
import { initStateStore, loadPersistedState, persistState, persistStateFull, closeStateStore } from "./store.ts";
import { initQueueWorkers, stopQueueWorkers, enqueueForPlanning, enqueueForExecution, enqueueForReview } from "./queue-workers.ts";
import {
  applyPersistedSettings,
  loadRuntimeSettings,
  persistDetectedProvidersSetting,
  syncRuntimeConfigSettings,
} from "./settings.ts";
import { buildQueueTitle, detectProjectName, resolveProjectMetadata } from "./project-meta.ts";
import {
  detectAvailableProviders,
  resolveDefaultProvider,
  getProviderDefaultCommand,
} from "./providers.ts";
import { parsePort, setSkipSource } from "./workflow.ts";
import { deriveConfig, applyWorkflowConfig, buildRuntimeState, computeMetrics, addEvent, validateConfig } from "./issues.ts";
import { hasDirtyState } from "./dirty-tracker.ts";
import { startApiServer } from "./api-server.ts";
import { installGracefulShutdown, isShuttingDown, ensureNotStale, hasTerminalQueue } from "./scheduler.ts";
import { cleanWorkspace, isAgentStillRunning, cleanStalePidFile } from "./agent.ts";
import { startDevFrontend } from "./dev-server.ts";
import { recoverPlanningSession } from "./issue-planner.ts";
import { hydrate as hydrateTokenLedger } from "./token-ledger.ts";
import { detectDefaultBranch } from "./workspace-setup.ts";
import type { RuntimeState } from "./types.ts";

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
    "  --dev                   Start Vite dev server alongside API (HMR on port+1)\n" +
    "  --once                  Process once and exit\n" +
    "  --skip-source           Skip source snapshot copy\n" +
    "  --skip-scan             Skip project analysis\n" +
    "  --skip-recovery         Skip orphaned agent recovery\n" +
    "  --fast-boot             Equivalent to --skip-source --skip-scan --skip-recovery\n",
  );
}

async function main() {
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
    issues: [],
    events: [],
    metrics: { total: 0, planning: 0, queued: 0, inProgress: 0, blocked: 0, done: 0, cancelled: 0, activeWorkers: 0 },
    notes: [],
    booting: true,
  };

  let apiState = earlyState;
  if (dashboardPort) {
    await startApiServer(apiState, dashboardPort);
    debugBoot("main:api-server-early-start");

    if (devMode) {
      const devPort = dashboardPort + 1;
      await startDevFrontend(dashboardPort, devPort);
    }
  }

  // ── Phase C: Parallel state loading ─────────────────────────────────────────
  debugBoot("main:phase-c-start");
  logger.debug("[Boot] Loading persisted state, settings, and recovering sessions");
  const [previous, persistedSettings] = await Promise.all([
    loadPersistedState(),
    loadRuntimeSettings(),
    persistDetectedProvidersSetting(detectedProviders),
    recoverPlanningSession(),
  ]);
  logger.info({ hadPreviousState: previous !== null, issueCount: previous?.issues?.length ?? 0, settingsCount: persistedSettings.length }, "[Boot] State loaded from persistence");
  debugBoot("main:state-loaded");

  config = applyPersistedSettings(config, persistedSettings);
  await syncRuntimeConfigSettings(config, persistedSettings);
  const projectMetadata = resolveProjectMetadata(persistedSettings, TARGET_ROOT);
  const state = buildRuntimeState(previous, config, projectMetadata);
  debugBoot("main:state-merged");

  state.config.dashboardPort = dashboardPort ? String(dashboardPort) : undefined;
  state.updatedAt = now();
  state.booting = false;

  // Detect and lock the default branch once at startup
  if (!state.config.defaultBranch) {
    try {
      const detectedBranch = detectDefaultBranch(TARGET_ROOT);
      state.config.defaultBranch = detectedBranch;
      logger.info({ defaultBranch: detectedBranch }, "[Agent] Default branch detected");
    } catch {
      // Not a git repo or detection failed — leave undefined
    }
  }

  if (state.config.agentCommand) {
    state.notes.push(`Using agent command: ${state.config.agentCommand}`);
  }
  state.notes.push(`Agent session max turns: ${state.config.maxTurns}`);
  state.notes.push(`Agent provider: ${state.config.agentProvider}`);
  state.notes.push(`Interface mode: ${interfaceMode}`);

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

  // Clean terminal workspaces in background (non-blocking boot)
  const terminalIssues = state.issues.filter((i) => i.state === "Done" || i.state === "Cancelled");
  if (terminalIssues.length > 0) {
    logger.info(`Scheduling cleanup of ${terminalIssues.length} terminal workspace(s) in background...`);
    setImmediate(async () => {
      for (const issue of terminalIssues) {
        try { await cleanWorkspace(issue.id, issue, state); } catch {}
      }
      logger.info("Background workspace cleanup complete.");
    });
  }

  // Recover orphaned agent processes from previous session
  if (!skipRecovery) {
    logger.debug({ issueCount: state.issues.filter((i) => i.state === "Running" || i.state === "Queued").length }, "[Boot] Checking for orphaned agent processes");
    for (const issue of state.issues) {
      if (issue.state === "Running" || issue.state === "Queued") {
        const { alive, pid } = isAgentStillRunning(issue);
        if (alive && pid) {
          logger.info(`Agent for ${issue.identifier} still alive (PID ${pid.pid}), keeping state as Running.`);
          issue.state = "Running";
          addEvent(state, issue.id, "info", `Orphaned agent detected (PID ${pid.pid}), still alive — tracking resumed.`);
        } else {
          // Agent died — clean PID file, mark as Queued for resumption
          if (issue.workspacePath) cleanStalePidFile(issue.workspacePath);
          if (issue.state === "Running") {
            issue.state = "Queued";
            issue.history.push(`[${now()}] Agent process not found on boot — marked Queued.`);
            addEvent(state, issue.id, "info", `Agent for ${issue.identifier} not found, marked Queued.`);
          }
        }
      }
    }
  }

  state.metrics = computeMetrics(state.issues);
  await persistStateFull(state);

  // Initialize queue workers after state is fully ready
  try {
    await initQueueWorkers(state);
  } catch (error) {
    logger.warn({ err: error }, "[Boot] Queue workers failed to initialize — continuing without queue-based dispatch");
  }

  // Update the API server to use the real state (swap reference)
  if (dashboardPort) {
    // The API server closure captures apiState — mutate it to point to real state
    Object.assign(apiState, state);
    debugBoot("main:api-state-swapped");
  }

  const running = new Set<string>();
  installGracefulShutdown(state, running);

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
    logger.info({ runForever, runOnce, dashboardPort, interfaceMode }, "[Boot] Entering queue supervisor loop");

    // Boot recovery: enqueue all in-progress issues so queue workers pick them up
    for (const issue of state.issues) {
      if (issue.state === "Planning" && issue.planningStatus !== "planning") {
        await enqueueForPlanning(issue).catch(() => {});
      } else if (issue.state === "Queued" || issue.state === "Running") {
        await enqueueForExecution(issue).catch(() => {});
      } else if (issue.state === "Reviewing") {
        await enqueueForReview(issue).catch(() => {});
      }
    }

    const PERSIST_DEBOUNCE_MS = 5_000;
    let lastPersistAt = 0;

    if (runForever) {
      while (!isShuttingDown()) {
        // Take a snapshot of states before stale recovery so we can detect transitions
        const statesBefore = new Map(state.issues.map((i) => [i.id, i.state]));
        await ensureNotStale(state, state.config.staleInProgressTimeoutMs);

        // Re-enqueue any issues that just changed state due to stale recovery or retry eligibility
        for (const issue of state.issues) {
          const prev = statesBefore.get(issue.id);
          if (prev !== issue.state) {
            if (issue.state === "Queued") enqueueForExecution(issue).catch(() => {});
            else if (issue.state === "Reviewing") enqueueForReview(issue).catch(() => {});
            else if (issue.state === "Planning") enqueueForPlanning(issue).catch(() => {});
          }
        }

        state.updatedAt = now();
        if (hasDirtyState() || Date.now() - lastPersistAt > PERSIST_DEBOUNCE_MS) {
          await persistState(state);
          lastPersistAt = Date.now();
        }
        await sleep(1_000);
      }
    } else {
      // Batch mode: wait until all issues reach terminal states
      while (!hasTerminalQueue(state)) {
        await sleep(state.config.pollIntervalMs);
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
    try { await stopQueueWorkers(); } catch {}
    await closeStateStore();
  }
}

main().catch((error) => {
  logger.error({ err: error }, `Fatal runtime error: ${String(error)}`);
  exit(1);
});
