import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { IssuePlan, IssuePlanStep, IssueEntry, AgentProviderDefinition, EffortConfig, AgentProviderRole } from "../../types.ts";

/** Render plan context (summary, assumptions, constraints, unknowns) */
export function buildPlanContextSection(plan: IssuePlan): string {
  const parts: string[] = ["## Plan Context", "", `**Summary:** ${plan.summary}`];

  if (plan.assumptions?.length) {
    parts.push("", "**Assumptions:**");
    plan.assumptions.forEach((a) => parts.push(`- ${a}`));
  }
  if (plan.constraints?.length) {
    parts.push("", "**Constraints:**");
    plan.constraints.forEach((c) => parts.push(`- ${c}`));
  }
  if (plan.unknowns?.length) {
    parts.push("", "**Unknowns to investigate:**");
    plan.unknowns.forEach((u) => {
      parts.push(`- **${u.question}**`);
      if (u.whyItMatters) parts.push(`  Why it matters: ${u.whyItMatters}`);
      if (u.howToResolve) parts.push(`  How to resolve: ${u.howToResolve}`);
    });
  }

  return parts.join("\n");
}

/** Render execution steps or phases */
export function buildStepsSection(plan: IssuePlan): string {
  const parts: string[] = ["## Execution Steps"];

  if (plan.phases?.length) {
    for (const phase of plan.phases) {
      parts.push("", `### Phase: ${phase.phaseName}`, `Goal: ${phase.goal}`);
      if (phase.dependencies?.length) parts.push(`Dependencies: ${phase.dependencies.join(", ")}`);
      for (const task of phase.tasks) {
        parts.push(`${task.step}. **${task.action}**${task.ownerType ? ` [${task.ownerType}]` : ""}`);
        if (task.details) parts.push(`   ${task.details}`);
        if (task.doneWhen) parts.push(`   Done when: ${task.doneWhen}`);
        if (task.files?.length) parts.push(`   Files: ${task.files.join(", ")}`);
      }
      if (phase.outputs?.length) parts.push(`Outputs: ${phase.outputs.join(", ")}`);
    }
  } else {
    parts.push("");
    for (const step of plan.steps) {
      parts.push(`${step.step}. **${step.action}**${step.ownerType ? ` [${step.ownerType}]` : ""}`);
      if (step.details) parts.push(`   ${step.details}`);
      if (step.doneWhen) parts.push(`   Done when: ${step.doneWhen}`);
      if (step.files?.length) parts.push(`   Files: ${step.files.join(", ")}`);
    }
  }

  parts.push("", "Follow this plan. Complete each step in order.");
  return parts.join("\n");
}

/** Render risks section */
export function buildRiskSection(plan: IssuePlan): string {
  if (!plan.risks?.length) return "";
  const parts = ["## Risks"];
  for (const r of plan.risks) {
    parts.push(`- **${r.risk}** — Impact: ${r.impact}. Mitigation: ${r.mitigation}`);
  }
  return parts.join("\n");
}

/** Render validation requirements */
export function buildValidationSection(plan: IssuePlan): string {
  const parts: string[] = [];

  if (plan.successCriteria?.length) {
    parts.push("## Success Criteria");
    plan.successCriteria.forEach((c) => parts.push(`- ${c}`));
  }
  if (plan.validation?.length) {
    parts.push("", "## Validation Checks");
    parts.push("Run these before marking as done:");
    plan.validation.forEach((v) => parts.push(`- ${v}`));
  }
  if (plan.deliverables?.length) {
    parts.push("", "## Deliverables");
    plan.deliverables.forEach((d) => parts.push(`- ${d}`));
  }

  return parts.join("\n");
}

/** Render tooling/delegation decisions */
export function buildToolingSection(plan: IssuePlan): string {
  const td = plan.toolingDecision;
  if (!td) return "";

  const parts = ["## Tooling & Delegation Strategy"];

  if (td.decisionSummary) parts.push("", td.decisionSummary);

  if (td.shouldUseSkills && td.skillsToUse?.length) {
    parts.push("", "**Skills to activate:**");
    td.skillsToUse.forEach((s) => parts.push(`- **${s.name}**: ${s.why}`));
  }

  if (td.shouldUseSubagents && td.subagentsToUse?.length) {
    parts.push("", "**Subagents to use:**");
    td.subagentsToUse.forEach((a) => parts.push(`- **${a.name}** (${a.role}): ${a.why}`));
  }

  return parts.join("\n");
}

/** Render execution strategy */
export function buildStrategySection(plan: IssuePlan): string {
  const es = plan.executionStrategy;
  if (!es) return "";

  const parts = [
    "## Execution Strategy",
    "",
    `**Approach:** ${es.approach}`,
    `**Rationale:** ${es.whyThisApproach}`,
  ];

  if (es.alternativesConsidered?.length) {
    parts.push("", "Alternatives considered:");
    es.alternativesConsidered.forEach((a) => parts.push(`- ${a}`));
  }

  return parts.join("\n");
}

/** Resolve effort for a given role */
export function resolveEffortForProvider(
  plan: IssuePlan | undefined,
  role: AgentProviderRole,
  globalEffort?: EffortConfig,
): string | undefined {
  const planEffort = plan?.suggestedEffort;
  const roleKey = role as keyof EffortConfig;
  return planEffort?.[roleKey] as string
    || planEffort?.default as string
    || globalEffort?.[roleKey] as string
    || globalEffort?.default as string
    || undefined;
}

/** Build the complete plan section for any provider */
export function buildFullPlanPrompt(plan: IssuePlan): string {
  return [
    buildPlanContextSection(plan),
    buildStrategySection(plan),
    buildToolingSection(plan),
    buildStepsSection(plan),
    buildRiskSection(plan),
    buildValidationSection(plan),
  ].filter(Boolean).join("\n\n");
}

/** Extract validation commands from plan for hooks */
export function extractValidationCommands(plan: IssuePlan): { pre: string[]; post: string[] } {
  const pre: string[] = [];
  const post: string[] = [];

  for (const v of plan.validation || []) {
    const lower = v.toLowerCase();
    if (lower.includes("lint")) post.push("pnpm lint --quiet 2>/dev/null || true");
    if (lower.includes("typecheck") || lower.includes("tsc")) post.push("pnpm tsc --noEmit 2>/dev/null || true");
    if (lower.includes("test")) post.push("pnpm test 2>/dev/null || true");
  }

  // Deduplicate
  return { pre: [...new Set(pre)], post: [...new Set(post)] };
}

// ── Execution Payload ─────────────────────────────────────────────────────────

/**
 * Canonical structured input for CLI execution.
 * This is the single source of truth that the prompt references.
 * The prompt provides the markdown frame (instructions, role, strategy);
 * the payload carries the structured data (plan, constraints, criteria).
 */
export type ExecutionPayload = {
  /** Schema version for forward compat */
  version: 1;

  /** Issue identity */
  issue: {
    id: string;
    identifier: string;
    title: string;
    description: string;
    labels: string[];
    paths: string[];
  };

  /** Provider context */
  provider: {
    name: string;
    role: AgentProviderRole;
    model: string;
    effort: string;
    capabilityCategory: string;
    overlays: string[];
  };

  /** Execution intent — what to do and how */
  executionIntent: {
    complexity: string;
    approach: string;
    rationale: string;
    workPattern: "sequential" | "phased" | "parallel_subtasks";
  };

  /** Structured plan data */
  plan: {
    summary: string;
    steps: Array<{
      step: number;
      action: string;
      files: string[];
      ownerType: string;
      doneWhen: string;
    }>;
    phases: Array<{
      name: string;
      goal: string;
      tasks: number[];
      dependencies: string[];
      outputs: string[];
    }>;
  };

  /** Constraints the agent must respect */
  constraints: string[];

  /** Success criteria — each must be met for "done" */
  successCriteria: string[];

  /** Validation commands to run before reporting done */
  validation: string[];

  /** Expected deliverables */
  deliverables: string[];

  /** Assumptions the plan is built on */
  assumptions: string[];

  /** Unknowns that may need resolution */
  unknowns: Array<{ question: string; whyItMatters: string; howToResolve: string }>;

  /** Risks with impact and mitigation */
  risks: Array<{ risk: string; impact: string; mitigation: string }>;

  /** Tooling decisions */
  tooling: {
    skills: Array<{ name: string; why: string }>;
    subagents: Array<{ name: string; role: string; why: string }>;
  };

  /** Target paths for focused changes */
  targetPaths: string[];

  /** Workspace location */
  workspacePath: string;

  /** Timestamp */
  createdAt: string;
};

// ── Image handling ───────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/**
 * Build a markdown section with base64-embedded images.
 * Used by adapters whose CLI has no `--image` flag (e.g. Gemini).
 * For CLIs with native image flags (Claude, Codex), use command-level flags instead.
 */
export function buildImagePromptSection(imagePaths: string[]): string {
  const validPaths = imagePaths.filter((p) => existsSync(p));
  if (validPaths.length === 0) return "";

  const parts: string[] = ["## Attached Images", ""];
  for (const imgPath of validPaths) {
    const ext = extname(imgPath).toLowerCase();
    const mime = MIME_MAP[ext] || "image/png";
    const name = basename(imgPath);
    try {
      const data = readFileSync(imgPath).toString("base64");
      parts.push(`### ${name}`);
      parts.push(`![${name}](data:${mime};base64,${data})`);
      parts.push("");
    } catch {
      // Skip unreadable images
    }
  }
  return parts.length > 2 ? parts.join("\n") : "";
}

/**
 * Build the canonical execution payload from issue + plan + provider context.
 */
export function buildExecutionPayload(
  issue: IssueEntry,
  provider: AgentProviderDefinition,
  plan: IssuePlan,
  workspacePath: string,
): ExecutionPayload {
  const strategy = plan.executionStrategy;
  const hasPhases = Boolean(plan.phases?.length);

  return {
    version: 1,

    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description || "",
      labels: issue.labels || [],
      paths: issue.paths || [],
    },

    provider: {
      name: provider.provider,
      role: provider.role,
      model: provider.model || "default",
      effort: provider.reasoningEffort || "medium",
      capabilityCategory: provider.capabilityCategory || "",
      overlays: provider.overlays || [],
    },

    executionIntent: {
      complexity: plan.estimatedComplexity,
      approach: strategy?.approach || "",
      rationale: strategy?.whyThisApproach || "",
      workPattern: hasPhases
        ? "phased"
        : plan.toolingDecision?.shouldUseSubagents
          ? "parallel_subtasks"
          : "sequential",
    },

    plan: {
      summary: plan.summary,
      steps: plan.steps.map((s) => ({
        step: s.step,
        action: s.action,
        files: s.files || [],
        ownerType: s.ownerType || "agent",
        doneWhen: s.doneWhen || "",
      })),
      phases: (plan.phases || []).map((p) => ({
        name: p.phaseName,
        goal: p.goal,
        tasks: p.tasks.map((t) => t.step),
        dependencies: p.dependencies || [],
        outputs: p.outputs || [],
      })),
    },

    constraints: plan.constraints || [],
    successCriteria: plan.successCriteria || [],
    validation: plan.validation || [],
    deliverables: plan.deliverables || [],
    assumptions: plan.assumptions || [],
    unknowns: (plan.unknowns || []).map((u) => ({
      question: u.question,
      whyItMatters: u.whyItMatters || "",
      howToResolve: u.howToResolve || "",
    })),
    risks: (plan.risks || []).map((r) => ({
      risk: r.risk,
      impact: r.impact || "",
      mitigation: r.mitigation || "",
    })),

    tooling: {
      skills: plan.toolingDecision?.skillsToUse || [],
      subagents: plan.toolingDecision?.subagentsToUse || [],
    },

    targetPaths: plan.suggestedPaths || [],
    workspacePath,
    createdAt: new Date().toISOString(),
  };
}
