import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { spawn } from "node:child_process";
import type {
  AgentDirective,
  AgentDirectiveStatus,
  AgentPipelineRecord,
  AgentPipelineState,
  AgentProviderDefinition,
  AgentSessionRecord,
  AgentSessionResult,
  AgentSessionState,
  AgentSessionTurn,
  IssueEntry,
  JsonRecord,
  RuntimeConfig,
  RuntimeState,
  WorkflowDefinition,
} from "./types.ts";
import {
  SOURCE_ROOT,
  TERMINAL_STATES,
  WORKSPACE_ROOT,
} from "./constants.ts";
import {
  now,
  sleep,
  toStringValue,
  toNumberValue,
  clamp,
  idToSafePath,
  appendFileTail,
  getNestedRecord,
  getNestedNumber,
} from "./helpers.ts";
import { logger } from "./logger.ts";
import {
  getAgentSessionResource,
  getAgentPipelineResource,
  isStateNotFoundError,
  persistState,
} from "./store.ts";
import {
  normalizeAgentProvider,
  getEffectiveAgentProviders,
  applyCapabilityMetadata,
} from "./providers.ts";
import {
  addEvent,
  transitionIssueState,
  computeMetrics,
  getNextRetryAt,
} from "./issues.ts";
import {
  inferCapabilityPaths,
  resolveTaskCapabilities,
} from "../routing/capability-resolver.ts";
import { discoverSkills, buildSkillContext } from "./skills.ts";

function normalizeAgentDirectiveStatus(value: unknown, fallback: AgentDirectiveStatus): AgentDirectiveStatus {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "done" || normalized === "continue" || normalized === "blocked" || normalized === "failed") {
    return normalized;
  }
  return fallback;
}

function extractOutputMarker(output: string, name: string): string {
  const match = output.match(new RegExp(`^${name}=(.+)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function tryParseJsonOutput(output: string): JsonRecord | null {
  const trimmed = output.trim();
  // --output-format json wraps the result in a JSON object with a "result" field
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as JsonRecord;
      // Claude --output-format json returns { result: "..." } — the result may itself be JSON
      if (typeof obj.result === "string") {
        try {
          const inner = JSON.parse(obj.result) as unknown;
          if (inner && typeof inner === "object" && !Array.isArray(inner)) {
            return inner as JsonRecord;
          }
        } catch {
          // result is plain text, not JSON
        }
      }
      // Direct JSON with status field (from --json-schema)
      if (obj.status) return obj;
    }
  } catch {
    // Not JSON output — fall through to legacy parsing
  }
  return null;
}

function readAgentDirective(workspacePath: string, output: string, success: boolean): AgentDirective {
  const fallbackStatus: AgentDirectiveStatus = success ? "done" : "failed";
  const resultFile = join(workspacePath, "symphifony-result.json");
  let resultPayload: JsonRecord = {};

  // 1. Try structured JSON from stdout (claude --output-format json --json-schema)
  const jsonOutput = tryParseJsonOutput(output);
  if (jsonOutput?.status) {
    return {
      status: normalizeAgentDirectiveStatus(jsonOutput.status, fallbackStatus),
      summary: toStringValue(jsonOutput.summary) || toStringValue(jsonOutput.message) || "",
      nextPrompt: toStringValue(jsonOutput.nextPrompt) || toStringValue(jsonOutput.next_prompt) || "",
    };
  }

  // 2. Try symphifony-result.json file
  if (existsSync(resultFile)) {
    try {
      const parsed = JSON.parse(readFileSync(resultFile, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        resultPayload = parsed as JsonRecord;
      }
    } catch (error) {
      logger.warn(`Invalid symphifony-result.json in ${workspacePath}: ${String(error)}`);
    }
  }

  // 3. Fall back to file + output marker parsing
  const status = normalizeAgentDirectiveStatus(
    resultPayload.status ?? extractOutputMarker(output, "SYMPHIFONY_STATUS"),
    fallbackStatus,
  );
  const summary =
    toStringValue(resultPayload.summary)
    || toStringValue(resultPayload.message)
    || extractOutputMarker(output, "SYMPHIFONY_SUMMARY");
  const nextPrompt =
    toStringValue(resultPayload.nextPrompt)
    || toStringValue(resultPayload.next_prompt)
    || "";

  return { status, summary, nextPrompt };
}

export function canRunIssue(issue: IssueEntry, running: Set<string>, state: RuntimeState): boolean {
  if (!issue.assignedToWorker) return false;
  if (running.has(issue.id)) return false;
  if (TERMINAL_STATES.has(issue.state)) return false;

  if (issue.state === "Blocked") {
    if (!issue.nextRetryAt) return false;
    if (issue.attempts >= issue.maxAttempts) return false;
    if (Date.parse(issue.nextRetryAt) > Date.now()) return false;
  }

  if (!issueDepsResolved(issue, state.issues)) return false;

  if (issue.state === "Todo") return true;
  if (issue.state === "Queued") return true;
  if (issue.state === "Blocked") return true;
  if (issue.state === "Interrupted") return true;
  if (issue.state === "Running" && issueHasResumableSession(issue)) return true;
  if (issue.state === "In Review") return true;

  return false;
}

function issueDepsResolved(issue: IssueEntry, allIssues: IssueEntry[]): boolean {
  if (issue.blockedBy.length === 0) return true;
  const map = new Map(allIssues.map((entry) => [entry.id, entry]));
  return issue.blockedBy.every((depId) => {
    const dep = map.get(depId);
    return dep?.state === "Done";
  });
}

function shouldSkipRoutingPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((segment) => segment === ".git" || segment === "node_modules" || segment === ".symphifony")) {
    return true;
  }
  const base = parts.at(-1) ?? "";
  return base === "WORKFLOW.local.md"
    || base === ".symphifony-env.sh"
    || base.startsWith("symphifony-")
    || base.startsWith("symphifony_");
}

function inferChangedWorkspacePaths(workspacePath: string, limit = 32): string[] {
  if (!workspacePath || !existsSync(workspacePath) || !existsSync(SOURCE_ROOT)) return [];

  const changed = new Set<string>();

  const walk = (currentRoot: string, relativeRoot = ""): void => {
    if (changed.size >= limit) return;
    for (const item of readdirSync(currentRoot, { withFileTypes: true })) {
      if (changed.size >= limit) return;
      const nextRelative = relativeRoot ? `${relativeRoot}/${item.name}` : item.name;
      if (shouldSkipRoutingPath(nextRelative)) continue;
      const currentPath = join(currentRoot, item.name);
      if (item.isDirectory()) { walk(currentPath, nextRelative); continue; }
      if (!item.isFile()) continue;
      const sourcePath = join(SOURCE_ROOT, nextRelative);
      if (!existsSync(sourcePath)) { changed.add(nextRelative); continue; }
      const currentStat = statSync(currentPath);
      const sourceStat = statSync(sourcePath);
      if (currentStat.size !== sourceStat.size) { changed.add(nextRelative); continue; }
      const currentFile = readFileSync(currentPath);
      const sourceFile = readFileSync(sourcePath);
      if (!currentFile.equals(sourceFile)) changed.add(nextRelative);
    }
  };

  walk(workspacePath);
  return [...changed];
}

export function hydrateIssuePathsFromWorkspace(issue: IssueEntry): string[] {
  const inferredPaths = inferChangedWorkspacePaths(issue.workspacePath ?? "");
  if (inferredPaths.length === 0) return [];
  issue.paths = [...new Set([...(issue.paths ?? []), ...inferredPaths])];
  issue.inferredPaths = [...new Set([...(issue.inferredPaths ?? []), ...inferredPaths])];
  return inferredPaths;
}

export function describeRoutingSignals(issue: IssueEntry, workspaceDerivedPaths: string[]): string {
  const explicitPaths = issue.paths ?? [];
  const textDerivedPaths = inferCapabilityPaths({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    labels: issue.labels,
  }).filter((path) => !explicitPaths.includes(path));

  const parts: string[] = [];
  if (explicitPaths.length > 0) parts.push(`payload paths=${explicitPaths.join(", ")}`);
  if (textDerivedPaths.length > 0) parts.push(`text hints=${textDerivedPaths.join(", ")}`);
  if (workspaceDerivedPaths.length > 0) parts.push(`workspace diff=${workspaceDerivedPaths.join(", ")}`);
  return parts.join(" | ");
}

function buildAgentSessionState(
  issue: IssueEntry,
  attempt: number,
  maxTurns: number,
): AgentSessionState {
  const createdAt = now();
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    attempt,
    status: "running",
    startedAt: createdAt,
    updatedAt: createdAt,
    maxTurns,
    turns: [],
    lastPrompt: "",
    lastPromptFile: "",
    lastOutput: "",
    lastCode: null,
    lastDirectiveStatus: "continue",
    lastDirectiveSummary: "",
    nextPrompt: "",
  };
}

async function loadAgentSessionState(
  sessionKey: string,
  issue: IssueEntry,
  attempt: number,
  maxTurns: number,
): Promise<{ session: AgentSessionState; key: string }> {
  const agentSessionResource = getAgentSessionResource();
  if (agentSessionResource) {
    try {
      const record = await agentSessionResource.get(sessionKey) as AgentSessionRecord;
      if (
        record?.session
        && record.issueId === issue.id
        && record.attempt === attempt
        && Array.isArray(record.session.turns)
      ) {
        return {
          session: {
            ...buildAgentSessionState(issue, attempt, maxTurns),
            ...record.session,
            maxTurns,
            turns: record.session.turns as AgentSessionTurn[],
            updatedAt: now(),
          },
          key: sessionKey,
        };
      }
    } catch (error) {
      if (!isStateNotFoundError(error)) {
        logger.warn(`Failed to load session state for ${issue.id}: ${String(error)}`);
      }
    }
  }

  return { session: buildAgentSessionState(issue, attempt, maxTurns), key: sessionKey };
}

async function persistAgentSessionState(
  key: string,
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  cycle: number,
  session: AgentSessionState,
): Promise<void> {
  session.updatedAt = now();
  const agentSessionResource = getAgentSessionResource();
  if (!agentSessionResource) return;

  await agentSessionResource.replace(key, {
    id: key,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    attempt: session.attempt,
    cycle,
    provider: provider.provider,
    role: provider.role,
    updatedAt: session.updatedAt,
    session,
  } satisfies AgentSessionRecord);
}

export function issueHasResumableSession(issue: IssueEntry): boolean {
  return Boolean(issue.workspacePath) && (issue.state === "Running" || issue.state === "Interrupted");
}

function buildProviderSessionKey(issue: IssueEntry, attempt: number, provider: AgentProviderDefinition, cycle: number): string {
  return `${idToSafePath(issue.id)}-a${attempt}-${provider.role}-${provider.provider}-c${cycle}`;
}

function buildPipelineKey(issue: IssueEntry, attempt: number): string {
  return `${idToSafePath(issue.id)}-a${attempt}`;
}

function getLatestPipelineAttempt(issue: IssueEntry): number {
  if (issue.state === "Blocked" || issue.state === "Cancelled") {
    return Math.max(1, issue.attempts);
  }
  return Math.max(1, issue.attempts + 1);
}

function stateConfigMaxTurnsFallback(workflowDefinition: WorkflowDefinition | null): number {
  if (!workflowDefinition) return 4;
  return clamp(getNestedNumber(getNestedRecord(workflowDefinition.config, "agent"), "max_turns", 4), 1, 16);
}

export async function loadAgentPipelineState(
  issue: IssueEntry,
  attempt: number,
  providers: AgentProviderDefinition[],
): Promise<{ pipeline: AgentPipelineState; key: string }> {
  const pipelineKey = buildPipelineKey(issue, attempt);
  const agentPipelineResource = getAgentPipelineResource();

  if (agentPipelineResource) {
    try {
      const record = await agentPipelineResource.get(pipelineKey) as AgentPipelineRecord;
      if (record?.pipeline && record.issueId === issue.id && record.attempt === attempt) {
        return {
          pipeline: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            attempt,
            cycle: Math.max(1, toNumberValue(record.pipeline.cycle, 1)),
            activeIndex: clamp(toNumberValue(record.pipeline.activeIndex, 0), 0, Math.max(0, providers.length - 1)),
            updatedAt: now(),
            history: Array.isArray(record.pipeline.history)
              ? record.pipeline.history.filter((entry): entry is string => typeof entry === "string")
              : [],
          },
          key: pipelineKey,
        };
      }
    } catch (error) {
      if (!isStateNotFoundError(error)) {
        logger.warn(`Failed to load pipeline state for ${issue.id}: ${String(error)}`);
      }
    }
  }

  return {
    pipeline: {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt,
      cycle: 1,
      activeIndex: 0,
      updatedAt: now(),
      history: [],
    },
    key: pipelineKey,
  };
}

async function persistAgentPipelineState(key: string, pipeline: AgentPipelineState): Promise<void> {
  pipeline.updatedAt = now();
  const agentPipelineResource = getAgentPipelineResource();
  if (!agentPipelineResource) return;

  await agentPipelineResource.replace(key, {
    id: key,
    issueId: pipeline.issueId,
    issueIdentifier: pipeline.issueIdentifier,
    attempt: pipeline.attempt,
    updatedAt: pipeline.updatedAt,
    pipeline,
  } satisfies AgentPipelineRecord);
}

export async function loadAgentPipelineSnapshotForIssue(
  issue: IssueEntry,
  providers: AgentProviderDefinition[],
): Promise<AgentPipelineState | null> {
  const attempt = getLatestPipelineAttempt(issue);
  const agentPipelineResource = getAgentPipelineResource();

  if (agentPipelineResource?.list) {
    try {
      const records = await agentPipelineResource.list({
        partition: "byIssueAttempt",
        partitionValues: { issueId: issue.id, attempt },
        limit: 10,
      });
      const record = records
        .map((entry) => entry as AgentPipelineRecord)
        .find((entry) => entry.issueId === issue.id && entry.attempt === attempt && entry.pipeline);
      if (record?.pipeline) {
        return {
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          attempt,
          cycle: Math.max(1, toNumberValue(record.pipeline.cycle, 1)),
          activeIndex: clamp(toNumberValue(record.pipeline.activeIndex, 0), 0, Math.max(0, providers.length - 1)),
          updatedAt: now(),
          history: Array.isArray(record.pipeline.history)
            ? record.pipeline.history.filter((entry): entry is string => typeof entry === "string")
            : [],
        };
      }
    } catch (error) {
      logger.warn(`Failed to load partitioned pipeline snapshot for ${issue.id}: ${String(error)}`);
    }
  }

  const loaded = await loadAgentPipelineState(issue, attempt, providers);
  return loaded.pipeline.history.length > 0 ? loaded.pipeline : null;
}

export async function loadAgentSessionSnapshotsForIssue(
  issue: IssueEntry,
  providers: AgentProviderDefinition[],
  pipeline: AgentPipelineState | null,
  workflowDefinition: WorkflowDefinition | null,
): Promise<Array<{ key: string; session: AgentSessionState; provider: string; role: string; cycle: number }>> {
  if (!pipeline) return [];

  const sessions: Array<{ key: string; session: AgentSessionState; provider: string; role: string; cycle: number }> = [];
  const attempt = pipeline.attempt;
  const agentSessionResource = getAgentSessionResource();
  const maxTurns = stateConfigMaxTurnsFallback(workflowDefinition);

  if (agentSessionResource?.list) {
    try {
      const records = await agentSessionResource.list({
        partition: "byIssueAttempt",
        partitionValues: { issueId: issue.id, attempt },
        limit: Math.max(12, providers.length * Math.max(1, pipeline.cycle) * 2),
      });
      const loadedSessions = records
        .map((entry) => entry as AgentSessionRecord)
        .filter((entry) => entry.issueId === issue.id && entry.attempt === attempt && entry.session && Array.isArray(entry.session.turns));

      for (const record of loadedSessions) {
        if (!record.session.turns.length) continue;
        sessions.push({
          key: record.id,
          session: {
            ...buildAgentSessionState(issue, attempt, maxTurns),
            ...record.session,
            maxTurns,
            turns: record.session.turns as AgentSessionTurn[],
            updatedAt: now(),
          },
          provider: record.provider,
          role: record.role,
          cycle: record.cycle,
        });
      }

      sessions.sort((a, b) => a.cycle !== b.cycle ? a.cycle - b.cycle : a.key.localeCompare(b.key));
      if (sessions.length > 0) return sessions;
    } catch (error) {
      logger.warn(`Failed to load partitioned session snapshots for ${issue.id}: ${String(error)}`);
    }
  }

  for (let cycle = 1; cycle <= pipeline.cycle; cycle += 1) {
    for (const provider of providers) {
      const key = buildProviderSessionKey(issue, attempt, provider, cycle);
      const loaded = await loadAgentSessionState(key, issue, attempt, maxTurns);
      if (loaded.session.turns.length === 0) continue;
      sessions.push({
        key,
        session: loaded.session,
        provider: provider.provider,
        role: provider.role,
        cycle,
      });
    }
  }

  return sessions;
}

function buildPrompt(issue: IssueEntry, workflowDefinition: WorkflowDefinition | null): string {
  const template = workflowDefinition?.promptTemplate.trim() || [
    "You are working on {{ issue.identifier }}.",
    "",
    "Title: {{ issue.title }}",
    "Description:",
    "{{ issue.description }}",
  ].join("\n");

  const knownKeys = new Set(Object.keys(issue));
  const errors: string[] = [];

  const rendered = template.replace(/{{\s*issue\.([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
    if (!knownKeys.has(key)) {
      errors.push(`Unknown template variable: issue.${key}`);
      return `{{ issue.${key} }}`;
    }
    const value = issue[key as keyof IssueEntry];
    if (Array.isArray(value)) return value.join(", ");
    return value == null ? "" : String(value);
  });

  // Also check for {{ attempt }} variable
  const withAttempt = rendered.replace(/{{\s*attempt\s*}}/g, String(issue.attempts || 0));

  if (errors.length > 0) {
    throw new Error(`Prompt rendering failed: ${errors.join("; ")}`);
  }

  return withAttempt;
}

function buildTurnPrompt(
  issue: IssueEntry,
  basePrompt: string,
  previousOutput: string,
  turnIndex: number,
  maxTurns: number,
  nextPrompt: string,
): string {
  if (turnIndex === 1) return basePrompt;

  const outputTail = previousOutput.trim() || "No previous output captured.";
  const continuation = nextPrompt.trim() || "Continue the work, inspect the workspace, and move the issue toward completion.";

  return [
    `Continue working on ${issue.identifier}.`,
    `Turn ${turnIndex} of ${maxTurns}.`,
    "",
    "Base objective:",
    basePrompt,
    "",
    "Continuation guidance:",
    continuation,
    "",
    "Previous command output tail:",
    "```text",
    outputTail,
    "```",
    "",
    "Before exiting successfully, emit one of the following control markers:",
    "- `SYMPHIFONY_STATUS=continue` if more turns are required.",
    "- `SYMPHIFONY_STATUS=done` if the issue is complete.",
    "- `SYMPHIFONY_STATUS=blocked` if manual intervention is required.",
    'You may also write `symphifony-result.json` with `{ "status": "...", "summary": "...", "nextPrompt": "..." }`.',
  ].join("\n");
}

function buildProviderBasePrompt(
  provider: AgentProviderDefinition,
  issue: IssueEntry,
  basePrompt: string,
  workspacePath: string,
  skillContext: string,
): string {
  const roleInstructions = provider.role === "planner"
    ? [
        "Role: planner.",
        "Analyze the issue and prepare an execution plan for the implementation agents.",
        "Do not claim the issue is complete unless the plan itself is the deliverable.",
      ]
    : provider.role === "reviewer"
      ? [
          "Role: reviewer.",
          "Inspect the workspace and review the current implementation critically.",
          "If rework is required, emit `SYMPHIFONY_STATUS=continue` and provide actionable `nextPrompt` feedback.",
          "Emit `SYMPHIFONY_STATUS=done` only when the work is acceptable.",
        ]
      : [
          "Role: executor.",
          "Implement the required changes in the workspace.",
          "Use any planner guidance or prior reviewer feedback already persisted in the workspace.",
        ];

  const overlayInstructions = provider.overlays?.includes("impeccable")
    ? [
        "Impeccable overlay is active.",
        "Raise the bar on UI polish, clarity, responsiveness, visual hierarchy, and interaction quality.",
        provider.role === "reviewer"
          ? "Review with a stricter frontend and product-quality standard than a normal correctness-only pass."
          : "When touching frontend work, do not settle for baseline implementation quality.",
      ]
    : provider.overlays?.includes("frontend-design")
      ? [
          "Frontend-design overlay is active.",
          "Prefer stronger hierarchy, spacing, and readability decisions over generic implementation choices.",
        ]
      : [];

  const sections = [
    ...roleInstructions,
    ...overlayInstructions,
    ...(provider.profileInstructions
      ? ["", "## Agent Profile", provider.profileInstructions]
      : []),
    ...(skillContext ? ["", skillContext] : []),
    ...(provider.capabilityCategory
      ? [
          "",
          `Capability routing: ${provider.capabilityCategory}.`,
          `Selection reason: ${provider.selectionReason ?? "No additional routing reason."}`,
          ...(provider.overlays?.length ? [`Overlays: ${provider.overlays.join(", ")}.`] : []),
        ]
      : []),
    ...(issue.paths?.length
      ? ["", `Target paths: ${issue.paths.join(", ")}`]
      : []),
    "",
    `Workspace: ${workspacePath}`,
    "",
    basePrompt,
  ];

  return sections.join("\n");
}

async function runCommandWithTimeout(
  command: string,
  workspacePath: string,
  issue: IssueEntry,
  config: RuntimeConfig,
  promptText: string,
  promptFile: string,
  extraEnv: Record<string, string> = {},
): Promise<{ success: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const resultFile = extraEnv.SYMPHIFONY_RESULT_FILE;
    if (resultFile && extraEnv.SYMPHIFONY_PRESERVE_RESULT_FILE !== "1") {
      rmSync(resultFile, { force: true });
    }

    // Write all SYMPHIFONY_* vars to an env file and source it in the command.
    // This avoids E2BIG: child inherits process.env naturally (no ...env spread),
    // and our custom vars are loaded from a file instead of argv/env.
    const allVars: Record<string, string> = {
      SYMPHIFONY_ISSUE_ID: issue.id,
      SYMPHIFONY_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHIFONY_ISSUE_TITLE: issue.title,
      SYMPHIFONY_ISSUE_PRIORITY: String(issue.priority),
      SYMPHIFONY_WORKSPACE_PATH: workspacePath,
      SYMPHIFONY_PROMPT_FILE: promptFile,
    };
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value.length > 4000) {
        const valFile = join(workspacePath, `${key.toLowerCase()}.txt`);
        writeFileSync(valFile, value, "utf8");
        allVars[`${key}_FILE`] = valFile;
      } else {
        allVars[key] = value;
      }
    }

    const envFilePath = join(workspacePath, ".symphifony-env.sh");
    const envFileLines = Object.entries(allVars)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("\n");
    writeFileSync(envFilePath, envFileLines, "utf8");

    const wrappedCommand = `. "${envFilePath}" && ${command}`;
    const child = spawn(wrappedCommand, {
      shell: true,
      cwd: workspacePath,
    });

    if (child.stdin) {
      child.stdin.end();
    }

    let output = "";
    let timedOut = false;
    let outputBytes = 0;
    const liveLogFile = join(workspacePath, "symphifony-live-output.log");
    // Truncate live log at start
    writeFileSync(liveLogFile, "", "utf8");

    const onChunk = (chunk: Buffer | string) => {
      const text = String(chunk);
      output = appendFileTail(output, text, config.logLinesTail);
      outputBytes += text.length;
      // Append to live log file for monitoring
      try { appendFileSync(liveLogFile, text); } catch {}
      // Update issue output tail in-place for real-time visibility
      issue.commandOutputTail = output;
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, config.commandTimeoutMs);

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ success: false, code: null, output: `Command execution failed for issue ${issue.id}.` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ success: false, code: null, output: appendFileTail(output, `\nExecution timeout after ${config.commandTimeoutMs}ms.`, config.logLinesTail) });
        return;
      }
      const duration = Math.max(0, Date.now() - started);
      if (code === 0) {
        resolve({ success: true, code, output: appendFileTail(output, `\nExecution succeeded in ${duration}ms.`, config.logLinesTail) });
        return;
      }
      resolve({ success: false, code, output: appendFileTail(output, `\nCommand exit code ${code ?? "unknown"} after ${duration}ms.`, config.logLinesTail) });
    });
  });
}

async function runHook(
  command: string,
  workspacePath: string,
  issue: IssueEntry,
  hookName: string,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  if (!command.trim()) return;

  const result = await runCommandWithTimeout(command, workspacePath, issue, {
    pollIntervalMs: 0,
    workerConcurrency: 1,
    maxConcurrentByState: {},
    commandTimeoutMs: 300_000,
    maxAttemptsDefault: 1,
    retryDelayMs: 0,
    staleInProgressTimeoutMs: 0,
    logLinesTail: 12_000,
    agentProvider: normalizeAgentProvider(env.SYMPHIFONY_AGENT_PROVIDER ?? "codex"),
    agentCommand: command,
    maxTurns: 1,
    runMode: "filesystem",
  }, "", "", { SYMPHIFONY_HOOK_NAME: hookName, ...extraEnv });

  if (!result.success) {
    throw new Error(`${hookName} hook failed: ${result.output}`);
  }
}

export async function cleanWorkspace(
  issueId: string,
  workflowDefinition: WorkflowDefinition | null,
): Promise<void> {
  const safeId = idToSafePath(issueId);
  const workspacePath = join(WORKSPACE_ROOT, safeId);
  if (!existsSync(workspacePath)) return;

  // Run before_remove hook (failure is logged but ignored)
  if (workflowDefinition?.beforeRemoveHook) {
    try {
      const dummyIssue = { id: issueId, identifier: issueId } as IssueEntry;
      await runHook(workflowDefinition.beforeRemoveHook, workspacePath, dummyIssue, "before_remove");
    } catch (error) {
      logger.warn(`before_remove hook failed for ${issueId}: ${String(error)}`);
    }
  }

  try {
    rmSync(workspacePath, { recursive: true, force: true });
    logger.info(`Cleaned workspace for ${issueId}: ${workspacePath}`);
  } catch (error) {
    logger.warn(`Failed to clean workspace for ${issueId}: ${String(error)}`);
  }
}

async function prepareWorkspace(
  issue: IssueEntry,
  workflowDefinition: WorkflowDefinition | null,
): Promise<{ workspacePath: string; promptText: string; promptFile: string }> {
  const safeId = idToSafePath(issue.id);
  const workspaceRoot = join(WORKSPACE_ROOT, safeId);
  const createdNow = !existsSync(workspaceRoot);

  if (createdNow) {
    mkdirSync(workspaceRoot, { recursive: true });
    if (workflowDefinition?.afterCreateHook) {
      await runHook(workflowDefinition.afterCreateHook, workspaceRoot, issue, "after_create");
    } else {
      cpSync(SOURCE_ROOT, workspaceRoot, {
        recursive: true,
        force: true,
        filter: (sourcePath) => !sourcePath.startsWith(WORKSPACE_ROOT),
      });
    }
  }

  const metaPath = join(workspaceRoot, "symphifony-issue.json");
  const promptText = buildPrompt(issue, workflowDefinition);
  const promptFile = join(workspaceRoot, "symphifony-prompt.md");
  writeFileSync(metaPath, JSON.stringify({ ...issue, runtimeSource: SOURCE_ROOT, bootstrapAt: now() }, null, 2), "utf8");
  writeFileSync(promptFile, `${promptText}\n`, "utf8");

  issue.workspacePath = workspaceRoot;
  issue.workspacePreparedAt = now();

  return { workspacePath: workspaceRoot, promptText, promptFile };
}

async function runAgentSession(
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
  const resultFile = join(workspacePath, `symphifony-result-${provider.role}-${provider.provider}.json`);

  if (session.status === "done" && session.turns.length > 0) {
    return { success: true, blocked: false, continueRequested: false, code: session.lastCode, output: session.lastOutput, turns: session.turns.length };
  }

  const turnIndex = session.turns.length + 1;
  if (turnIndex > maxTurns) {
    session.status = "blocked";
    session.lastOutput = appendFileTail(lastOutput, `\nAgent requested additional turns beyond configured limit (${maxTurns}).`, state.config.logLinesTail);
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: true, continueRequested: false, code: lastCode, output: session.lastOutput, turns: session.turns.length };
  }

  const turnPrompt = buildTurnPrompt(issue, basePromptText, previousOutput, turnIndex, maxTurns, nextPrompt);
  const turnPromptFile = turnIndex === 1
    ? basePromptFile
    : join(workspacePath, `symphifony-turn-${String(turnIndex).padStart(2, "0")}.md`);

  if (turnIndex > 1) writeFileSync(turnPromptFile, `${turnPrompt}\n`, "utf8");

  session.status = "running";
  session.lastPrompt = turnPrompt;
  session.lastPromptFile = turnPromptFile;
  session.maxTurns = maxTurns;
  await persistAgentSessionState(sessionKey, issue, provider, cycle, session);

  const turnStartedAt = now();
  const turnEnv = {
    SYMPHIFONY_AGENT_PROVIDER: provider.provider,
    SYMPHIFONY_AGENT_ROLE: provider.role,
    SYMPHIFONY_SESSION_KEY: sessionKey,
    SYMPHIFONY_SESSION_ID: `${issue.id}-attempt-${attempt}`,
    SYMPHIFONY_TURN_INDEX: String(turnIndex),
    SYMPHIFONY_MAX_TURNS: String(maxTurns),
    SYMPHIFONY_TURN_PROMPT: turnPrompt,
    SYMPHIFONY_TURN_PROMPT_FILE: turnPromptFile,
    SYMPHIFONY_CONTINUE: turnIndex > 1 ? "1" : "0",
    SYMPHIFONY_PREVIOUS_OUTPUT: previousOutput,
    SYMPHIFONY_RESULT_FILE: resultFile,
    SYMPHIFONY_AGENT_PROFILE: provider.profile,
    SYMPHIFONY_AGENT_PROFILE_FILE: provider.profilePath,
    SYMPHIFONY_AGENT_PROFILE_INSTRUCTIONS: provider.profileInstructions,
  };

  const workflowDefinition = state._workflowDefinition as WorkflowDefinition | null | undefined;
  if (workflowDefinition?.beforeRunHook) {
    await runHook(workflowDefinition.beforeRunHook, workspacePath, issue, "before_run", turnEnv);
  }

  addEvent(state, issue.id, "runner", `Turn ${turnIndex}/${maxTurns} started for ${issue.identifier}.`);

  const turnResult = await runCommandWithTimeout(provider.command, workspacePath, issue, state.config, turnPrompt, turnPromptFile, turnEnv);

  if (workflowDefinition?.afterRunHook) {
    await runHook(workflowDefinition.afterRunHook, workspacePath, issue, "after_run", {
      ...turnEnv,
      SYMPHIFONY_LAST_EXIT_CODE: String(turnResult.code ?? ""),
      SYMPHIFONY_LAST_OUTPUT: turnResult.output,
      SYMPHIFONY_PRESERVE_RESULT_FILE: "1",
    });
  }

  const directive = readAgentDirective(workspacePath, turnResult.output, turnResult.success);
  lastCode = turnResult.code;
  lastOutput = turnResult.output;
  previousOutput = turnResult.output;
  nextPrompt = directive.nextPrompt;

  session.turns.push({
    turn: turnIndex,
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
  });

  session.lastCode = lastCode;
  session.lastOutput = lastOutput;
  session.lastDirectiveStatus = directive.status;
  session.lastDirectiveSummary = directive.summary;
  session.nextPrompt = nextPrompt;

  const directiveSummary = directive.summary ? ` ${directive.summary}` : "";
  addEvent(state, issue.id, "runner", `Turn ${turnIndex}/${maxTurns} finished with status ${directive.status}.${directiveSummary}`.trim());

  if (!turnResult.success || directive.status === "failed") {
    session.status = "failed";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: false, continueRequested: false, code: lastCode, output: lastOutput, turns: turnIndex };
  }

  if (directive.status === "blocked") {
    session.status = "blocked";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: true, continueRequested: false, code: lastCode, output: lastOutput, turns: turnIndex };
  }

  if (directive.status === "continue") {
    session.status = "running";
    await persistAgentSessionState(sessionKey, issue, provider, cycle, session);
    return { success: false, blocked: false, continueRequested: true, code: lastCode, output: lastOutput, turns: turnIndex };
  }

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
  workflowDefinition: WorkflowDefinition | null,
): Promise<AgentSessionResult> {
  const providers = getEffectiveAgentProviders(state, issue, workflowDefinition);
  const attempt = issue.attempts + 1;
  const { pipeline, key: pipelineFile } = await loadAgentPipelineState(issue, attempt, providers);
  const activeProvider = providers[clamp(pipeline.activeIndex, 0, Math.max(0, providers.length - 1))];
  const executorIndex = providers.findIndex((provider) => provider.role === "executor");

  // Discover skills and build context
  const skills = discoverSkills(workspacePath);
  const skillContext = buildSkillContext(skills);

  // Write skills reference to workspace
  if (skillContext) {
    writeFileSync(join(workspacePath, "symphifony-skills.md"), skillContext, "utf8");
  }

  const providerPrompt = buildProviderBasePrompt(activeProvider, issue, basePromptText, workspacePath, skillContext);

  if (!activeProvider.command.trim()) {
    throw new Error(`No command configured for provider ${activeProvider.provider} (${activeProvider.role}).`);
  }

  pipeline.history.push(`[${now()}] Running ${activeProvider.role}:${activeProvider.provider} in cycle ${pipeline.cycle}.`);
  await persistAgentPipelineState(pipelineFile, pipeline);

  // Attach workflowDefinition to state for session hooks
  (state as any)._workflowDefinition = workflowDefinition;

  const result = await runAgentSession(state, issue, activeProvider, pipeline.cycle, workspacePath, providerPrompt, basePromptFile);

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

export async function runIssueOnce(
  state: RuntimeState,
  issue: IssueEntry,
  running: Set<string>,
  workflowDefinition: WorkflowDefinition | null,
): Promise<void> {
  const startTs = Date.now();
  const isReview = issue.state === "In Review";
  const isResuming = issue.state === "Running" || issue.state === "Interrupted";
  running.add(issue.id);
  state.metrics.activeWorkers += 1;
  issue.startedAt = issue.startedAt ?? now();

  if (isReview) {
    issue.updatedAt = now();
    issue.history.push(`[${issue.updatedAt}] Review stage started for ${issue.identifier}.`);
    addEvent(state, issue.id, "progress", `Review started for ${issue.identifier}.`);
  } else if (isResuming) {
    await transitionIssueState(issue, "Running", `Resuming runner for ${issue.identifier}.`);
    addEvent(state, issue.id, "progress", `Runner resumed for ${issue.identifier}.`);
  } else {
    // Todo / Queued / Blocked → Queued → Running
    if (issue.state !== "Queued") {
      await transitionIssueState(issue, "Queued", `Issue ${issue.identifier} queued for execution.`);
    }
    await transitionIssueState(issue, "Running", `Agent started for ${issue.identifier}.`);
    addEvent(state, issue.id, "progress", `Runner started for ${issue.identifier}.`);
  }

  try {
    const workspaceDerivedPaths = hydrateIssuePathsFromWorkspace(issue);
    if ((issue.paths ?? []).length > 0) {
      issue.inferredPaths = [...new Set([...(issue.inferredPaths ?? []), ...inferCapabilityPaths({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        labels: issue.labels,
        paths: issue.paths,
      })])];
    }

    const { workspacePath, promptText, promptFile } = await prepareWorkspace(issue, workflowDefinition);
    addEvent(state, issue.id, "info", `Workspace ready at ${workspacePath}.`);

    const routedProviders = getEffectiveAgentProviders(state, issue, workflowDefinition);

    if (isReview) {
      // ── Review stage: run only the reviewer provider ──────────────────
      const reviewer = routedProviders.find((p) => p.role === "reviewer");
      if (!reviewer) {
        // No reviewer configured → auto-approve
        await transitionIssueState(issue, "Done", `No reviewer configured; auto-approved for ${issue.identifier}.`);
        addEvent(state, issue.id, "runner", `Issue ${issue.identifier} auto-approved (no reviewer provider).`);
        issue.completedAt = now();
        issue.lastError = undefined;
        return;
      }

      addEvent(state, issue.id, "info", `Review provider: ${reviewer.role}:${reviewer.provider}${reviewer.profile ? `:${reviewer.profile}` : ""}.`);

      const reviewPrompt = [
        `Review the work done for ${issue.identifier}.`,
        "",
        "Title: " + issue.title,
        "Description: " + (issue.description || "(none)"),
        "",
        `Workspace: ${workspacePath}`,
        "",
        "Inspect all changes in the workspace and determine if the issue is properly resolved.",
        "If the work is acceptable, emit SYMPHIFONY_STATUS=done.",
        "If rework is needed, emit SYMPHIFONY_STATUS=continue and provide actionable feedback in nextPrompt.",
        "If the work is fundamentally broken, emit SYMPHIFONY_STATUS=blocked.",
      ].join("\n");

      const reviewPromptFile = join(workspacePath, "symphifony-review-prompt.md");
      writeFileSync(reviewPromptFile, `${reviewPrompt}\n`, "utf8");

      (state as any)._workflowDefinition = workflowDefinition;
      const reviewResult = await runAgentSession(state, issue, reviewer, 1, workspacePath, reviewPrompt, reviewPromptFile);

      issue.durationMs = (issue.durationMs ?? 0) + (Date.now() - startTs);
      issue.commandExitCode = reviewResult.code;
      issue.commandOutputTail = reviewResult.output;

      if (reviewResult.success) {
        await transitionIssueState(issue, "Done", `Reviewer approved ${issue.identifier} in ${reviewResult.turns} turn(s).`);
        addEvent(state, issue.id, "runner", `Issue ${issue.identifier} approved by reviewer → Done.`);
        issue.completedAt = now();
        issue.lastError = undefined;
      } else if (reviewResult.continueRequested) {
        // Reviewer wants rework → back to Queued for re-execution
        await transitionIssueState(issue, "Queued", `Reviewer requested rework for ${issue.identifier}.`);
        issue.nextRetryAt = new Date(Date.now() + 1000).toISOString();
        issue.lastError = undefined;
        addEvent(state, issue.id, "runner", `Issue ${issue.identifier} sent back for rework by reviewer.`);
      } else {
        // Reviewer blocked or failed
        issue.lastError = reviewResult.output;
        issue.attempts += 1;
        if (issue.attempts >= issue.maxAttempts) {
          await transitionIssueState(issue, "Cancelled", `Review failed, max attempts reached for ${issue.identifier}.`);
          addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled after review failure.`);
        } else {
          issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
          await transitionIssueState(issue, "Blocked", `Review failed for ${issue.identifier}. Retry at ${issue.nextRetryAt}.`);
          addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked after review failure.`);
        }
      }
      return;
    }

    // ── Normal execution (Todo / In Progress / Blocked) ───────────────
    addEvent(state, issue.id, "info",
      `Capability routing selected ${routedProviders.map((p) => `${p.role}:${p.provider}${p.profile ? `:${p.profile}` : ""}`).join(", ")}.`);

    const routingSignals = describeRoutingSignals(issue, workspaceDerivedPaths);
    if (routingSignals) {
      addEvent(state, issue.id, "info", `Capability routing signals: ${routingSignals}.`);
    }

    const runResult = await runAgentPipeline(state, issue, workspacePath, promptText, promptFile, workflowDefinition);

    issue.durationMs = Date.now() - startTs;
    issue.commandExitCode = runResult.code;
    issue.commandOutputTail = runResult.output;

    if (runResult.success) {
      // Move to In Review — the reviewer will run as a separate scheduler pick
      await transitionIssueState(issue, "In Review", `Agent execution finished in ${runResult.turns} turn(s) for ${issue.identifier}. Awaiting review.`);
      issue.lastError = undefined;
      addEvent(state, issue.id, "runner", `Issue ${issue.identifier} moved to In Review.`);
    } else if (runResult.continueRequested) {
      issue.updatedAt = now();
      issue.commandExitCode = runResult.code;
      issue.commandOutputTail = runResult.output;
      issue.lastError = undefined;
      // Short continuation retry (1s) — spec §7.1, §8.4
      issue.nextRetryAt = new Date(Date.now() + 1000).toISOString();
      issue.history.push(`[${issue.updatedAt}] Agent requested another turn (${runResult.turns}/${state.config.maxTurns}).`);
      addEvent(state, issue.id, "runner", `Issue ${issue.identifier} queued for next turn.`);
    } else {
      issue.lastError = runResult.output;
      issue.attempts += 1;

      if (issue.attempts >= issue.maxAttempts) {
        issue.commandExitCode = runResult.code;
        await transitionIssueState(issue, "Cancelled", `Max attempts reached (${issue.attempts}/${issue.maxAttempts}).`);
        addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled after repeated failures.`);
      } else {
        issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
        await transitionIssueState(issue,
          "Blocked",
          `${runResult.blocked ? "Agent requested manual intervention" : "Failure"} on attempt ${issue.attempts}/${issue.maxAttempts}; retry scheduled at ${issue.nextRetryAt}.`);
        addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked waiting for retry.`);
      }
    }
  } catch (error) {
    issue.attempts += 1;
    issue.lastError = String(error);

    if (issue.attempts >= issue.maxAttempts) {
      await transitionIssueState(issue, "Cancelled", `Issue failed unexpectedly: ${issue.lastError}`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled unexpectedly.`);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      await transitionIssueState(issue, "Blocked", `Unexpected failure. Retry scheduled at ${issue.nextRetryAt}.`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked after unexpected failure.`);
    }
  } finally {
    issue.updatedAt = now();
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers - 1, 0);
    running.delete(issue.id);
    state.metrics = computeMetrics(state.issues);
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers, 0);
    state.updatedAt = now();
    await persistState(state);
  }
}
