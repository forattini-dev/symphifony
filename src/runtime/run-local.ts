#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { env, exit, argv } from "node:process";
import { CLI_ARGS, LOCAL_ISSUES_FILE, STATE_ROOT, TRACKER_KIND, WORKFLOW_RENDERED } from "./constants.ts";
import { debugBoot, fail, now } from "./helpers.ts";
import { initLogger, logger } from "./logger.ts";
import { initStateStore, loadPersistedState, persistState, closeStateStore } from "./store.ts";
import {
  detectAvailableProviders,
  resolveDefaultProvider,
  getProviderDefaultCommand,
} from "./providers.ts";
import { bootstrapSource, loadWorkflowDefinition, parsePort, watchWorkflowFile } from "./workflow.ts";
import { deriveConfig, applyWorkflowConfig, loadSeedIssues, mergeStateWithSeed, computeMetrics, addEvent } from "./issues.ts";
import { startApiServer } from "./api-server.ts";
import { scheduler, installGracefulShutdown } from "./scheduler.ts";
import { cleanWorkspace } from "./agent.ts";

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
    "  --once                  Process once and exit\n",
  );
}

async function main() {
  debugBoot("main:start");
  if (TRACKER_KIND !== "filesystem") {
    fail("SYMPHIFO_TRACKER_KIND must be 'filesystem' for this fork.");
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

  const interfaceMode = (env.SYMPHIFO_INTERFACE ?? "cli").trim().toLowerCase();
  const runOnce = args.includes("--once");

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

  const seedIssues = loadSeedIssues(LOCAL_ISSUES_FILE, workflowDefinition);
  debugBoot("main:seed-loaded");
  const previous = await loadPersistedState();
  debugBoot("main:state-loaded");
  const state = mergeStateWithSeed(seedIssues, previous, config, workflowDefinition);
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
        ? "No agent command configured and no providers (claude, codex) found in PATH.\nInstall claude or codex, or set SYMPHIFO_AGENT_COMMAND / configure codex.command or claude.command in WORKFLOW.md."
        : "No agent command configured. Set SYMPHIFO_AGENT_COMMAND or configure codex.command / claude.command in WORKFLOW.md.",
    );
  }

  // Startup: clean workspaces and prune sessions for terminal issues
  const terminalIssues = state.issues.filter((i) => i.state === "Done" || i.state === "Cancelled");
  if (terminalIssues.length > 0) {
    logger.info(`Cleaning ${terminalIssues.length} terminal issue workspace(s)...`);
    for (const issue of terminalIssues) {
      await cleanWorkspace(issue.id, workflowDefinition);
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
  }

  // Watch WORKFLOW.md for dynamic reload
  watchWorkflowFile((newDefinition) => {
    const newConfig = applyWorkflowConfig(deriveConfig(args), newDefinition, port);
    Object.assign(state.config, newConfig);
    addEvent(state, undefined, "info", `WORKFLOW.md reloaded — config updated (concurrency: ${newConfig.workerConcurrency}, turns: ${newConfig.maxTurns}).`);
    state.updatedAt = now();
    persistState(state).catch(() => {});
  });

  try {
    addEvent(state, undefined, "info", `Runtime started in local-only mode (filesystem tracker).`);
    const runForever = !runOnce && (Boolean(dashboardPort) || interfaceMode === "mcp");
    await scheduler(state, running, runForever, workflowDefinition);
  } catch (error) {
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
  logger.error(`Fatal runtime error: ${String(error)}`);
  exit(1);
});
