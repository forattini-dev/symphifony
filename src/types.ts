export type JsonRecord = Record<string, unknown>;

export type IssueState =
  | "Planning"
  | "PendingApproval"
  | "Queued"
  | "Running"
  | "Reviewing"
  | "PendingDecision"
  | "Blocked"
  | "Approved"
  | "Merged"
  | "Cancelled"
  | "Archived";

export type RuntimeEventType =
  | "info"
  | "state"
  | "progress"
  | "error"
  | "manual"
  | "runner"
  | "merge";

export type RuntimeEvent = {
  id: string;
  issueId?: string;
  kind: RuntimeEventType;
  message: string;
  at: string;
};

export type IssueEntry = {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: IssueState;
  branchName?: string;
  baseBranch?: string;
  headCommitAtStart?: string;
  worktreePath?: string;
  url?: string;
  assigneeId?: string;
  labels: string[];
  paths?: string[];
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
  /** Which phase produced the lastError — used by onEnterQueued to tag AttemptSummary */
  lastFailedPhase?: "plan" | "execute" | "review" | "crash";
  durationMs?: number;
  commandExitCode?: number | null;
  commandOutputTail?: string;
  terminalWeek?: string; // e.g. "2026-W12" — set when issue reaches Done/Cancelled, "" when active
  tokenUsage?: AgentTokenUsage; // aggregated across all turns/attempts
  tokensByPhase?: Record<AgentProviderRole, AgentTokenUsage>; // per-phase breakdown (planner/executor/reviewer)
  tokensByModel?: Record<string, AgentTokenUsage>; // full per-model breakdown with input/output
  images?: string[]; // absolute paths to attached image files (screenshots, evidence)
  issueType?: string; // template type selected at creation (blank/bug/feature/refactor/docs/chore)
  eventsCount?: number; // total events added to this issue — tracked via EventualConsistency plugin
  usage?: { tokens: Record<string, number> }; // { tokens: { "claude-opus-4-6": 12345, "gpt-5.3": 6789 } } — for EventualConsistency
  effort?: EffortConfig; // per-issue reasoning effort override
  linesAdded?: number;
  linesRemoved?: number;
  filesChanged?: number;
  plan?: IssuePlan;
  /** When the workspace was merged into TARGET_ROOT */
  mergedAt?: string;
  /** Summary of the merge result */
  mergeResult?: { copied: number; deleted: number; skipped: number; conflicts: number; conflictFiles?: string[]; conflictResolution?: { resolved: boolean; provider: string; resolvedFiles: string[]; durationMs: number; output?: string; resolvedAt: string } };
  /** Summary of pre-merge rebase attempt (auto-rebase before merge to resolve diverged branches) */
  rebaseResult?: { success: boolean; conflictFiles: string[]; rebasedAt: string };
  /** Why the issue was merged — set for both auto and manual merges */
  mergedReason?: string;
  /** Why the issue was cancelled — set for both auto and manual cancels */
  cancelledReason?: string;
  /** Whether a test squash (git merge --squash) is currently applied to TARGET_ROOT */
  testApplied?: boolean;
  /** ISO timestamp when issue entered Reviewing state (last time, for code review turnaround KPI) */
  reviewingAt?: string;
  /** Planning process status — driven by scheduler-managed planning job */
  planningStatus?: "idle" | "planning";
  /** ISO timestamp when planning started */
  planningStartedAt?: string;
  /** Error message from last plan generation attempt */
  planningError?: string;
  /** Increments with each plan generation (0 = no plan, 1 = first plan, 2+ = after replan) */
  planVersion: number;
  /** Execution attempt counter for current planVersion (resets on replan) */
  executeAttempt: number;
  /** Review attempt counter for current planVersion (resets on replan) */
  reviewAttempt: number;
  /** Previous plans archived before each replan */
  planHistory?: IssuePlan[];
  /** Summaries of previous failed execution attempts (for retry context) */
  previousAttemptSummaries?: AttemptSummary[];
  /** Validation gate result (test command execution) */
  validationResult?: ValidationResult;
  /** URL of the PR created via push-pr merge mode */
  prUrl?: string;
};

export type AttemptSummary = {
  planVersion: number;
  executeAttempt: number;
  /** Which phase failed: plan, execute, review, or unknown */
  phase?: "plan" | "execute" | "review" | "crash";
  error: string;
  outputTail?: string;
  outputFile?: string;
  timestamp: string;
  /** Structured failure analysis (populated by failure-analyzer) */
  insight?: {
    errorType: string;
    rootCause: string;
    failedCommand?: string;
    filesInvolved: string[];
    suggestion: string;
  };
};

export type ValidationResult = {
  passed: boolean;
  output: string;
  command: string;
  ranAt: string;
};

export type IssuePlanStep = {
  step: number;
  action: string;
  files?: string[];
  details?: string;
  ownerType?: "human" | "agent" | "skill" | "subagent" | "tool";
  doneWhen?: string;
};

export type IssuePlanPhase = {
  phaseName: string;
  goal: string;
  tasks: IssuePlanStep[];
  dependencies?: string[];
  outputs?: string[];
};

export type IssuePlanRisk = {
  risk: string;
  impact: string;
  mitigation: string;
};

export type IssuePlan = {
  // Core
  summary: string;
  estimatedComplexity: "trivial" | "low" | "medium" | "high";

  // Structured plan (new format with phases)
  phases?: IssuePlanPhase[];
  // Simple steps (flat list, used alongside phases)
  steps: IssuePlanStep[];

  // Context
  assumptions?: string[];
  constraints?: string[];
  unknowns?: { question: string; whyItMatters: string; howToResolve: string }[];
  successCriteria?: string[];
  risks?: IssuePlanRisk[];
  validation?: string[];
  deliverables?: string[];

  // Suggestions
  suggestedPaths: string[];
  suggestedSkills: string[];
  suggestedAgents: string[];
  suggestedEffort: EffortConfig;

  // Refinement history
  refinements?: Array<{ feedback: string; at: string; version: number }>;

  // Meta
  provider: string;
  createdAt: string;
};

export type RuntimeConfig = {
  pollIntervalMs: number;
  workerConcurrency: number;
  maxConcurrentByState: Record<string, number>;
  commandTimeoutMs: number;
  maxAttemptsDefault: number;
  maxTurns: number;
  retryDelayMs: number;
  staleInProgressTimeoutMs: number;
  logLinesTail: number;
  maxPreviousOutputChars: number;
  agentProvider: string;
  agentCommand: string;
  defaultEffort: EffortConfig;
  dashboardPort?: string;
  runMode: "filesystem";
  defaultBranch?: string;
  mergeMode?: "local" | "push-pr";
  /** If true, review approval can still be automatic after reviewer success; if false, reviewer success waits for manual approval. */
  autoReviewApproval: boolean;
  testCommand?: string;
  prBaseBranch?: string;
  /** Maximum dollar budget per agent execution (claude --max-budget-usd) */
  maxBudgetUsd?: number;
  afterCreateHook: string;
  beforeRunHook: string;
  afterRunHook: string;
  beforeRemoveHook: string;
};

export type ProjectNameSource = "saved" | "detected" | "missing";

export type RuntimeMetrics = {
  total: number;
  planning: number;
  queued: number;
  inProgress: number;
  blocked: number;
  done: number;
  merged: number;
  cancelled: number;
  activeWorkers: number;
  avgCompletionMs?: number;
  medianCompletionMs?: number;
  fastestCompletionMs?: number;
  slowestCompletionMs?: number;
};

export type RuntimeState = {
  startedAt: string;
  updatedAt: string;
  trackerKind: "filesystem";
  sourceRepoUrl: string;
  sourceRef: string;
  projectName?: string;
  detectedProjectName?: string;
  projectNameSource?: ProjectNameSource;
  queueTitle?: string;
  dashboardPort?: string;
  booting?: boolean;
  config: RuntimeConfig;
  issues: IssueEntry[];
  events: RuntimeEvent[];
  metrics: RuntimeMetrics;
  notes: string[];
};

export type RuntimeStateRecord = {
  id: string;
  schemaVersion: number;
  trackerKind: RuntimeState["trackerKind"];
  runtimeTag: string;
  updatedAt: string;
  state: RuntimeState;
};

export type AgentProviderRole = "planner" | "executor" | "reviewer";
export type ReasoningEffort = "low" | "medium" | "high" | "extra-high";

/** Configuration for a single pipeline stage (plan, execute, review) */
export type PipelineStageConfig = {
  provider: string;    // "claude" | "codex"
  model: string;       // "claude-opus-4-6", "claude-sonnet-4-6", "gpt-5.4", etc.
  effort: ReasoningEffort;
};

/** Full workflow config: what to use at each stage */
export type WorkflowConfig = {
  plan: PipelineStageConfig;
  execute: PipelineStageConfig;
  review: PipelineStageConfig;
};

export type EffortConfig = {
  default?: ReasoningEffort;
  planner?: ReasoningEffort;
  executor?: ReasoningEffort;
  reviewer?: ReasoningEffort;
};

export type AgentProviderDefinition = {
  provider: string;
  role: AgentProviderRole;
  command: string;
  model?: string;
  profile: string;
  profilePath: string;
  profileInstructions: string;
  selectionReason?: string;
  overlays?: string[];
  reasoningEffort?: ReasoningEffort;
};

export type AgentDirectiveStatus = "done" | "continue" | "blocked" | "failed";

export type AgentTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
  model?: string;
};

export type AgentDirective = {
  status: AgentDirectiveStatus;
  summary: string;
  nextPrompt: string;
  tokenUsage?: AgentTokenUsage;
};

export type AgentSessionResult = {
  success: boolean;
  blocked: boolean;
  continueRequested: boolean;
  code: number | null;
  output: string;
  turns: number;
};

export type AgentSessionTurn = {
  turn: number;
  role?: AgentProviderRole;
  model?: string;
  startedAt: string;
  completedAt: string;
  promptFile: string;
  prompt: string;
  output: string;
  code: number | null;
  success: boolean;
  directiveStatus: AgentDirectiveStatus;
  directiveSummary: string;
  nextPrompt: string;
  tokenUsage?: AgentTokenUsage;
};

export type AgentSessionState = {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  status: "running" | "done" | "blocked" | "failed";
  startedAt: string;
  updatedAt: string;
  maxTurns: number;
  turns: AgentSessionTurn[];
  lastPrompt: string;
  lastPromptFile: string;
  lastOutput: string;
  lastCode: number | null;
  lastDirectiveStatus: AgentDirectiveStatus;
  lastDirectiveSummary: string;
  nextPrompt: string;
};

export type AgentPipelineState = {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  cycle: number;
  activeIndex: number;
  updatedAt: string;
  history: string[];
};

export type AgentSessionRecord = {
  id: string;
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  cycle: number;
  provider: string;
  role: AgentProviderRole;
  updatedAt: string;
  session: AgentSessionState;
};

export type AgentPipelineRecord = {
  id: string;
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  updatedAt: string;
  pipeline: AgentPipelineState;
};

export type RuntimeSettingScope = "runtime" | "providers" | "ui" | "system";
export type RuntimeSettingSource = "user" | "detected" | "workflow" | "system";
export type RuntimeSettingRecord = {
  id: string;
  scope: RuntimeSettingScope;
  value: unknown;
  source: RuntimeSettingSource;
  updatedAt: string;
};


export type SqliteClientOptions = {
  basePath: string;
};

export type S3dbResource = {
  get: (id: string) => Promise<any>;
  replace: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
  list?: (options?: {
    partition?: string | null;
    partitionValues?: Record<string, string | number>;
    limit?: number;
    offset?: number;
  }) => Promise<any[]>;
};

export type S3dbDatabase = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  usePlugin: (plugin: unknown, name?: string | null) => Promise<unknown>;
  createResource: (config: {
    name: string;
    attributes: Record<string, string>;
    behavior?: string;
    timestamps?: boolean;
    paranoid?: boolean;
    partitions?: Record<string, unknown>;
    asyncPartitions?: boolean;
    api?: Record<string, unknown>;
    description?: string;
  }) => Promise<unknown>;
  getResource: (name: string) => Promise<S3dbResource>;
};

export type S3dbModule = {
  S3db: new (options: Record<string, unknown>) => S3dbDatabase;
  SqliteClient: new (options: SqliteClientOptions) => unknown;
  ApiPlugin: new (options: Record<string, unknown>) => {
    stop?: () => Promise<void>;
  };
  StateMachinePlugin?: new (options: Record<string, unknown>) => {
    stop?: () => Promise<void>;
    waitForPendingEvents?: (timeout?: number) => Promise<void>;
    getMachineDefinition?: (machineId: string) => unknown;
    getState?: (machineId: string, entityId: string) => Promise<unknown>;
    getValidEvents?: (machineId: string, stateOrEntityId: string) => Promise<string[]>;
    initializeEntity?: (machineId: string, entityId: string, context?: Record<string, unknown>) => Promise<unknown>;
    send?: (machineId: string, entityId: string, event: string, context?: Record<string, unknown>) => Promise<unknown>;
  };
  WebSocketPlugin?: new (options: Record<string, unknown>) => {
    stop?: () => Promise<void>;
    broadcast?: (message: unknown) => void;
  };
  loadWebSocketPlugin?: () => Promise<
    new (options: Record<string, unknown>) => {
      stop?: () => Promise<void>;
      broadcast?: (message: unknown) => void;
    }
  >;
  EventualConsistencyPlugin?: new (options: Record<string, unknown>) => {
    stop?: () => Promise<void>;
    getAnalytics?: (resource: string, field: string, options?: Record<string, unknown>) => Promise<unknown[]>;
    getLastNDays?: (resource: string, field: string, days?: number, options?: Record<string, unknown>) => Promise<unknown[]>;
    getLastNWeeks?: (resource: string, field: string, weeks?: number, options?: Record<string, unknown>) => Promise<unknown[]>;
    getTopRecords?: (resource: string, field: string, options?: Record<string, unknown>) => Promise<unknown[]>;
    getStatus?: () => Record<string, unknown>;
  };
  S3QueuePlugin?: new (options: Record<string, unknown>) => {
    startProcessing: (handler?: any, options?: { concurrency?: number }) => Promise<void>;
    stopProcessing: () => Promise<void>;
    getStats: () => Promise<{ total: number; pending: number; processing: number; completed: number; failed: number; dead: number }>;
    recoverStalledMessages: (now: number) => Promise<void>;
  };
};

export type ParallelismAnalysis = {
  canParallelize: boolean;
  maxSafeParallelism: number;
  reason: string;
  groups: string[][];
};

export type DetectedProvider = {
  name: string;
  available: boolean;
  path: string;
};
