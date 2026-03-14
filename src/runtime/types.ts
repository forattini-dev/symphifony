export type JsonRecord = Record<string, unknown>;

export type IssueState =
  | "Todo"
  | "In Progress"
  | "In Review"
  | "Blocked"
  | "Done"
  | "Cancelled";

export type RuntimeEventType =
  | "info"
  | "state"
  | "progress"
  | "error"
  | "manual"
  | "runner";

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
  priority: number;
  state: IssueState;
  branchName?: string;
  url?: string;
  assigneeId?: string;
  labels: string[];
  paths?: string[];
  inferredPaths?: string[];
  capabilityCategory?: string;
  capabilityOverlays?: string[];
  capabilityRationale?: string[];
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
  agentProvider: string;
  agentCommand: string;
  dashboardPort?: string;
  runMode: "filesystem";
};

export type RuntimeMetrics = {
  total: number;
  queued: number;
  inProgress: number;
  blocked: number;
  done: number;
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
  workflowPath: string;
  dashboardPort?: string;
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

export type AgentProviderDefinition = {
  provider: string;
  role: AgentProviderRole;
  command: string;
  profile: string;
  profilePath: string;
  profileInstructions: string;
  selectionReason?: string;
  overlays?: string[];
  capabilityCategory?: string;
};

export type AgentDirectiveStatus = "done" | "continue" | "blocked" | "failed";

export type AgentDirective = {
  status: AgentDirectiveStatus;
  summary: string;
  nextPrompt: string;
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

export type IssueRecord = IssueEntry;
export type EventRecord = RuntimeEvent;

export type WorkflowDefinition = {
  workflowPath: string;
  rendered: string;
  config: JsonRecord;
  promptTemplate: string;
  agentProvider: string;
  agentProfile: string;
  agentProfilePath: string;
  agentProfileInstructions: string;
  agentProviders: AgentProviderDefinition[];
  afterCreateHook: string;
  beforeRunHook: string;
  afterRunHook: string;
  beforeRemoveHook: string;
};

export type FileSystemClientOptions = {
  basePath: string;
  bucket: string;
  keyPrefix?: string;
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
  FileSystemClient: new (options: FileSystemClientOptions) => unknown;
  ApiPlugin: new (options: Record<string, unknown>) => {
    stop?: () => Promise<void>;
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
