import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AgentProviderDefinition,
  AgentSessionResult,
  IssueEntry,
  RuntimeState,
  WorkflowConfig,
} from "../types.ts";
import { now, clamp } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { getExecutionProviders } from "./providers.ts";
import { addEvent } from "../domains/issues.ts";
import { compileExecution, persistCompilationArtifacts } from "./adapters/index.ts";
import { discoverSkills, buildSkillContext, discoverAgents, discoverCommands, buildCapabilitiesManifest } from "../agents/skills.ts";
import {
  loadAgentSessionState,
  persistAgentSessionState,
  loadAgentPipelineState,
  persistAgentPipelineState,
  buildProviderSessionKey,
} from "./session-state.ts";
import { readAgentDirective, addTokenUsage } from "./directive-parser.ts";
import { buildTurnPrompt, buildProviderBasePrompt, buildRetryContext, resolveContextWindow } from "./prompt-builder.ts";
import { runCommandWithTimeout, runHook } from "./command-executor.ts";
import { record as recordTokens } from "../domains/tokens.ts";
import { buildContextMarkdown, buildTraceFromContext } from "./context-engine.ts";
import { markIssueDirty } from "../persistence/dirty-tracker.ts";
import {
  attachNodeArtifacts,
  BLUEPRINT_EXECUTION_NODE_IDS,
  buildBlueprintBrief,
  buildHarnessBlueprint,
  finalizeBlueprintRun,
  shouldRunBlueprintNode,
  startBlueprintRun,
  summarizeDeterministicNode,
  updateBlueprintNodeRun,
  writeBlueprintArtifact,
  writeBlueprintJsonArtifact,
} from "./blueprints.ts";

/** Compute the versioned stdout output filename for a given phase/version/attempt/turn. */
function resolveOutputFileName(role: string, planVersion: number, attempt: number, turn: number): string {
  if (role === "planner") {
    return `plan.v${planVersion}.t${turn}.stdout.log`;
  }
  return `${role === "reviewer" ? "review" : "execute"}.v${planVersion}a${attempt}.t${turn}.stdout.log`;
}

export async function runAgentSession(
  state: RuntimeState,
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  cycle: number,
  workspacePath: string,
  basePromptText: string,
  basePromptFile: string,
): Promise<AgentSessionResult> {
  const maxTurns = clamp(state.config.maxTurns, 1, 16);
  const attempt = issue.attempts + 1;
  const sessionLookupKey = buildProviderSessionKey(issue, attempt, provider, cycle);
  const loadedSession = await loadAgentSessionState(sessionLookupKey, issue, attempt, maxTurns);
  const sessionKey = loadedSession.key;
  const session = loadedSession.session;
  let previousOutput = session.lastOutput;
  let nextPrompt = session.nextPrompt;
  let lastCode: number | null = session.lastCode;
  let lastOutput = session.lastOutput;
  const resultFile = join(workspacePath, `result-${provider.role}-${provider.provider}.json`);

  if (session.status === "done" && session.turns.length > 0) {
    logger.debug({ issueId: issue.id, identifier: issue.identifier, provider: provider.provider, role: provider.role }, "[Agent] Session already completed, returning cached result");
    return { success: true, blocked: false, continueRequested: false, code: session.lastCode, output: session.lastOutput, turns: session.turns.length };
  }

  const turnIndex = session.turns.length + 1;
  if (turnIndex > maxTurns) {
    session.status = "blocked";
    session.lastOutput = session.lastOutput + `\nAgent requested additional turns beyond configured limit (${maxTurns}).`;
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: true, continueRequested: false, code: lastCode, output: session.lastOutput, turns: session.turns.length };
  }

  const maxOutputChars = state.config.maxPreviousOutputChars;
  const compactedOutput = previousOutput.length > maxOutputChars
    ? `[...${previousOutput.length - maxOutputChars} chars truncated...]\n${previousOutput.slice(-maxOutputChars)}`
    : previousOutput;
  const contextResult = await buildContextMarkdown({
    role: provider.role,
    title: issue.title,
    description: issue.description,
    issue,
    workspacePath,
    previousOutput: compactedOutput,
    nextPrompt,
    runtimeState: state,
  }).catch((error) => {
    logger.warn({ err: error, issueId: issue.id, role: provider.role }, "[Context] Failed to build context pack");
    return {
      pack: {
        role: provider.role,
        query: "",
        generatedAt: now(),
        hits: [],
        lexicalHitCount: 0,
        semanticHitCount: 0,
        memoryHitCount: 0,
        explicitHitCount: 0,
      },
      markdown: "",
    };
  });
  issue.contextReportsByRole = {
    ...(issue.contextReportsByRole ?? {}),
    [provider.role]: "report" in contextResult.pack ? contextResult.pack.report : undefined,
  };
  markIssueDirty(issue.id);
  const effectiveBasePrompt = contextResult.markdown
    ? `${contextResult.markdown}\n\n${basePromptText}`
    : basePromptText;
  const turnPrompt = await buildTurnPrompt(issue, effectiveBasePrompt, compactedOutput, turnIndex, maxTurns, nextPrompt);
  const turnPromptFile = turnIndex === 1
    ? basePromptFile
    : join(workspacePath, `turn-${String(turnIndex).padStart(2, "0")}.md`);

  if (turnIndex > 1) writeFileSync(turnPromptFile, `${turnPrompt}\n`, "utf8");

  session.status = "running";
  session.lastPrompt = turnPrompt;
  session.lastPromptFile = turnPromptFile;
  session.maxTurns = maxTurns;
  await persistAgentSessionState(sessionKey, issue, provider, cycle, session);

  // Compute persistent stdout output file
  const outputsDir = join(workspacePath, "outputs");
  mkdirSync(outputsDir, { recursive: true });
  const outputFileName = resolveOutputFileName(
    provider.role,
    issue.planVersion ?? 1,
    provider.role === "planner" ? 0 : (issue.executeAttempt ?? 1),
    turnIndex,
  );
  const outputFilePath = join(outputsDir, outputFileName);

  logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, maxTurns, provider: provider.provider, role: provider.role, cycle, command: provider.command.slice(0, 120) }, "[Agent] Spawning agent command");
  const turnStartedAt = now();
  const turnEnv = {
    FIFONY_AGENT_PROVIDER: provider.provider,
    FIFONY_AGENT_ROLE: provider.role,
    FIFONY_REASONING_EFFORT: provider.reasoningEffort || "",
    FIFONY_SESSION_KEY: sessionKey,
    FIFONY_SESSION_ID: `${issue.id}-attempt-${attempt}`,
    FIFONY_TURN_INDEX: String(turnIndex),
    FIFONY_MAX_TURNS: String(maxTurns),
    FIFONY_TURN_PROMPT: turnPrompt,
    FIFONY_TURN_PROMPT_FILE: turnPromptFile,
    FIFONY_CONTINUE: turnIndex > 1 ? "1" : "0",
    FIFONY_PREVIOUS_OUTPUT: compactedOutput,
    FIFONY_RESULT_FILE: resultFile,
    FIFONY_AGENT_PROFILE: provider.profile,
    FIFONY_AGENT_PROFILE_FILE: provider.profilePath,
    FIFONY_AGENT_PROFILE_INSTRUCTIONS: provider.profileInstructions,
  };

  if (state.config.beforeRunHook) {
    await runHook(state.config.beforeRunHook, workspacePath, issue, "before_run", turnEnv);
  }

  addEvent(state, issue.id, "runner", `Turn ${turnIndex}/${maxTurns} started for ${issue.identifier}.`);

  const turnResult = await runCommandWithTimeout(provider.command, workspacePath, issue, state.config, turnPromptFile, turnEnv, outputFilePath);

  if (state.config.afterRunHook) {
    await runHook(state.config.afterRunHook, workspacePath, issue, "after_run", {
      ...turnEnv,
      FIFONY_LAST_EXIT_CODE: String(turnResult.code ?? ""),
      FIFONY_LAST_OUTPUT: turnResult.output,
      FIFONY_PRESERVE_RESULT_FILE: "1",
    });
  }

  const outputPreview = turnResult.output.length < 500 ? turnResult.output.trim() : undefined;
  logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, exitCode: turnResult.code, success: turnResult.success, outputBytes: turnResult.output.length, ...(outputPreview ? { outputPreview } : {}) }, "[Agent] Agent command finished");
  const directive = readAgentDirective(workspacePath, turnResult.output, turnResult.success);
  lastCode = turnResult.code;
  lastOutput = turnResult.output;
  previousOutput = turnResult.output;
  nextPrompt = directive.nextPrompt;
  if (!directive.tokenUsage) {
    logger.warn({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, role: provider.role, outputBytes: turnResult.output.length }, "[Agent] Token extraction failed — no usage data in CLI output");
  }
  addTokenUsage(issue, directive.tokenUsage, provider.role);
  if (directive.tokenUsage) recordTokens(issue, directive.tokenUsage, provider.role);

  if (directive.tokenUsage) {
    const tu = directive.tokenUsage;
    const parts = [
      `Turn ${turnIndex} (${provider.role})`,
      `${tu.totalTokens.toLocaleString()} tokens`,
      `(in: ${tu.inputTokens.toLocaleString()}, out: ${tu.outputTokens.toLocaleString()})`,
    ];
    if (tu.model) parts.push(`[${tu.model}]`);
    const cumulative = issue.tokenUsage;
    if (cumulative && cumulative.totalTokens > tu.totalTokens) {
      parts.push(`| cumulative: ${cumulative.totalTokens.toLocaleString()}`);
    }
    addEvent(state, issue.id, "info", parts.join(" "));
  }

  // Context overflow detection — check after each turn so the next turn's prompt
  // can steer the agent toward checkpointing before context is fully exhausted.
  // Also catches explicit context_length_exceeded signals in the CLI output.
  const ctxOverflowSignals = [
    "context_length_exceeded",
    "context window",
    "too many tokens",
    "maximum context",
    "prompt is too long",
  ];
  const hasOverflowSignal = ctxOverflowSignals.some((s) =>
    turnResult.output.toLowerCase().includes(s),
  );
  const cumulativeTokens = issue.tokenUsage?.totalTokens ?? 0;
  const contextWindow = resolveContextWindow(issue.tokenUsage?.model);
  const contextPct = contextWindow ? Math.round((cumulativeTokens / contextWindow) * 100) : null;
  const isNearLimit = (contextPct !== null && contextPct >= 80) || hasOverflowSignal;
  if (isNearLimit && directive.status === "continue") {
    const reason = hasOverflowSignal
      ? "Context overflow signal detected in output"
      : `Context at ~${contextPct}% (${cumulativeTokens.toLocaleString()} / ${contextWindow?.toLocaleString()} tokens)`;
    logger.warn({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, contextPct, reason }, "[Agent] Context pressure — steering next turn toward checkpoint");
    addEvent(state, issue.id, "warn", `Context pressure on turn ${turnIndex}: ${reason}. Next turn will prioritize checkpointing.`);
    // Override nextPrompt to steer the agent toward compacting its work
    nextPrompt = [
      nextPrompt,
      "",
      "IMPORTANT: Context is nearly full. Before continuing any new work:",
      "1. Write a `checkpoint.md` file summarizing: what has been done, what files were changed, and what remains.",
      "2. Keep all subsequent operations minimal and targeted.",
    ].join("\n").trim();
  }

  // Accumulate tools/skills/agents/commands used across turns
  if (directive.toolsUsed?.length) issue.toolsUsed = [...new Set([...(issue.toolsUsed ?? []), ...directive.toolsUsed])];
  if (directive.skillsUsed?.length) issue.skillsUsed = [...new Set([...(issue.skillsUsed ?? []), ...directive.skillsUsed])];
  if (directive.agentsUsed?.length) issue.agentsUsed = [...new Set([...(issue.agentsUsed ?? []), ...directive.agentsUsed])];
  if (directive.commandsRun?.length) issue.commandsRun = [...new Set([...(issue.commandsRun ?? []), ...directive.commandsRun])];

  session.turns.push({
    turn: turnIndex,
    role: provider.role,
    model: directive.tokenUsage?.model || provider.model || provider.provider,
    startedAt: turnStartedAt,
    completedAt: now(),
    promptFile: turnPromptFile,
    prompt: turnPrompt,
    output: turnResult.output,
    code: turnResult.code,
    success: turnResult.success,
    directiveStatus: directive.status,
    directiveSummary: directive.summary,
    nextPrompt: directive.nextPrompt,
    tokenUsage: directive.tokenUsage,
    toolsUsed: directive.toolsUsed,
    skillsUsed: directive.skillsUsed,
    agentsUsed: directive.agentsUsed,
    commandsRun: directive.commandsRun,
    contextPack: contextResult.pack,
    traceSteps: buildTraceFromContext(contextResult.pack, directive),
  });

  session.lastCode = lastCode;
  session.lastOutput = lastOutput;
  session.lastDirectiveStatus = directive.status;
  session.lastDirectiveSummary = directive.summary;
  session.nextPrompt = nextPrompt;

  const directiveSummary = directive.summary ? ` ${directive.summary}` : "";
  addEvent(state, issue.id, "runner", `Turn ${turnIndex}/${maxTurns} finished with status ${directive.status}.${directiveSummary}`.trim());

  if (!turnResult.success || directive.status === "failed") {
    logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, directiveStatus: directive.status, exitCode: lastCode }, "[Agent] Session turn failed");
    session.status = "failed";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: false, continueRequested: false, code: lastCode, output: lastOutput, turns: turnIndex };
  }

  if (directive.status === "blocked") {
    logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex }, "[Agent] Session turn blocked — manual intervention requested");
    session.status = "blocked";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: true, continueRequested: false, code: lastCode, output: lastOutput, turns: turnIndex };
  }

  if (directive.status === "continue") {
    logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, maxTurns }, "[Agent] Session requests continuation");
    session.status = "running";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: false, continueRequested: true, code: lastCode, output: lastOutput, turns: turnIndex };
  }

  logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex }, "[Agent] Session completed successfully");
  session.status = "done";
  await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
  return { success: true, blocked: false, continueRequested: false, code: lastCode, output: lastOutput, turns: turnIndex };
}

export async function runAgentPipeline(
  state: RuntimeState,
  issue: IssueEntry,
  workspacePath: string,
  basePromptText: string,
  basePromptFile: string,
  workflowConfig?: WorkflowConfig | null,
): Promise<AgentSessionResult> {
  const providers = getExecutionProviders(state, issue, workflowConfig);
  const attempt = issue.attempts + 1;
  logger.debug({ issueId: issue.id, identifier: issue.identifier, attempt, providers: providers.map((p) => `${p.role}:${p.provider}`) }, "[Agent] Starting pipeline");
  const { pipeline, key: pipelineFile } = await loadAgentPipelineState(issue, attempt, providers);
  const activeProvider = providers[clamp(pipeline.activeIndex, 0, Math.max(0, providers.length - 1))];
  const executorIndex = providers.findIndex((provider) => provider.role === "executor");

  // Discover skills, agents, commands and build context
  const skills = discoverSkills(workspacePath);
  const skillContext = buildSkillContext(skills);
  const agents = discoverAgents(workspacePath);
  const commands = discoverCommands(workspacePath);
  const capabilitiesManifest = buildCapabilitiesManifest(skills, agents, commands);

  // Write skills reference to workspace
  if (skillContext) {
    writeFileSync(join(workspacePath, "skills.md"), skillContext, "utf8");
  }

  // Compile plan-aware execution if plan exists
  const compiled = await compileExecution(issue, activeProvider, state.config, workspacePath, skillContext, capabilitiesManifest);
  const blueprint = issue.plan ? buildHarnessBlueprint(issue.plan, state.config) : null;
  const blueprintRun = blueprint ? startBlueprintRun(issue, blueprint, "execute") : null;
  if (issue.plan && blueprint) {
    issue.plan.blueprint = blueprint;
    issue.plan.executionContract.blueprintId = blueprint.id;
    issue.plan.executionContract.delegationPolicy = blueprint.delegationPolicy;
    issue.plan.executionContract.budgetPolicy = blueprint.budgetPolicy;
  }

  let providerPrompt: string;
  let effectiveProvider = activeProvider;
  let implementInputsArtifact = null;

  if (compiled) {
    providerPrompt = compiled.prompt;
    effectiveProvider = { ...activeProvider, command: compiled.command };
    persistCompilationArtifacts(workspacePath, compiled);
    addEvent(state, issue.id, "info",
      `Plan compiled for ${compiled.meta.adapter}: effort=${compiled.meta.reasoningEffort}, skills=[${compiled.meta.skillsActivated.join(",")}], subagents=[${compiled.meta.subagentsRequested.join(",")}].`);

    if (Object.keys(compiled.env).length > 0) {
      const envFile = join(workspacePath, ".compiled-env.sh");
      const envLines = Object.entries(compiled.env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n");
      writeFileSync(envFile, envLines, "utf8");
    }
    if (blueprint && blueprintRun) {
      implementInputsArtifact = writeBlueprintJsonArtifact(
        workspacePath,
        blueprintRun.id,
        BLUEPRINT_EXECUTION_NODE_IDS.implement,
        "inputs",
        {
          command: compiled.command,
          env: compiled.env,
          adapter: compiled.meta.adapter,
          model: compiled.meta.model,
          reasoningEffort: compiled.meta.reasoningEffort,
          subagentsRequested: compiled.meta.subagentsRequested,
          validationHooks: {
            pre: compiled.preHooks,
            post: compiled.postHooks,
          },
        },
      );
    }
  } else {
    providerPrompt = await buildProviderBasePrompt(activeProvider, issue, basePromptText, workspacePath, skillContext, capabilitiesManifest);
  }

  if (!effectiveProvider.command.trim()) {
    throw new Error(`No command configured for provider ${effectiveProvider.provider} (${effectiveProvider.role}).`);
  }

  // Inject retry context from previous failed attempts
  if (issue.attempts > 0) {
    const retryCtx = buildRetryContext(issue);
    if (retryCtx) {
      providerPrompt = `${providerPrompt}\n\n${retryCtx}`;
    }
  }

  pipeline.history.push(`[${now()}] Running ${effectiveProvider.role}:${effectiveProvider.provider} in cycle ${pipeline.cycle}${compiled ? ` [${compiled.meta.adapter} adapter]` : ""}.`);
  await persistAgentPipelineState(pipelineFile, pipeline);

  if (blueprint && blueprintRun && shouldRunBlueprintNode(blueprint, BLUEPRINT_EXECUTION_NODE_IDS.ingestContext, "execute")) {
    const contextNodeId = BLUEPRINT_EXECUTION_NODE_IDS.ingestContext;
    updateBlueprintNodeRun(blueprintRun, contextNodeId, "running");
    const contextResult = await buildContextMarkdown({
      role: effectiveProvider.role,
      title: issue.title,
      description: issue.description,
      issue,
      workspacePath,
      runtimeState: state,
    }).catch(() => ({ pack: null, markdown: "" }));
    const contextArtifacts = [
      writeBlueprintArtifact(
        workspacePath,
        blueprintRun.id,
        contextNodeId,
        "summary",
        contextResult.markdown || "# Ingest Context\n\nNo context markdown generated.\n",
      ),
      writeBlueprintJsonArtifact(
        workspacePath,
        blueprintRun.id,
        contextNodeId,
        "result",
        contextResult.pack ?? { role: effectiveProvider.role, hits: [] },
      ),
    ];
    attachNodeArtifacts(blueprintRun, contextNodeId, contextArtifacts);
    updateBlueprintNodeRun(blueprintRun, contextNodeId, "completed");
  }

  if (blueprint && blueprintRun && shouldRunBlueprintNode(blueprint, BLUEPRINT_EXECUTION_NODE_IDS.hydrateRules, "execute")) {
    const rulesNodeId = BLUEPRINT_EXECUTION_NODE_IDS.hydrateRules;
    updateBlueprintNodeRun(blueprintRun, rulesNodeId, "running");
    const artifacts = [
      writeBlueprintArtifact(
        workspacePath,
        blueprintRun.id,
        rulesNodeId,
        "summary",
        summarizeDeterministicNode("Hydrate Rules", {
          skills: skills.map((entry) => entry.name),
          agents: agents.map((entry) => entry.name),
          commands: commands.map((entry) => entry.name),
        }),
      ),
      writeBlueprintArtifact(
        workspacePath,
        blueprintRun.id,
        rulesNodeId,
        "result",
        capabilitiesManifest || "# Capabilities\n\nNo capabilities manifest generated.\n",
      ),
    ];
    attachNodeArtifacts(blueprintRun, rulesNodeId, artifacts);
    updateBlueprintNodeRun(blueprintRun, rulesNodeId, "completed");
  }

  if (blueprint && blueprintRun) {
    const implementNodeId = BLUEPRINT_EXECUTION_NODE_IDS.implement;
    updateBlueprintNodeRun(blueprintRun, implementNodeId, "running");
    const artifacts = [
      writeBlueprintArtifact(
        workspacePath,
        blueprintRun.id,
        implementNodeId,
        "brief",
        buildBlueprintBrief(issue, issue.plan!, blueprint, blueprint.nodes.find((entry) => entry.id === implementNodeId)!, effectiveProvider),
      ),
    ];
    if (implementInputsArtifact) artifacts.push(implementInputsArtifact);
    attachNodeArtifacts(blueprintRun, implementNodeId, artifacts);
  }

  const result = await runAgentSession(state, issue, effectiveProvider, pipeline.cycle, workspacePath, providerPrompt, basePromptFile);

  if (blueprint && blueprintRun) {
    const implementNodeId = BLUEPRINT_EXECUTION_NODE_IDS.implement;
    const implementArtifacts = [
      writeBlueprintArtifact(
        workspacePath,
        blueprintRun.id,
        implementNodeId,
        "result",
        result.output || "",
      ),
    ];
    if (result.continueRequested) {
      implementArtifacts.push(
        writeBlueprintArtifact(
          workspacePath,
          blueprintRun.id,
          implementNodeId,
          "resume",
          `# Resume\n\nAgent requested continuation for ${issue.identifier}.\n`,
        ),
      );
    }
    attachNodeArtifacts(blueprintRun, implementNodeId, implementArtifacts);
    updateBlueprintNodeRun(
      blueprintRun,
      implementNodeId,
      result.success ? "completed" : result.blocked ? "failed" : result.continueRequested ? "running" : "failed",
      result.success ? {} : { error: result.output.slice(-4000) },
    );
  }

  if (result.success) {
    if (compiled && blueprint && blueprintRun && shouldRunBlueprintNode(blueprint, BLUEPRINT_EXECUTION_NODE_IDS.runLocalGates, "execute")) {
      const localGateNodeId = BLUEPRINT_EXECUTION_NODE_IDS.runLocalGates;
      updateBlueprintNodeRun(blueprintRun, localGateNodeId, "running");
      const executedCommands = [...compiled.preHooks, ...compiled.postHooks];
      const gateArtifacts = [
        writeBlueprintArtifact(
          workspacePath,
          blueprintRun.id,
          localGateNodeId,
          "brief",
          buildBlueprintBrief(issue, issue.plan!, blueprint, blueprint.nodes.find((entry) => entry.id === localGateNodeId)!),
        ),
      ];
      attachNodeArtifacts(blueprintRun, localGateNodeId, gateArtifacts);

      try {
        for (const command of executedCommands) {
          await runHook(command, workspacePath, issue, "blueprint_local_gate");
        }
        const resultArtifact = writeBlueprintArtifact(
          workspacePath,
          blueprintRun.id,
          localGateNodeId,
          "result",
          summarizeDeterministicNode("Run Local Gates", {
            commands: executedCommands,
            status: executedCommands.length > 0 ? "pass" : "skipped",
          }),
        );
        attachNodeArtifacts(blueprintRun, localGateNodeId, [resultArtifact]);
        updateBlueprintNodeRun(
          blueprintRun,
          localGateNodeId,
          executedCommands.length > 0 ? "completed" : "skipped",
          executedCommands.length > 0 ? {} : { skippedReason: "No local gate commands were compiled for this plan." },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failureArtifact = writeBlueprintArtifact(
          workspacePath,
          blueprintRun.id,
          localGateNodeId,
          "result",
          `# Local Gate Failure\n\n${message}\n`,
        );
        attachNodeArtifacts(blueprintRun, localGateNodeId, [failureArtifact]);
        updateBlueprintNodeRun(blueprintRun, localGateNodeId, "failed", { error: message });
        finalizeBlueprintRun(blueprintRun, "failed");
        return {
          success: false,
          blocked: false,
          continueRequested: false,
          code: result.code,
          output: message,
          turns: result.turns,
          artifacts: failureArtifact ? [failureArtifact] : [],
        };
      }
    }

    if (blueprint && blueprintRun) {
      const handoffNodeId = BLUEPRINT_EXECUTION_NODE_IDS.handoff;
      updateBlueprintNodeRun(blueprintRun, handoffNodeId, "running");
      const artifacts = [
        writeBlueprintArtifact(
          workspacePath,
          blueprintRun.id,
          handoffNodeId,
          "resume",
          `# Handoff\n\nExecution completed for ${issue.identifier}.\n\nNext stage: review.\n`,
        ),
      ];
      attachNodeArtifacts(blueprintRun, handoffNodeId, artifacts);
      updateBlueprintNodeRun(blueprintRun, handoffNodeId, "completed");
      finalizeBlueprintRun(blueprintRun, "completed");
    }

    if (pipeline.activeIndex < providers.length - 1) {
      pipeline.activeIndex += 1;
      pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} completed; advancing to next provider.`);
      await persistAgentPipelineState(pipelineFile, pipeline);
      return { success: false, blocked: false, continueRequested: true, code: result.code, output: result.output, turns: result.turns };
    }
    pipeline.history.push(`[${now()}] Final provider ${activeProvider.role}:${activeProvider.provider} completed the issue.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  if (result.continueRequested && activeProvider.role === "reviewer" && executorIndex >= 0) {
    pipeline.cycle += 1;
    pipeline.activeIndex = executorIndex;
    pipeline.history.push(`[${now()}] Reviewer requested rework; returning to executor for cycle ${pipeline.cycle}.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  if (result.continueRequested) {
    pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} requested another turn.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  if (result.blocked) {
    if (blueprintRun) finalizeBlueprintRun(blueprintRun, "failed");
    pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} blocked the pipeline.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  if (blueprintRun) finalizeBlueprintRun(blueprintRun, "failed");
  pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} failed the pipeline.`);
  await persistAgentPipelineState(pipelineFile, pipeline);
  return result;
}
