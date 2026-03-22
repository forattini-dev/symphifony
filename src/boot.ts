#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { env, exit, argv } from "node:process";
import { CLI_ARGS, STATE_ROOT, TARGET_ROOT } from "./concerns/constants.ts";
import { debugBoot, fail, now, parseIntArg } from "./concerns/helpers.ts";
import { initLogger, logger } from "./concerns/logger.ts";
import { initStateStore, loadPersistedState, persistState, persistStateFull, closeStateStore } from "./persistence/store.ts";
import { initQueueWorkers, stopQueueWorkers, recoverState, recoverOrphans, cleanTerminalWorkspaces } from "./persistence/plugins/queue-workers.ts";
import { createContainer } from "./persistence/container.ts";
import {
  applyPersistedSettings,
  loadRuntimeSettings,
  persistDetectedProvidersSetting,
  syncRuntimeConfigSettings,
} from "./persistence/settings.ts";
import { buildQueueTitle, detectProjectName, resolveProjectMetadata } from "./domains/project.ts";
import {
  detectAvailableProviders,
  resolveDefaultProvider,
  getProviderDefaultCommand,
} from "./agents/providers.ts";
import { setSkipSource, detectDefaultBranch, getGitRepoStatus } from "./domains/workspace.ts";
import { deriveConfig, applyWorkflowConfig, buildRuntimeState, computeMetrics, addEvent, validateConfig } from "./domains/issues.ts";
import { startApiServer } from "./persistence/plugins/api-server.ts";
import { startDevFrontend } from "./persistence/plugins/dev-server.ts";
import { installGracefulShutdown, hasTerminalQueue } from "./persistence/plugins/scheduler.ts";
import { recoverPlanningSession } from "./agents/planning/issue-planner.ts";
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
    metrics: { total: 0, planning: 0, queued: 0, inProgress: 0, blocked: 0, done: 0, merged: 0, cancelled: 0, activeWorkers: 0 },
    notes: [],
    booting: true,
  };

  let apiState = earlyState;
  // Initialize container early so API routes can use commands immediately
  createContainer(apiState);
  debugBoot("main:container-early-init");

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

  installGracefulShutdown(state);

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
    try { await stopQueueWorkers(); } catch {}
    await closeStateStore();
  }
}

main().catch((error) => {
  logger.error({ err: error }, `Fatal runtime error: ${String(error)}`);
  exit(1);
});
