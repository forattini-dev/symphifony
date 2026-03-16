#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { env, exit, argv } from "node:process";
import { CLI_ARGS, STATE_ROOT, TRACKER_KIND, WORKFLOW_RENDERED } from "./constants.ts";
import { debugBoot, fail, now } from "./helpers.ts";
import { initLogger, logger } from "./logger.ts";
import { initStateStore, loadPersistedState, persistState, closeStateStore } from "./store.ts";
import {
  applyPersistedSettings,
  loadRuntimeSettings,
  persistDetectedProvidersSetting,
  syncRuntimeConfigSettings,
} from "./settings.ts";
import {
  detectAvailableProviders,
  resolveDefaultProvider,
  getProviderDefaultCommand,
} from "./providers.ts";
import { bootstrapSource, loadWorkflowDefinition, parsePort, watchWorkflowFile } from "./workflow.ts";
import { deriveConfig, applyWorkflowConfig, buildRuntimeState, computeMetrics, addEvent, validateConfig } from "./issues.ts";
import { startApiServer } from "./api-server.ts";
import { scheduler, installGracefulShutdown } from "./scheduler.ts";
import { cleanWorkspace, isAgentStillRunning, cleanStalePidFile } from "./agent.ts";
import { startDevFrontend } from "./dev-server.ts";
import { recoverPlanningSession } from "./issue-planner.ts";

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
    "  --once                  Process once and exit\n",
  );
}

async function main() {
  debugBoot("main:start");
  if (TRACKER_KIND !== "filesystem") {
    logger.warn(`Detected SYMPHIFONY_TRACKER_KIND=${TRACKER_KIND}; forcing local filesystem tracker mode for this fork.`);
  }

  const args = CLI_ARGS;
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  mkdirSync(STATE_ROOT, { recursive: true });
  initLogger(STATE_ROOT);

  // Detect available providers
  const detectedProviders = detectAvailableProviders();
  for (const p of detectedProviders) {
    logger.info(`Provider ${p.name}: ${p.available ? `available at ${p.path}` : "not found"}`);
  }

  const interfaceMode = (env.SYMPHIFONY_INTERFACE ?? "cli").trim().toLowerCase();
  const runOnce = args.includes("--once");
  const devMode = args.includes("--dev") || env.NODE_ENV === "development";

  debugBoot("main:state-root-ready");
  const workflowDefinition = loadWorkflowDefinition();
  debugBoot("main:workflow-loaded");

  const port = parsePort(args);
  let config = applyWorkflowConfig(deriveConfig(args), workflowDefinition, port);

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

  bootstrapSource();
  debugBoot("main:source-bootstrapped");
  await initStateStore();
  debugBoot("main:store-initialized");
  await persistDetectedProvidersSetting(detectedProviders);
  await recoverPlanningSession();

  const previous = await loadPersistedState();
  let persistedSettings = await loadRuntimeSettings();
  debugBoot("main:state-loaded");
  config = applyPersistedSettings(config, persistedSettings);
  await syncRuntimeConfigSettings(config, persistedSettings);
  const state = buildRuntimeState(previous, config, workflowDefinition);
  debugBoot("main:state-merged");

  state.config.dashboardPort = dashboardPort ? String(dashboardPort) : undefined;
  state.workflowPath = WORKFLOW_RENDERED;
  state.updatedAt = now();

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
        ? "No agent command configured and no providers (claude, codex) found in PATH.\nInstall claude or codex, or set SYMPHIFONY_AGENT_COMMAND / configure codex.command or claude.command in WORKFLOW.md."
        : "No agent command configured. Set SYMPHIFONY_AGENT_COMMAND or configure codex.command / claude.command in WORKFLOW.md.",
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
        try { await cleanWorkspace(issue.id, workflowDefinition); } catch {}
      }
      logger.info("Background workspace cleanup complete.");
    });
  }

  // Recover orphaned agent processes from previous session
  for (const issue of state.issues) {
    if (issue.state === "Running" || issue.state === "Interrupted" || issue.state === "Queued") {
      const { alive, pid } = isAgentStillRunning(issue);
      if (alive && pid) {
        logger.info(`Agent for ${issue.identifier} still alive (PID ${pid.pid}), keeping state as Running.`);
        issue.state = "Running" as any;
        addEvent(state, issue.id, "info", `Orphaned agent detected (PID ${pid.pid}), still alive — tracking resumed.`);
      } else {
        // Agent died — clean PID file, mark as Interrupted for resumption
        if (issue.workspacePath) cleanStalePidFile(issue.workspacePath);
        if (issue.state === "Running") {
          issue.state = "Interrupted" as any;
          issue.history.push(`[${now()}] Agent process not found on boot — marked Interrupted.`);
          addEvent(state, issue.id, "info", `Agent for ${issue.identifier} not found, marked Interrupted.`);
        }
      }
    }
  }

  state.metrics = computeMetrics(state.issues);
  await persistState(state);

  const running = new Set<string>();
  installGracefulShutdown(state, running);

  logger.info(`Rendered local workflow: ${WORKFLOW_RENDERED}`);
  logger.info(`Loaded issues: ${state.issues.length}`);
  logger.info(`Worker concurrency: ${state.config.workerConcurrency}`);
  logger.info(`Max attempts: ${state.config.maxAttemptsDefault}`);
  logger.info(`Max turns: ${state.config.maxTurns}`);
  logger.info(`Agent provider: ${state.config.agentProvider}`);
  logger.info(`Interface mode: ${interfaceMode}`);

  if (dashboardPort) {
    await startApiServer(state, dashboardPort, workflowDefinition);

    // In dev mode, start Vite on a separate port with proxy back to API
    if (devMode) {
      const devPort = dashboardPort + 1;
      await startDevFrontend(dashboardPort, devPort);
    }
  }

  // Watch WORKFLOW.md for dynamic reload
  watchWorkflowFile((newDefinition) => {
    void (async () => {
      persistedSettings = await loadRuntimeSettings();
      const newConfig = applyPersistedSettings(
        applyWorkflowConfig(deriveConfig(args), newDefinition, port),
        persistedSettings,
      );
      await syncRuntimeConfigSettings(newConfig, persistedSettings);
      Object.assign(state.config, newConfig);
      addEvent(state, undefined, "info", `WORKFLOW.md reloaded — config updated (concurrency: ${newConfig.workerConcurrency}, turns: ${newConfig.maxTurns}).`);
      state.updatedAt = now();
      await persistState(state);
    })().catch((error) => {
      logger.warn(`Failed to apply reloaded workflow config: ${String(error)}`);
    });
  });

  try {
    addEvent(state, undefined, "info", `Runtime started in local-only mode (filesystem tracker).`);
    const runForever = !runOnce && (Boolean(dashboardPort) || interfaceMode === "mcp");
    await scheduler(state, running, runForever, workflowDefinition);
  } catch (error) {
    console.error("FATAL STACK TRACE:", error);
    addEvent(state, undefined, "error", `Fatal runtime error: ${String(error)}`);
    await persistState(state);
    throw error;
  } finally {
    state.updatedAt = now();
    state.metrics = computeMetrics(state.issues);
    await persistState(state);
    await closeStateStore();
  }
}

main().catch((error) => {
  logger.error({ err: error }, `Fatal runtime error: ${String(error)}`);
  exit(1);
});
