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
  | "warn"
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
  milestoneId?: string;
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
  /** Tools the CLI actually used (accumulated across all turns) */
  toolsUsed?: string[];
  /** Skills (slash commands) actually invoked during execution */
  skillsUsed?: string[];
  /** Subagents actually spawned during execution */
  agentsUsed?: string[];
  /** Shell commands actually executed */
  commandsRun?: string[];
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
  /** Whether an isolated test workspace is currently provisioned for this issue */
  testApplied?: boolean;
  /** Absolute path to the isolated test workspace created for manual verification */
  testWorkspacePath?: string;
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
  /** Checkpoint review attempt counter for contractual checkpointed plans (resets on replan) */
  checkpointAttempt?: number;
  /** Current checkpoint state for contractual checkpointed execution */
  checkpointStatus?: "pending" | "passed" | "failed";
  /** Timestamp of the last successful checkpoint review */
  checkpointPassedAt?: string;
  /** Structured grading output from the last checkpoint review cycle */
  checkpointReport?: GradingReport;
  /** Negotiation attempt counter for pre-execution contract review */
  contractNegotiationAttempt?: number;
  /** Current status of the pre-execution contract negotiation */
  contractNegotiationStatus?: ContractNegotiationStatus;
  /** Persisted negotiation runs for the current and prior plans */
  contractNegotiationRuns?: ContractNegotiationRun[];
  /** Previous plans archived before each replan */
  planHistory?: IssuePlan[];
  /** Summaries of previous failed execution attempts (for retry context) */
  previousAttemptSummaries?: AttemptSummary[];
  /** Validation gate result (test command execution) */
  validationResult?: ValidationResult;
  /** Pre-review fast validation gate result — set after execution, before reviewer spawns */
  preReviewValidation?: ValidationResult;
  /** URL of the PR created via push-pr merge mode */
  prUrl?: string;
  /** Structured grading output from the last review cycle */
  gradingReport?: GradingReport;
  /** Active evaluator profile selected for the current review cycle */
  reviewProfile?: ReviewProfile;
  /** Persisted reviewer routing and verdict history for checkpoint/final cycles */
  reviewRuns?: ReviewRun[];
  /** Structured history of failed review criteria across checkpoint/final review cycles */
  reviewFailureHistory?: ReviewFailureRecord[];
  /** Audit trail of policy decisions that changed harness behavior */
  policyDecisions?: PolicyDecision[];
  /** Latest context assembly report per agent role */
  contextReportsByRole?: Partial<Record<AgentProviderRole, AgentContextAssemblyReport>>;
  /** Last workspace memory flush performed from structured state */
  memoryFlushAt?: string;
  /** Total number of workspace memory flushes for this issue */
  memoryFlushCount?: number;
  /** Persisted execution/review blueprint runs for audit and resume */
  blueprintRuns?: BlueprintRun[];
  /** Number of context resets (fresh session with handoff) performed in the current execute attempt */
  contextResetCount?: number;
  /** Path to the handoff artifact written during a context reset — injected into the next session */
  lastHandoffFile?: string;
  /** Parallel sub-task tracking for parallel-execution mode */
  parallelSubTasks?: ParallelSubTask[];
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

export type ParallelSubTask = {
  id: string;
  label: string;
  stepIndices: number[];
  worktreePath?: string;
  status: "pending" | "running" | "done" | "failed";
  result?: string;
  tokenUsage?: AgentTokenUsage;
  startedAt?: string;
  completedAt?: string;
};

export type WorkspaceMemoryEntryKind =
  | "bootstrap"
  | "review-failure"
  | "review-pass"
  | "checkpoint-failure"
  | "checkpoint-pass"
  | "contract-negotiation"
  | "policy-decision"
  | "validation"
  | "merge-summary";

export type WorkspaceMemoryEntry = {
  id: string;
  kind: WorkspaceMemoryEntryKind;
  issueId: string;
  issueIdentifier: string;
  title: string;
  summary: string;
  details?: string[];
  source: "runtime" | "planning" | "review" | "merge";
  createdAt: string;
  planVersion?: number;
  executeAttempt?: number;
  reviewAttempt?: number;
  reviewScope?: ReviewScope;
  persistLongTerm?: boolean;
  tags?: string[];
};

export type MemoryFlushReport = {
  flushedAt: string;
  reason: string;
  changedFiles: string[];
  entriesWritten: number;
  promotedEntries: number;
};

export type ContextLayerName =
  | "bootstrap"
  | "workspace-memory"
  | "issue-memory"
  | "retrieval";

export type ContextLayerReport = {
  name: ContextLayerName;
  hitCount: number;
  selectedHitCount: number;
  discardedHitCount: number;
  notes?: string[];
};

export type ContextPipelineStageName =
  | "ingest"
  | "flush-memory"
  | "retrieve"
  | "budget"
  | "compact"
  | "assemble";

export type ContextPipelineStageReport = {
  name: ContextPipelineStageName;
  status: "completed" | "skipped";
  durationMs: number;
  inputCount?: number;
  outputCount?: number;
  budgetLimit?: number;
  detail?: string;
  notes?: string[];
};

export type AgentContextAssemblyReport = {
  role: AgentProviderRole;
  query: string;
  generatedAt: string;
  maxHits: number;
  totalHits: number;
  selectedHits: number;
  discardedHits: number;
  layers: ContextLayerReport[];
  stages: ContextPipelineStageReport[];
  memoryFlush?: MemoryFlushReport | null;
};

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export type DoctorCheckResult = {
  id: string;
  title: string;
  status: DoctorCheckStatus;
  summary: string;
  detail?: string;
  suggestedAction?: string;
};

export type RuntimeHealthSnapshot = {
  generatedAt: string;
  ok: boolean;
  workspace: {
    root: string;
    git: {
      isGit: boolean;
      hasCommits: boolean;
      branch: string | null;
      isClean?: boolean;
      untrackedCount?: number;
    };
  };
  providers: {
    configuredProvider: string;
    configuredCommand: string;
    configuredCapabilities: ProviderCapabilities;
    capabilityWarnings: string[];
    available: DetectedProvider[];
  };
  issues: {
    total: number;
    planning: number;
    running: number;
    reviewing: number;
    blocked: number;
    pendingDecision: number;
  };
  agents: {
    active: number;
    crashed: number;
    idle: number;
  };
  services: {
    total: number;
    running: number;
    starting: number;
    stopped: number;
    crashed: number;
  };
  memory: {
    issuesWithFlushes: number;
    totalFlushes: number;
  };
};

export type AcceptanceCriterionCategory =
  | "functionality"
  | "correctness"
  | "regression"
  | "design"
  | "code_quality"
  | "performance"
  | "security"
  | "validation"
  | "integration";

export type AcceptanceCriterion = {
  id: string;
  description: string;
  category: AcceptanceCriterionCategory;
  verificationMethod: string;
  evidenceExpected: string;
  blocking: boolean;
  weight: number;
};

export type ExecutionContract = {
  summary: string;
  deliverables: string[];
  requiredChecks: string[];
  requiredEvidence: string[];
  focusAreas: string[];
  checkpointPolicy: "final_only" | "checkpointed";
  blueprintId?: string;
  delegationPolicy?: DelegationPolicy;
  budgetPolicy?: BudgetPolicy;
  /** User-defined deterministic nodes to inject into the blueprint after the implement node */
  deterministicNodes?: Array<{
    id: string;
    label: string;
    command: string;
    after: string;
    blocking?: boolean;
  }>;
  /** Parallel sub-task decomposition for multi-agent concurrent execution */
  parallelSubTasks?: Array<{
    id: string;
    label: string;
    steps: number[];
  }>;
};

export type HarnessMode = "solo" | "standard" | "contractual";

export type ReviewScope = "checkpoint" | "final";

export type ContractNegotiationStatus = "running" | "approved" | "failed" | "skipped";

export type ContractNegotiationDecisionStatus = "approved" | "revise";

export type ContractNegotiationConcernArea =
  | "harness_mode"
  | "steps"
  | "acceptance_criteria"
  | "execution_contract"
  | "validation"
  | "suggested_paths";

export type ContractNegotiationConcern = {
  id: string;
  severity: "blocking" | "advisory";
  area: ContractNegotiationConcernArea;
  problem: string;
  requiredChange: string;
};

export type ContractNegotiationDecision = {
  status: ContractNegotiationDecisionStatus;
  summary: string;
  rationale: string;
  concerns: ContractNegotiationConcern[];
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

export type IssuePlanExecutionStrategy = {
  approach: string;
  whyThisApproach: string;
  alternativesConsidered?: string[];
};

export type IssuePlan = {
  // Core
  summary: string;
  estimatedComplexity: "trivial" | "low" | "medium" | "high";
  harnessMode: HarnessMode;
  executionStrategy?: IssuePlanExecutionStrategy;

  // Structured plan (new format with phases)
  phases?: IssuePlanPhase[];
  // Simple steps (flat list, used alongside phases)
  steps: IssuePlanStep[];

  // Context
  assumptions?: string[];
  constraints?: string[];
  unknowns?: { question: string; whyItMatters: string; howToResolve: string }[];
  acceptanceCriteria: AcceptanceCriterion[];
  executionContract: ExecutionContract;
  blueprint?: HarnessBlueprint;
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

export type ServiceState =
  | "stopped"    // no pid file — clean state
  | "starting"   // spawned, grace period not elapsed yet
  | "running"    // alive + grace period elapsed (or health check passed)
  | "unhealthy"  // process alive but health check failing (reserved — FSM not yet wired)
  | "stopping"   // SIGTERM sent, awaiting exit
  | "crashed";   // process died unexpectedly

export type ServiceHealthcheck = {
  type: "http" | "tcp" | "command";
  /** http: full URL e.g. "http://localhost:3000/health" */
  endpoint?: string;
  /** tcp: port to probe */
  port?: number;
  /** command: shell command, exit 0 = healthy */
  command?: string;
  /** ms between checks (default 5000) */
  interval?: number;
  /** ms before timeout (default 3000) */
  timeout?: number;
  /** consecutive failures before unhealthy (default 3) */
  retries?: number;
  /** ms grace period after process start before checks begin (default 10000) */
  startPeriod?: number;
};

export type ServiceEntry = {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  autoStart?: boolean;
  /** Auto-restart on unexpected crash (default false) */
  autoRestart?: boolean;
  /** Max auto-restart attempts before giving up (default 5) */
  maxCrashes?: number;
  /** Optional port hint (informational) */
  port?: number;
  /** Optional healthcheck config — detected automatically or set manually */
  healthcheck?: ServiceHealthcheck;
};

export type ServiceStatus = {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  autoStart?: boolean;
  autoRestart?: boolean;
  maxCrashes?: number;
  port?: number;
  state: ServiceState;
  /** Convenience: true when state is "starting" or "running" */
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  uptime: number;
  logSize: number;
  crashCount: number;
  nextRetryAt?: string;
};

// ── Mesh (inter-service traffic proxy) ───────────────────────────

export type TrafficEntry = {
  id: string;
  sourceServiceId: string | null;
  targetServiceId: string | null;
  method: string;
  url: string;
  path: string;
  statusCode: number;
  requestSize: number;
  responseSize: number;
  startedAt: string;
  durationMs: number;
  error?: string;
};

export type ServiceGraphEdge = {
  source: string;
  target: string;
  requestCount: number;
  errorCount: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  lastSeenAt: string;
  topPaths: { path: string; count: number }[];
};

export type ServiceGraph = {
  nodes: { id: string; name: string; state: string; port?: number }[];
  edges: ServiceGraphEdge[];
  capturedSince: string;
  totalRequests: number;
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
  /** When true AND no reviewer is configured, issues auto-approve after execution. When true AND a reviewer IS configured, issues auto-approve after reviewer success. When false, issues always wait in PendingDecision for manual human approval. */
  autoReviewApproval: boolean;
  testCommand?: string;
  prBaseBranch?: string;
  /** Maximum dollar budget per agent execution (claude --max-budget-usd) */
  maxBudgetUsd?: number;
  /** When true, agent executions run inside a Docker container for filesystem isolation. */
  dockerExecution: boolean;
  /** Docker image used when dockerExecution is true. */
  dockerImage: string;
  afterCreateHook: string;
  beforeRunHook: string;
  afterRunHook: string;
  beforeRemoveHook: string;
  services?: ServiceEntry[];
  serviceEnv?: Record<string, string>;
  /** Maximum automated review→requeue cycles before escalating to human. Default: 2 */
  maxReviewAutoRetries?: number;
  /** When true, reviewer gets Playwright MCP access for UI verification (requires @playwright/mcp) */
  enablePlaywrightReview?: boolean;
  /** When true, auto-replan when the same error type repeats N times in a row (default: false) */
  autoReplanOnStall?: boolean;
  /** How many same-error attempts trigger auto-replan (default: 2) */
  autoReplanStallThreshold?: number;
  /** When true, planner output can be upgraded/downgraded to a stronger harness mode using historical lift. Default: true */
  adaptiveHarnessSelection?: boolean;
  /** When true, reviewer provider/model routing can adapt to historical lift by review profile. Default: true */
  adaptiveReviewRouting?: boolean;
  /** Minimum historical samples before adaptive policy trusts observed lift over heuristics. Default: 3 */
  adaptivePolicyMinSamples?: number;
  /** Maximum context reset (new session with handoff) cycles per execute attempt. Default: 2 */
  maxContextResets?: number;
  /** Context window usage % that triggers an automatic context reset. Default: 85 */
  contextResetThresholdPct?: number;
  /** When true, start a local HTTP forward proxy to capture inter-service traffic. Default: false */
  meshEnabled?: boolean;
  /** Port for the mesh proxy server. 0 = OS auto-assign. Default: 0 */
  meshProxyPort?: number;
  /** Max traffic entries kept in the in-memory ring buffer. Default: 1000 */
  meshBufferSize?: number;
  /** Auto-commit dirty TARGET_ROOT before merge/preview so merges aren't blocked. Default: true */
  autoCommitBeforeMerge?: boolean;
  /** When merge has conflicts, re-execute agent to resolve them automatically. Default: false */
  autoResolveConflicts?: boolean;
};

export type ProjectNameSource = "saved" | "detected" | "missing";
export type MilestoneNameSource = ProjectNameSource;

export type MilestoneStatus = "planned" | "active" | "paused" | "done" | "cancelled";

export type MilestoneProgressSummary = {
  scopeCount: number;
  completedCount: number;
  progressPercent: number;
};

export type VariableEntry = {
  id: string;        // "${scope}:${key}"
  key: string;
  value: string;
  scope: string;     // "global" | service id
  updatedAt: string;
};

export type MilestoneEntry = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  status: MilestoneStatus;
  createdAt: string;
  updatedAt: string;
  progress: MilestoneProgressSummary;
  issueCount: number;
};

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
  milestones: MilestoneEntry[];
  issues: IssueEntry[];
  events: RuntimeEvent[];
  metrics: RuntimeMetrics;
  notes: string[];
  variables: VariableEntry[];
};

export type BlueprintNodeType =
  | "deterministic"
  | "agent"
  | "review"
  | "handoff";

export type BlueprintNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type BlueprintRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type BlueprintNodeExecutionMode =
  | "serial"
  | "parallel";

export type DelegationPolicy = {
  mode: "serial" | "governed" | "aggressive";
  maxFanout: number;
  requireExplicitWriteScope: boolean;
  allowPlanningDelegation: boolean;
  allowExecutionDelegation: boolean;
  allowReviewDelegation: boolean;
};

export type BudgetPolicy = {
  maxLocalRetries: number;
  maxRemoteRounds: number;
  maxDelegationFanout: number;
  maxWallClockMinutes: number;
  maxTokenBudgetUsd?: number;
};

export type ProviderReadOnlyExecutionMode =
  | "plan"
  | "approval"
  | "none";

export type ProviderStructuredOutputMode =
  | "json-schema"
  | "prompt-contract"
  | "none";

export type ProviderImageInputMode =
  | "cli-flag"
  | "prompt-inline"
  | "none";

export type ProviderUsageReportingMode =
  | "cli-command"
  | "session-files"
  | "none";

export type ProviderNativeSubagentMode =
  | "native"
  | "runtime-only";

export type ProviderCapabilities = {
  readOnlyExecution: ProviderReadOnlyExecutionMode;
  structuredOutput: {
    mode: ProviderStructuredOutputMode;
    requiresToolDisable: boolean;
  };
  imageInput: ProviderImageInputMode;
  usageReporting: ProviderUsageReportingMode;
  nativeSubagents: ProviderNativeSubagentMode;
};

export type BlueprintArtifact = {
  id: string;
  nodeId: string;
  kind: "brief" | "inputs" | "result" | "evidence" | "resume" | "summary";
  path: string;
  createdAt: string;
};

export type BlueprintNode = {
  id: string;
  label: string;
  type: BlueprintNodeType;
  mode?: BlueprintNodeExecutionMode;
  role?: AgentProviderRole;
  dependsOn?: string[];
  required?: boolean;
  fanoutGroup?: string;
  outputs?: string[];
  /** Shell command to run for deterministic nodes */
  command?: string;
  /** When true, failure of this node blocks the pipeline */
  blocking?: boolean;
};

export type HarnessBlueprint = {
  id: string;
  version: number;
  summary: string;
  mode: "copilot" | "unattended";
  checkpointPolicy: "final_only" | "checkpointed";
  delegationPolicy: DelegationPolicy;
  budgetPolicy: BudgetPolicy;
  nodes: BlueprintNode[];
};

export type BlueprintNodeRun = {
  nodeId: string;
  label: string;
  type: BlueprintNodeType;
  status: BlueprintNodeStatus;
  startedAt?: string;
  completedAt?: string;
  skippedReason?: string;
  error?: string;
  artifacts: BlueprintArtifact[];
};

export type BlueprintRun = {
  id: string;
  blueprintId: string;
  issueId: string;
  planVersion: number;
  executeAttempt: number;
  status: BlueprintRunStatus;
  startedAt: string;
  completedAt?: string;
  scope: "plan" | "execute" | "review";
  nodes: BlueprintNodeRun[];
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
  capabilities?: ProviderCapabilities;
};

export type ReviewProfileName =
  | "general-quality"
  | "ui-polish"
  | "workflow-fsm"
  | "integration-safety"
  | "api-contract"
  | "security-hardening";

export type ReviewProfile = {
  primary: ReviewProfileName;
  secondary: ReviewProfileName[];
  rationale: string[];
  focusAreas: string[];
  failureModes: string[];
  evidencePriorities: string[];
  severityBias: string;
};

export type ReviewRoutingSnapshot = {
  provider: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  overlays: string[];
  selectionReason?: string;
};

export type ReviewRunStatus = "running" | "completed" | "crashed";

export type ContractNegotiationRunStatus = "running" | "completed" | "crashed";

export type ReviewRun = {
  id: string;
  nodeId?: string;
  scope: ReviewScope;
  planVersion: number;
  attempt: number;
  cycle: number;
  status: ReviewRunStatus;
  reviewProfile: ReviewProfile;
  routing: ReviewRoutingSnapshot;
  promptFile: string;
  startedAt: string;
  completedAt?: string;
  sessionSuccess?: boolean;
  continueRequested?: boolean;
  blocked?: boolean;
  exitCode?: number | null;
  turns?: number;
  overallVerdict?: "PASS" | "FAIL";
  blockingVerdict?: "PASS" | "FAIL";
  criteriaCount?: number;
  failedCriteriaCount?: number;
  blockingFailedCriteriaCount?: number;
  advisoryFailedCriteriaCount?: number;
  error?: string;
};

export type ContractNegotiationRun = {
  id: string;
  nodeId?: string;
  planVersion: number;
  attempt: number;
  status: ContractNegotiationRunStatus;
  reviewProfile: ReviewProfile;
  routing: ReviewRoutingSnapshot;
  promptFile: string;
  startedAt: string;
  completedAt?: string;
  sessionSuccess?: boolean;
  continueRequested?: boolean;
  blocked?: boolean;
  exitCode?: number | null;
  turns?: number;
  decisionStatus?: ContractNegotiationDecisionStatus;
  summary?: string;
  rationale?: string;
  concerns?: ContractNegotiationConcern[];
  concernsCount?: number;
  blockingConcernsCount?: number;
  advisoryConcernsCount?: number;
  appliedRefinement?: boolean;
  error?: string;
};

export type ReviewFailureRecord = {
  id: string;
  runId: string;
  scope: ReviewScope;
  planVersion: number;
  attempt: number;
  criterionId: string;
  description: string;
  category: AcceptanceCriterionCategory;
  verificationMethod: string;
  blocking: boolean;
  weight: number;
  evidence: string;
  recordedAt: string;
  reviewProfile?: ReviewProfileName;
  routing?: ReviewRoutingSnapshot;
};

export type PolicyDecisionKind =
  | "harness-mode"
  | "checkpoint-policy"
  | "review-recovery";

export type PolicyDecisionScope =
  | "planning"
  | "checkpoint-review"
  | "final-review";

export type PolicyDecision = {
  id: string;
  kind: PolicyDecisionKind;
  scope: PolicyDecisionScope;
  planVersion: number;
  attempt?: number;
  basis: "historical" | "heuristic" | "runtime";
  from?: string;
  to: string;
  rationale: string;
  recordedAt: string;
  profile?: ReviewProfileName;
  reviewScope?: ReviewScope;
};

export type GradingCriterion = {
  id: string;
  description: string;
  category: AcceptanceCriterionCategory;
  verificationMethod: string;
  evidenceExpected: string;
  blocking: boolean;
  weight: number;
  result: "PASS" | "FAIL" | "SKIP";
  evidence: string;
};

export type GradingReport = {
  scope: ReviewScope;
  overallVerdict: "PASS" | "FAIL";
  blockingVerdict: "PASS" | "FAIL";
  criteria: GradingCriterion[];
  reviewAttempt: number;
};

export type AgentDirectiveStatus = "done" | "continue" | "blocked" | "failed";

export type AgentContextHitKind =
  | "doc"
  | "code-snippet"
  | "issue-memory"
  | "review-memory"
  | "failure-memory"
  | "config"
  | "test";

export type AgentContextHitSource = "explicit" | "lexical" | "semantic" | "memory" | "structural";

export type AgentContextHit = {
  id: string;
  kind: AgentContextHitKind;
  source: AgentContextHitSource;
  path?: string;
  sourceId?: string;
  issueId?: string;
  score: number;
  reason: string;
  excerpt: string;
};

export type AgentContextPack = {
  role: AgentProviderRole;
  consumerNodeType?: BlueprintNodeType;
  query: string;
  generatedAt: string;
  hits: AgentContextHit[];
  lexicalHitCount: number;
  semanticHitCount: number;
  memoryHitCount: number;
  explicitHitCount: number;
  report?: AgentContextAssemblyReport;
};

export type AgentTraceStepType =
  | "context_built"
  | "lexical_search"
  | "semantic_search"
  | "memory_loaded"
  | "prompt_compiled"
  | "tool_used"
  | "skill_used"
  | "subagent_used"
  | "command_used"
  | "turn_finished";

export type AgentTraceStep = {
  type: AgentTraceStepType;
  label: string;
  detail?: string;
};

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
  /** Tools the CLI actually used (Read, Write, Edit, Bash, etc.) */
  toolsUsed?: string[];
  /** Skills (slash commands) actually invoked during execution */
  skillsUsed?: string[];
  /** Subagents actually spawned during execution */
  agentsUsed?: string[];
  /** Shell commands actually executed */
  commandsRun?: string[];
};

export type AgentSessionResult = {
  success: boolean;
  blocked: boolean;
  continueRequested: boolean;
  code: number | null;
  output: string;
  turns: number;
  artifacts?: BlueprintArtifact[];
  /** True when a context reset was triggered (new session will start from handoff) */
  contextReset?: boolean;
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
  toolsUsed?: string[];
  skillsUsed?: string[];
  agentsUsed?: string[];
  commandsRun?: string[];
  contextPack?: AgentContextPack;
  traceSteps?: AgentTraceStep[];
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

export type RuntimeExecutionRequest = {
  issue: Pick<IssueEntry, "id" | "identifier" | "title" | "description" | "planVersion" | "executeAttempt">;
  blueprint: HarnessBlueprint;
  node: BlueprintNode;
  workspacePath: string;
  provider: AgentProviderDefinition;
  prompt: string;
  promptFile: string;
  role: AgentProviderRole;
};

export type RuntimeExecutionResult = {
  success: boolean;
  blocked: boolean;
  continueRequested: boolean;
  code: number | null;
  output: string;
  turns: number;
  artifacts: BlueprintArtifact[];
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
  VectorPlugin?: new (options: Record<string, unknown>) => {
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
  };
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
    getStatus?: () => unknown;
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
  capabilities?: ProviderCapabilities;
};
