import {
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
import { getEffectiveAgentProviders } from "./providers.ts";
import { addEvent } from "../domains/issues.ts";
import { compileExecution, persistCompilationArtifacts } from "./adapters/index.ts";
import { discoverSkills, buildSkillContext } from "../agents/skills.ts";
import {
  loadAgentSessionState,
  persistAgentSessionState,
  loadAgentPipelineState,
  persistAgentPipelineState,
  buildProviderSessionKey,
} from "./session-state.ts";
import { readAgentDirective, addTokenUsage } from "./directive-parser.ts";
import { buildTurnPrompt, buildProviderBasePrompt } from "./prompt-builder.ts";
import { runCommandWithTimeout, runHook } from "./command-executor.ts";
import { record as recordTokens } from "../domains/tokens.ts";

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
  const turnPrompt = await buildTurnPrompt(issue, basePromptText, compactedOutput, turnIndex, maxTurns, nextPrompt);
  const turnPromptFile = turnIndex === 1
    ? basePromptFile
    : join(workspacePath, `turn-${String(turnIndex).padStart(2, "0")}.md`);

  if (turnIndex > 1) writeFileSync(turnPromptFile, `${turnPrompt}\n`, "utf8");

  session.status = "running";
  session.lastPrompt = turnPrompt;
  session.lastPromptFile = turnPromptFile;
  session.maxTurns = maxTurns;
  await persistAgentSessionState(sessionKey, issue, provider, cycle, session);

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

  const turnResult = await runCommandWithTimeout(provider.command, workspacePath, issue, state.config, turnPrompt, turnPromptFile, turnEnv);

  if (state.config.afterRunHook) {
    await runHook(state.config.afterRunHook, workspacePath, issue, "after_run", {
      ...turnEnv,
      FIFONY_LAST_EXIT_CODE: String(turnResult.code ?? ""),
      FIFONY_LAST_OUTPUT: turnResult.output,
      FIFONY_PRESERVE_RESULT_FILE: "1",
    });
  }

  logger.info({ issueId: issue.id, identifier: issue.identifier, turn: turnIndex, exitCode: turnResult.code, success: turnResult.success, outputBytes: turnResult.output.length }, "[Agent] Agent command finished");
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
  const providers = getEffectiveAgentProviders(state, issue, null, workflowConfig);
  const attempt = issue.attempts + 1;
  logger.debug({ issueId: issue.id, identifier: issue.identifier, attempt, providers: providers.map((p) => `${p.role}:${p.provider}`) }, "[Agent] Starting pipeline");
  const { pipeline, key: pipelineFile } = await loadAgentPipelineState(issue, attempt, providers);
  const activeProvider = providers[clamp(pipeline.activeIndex, 0, Math.max(0, providers.length - 1))];
  const executorIndex = providers.findIndex((provider) => provider.role === "executor");

  // Discover skills and build context
  const skills = discoverSkills(workspacePath);
  const skillContext = buildSkillContext(skills);

  // Write skills reference to workspace
  if (skillContext) {
    writeFileSync(join(workspacePath, "skills.md"), skillContext, "utf8");
  }

  // Compile plan-aware execution if plan exists
  const compiled = await compileExecution(issue, activeProvider, state.config, workspacePath, skillContext);

  let providerPrompt: string;
  let effectiveProvider = activeProvider;

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
  } else {
    providerPrompt = await buildProviderBasePrompt(activeProvider, issue, basePromptText, workspacePath, skillContext);
  }

  if (!effectiveProvider.command.trim()) {
    throw new Error(`No command configured for provider ${effectiveProvider.provider} (${effectiveProvider.role}).`);
  }

  pipeline.history.push(`[${now()}] Running ${effectiveProvider.role}:${effectiveProvider.provider} in cycle ${pipeline.cycle}${compiled ? ` [${compiled.meta.adapter} adapter]` : ""}.`);
  await persistAgentPipelineState(pipelineFile, pipeline);

  const result = await runAgentSession(state, issue, effectiveProvider, pipeline.cycle, workspacePath, providerPrompt, basePromptFile);

  if (result.success) {
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
    pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} blocked the pipeline.`);
    await persistAgentPipelineState(pipelineFile, pipeline);
    return result;
  }

  pipeline.history.push(`[${now()}] ${activeProvider.role}:${activeProvider.provider} failed the pipeline.`);
  await persistAgentPipelineState(pipelineFile, pipeline);
  return result;
}
