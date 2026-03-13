#!/usr/bin/env node
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
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env, exit, argv } from "node:process";
import { homedir } from "node:os";

type JsonRecord = Record<string, unknown>;

type IssueState =
  | "Todo"
  | "In Progress"
  | "In Review"
  | "Blocked"
  | "Done"
  | "Cancelled";

type RuntimeEventType =
  | "info"
  | "state"
  | "progress"
  | "error"
  | "manual"
  | "runner";

type RuntimeEvent = {
  id: string;
  issueId?: string;
  kind: RuntimeEventType;
  message: string;
  at: string;
};

type IssueEntry = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  priority: number;
  state: IssueState;
  branchName?: string;
  url?: string;
  assigneeId?: string;
  labels: string[];
  blockedBy: string[];
  assignedToWorker: boolean;
  createdAt: string;
  updatedAt: string;
  history: string[];
  startedAt?: string;
  completedAt?: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: string;
  workspacePath?: string;
  workspacePreparedAt?: string;
  lastError?: string;
  durationMs?: number;
  commandExitCode?: number | null;
  commandOutputTail?: string;
};

type RuntimeConfig = {
  pollIntervalMs: number;
  workerConcurrency: number;
  commandTimeoutMs: number;
  maxAttemptsDefault: number;
  retryDelayMs: number;
  staleInProgressTimeoutMs: number;
  logLinesTail: number;
  agentCommand: string;
  dashboardPort?: string;
  runMode: "memory";
};

type RuntimeMetrics = {
  total: number;
  queued: number;
  inProgress: number;
  blocked: number;
  done: number;
  cancelled: number;
  activeWorkers: number;
};

type RuntimeState = {
  startedAt: string;
  updatedAt: string;
  trackerKind: "memory";
  sourceRepoUrl: string;
  sourceRef: string;
  workflowPath: string;
  dashboardPort?: string;
  config: RuntimeConfig;
  issues: IssueEntry[];
  events: RuntimeEvent[];
  metrics: RuntimeMetrics;
  notes: string[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const TRACKER_KIND = env.SYMPHONY_TRACKER_KIND ?? "memory";
const STATE_ROOT = env.SYMPHONY_BOOTSTRAP_ROOT ?? `${homedir()}/.local/share/symphony-aozo`;
const SOURCE_ROOT = `${STATE_ROOT}/aozo-source`;
const WORKSPACE_ROOT = `${STATE_ROOT}/workspaces`;
const SOURCE_MARKER = `${SOURCE_ROOT}/.symphony-local-source-ready`;
const WORKFLOW_TEMPLATE = `${REPO_ROOT}/WORKFLOW.md`;
const WORKFLOW_RENDERED = `${STATE_ROOT}/WORKFLOW.local.md`;
const STATE_DUMP = `${STATE_ROOT}/symphony-memory-state.json`;
const LOCAL_ISSUES_FILE = env.SYMPHONY_MEMORY_ISSUES_FILE ?? `${__dirname}/symphony-local-issues.json`;
const FRONTEND_DIR = `${__dirname}/symphony-dashboard`;
const FRONTEND_INDEX = `${FRONTEND_DIR}/index.html`;
const FRONTEND_APP_JS = `${FRONTEND_DIR}/app.js`;
const FRONTEND_STYLES_CSS = `${FRONTEND_DIR}/styles.css`;

const LOG_PATH = `${STATE_ROOT}/symphony-local.log`;

const ALLOWED_STATES: IssueState[] = ["Todo", "In Progress", "In Review", "Blocked", "Done", "Cancelled"];
const TERMINAL_STATES = new Set<IssueState>(["Done", "Cancelled"]);
const EXECUTING_STATES = new Set<IssueState>(["In Progress", "In Review"]);
const PERSIST_EVENTS_MAX = 500;

function fail(message: string): never {
  console.error(message);
  exit(1);
}

function log(message: string) {
  const time = new Date().toISOString();
  console.log(`[${time}] ${message}`);
}

function now() {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function toNumberValue(value: unknown, fallback = 1): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function toBooleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeState(value: unknown): IssueState {
  const raw = typeof value === "string" ? value.trim() : "";
  if ((ALLOWED_STATES as readonly string[]).includes(raw)) {
    return raw as IssueState;
  }
  return "Todo";
}

function parseEnvNumber(name: string, fallback: number): number {
  return toNumberValue(env[name], fallback);
}

function parseIntArg(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const source = env[name];
  if (!source) {
    return fallback;
  }

  return parseIntArg(source, fallback);
}

function withRetryBackoff(attempt: number, baseDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** attempt, 5 * 60 * 1000);
}

function idToSafePath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

function appendFileTail(target: string, text: string, maxLength: number): string {
  const merged = `${target}\n${text}`;
  if (merged.length <= maxLength) {
    return merged;
  }

  return `…${merged.slice(-(maxLength - 1))}`;
}

function readJsonOrNull<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(target: string, payload: unknown) {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  rmSync(target, { force: true });
  cpSync(tmp, target);
  rmSync(tmp, { force: true });
}

function appendLog(entry: string) {
  appendFileSync(LOG_PATH, `${now()} [symphony-local-ts] ${entry}\n`, "utf8");
}

function bootstrapSource() {
  if (existsSync(SOURCE_MARKER)) {
    return;
  }

  log("Creating local source snapshot for Symphony (local-only runtime)...");

  const skipDirs = new Set([
    ".git",
    "node_modules",
    ".venv",
    "data",
    "app/data",
    "app/dist",
    "app/.tanstack",
    "apk-pull",
    "mobile-assets",
    "pcap-archive",
    "lua-extract",
    "locale-extract",
  ]);

  const shouldSkip = (relativePath: string): boolean => {
    const parts = relativePath.split("/");
    if (parts.some((segment) => skipDirs.has(segment))) {
      return true;
    }

    const base = relativePath.split("/").at(-1) ?? "";
    if (base.startsWith("map_scan_") && extname(base) === ".json") {
      return true;
    }

    if (extname(base) === ".xlsx") {
      return true;
    }

    return false;
  };

  const copyRecursive = (source: string, target: string, rel = "") => {
    mkdirSync(target, { recursive: true });
    const items = readdirSync(source, { withFileTypes: true });

    for (const item of items) {
      const nextRel = rel ? `${rel}/${item.name}` : item.name;
      if (shouldSkip(nextRel)) {
        continue;
      }

      const sourcePath = `${source}/${item.name}`;
      const targetPath = `${target}/${item.name}`;
      const itemStat = statSync(sourcePath);

      if (item.isDirectory()) {
        copyRecursive(sourcePath, targetPath, nextRel);
        continue;
      }

      if (item.isSymbolicLink() || itemStat.isSymbolicLink()) {
        continue;
      }

      if (itemStat.isFile() || itemStat.isFIFO()) {
        try {
          const file = readFileSync(sourcePath);
          writeFileSync(targetPath, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            log(`Skipped missing source file: ${sourcePath}`);
          } else {
            throw error;
          }
        }
      }
    }
  };

  mkdirSync(SOURCE_ROOT, { recursive: true });
  copyRecursive(REPO_ROOT, SOURCE_ROOT);
  writeFileSync(SOURCE_MARKER, `${now()}\n`, "utf8");
}

function renderWorkflow() {
  const template = readFileSync(WORKFLOW_TEMPLATE, "utf8");
  const withTracker = template.replace(/kind:\s*linear/g, "kind: memory");
  const rendered = withTracker.replace(/project_slug:\s*".*?"/, 'project_slug: ""');
  writeFileSync(WORKFLOW_RENDERED, rendered, "utf8");
  return rendered;
}

function parsePort(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: ${argv[1]} [options]\n` +
        "Options:\n" +
        "  --port <n>             Start local dashboard (default: no UI and single batch run)\n" +
        "  --concurrency <n>      Maximum number of parallel issue runners\n" +
        "  --attempts <n>         Maximum attempts per issue\n" +
        "  --poll <ms>            Polling interval for the scheduler\n" +
        "  --once                  Run one local batch and exit\n" +
        "  --help                  Show this message");
      exit(0);
    }

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

function normalizeIssue(raw: JsonRecord): IssueEntry | null {
  const id = toStringValue(raw.id, "") || toStringValue(raw.identifier, "");
  if (!id) {
    return null;
  }

  const createdAt = toStringValue(raw.created_at, now());
  const updatedAt = toStringValue(raw.updated_at, createdAt);

  return {
    id,
    identifier: toStringValue(raw.identifier, id),
    title: toStringValue(raw.title, `Issue ${id}`),
    description: toStringValue(raw.description, ""),
    priority: toNumberValue(raw.priority, 1),
    state: normalizeState(raw.state),
    branchName: toStringValue(raw.branch_name) || toStringValue(raw.branchName),
    url: toStringValue(raw.url),
    assigneeId: toStringValue(raw.assignee_id),
    labels: toStringArray(raw.labels),
    blockedBy: toStringArray(raw.blocked_by),
    assignedToWorker: toBooleanValue(raw.assigned_to_worker, true),
    createdAt,
    updatedAt,
    history: [],
    attempts: toNumberValue(raw.attempts, 0),
    maxAttempts: toNumberValue(raw.max_attempts, 3),
    nextRetryAt: toStringValue(raw.next_retry_at),
  };
}

function loadSeedIssues(path: string): IssueEntry[] {
  const sourcePath = env.SYMPHONY_MEMORY_ISSUES_JSON ?? path;

  if (sourcePath !== path && sourcePath) {
    writeFileSync(path, `${sourcePath}\n`, "utf8");
  }

  if (!existsSync(path)) {
    fail(`Local issues file not found: ${path}`);
  }

  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Invalid local issues JSON: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    fail("Local issues payload must be an array.");
  }

  const issues = parsed
    .filter((candidate): candidate is JsonRecord => typeof candidate === "object" && candidate !== null)
    .map(normalizeIssue)
    .filter((issue): issue is IssueEntry => issue !== null);

  if (issues.length === 0) {
    fail("No local issues found for execution.");
  }

  return issues;
}

function deriveConfig(args: string[]): RuntimeConfig {
  const parsedConcurrency = parsePositiveIntEnv("SYMPHONY_WORKER_CONCURRENCY", 2);
  let pollIntervalMs = parseEnvNumber("SYMPHONY_POLL_INTERVAL_MS", 1200);
  let workerConcurrency = parsedConcurrency;
  let maxAttemptsDefault = parseEnvNumber("SYMPHONY_MAX_ATTEMPTS", 3);
  let commandTimeoutMs = parseEnvNumber("SYMPHONY_AGENT_TIMEOUT_MS", 120000);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--poll") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) {
        fail(`Invalid value for --poll: ${value}`);
      }
      pollIntervalMs = parseIntArg(value, pollIntervalMs);
    }

    if (arg === "--concurrency") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) {
        fail(`Invalid value for --concurrency: ${value}`);
      }
      workerConcurrency = parseIntArg(value, workerConcurrency);
    }

    if (arg === "--attempts") {
      const value = args[i + 1] ?? "";
      if (!/^\d+$/.test(value)) {
        fail(`Invalid value for --attempts: ${value}`);
      }
      maxAttemptsDefault = parseIntArg(value, maxAttemptsDefault);
    }
  }

  return {
    pollIntervalMs: clamp(pollIntervalMs, 200, 10_000),
    workerConcurrency: clamp(workerConcurrency, 1, 16),
    commandTimeoutMs: clamp(commandTimeoutMs, 1_000, 600_000),
    maxAttemptsDefault: clamp(maxAttemptsDefault, 1, 10),
    retryDelayMs: parseEnvNumber("SYMPHONY_RETRY_DELAY_MS", 3_000),
    staleInProgressTimeoutMs: parseEnvNumber("SYMPHONY_STALE_IN_PROGRESS_MS", 20_000),
    logLinesTail: parseEnvNumber("SYMPHONY_LOG_TAIL_CHARS", 12_000),
    agentCommand: toStringValue(env.SYMPHONY_AGENT_COMMAND, ""),
    runMode: "memory",
  };
}

function dedupHistoryEntries(issues: IssueEntry[]) {
  for (const issue of issues) {
    const seen = new Set<string>();
    issue.history = issue.history.filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}

function mergeStateWithSeed(seedIssues: IssueEntry[], previous: RuntimeState | null, config: RuntimeConfig): RuntimeState {
  const previousMap = new Map((previous?.issues ?? []).map((issue) => [issue.id, issue]));

  const mergedIssues = seedIssues.map((seed) => {
    const saved = previousMap.get(seed.id);
    if (!saved) {
      return seed;
    }

    return {
      ...seed,
      state: normalizeState(saved.state),
      history: saved.history,
      attempts: clamp(saved.attempts, 0, config.maxAttemptsDefault),
      maxAttempts: clamp(saved.maxAttempts, 1, config.maxAttemptsDefault),
      nextRetryAt: toStringValue(saved.nextRetryAt),
      startedAt: saved.startedAt,
      completedAt: saved.completedAt,
      updatedAt: saved.updatedAt,
      workspacePath: saved.workspacePath,
      workspacePreparedAt: saved.workspacePreparedAt,
      lastError: saved.lastError,
      durationMs: typeof saved.durationMs === "number" ? saved.durationMs : undefined,
      commandExitCode: typeof saved.commandExitCode === "number" ? saved.commandExitCode : saved.commandExitCode,
      commandOutputTail: toStringValue(saved.commandOutputTail),
    };
  });

  dedupHistoryEntries(mergedIssues);

  const metrics = computeMetrics(mergedIssues);

  const runtimeState: RuntimeState = {
    startedAt: previous?.startedAt ?? now(),
    updatedAt: now(),
    trackerKind: "memory",
    sourceRepoUrl: SOURCE_ROOT,
    sourceRef: "main",
    workflowPath: WORKFLOW_RENDERED,
    config: {
      ...config,
      dashboardPort: previous?.config.dashboardPort,
    },
    issues: mergedIssues,
    events: previous?.events ?? [],
    metrics,
    notes: previous?.notes ?? [
      "Local TypeScript runtime bootstrapped.",
      "Codex-only execution path enabled.",
      "No external tracker dependency (memory mode).",
    ],
  };

  return runtimeState;
}

function computeMetrics(issues: IssueEntry[]): RuntimeMetrics {
  let queued = 0;
  let inProgress = 0;
  let blocked = 0;
  let done = 0;
  let cancelled = 0;

  for (const issue of issues) {
    switch (issue.state) {
      case "Todo":
      case "Blocked":
        queued += 1;
        break;
      case "In Progress":
      case "In Review":
        inProgress += 1;
        break;
      case "Done":
        done += 1;
        break;
      case "Cancelled":
        cancelled += 1;
        break;
    }

    if (issue.state === "Blocked") {
      blocked += 1;
    }
  }

  return {
    total: issues.length,
    queued,
    inProgress,
    blocked,
    done,
    cancelled,
    activeWorkers: 0,
  };
}

function addEvent(state: RuntimeState, issueId: string | undefined, kind: RuntimeEventType, message: string) {
  const event: RuntimeEvent = {
    id: `${Date.now()}-${state.events.length + 1}`,
    issueId,
    kind,
    message,
    at: now(),
  };

  state.events = [event, ...state.events].slice(0, PERSIST_EVENTS_MAX);
  appendLog(`${issueId ? `[${issueId}] ` : ""}${message}`);
}

function transition(issue: IssueEntry, target: IssueState, note: string) {
  const previous = issue.state;
  issue.state = target;
  issue.updatedAt = now();
  issue.history.push(`[${issue.updatedAt}] ${note}`);

  if (previous === "Blocked" && target === "Todo") {
    issue.lastError = undefined;
    issue.nextRetryAt = undefined;
  }

  if (TERMINAL_STATES.has(target)) {
    issue.completedAt = now();
    issue.nextRetryAt = undefined;
  }

  if (target === "Todo") {
    issue.attempts = Math.max(0, issue.attempts - 1);
  }

  if (target === "Done") {
    issue.lastError = undefined;
  }
}

function issueDependenciesResolved(issue: IssueEntry, allIssues: IssueEntry[]): boolean {
  if (issue.blockedBy.length === 0) {
    return true;
  }

  const map = new Map(allIssues.map((entry) => [entry.id, entry]));
  return issue.blockedBy.every((dependencyId) => {
    const dep = map.get(dependencyId);
    return dep?.state === "Done";
  });
}

function getNextRetryAt(issue: IssueEntry, baseMs: number): string {
  const nextAttempt = issue.attempts + 1;
  const nextDelay = withRetryBackoff(nextAttempt, baseMs);
  return new Date(Date.now() + nextDelay).toISOString();
}

function canRunIssue(issue: IssueEntry, running: Set<string>, state: RuntimeState): boolean {
  if (!issue.assignedToWorker) {
    return false;
  }

  if (running.has(issue.id)) {
    return false;
  }

  if (TERMINAL_STATES.has(issue.state)) {
    return false;
  }

  if (issue.state === "Blocked") {
    if (!issue.nextRetryAt) {
      return false;
    }

    if (issue.attempts >= issue.maxAttempts) {
      return false;
    }

    if (Date.parse(issue.nextRetryAt) > Date.now()) {
      return false;
    }
  }

  if (!issueDependenciesResolved(issue, state.issues)) {
    return false;
  }

  if (issue.state === "Todo" || issue.state === "Blocked") {
    return true;
  }

  return false;
}

async function runCommandWithTimeout(command: string, workspacePath: string, issue: IssueEntry, config: RuntimeConfig): Promise<{ success: boolean; code: number | null; output: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, {
      shell: true,
      cwd: workspacePath,
      env: {
        ...env,
        SYMPHONY_ISSUE_ID: issue.id,
        SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
        SYMPHONY_ISSUE_TITLE: issue.title,
        SYMPHONY_ISSUE_PRIORITY: String(issue.priority),
        SYMPHONY_WORKSPACE_PATH: workspacePath,
      },
    });

    let output = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk) => {
      output = appendFileTail(output, String(chunk), config.logLinesTail);
    });

    child.stderr?.on("data", (chunk) => {
      output = appendFileTail(output, String(chunk), config.logLinesTail);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, config.commandTimeoutMs);

    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        success: false,
        code: null,
        output: `Command execution failed for issue ${issue.id}.`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        resolve({
          success: false,
          code: null,
          output: appendFileTail(output, `\nExecution timeout after ${config.commandTimeoutMs}ms.`, config.logLinesTail),
        });
        return;
      }

      const duration = Math.max(0, Date.now() - started);
      if (code === 0) {
        resolve({
          success: true,
          code,
          output: appendFileTail(output, `\nExecution succeeded in ${duration}ms.`, config.logLinesTail),
        });
        return;
      }

      resolve({
        success: false,
        code,
        output: appendFileTail(output, `\nCommand exit code ${code ?? "unknown"} after ${duration}ms.`, config.logLinesTail),
      });
    });
  });
}

async function runSimulatedAgent(issue: IssueEntry): Promise<{ success: boolean; code: number | null; output: string; duration: number }> {
  const baseMs = 450 + (issue.priority * 150);
  const jitter = (issue.id.length * 73) % 600;
  const duration = baseMs + jitter;
  await sleep(duration);

  return {
    success: true,
    code: 0,
    output: `Local simulator completed for ${issue.identifier} in ${duration}ms.`,
    duration,
  };
}

function prepareWorkspace(issue: IssueEntry): string {
  const safeId = idToSafePath(issue.id);
  const workspaceRoot = join(SOURCE_ROOT, "workspaces", safeId);

  if (!existsSync(workspaceRoot)) {
    mkdirSync(workspaceRoot, { recursive: true });
    cpSync(SOURCE_ROOT, workspaceRoot, {
      recursive: true,
      force: true,
      filter: (sourcePath) => {
        return !sourcePath.startsWith(WORKSPACE_ROOT);
      },
    });
  }

  const metaPath = join(workspaceRoot, "symphony-issue.json");
  writeFileSync(metaPath, JSON.stringify({
    ...issue,
    runtimeSource: SOURCE_ROOT,
    bootstrapAt: now(),
  }, null, 2), "utf8");

  issue.workspacePath = workspaceRoot;
  issue.workspacePreparedAt = now();

  return workspaceRoot;
}

async function runIssueOnce(state: RuntimeState, issue: IssueEntry, running: Set<string>) {
  const startedAt = now();
  const startTs = Date.now();
  running.add(issue.id);
  state.metrics.activeWorkers += 1;

  transition(issue, "In Progress", `Starting local runner for ${issue.identifier}.`);
  state.metrics.inProgress += 1;
  state.metrics.queued = Math.max(state.metrics.queued - 1, 0);
  addEvent(state, issue.id, "progress", `Runner started for ${issue.identifier}.`);

  try {
    const workspacePath = prepareWorkspace(issue);
    addEvent(state, issue.id, "info", `Workspace ready at ${workspacePath}.`);

    const runResult = state.config.agentCommand
      ? await runCommandWithTimeout(state.config.agentCommand, workspacePath, issue, state.config)
      : (await runSimulatedAgent(issue));

    const duration = now();
    issue.durationMs = (Date.now() - startTs);
    issue.commandExitCode = runResult.code;
    issue.commandOutputTail = runResult.output;

    if (runResult.success) {
      transition(issue, "In Review", `Local run finished successfully for ${issue.identifier}.`);
      issue.lastError = undefined;
      await sleep(250);
      transition(issue, "Done", `Issue accepted by local review stage.`);
      addEvent(state, issue.id, "runner", `Issue ${issue.identifier} moved to Done.`);
      issue.completedAt = duration;
    } else {
      issue.lastError = runResult.output;
      issue.attempts += 1;

      if (issue.attempts >= issue.maxAttempts) {
        issue.commandExitCode = runResult.code;
        transition(issue, "Cancelled", `Max attempts reached (${issue.attempts}/${issue.maxAttempts}).`);
        addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled after repeated failures.`);
      } else {
        issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
        transition(issue, "Blocked", `Failure on attempt ${issue.attempts}/${issue.maxAttempts}; retry scheduled at ${issue.nextRetryAt}.`);
        addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked waiting for retry.`);
      }
    }
  } catch (error) {
    issue.attempts += 1;
    issue.lastError = String(error);

    if (issue.attempts >= issue.maxAttempts) {
      transition(issue, "Cancelled", `Issue failed unexpectedly: ${issue.lastError}`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} cancelled unexpectedly.`);
    } else {
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      transition(issue, "Blocked", `Unexpected failure. Retry scheduled at ${issue.nextRetryAt}.`);
      addEvent(state, issue.id, "error", `Issue ${issue.identifier} blocked after unexpected failure.`);
    }
  } finally {
    issue.updatedAt = now();
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers - 1, 0);
    running.delete(issue.id);
    state.metrics = computeMetrics(state.issues);
    state.metrics.activeWorkers = Math.max(state.metrics.activeWorkers, 0);
    state.updatedAt = now();
    persistState(state);
  }

  return;
}

function ensureNotStale(state: RuntimeState, staleTimeoutMs: number) {
  const limit = Date.now() - staleTimeoutMs;
  for (const issue of state.issues) {
    if (EXECUTING_STATES.has(issue.state) && Date.parse(issue.updatedAt) < limit && !TERMINAL_STATES.has(issue.state)) {
      issue.attempts += 1;
      issue.nextRetryAt = getNextRetryAt(issue, state.config.retryDelayMs);
      issue.startedAt = undefined;
      transition(issue, "Blocked", `Issue state auto-recovered from stale execution.`);
    }
  }
}

function persistState(state: RuntimeState) {
  state.metrics = {
    ...computeMetrics(state.issues),
    activeWorkers: state.metrics.activeWorkers,
  };
  writeJsonAtomic(STATE_DUMP, state);
}

function pickNextIssues(state: RuntimeState, running: Set<string>): IssueEntry[] {
  const queued = state.issues
    .filter((issue) => canRunIssue(issue, running, state))
    .sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });

  return queued;
}

function hasTerminalQueue(state: RuntimeState): boolean {
  return state.issues.every((issue) => TERMINAL_STATES.has(issue.state) || issue.attempts >= issue.maxAttempts);
}

function parseBody(req: any): Promise<JsonRecord> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk;
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body) as JsonRecord);
      } catch {
        resolve({});
      }
    });
  });
}

function handleStatePatch(state: RuntimeState, issue: IssueEntry, payload: JsonRecord) {
  const nextState = normalizeState(payload.state);
  const allowed = new Set([...ALLOWED_STATES]);

  if (!allowed.has(nextState)) {
    throw new Error(`Unsupported state: ${String(payload.state)}`);
  }

  transition(issue, nextState, `Manual state update: ${nextState}`);
  if (nextState === "Todo") {
    issue.nextRetryAt = undefined;
    issue.lastError = undefined;
  }

  if (nextState === "Cancelled") {
    issue.lastError = toStringValue(payload.reason);
  }

  addEvent(state, issue.id, "manual", `Manual state transition to ${nextState}`);
}

function startDashboard(state: RuntimeState, port: number) {
  const indexHtml = readJsonOrNull<string>(FRONTEND_INDEX) ?? "";
  const appJs = readJsonOrNull<string>(FRONTEND_APP_JS) ?? "";
  const stylesCss = readJsonOrNull<string>(FRONTEND_STYLES_CSS) ?? "";

  const fallback = `<!doctype html><html><body><pre>Unable to load Symphony dashboard assets.</pre></body></html>`;

  const server = createServer(async (req, res) => {
    const requested = new URL(req.url ?? "/", `http://localhost:${port}`).pathname;
    const method = req.method ?? "GET";

    const sendJson = (code: number, payload: unknown) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload, null, 2));
    };

    const sendText = (contentType: string, text: string) => {
      res.statusCode = 200;
      res.setHeader("content-type", contentType);
      res.end(text);
    };

    if (requested === "/api/state" && method === "GET") {
      sendJson(200, state);
      return;
    }

    if (requested === "/api/health" && method === "GET") {
      sendJson(200, {
        status: "ok",
        updatedAt: state.updatedAt,
        config: state.config,
        trackerKind: state.trackerKind,
      });
      return;
    }

    if (requested === "/api/issues" && method === "GET") {
      sendJson(200, { issues: state.issues });
      return;
    }

    if (requested === "/api/events" && method === "GET") {
      const since = new URL(req.url ?? "/", `http://localhost:${port}`).searchParams.get("since");
      const events = typeof since === "string" ? state.events.filter((entry) => entry.at > since) : state.events;
      sendJson(200, { events: events.slice(0, 200) });
      return;
    }

    if (requested === "/state" && method === "GET") {
      res.statusCode = 301;
      res.setHeader("location", "/api/state");
      res.end();
      return;
    }

    const issueStateMatch = requested.match(/^\/api\/issue\/([^/]+)\/state$/);
    if (issueStateMatch && method === "POST") {
      const issueId = decodeURIComponent(issueStateMatch[1]);
      const issue = state.issues.find((candidate) => candidate.id === issueId || candidate.identifier === issueId);
      if (!issue) {
        sendJson(404, { ok: false, error: "Issue not found" });
        return;
      }

      const payload = await parseBody(req);
      try {
        handleStatePatch(state, issue, payload);
        persistState(state);
        sendJson(200, { ok: true, issue });
      } catch (error) {
        sendJson(400, { ok: false, error: String(error) });
      }
      return;
    }

    const issueRetryMatch = requested.match(/^\/api\/issue\/([^/]+)\/retry$/);
    if (issueRetryMatch && method === "POST") {
      const issueId = decodeURIComponent(issueRetryMatch[1]);
      const issue = state.issues.find((candidate) => candidate.id === issueId || candidate.identifier === issueId);
      if (!issue) {
        sendJson(404, { ok: false, error: "Issue not found" });
        return;
      }

      if (TERMINAL_STATES.has(issue.state)) {
        issue.state = "Todo";
        issue.attempts = Math.max(0, issue.attempts - 1);
        issue.lastError = undefined;
        issue.nextRetryAt = undefined;
        transition(issue, "Todo", "Manual retry requested.");
      } else {
        issue.nextRetryAt = undefined;
        issue.lastError = undefined;
      }

      addEvent(state, issue.id, "manual", `Manual retry requested for ${issue.id}.`);
      persistState(state);
      sendJson(200, { ok: true, issue });
      return;
    }

    const issueCancelMatch = requested.match(/^\/api\/issue\/([^/]+)\/cancel$/);
    if (issueCancelMatch && method === "POST") {
      const issueId = decodeURIComponent(issueCancelMatch[1]);
      const issue = state.issues.find((candidate) => candidate.id === issueId || candidate.identifier === issueId);
      if (!issue) {
        sendJson(404, { ok: false, error: "Issue not found" });
        return;
      }

      transition(issue, "Cancelled", `Manual cancel requested.`);
      addEvent(state, issue.id, "manual", `Manual cancel requested for ${issue.id}.`);
      persistState(state);
      sendJson(200, { ok: true, issue });
      return;
    }

    if (requested === "/" || requested === "/index.html") {
      sendText("text/html; charset=utf-8", indexHtml || fallback);
      return;
    }

    if (requested === "/assets/app.js") {
      sendText("application/javascript; charset=utf-8", appJs || "console.log('Dashboard script not found.');");
      return;
    }

    if (requested === "/assets/styles.css") {
      sendText("text/css; charset=utf-8", stylesCss || "");
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  });

  server.listen(port, () => {
    log(`Local dashboard available at http://localhost:${port}`);
    log(`State API: http://localhost:${port}/api/state`);
  });

  return server;
}

async function scheduler(state: RuntimeState, running: Set<string>, runForever: boolean) {
  if (runForever) {
    while (true) {
      ensureNotStale(state, state.config.staleInProgressTimeoutMs);
      const ready = pickNextIssues(state, running);
      const slots = state.config.workerConcurrency - running.size;
      if (slots > 0) {
        const next = ready.slice(0, Math.max(0, slots));
        await Promise.all(next.map((issue) => runIssueOnce(state, issue, running)));
      }

      state.updatedAt = now();
      persistState(state);
      addEvent(state, undefined, "info", "Scheduler tick completed.");
      await sleep(state.config.pollIntervalMs);
    }
  }

  while (!hasTerminalQueue(state)) {
    ensureNotStale(state, state.config.staleInProgressTimeoutMs);
    const ready = pickNextIssues(state, running);
    const slots = state.config.workerConcurrency - running.size;
    const next = ready.slice(0, Math.max(0, slots));

    if (next.length === 0 && running.size === 0) {
      if (state.issues.some((issue) => issue.state === "Blocked" && issue.nextRetryAt && issue.attempts < issue.maxAttempts)) {
        await sleep(state.config.pollIntervalMs);
        continue;
      }
      break;
    }

    await Promise.all(next.map((issue) => runIssueOnce(state, issue, running)));
    state.updatedAt = now();
    persistState(state);

    if (running.size === 0) {
      await sleep(state.config.pollIntervalMs);
    }
  }
}

function usage() {
  console.log(`Usage: ${argv[1]} [options]\n` +
    "Options:\n" +
    "  --port <n>             Start local dashboard\n" +
    "  --concurrency <n>      Maximum number of local workers\n" +
    "  --attempts <n>         Maximum attempts per issue\n" +
    "  --poll <ms>            Scheduler interval in ms\n" +
    "  --once                  Process once and exit\n");
}

async function main() {
  if (TRACKER_KIND !== "memory") {
    fail("SYMPHONY_TRACKER_KIND must be 'memory' for this local fork.");
  }

  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  const runOnce = args.includes("--once");
  const port = parsePort(args);
  const config = deriveConfig(args);

  mkdirSync(STATE_ROOT, { recursive: true });

  bootstrapSource();
  const rendered = renderWorkflow();

  const seedIssues = loadSeedIssues(LOCAL_ISSUES_FILE);
  const previous = readJsonOrNull<RuntimeState>(STATE_DUMP);
  const state = mergeStateWithSeed(seedIssues, previous, config);

  state.config.dashboardPort = port ? String(port) : undefined;
  state.workflowPath = rendered;
  state.updatedAt = now();

  if (state.config.agentCommand) {
    state.notes.push(`Using external Codex local command: ${state.config.agentCommand}`);
  } else {
    state.notes.push("No SYMPHONY_AGENT_COMMAND set. Using deterministic local simulator.");
  }

  state.metrics = computeMetrics(state.issues);
  persistState(state);

  const running = new Set<string>();
  log(`Rendered local workflow: ${WORKFLOW_RENDERED}`);
  log(`Loaded issues: ${state.issues.length}`);
  log(`Worker concurrency: ${state.config.workerConcurrency}`);
  log(`Max attempts: ${state.config.maxAttemptsDefault}`);

  if (port) {
    startDashboard(state, port);
  }

  try {
    addEvent(state, undefined, "info", `Runtime started in local-only mode (memory tracker).`);
    const runForever = Boolean(port) && !runOnce;
    await scheduler(state, running, runForever);
  } catch (error) {
    addEvent(state, undefined, "error", `Fatal runtime error: ${String(error)}`);
    persistState(state);
    throw error;
  } finally {
    state.updatedAt = now();
    state.metrics = computeMetrics(state.issues);
    persistState(state);
  }
}

main().catch((error) => {
  console.error("Fatal runtime error", error);
  exit(1);
});
