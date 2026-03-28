import type {
  AgentProviderDefinition,
  ContractNegotiationRun,
  HarnessMode,
  IssueEntry,
  IssuePlan,
  ReviewProfile,
  ReviewProfileName,
  ReviewRoutingSnapshot,
  ReviewScope,
  ReviewRun,
} from "../types.ts";
import { deriveReviewProfile } from "./review-profile.ts";

type HarnessModeStats = {
  reviewedIssues: number;
  completedReviewedIssues: number;
  gatePasses: number;
  firstPassPasses: number;
  reworkIssues: number;
  gatePassRate: number | null;
  firstPassPassRate: number | null;
  reviewReworkRate: number | null;
};

type ReviewRouteStats = {
  reviewedIssues: number;
  completedReviewedIssues: number;
  gatePasses: number;
  blockingFailRuns: number;
  advisoryFailRuns: number;
  gatePassRate: number | null;
  blockingFailRate: number | null;
};

type ContractNegotiationStats = {
  negotiatedIssues: number;
  approvedIssues: number;
  firstPassApprovals: number;
  revisedIssues: number;
  blockingConcernIssues: number;
  totalRounds: number;
  approvalRate: number | null;
  firstPassApprovalRate: number | null;
  revisionRate: number | null;
  blockingConcernRate: number | null;
  avgRoundsPerIssue: number | null;
};

type CheckpointPolicy = IssuePlan["executionContract"]["checkpointPolicy"];

type CheckpointPolicyStats = {
  reviewedIssues: number;
  completedReviewedIssues: number;
  gatePasses: number;
  firstPassPasses: number;
  reworkIssues: number;
  checkpointFailures: number;
  checkpointPasses: number;
  checkpointRuns: number;
  gatePassRate: number | null;
  firstPassPassRate: number | null;
  reviewReworkRate: number | null;
  checkpointFailureRate: number | null;
  checkpointPassRate: number | null;
  avgCheckpointRunsPerIssue: number | null;
};

export type AdaptiveHarnessModeRecommendation = {
  mode: HarnessMode;
  rationale: string;
  profile: ReviewProfile;
  basis: "historical" | "heuristic";
};

export type AdaptiveCheckpointPolicyRecommendation = {
  checkpointPolicy: CheckpointPolicy;
  rationale: string;
  profile: ReviewProfile;
  basis: "historical" | "heuristic";
};

export type AdaptiveReviewRouteRecommendation = {
  candidate: AgentProviderDefinition;
  rationale: string;
  basis: "historical" | "heuristic";
  profile: ReviewProfile;
};

const HIGH_RISK_PROFILES = new Set<ReviewProfileName>([
  "workflow-fsm",
  "integration-safety",
  "api-contract",
  "security-hardening",
]);

const HIGH_CHECKPOINT_PROFILES = new Set<ReviewProfileName>([
  "workflow-fsm",
  "integration-safety",
  "security-hardening",
]);

const ROUTE_AFFINITY: Record<ReviewProfileName, Record<string, number>> = {
  "general-quality": { claude: 2.4, codex: 1.8, gemini: 1.4 },
  "ui-polish": { claude: 3.2, codex: 1.8, gemini: 1.6 },
  "workflow-fsm": { codex: 3.1, claude: 2.0, gemini: 1.0 },
  "integration-safety": { codex: 3.0, claude: 2.0, gemini: 1.0 },
  "api-contract": { codex: 3.1, claude: 1.9, gemini: 1.2 },
  "security-hardening": { claude: 2.6, codex: 2.6, gemini: 0.8 },
};

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function isCompletedIssue(issue: IssueEntry): boolean {
  return issue.state === "Approved" || issue.state === "Merged";
}

function hadReviewRework(issue: IssueEntry): boolean {
  return (issue.previousAttemptSummaries ?? []).some((summary) => summary.phase === "review");
}

function resolveEffectiveReviewProfile(issue: IssueEntry): ReviewProfile {
  return issue.reviewProfile ?? deriveReviewProfile(issue);
}

export function serializeReviewRouteSnapshot(route: Pick<ReviewRoutingSnapshot, "provider" | "model" | "reasoningEffort" | "overlays">): string {
  const providerLabel = `${route.provider}${route.model ? `/${route.model}` : ""}`;
  const effortLabel = route.reasoningEffort ? `[${route.reasoningEffort}]` : "";
  const overlayLabel = route.overlays?.length
    ? `overlays:${[...route.overlays].sort().join(",")}`
    : "";
  return [providerLabel, effortLabel, overlayLabel].filter(Boolean).join(" | ");
}

export function buildReviewRouteKey(candidate: Pick<AgentProviderDefinition, "provider" | "model" | "reasoningEffort" | "overlays">): string {
  return serializeReviewRouteSnapshot({
    provider: candidate.provider,
    model: candidate.model,
    reasoningEffort: candidate.reasoningEffort,
    overlays: candidate.overlays ?? [],
  });
}

export function applyHarnessModeToPlan(
  plan: Pick<IssuePlan, "harnessMode" | "executionContract">,
  mode: HarnessMode,
): void {
  plan.harnessMode = mode;
  if (mode !== "contractual") {
    plan.executionContract.checkpointPolicy = "final_only";
  } else if (plan.executionContract.checkpointPolicy !== "checkpointed") {
    plan.executionContract.checkpointPolicy = "final_only";
  }
}

export function applyCheckpointPolicyToPlan(
  plan: Pick<IssuePlan, "harnessMode" | "executionContract">,
  checkpointPolicy: CheckpointPolicy,
): void {
  plan.executionContract.checkpointPolicy = plan.harnessMode === "contractual"
    ? checkpointPolicy
    : "final_only";
}

export function resolveLatestCompletedReviewRun(issue: IssueEntry, scope: "final" | "checkpoint" = "final"): ReviewRun | null {
  const reviewRuns = Array.isArray(issue.reviewRuns) ? issue.reviewRuns : [];
  const completed = reviewRuns.filter((entry) => entry.status === "completed");
  const matchingScope = completed.filter((entry) => entry.scope === scope);
  const pool = matchingScope.length > 0 ? matchingScope : completed;
  if (pool.length === 0) return null;
  return [...pool].sort((left, right) => {
    const leftAt = Date.parse(left.completedAt ?? left.startedAt);
    const rightAt = Date.parse(right.completedAt ?? right.startedAt);
    if (!Number.isNaN(leftAt) && !Number.isNaN(rightAt) && leftAt !== rightAt) return rightAt - leftAt;
    if ((left.planVersion ?? 0) !== (right.planVersion ?? 0)) return (right.planVersion ?? 0) - (left.planVersion ?? 0);
    return (right.attempt ?? 0) - (left.attempt ?? 0);
  })[0] ?? null;
}

function resolveLatestCompletedContractNegotiationRuns(issue: IssueEntry): ContractNegotiationRun[] {
  const runs = Array.isArray(issue.contractNegotiationRuns) ? issue.contractNegotiationRuns : [];
  const completed = runs.filter((entry) => entry.status === "completed");
  if (completed.length === 0) return [];

  const latestPlanVersion = completed.reduce((maxPlanVersion, entry) => Math.max(maxPlanVersion, entry.planVersion ?? 0), 0);
  return completed
    .filter((entry) => (entry.planVersion ?? 0) === latestPlanVersion)
    .sort((left, right) => {
      if ((left.attempt ?? 0) !== (right.attempt ?? 0)) return (left.attempt ?? 0) - (right.attempt ?? 0);
      const leftAt = Date.parse(left.completedAt ?? left.startedAt);
      const rightAt = Date.parse(right.completedAt ?? right.startedAt);
      if (!Number.isNaN(leftAt) && !Number.isNaN(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
      return left.id.localeCompare(right.id);
    });
}

function resolveLatestCompletedScopedReviewRuns(issue: IssueEntry, scope: ReviewScope): ReviewRun[] {
  const reviewRuns = Array.isArray(issue.reviewRuns) ? issue.reviewRuns : [];
  const completed = reviewRuns.filter((entry) => entry.status === "completed" && entry.scope === scope);
  if (completed.length === 0) return [];
  const latestPlanVersion = completed.reduce((maxPlanVersion, entry) => Math.max(maxPlanVersion, entry.planVersion ?? 0), 0);
  return completed
    .filter((entry) => (entry.planVersion ?? 0) === latestPlanVersion)
    .sort((left, right) => {
      if ((left.attempt ?? 0) !== (right.attempt ?? 0)) return (left.attempt ?? 0) - (right.attempt ?? 0);
      const leftAt = Date.parse(left.completedAt ?? left.startedAt);
      const rightAt = Date.parse(right.completedAt ?? right.startedAt);
      if (!Number.isNaN(leftAt) && !Number.isNaN(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
      return left.id.localeCompare(right.id);
    });
}

export function computeHarnessModeStats(issues: IssueEntry[], profileName: ReviewProfileName): Record<HarnessMode, HarnessModeStats> {
  const buckets: Record<HarnessMode, Omit<HarnessModeStats, "gatePassRate" | "firstPassPassRate" | "reviewReworkRate">> = {
    solo: { reviewedIssues: 0, completedReviewedIssues: 0, gatePasses: 0, firstPassPasses: 0, reworkIssues: 0 },
    standard: { reviewedIssues: 0, completedReviewedIssues: 0, gatePasses: 0, firstPassPasses: 0, reworkIssues: 0 },
    contractual: { reviewedIssues: 0, completedReviewedIssues: 0, gatePasses: 0, firstPassPasses: 0, reworkIssues: 0 },
  };

  for (const issue of issues) {
    const reviewRun = resolveLatestCompletedReviewRun(issue, "final");
    if (!reviewRun) continue;
    const effectiveProfile = reviewRun.reviewProfile ?? resolveEffectiveReviewProfile(issue);
    if (effectiveProfile.primary !== profileName) continue;
    const mode = issue.plan?.harnessMode ?? "standard";
    const bucket = buckets[mode];
    bucket.reviewedIssues += 1;
    if (isCompletedIssue(issue)) bucket.completedReviewedIssues += 1;
    if (reviewRun.blockingVerdict === "PASS") bucket.gatePasses += 1;
    if ((issue.reviewAttempt ?? 0) <= 1 && !hadReviewRework(issue) && isCompletedIssue(issue)) bucket.firstPassPasses += 1;
    if (hadReviewRework(issue)) bucket.reworkIssues += 1;
  }

  return {
    solo: {
      ...buckets.solo,
      gatePassRate: rate(buckets.solo.gatePasses, buckets.solo.reviewedIssues),
      firstPassPassRate: rate(buckets.solo.firstPassPasses, buckets.solo.completedReviewedIssues),
      reviewReworkRate: rate(buckets.solo.reworkIssues, buckets.solo.reviewedIssues),
    },
    standard: {
      ...buckets.standard,
      gatePassRate: rate(buckets.standard.gatePasses, buckets.standard.reviewedIssues),
      firstPassPassRate: rate(buckets.standard.firstPassPasses, buckets.standard.completedReviewedIssues),
      reviewReworkRate: rate(buckets.standard.reworkIssues, buckets.standard.reviewedIssues),
    },
    contractual: {
      ...buckets.contractual,
      gatePassRate: rate(buckets.contractual.gatePasses, buckets.contractual.reviewedIssues),
      firstPassPassRate: rate(buckets.contractual.firstPassPasses, buckets.contractual.completedReviewedIssues),
      reviewReworkRate: rate(buckets.contractual.reworkIssues, buckets.contractual.reviewedIssues),
    },
  };
}

export function computeCheckpointPolicyStats(
  issues: IssueEntry[],
  profileName: ReviewProfileName,
): Record<CheckpointPolicy, CheckpointPolicyStats> {
  const buckets: Record<CheckpointPolicy, Omit<CheckpointPolicyStats, "gatePassRate" | "firstPassPassRate" | "reviewReworkRate" | "checkpointFailureRate" | "checkpointPassRate" | "avgCheckpointRunsPerIssue">> = {
    final_only: {
      reviewedIssues: 0,
      completedReviewedIssues: 0,
      gatePasses: 0,
      firstPassPasses: 0,
      reworkIssues: 0,
      checkpointFailures: 0,
      checkpointPasses: 0,
      checkpointRuns: 0,
    },
    checkpointed: {
      reviewedIssues: 0,
      completedReviewedIssues: 0,
      gatePasses: 0,
      firstPassPasses: 0,
      reworkIssues: 0,
      checkpointFailures: 0,
      checkpointPasses: 0,
      checkpointRuns: 0,
    },
  };

  for (const issue of issues) {
    if ((issue.plan?.harnessMode ?? "standard") !== "contractual") continue;
    const finalReviewRun = resolveLatestCompletedReviewRun(issue, "final");
    if (!finalReviewRun) continue;

    const effectiveProfile = finalReviewRun.reviewProfile ?? resolveEffectiveReviewProfile(issue);
    if (effectiveProfile.primary !== profileName) continue;

    const checkpointPolicy = issue.plan?.executionContract?.checkpointPolicy === "checkpointed"
      ? "checkpointed"
      : "final_only";
    const bucket = buckets[checkpointPolicy];
    bucket.reviewedIssues += 1;
    if (isCompletedIssue(issue)) bucket.completedReviewedIssues += 1;
    if (finalReviewRun.blockingVerdict === "PASS") bucket.gatePasses += 1;
    if ((issue.reviewAttempt ?? 0) <= 1 && !hadReviewRework(issue) && isCompletedIssue(issue)) bucket.firstPassPasses += 1;
    if (hadReviewRework(issue)) bucket.reworkIssues += 1;

    if (checkpointPolicy === "checkpointed") {
      const checkpointRuns = resolveLatestCompletedScopedReviewRuns(issue, "checkpoint");
      bucket.checkpointRuns += checkpointRuns.length;
      if (checkpointRuns.some((entry) => entry.blockingVerdict === "FAIL")) bucket.checkpointFailures += 1;
      if (checkpointRuns.some((entry) => entry.blockingVerdict === "PASS")) bucket.checkpointPasses += 1;
    }
  }

  return {
    final_only: {
      ...buckets.final_only,
      gatePassRate: rate(buckets.final_only.gatePasses, buckets.final_only.reviewedIssues),
      firstPassPassRate: rate(buckets.final_only.firstPassPasses, buckets.final_only.completedReviewedIssues),
      reviewReworkRate: rate(buckets.final_only.reworkIssues, buckets.final_only.reviewedIssues),
      checkpointFailureRate: rate(buckets.final_only.checkpointFailures, buckets.final_only.reviewedIssues),
      checkpointPassRate: rate(buckets.final_only.checkpointPasses, buckets.final_only.reviewedIssues),
      avgCheckpointRunsPerIssue: rate(buckets.final_only.checkpointRuns, buckets.final_only.reviewedIssues),
    },
    checkpointed: {
      ...buckets.checkpointed,
      gatePassRate: rate(buckets.checkpointed.gatePasses, buckets.checkpointed.reviewedIssues),
      firstPassPassRate: rate(buckets.checkpointed.firstPassPasses, buckets.checkpointed.completedReviewedIssues),
      reviewReworkRate: rate(buckets.checkpointed.reworkIssues, buckets.checkpointed.reviewedIssues),
      checkpointFailureRate: rate(buckets.checkpointed.checkpointFailures, buckets.checkpointed.reviewedIssues),
      checkpointPassRate: rate(buckets.checkpointed.checkpointPasses, buckets.checkpointed.reviewedIssues),
      avgCheckpointRunsPerIssue: rate(buckets.checkpointed.checkpointRuns, buckets.checkpointed.reviewedIssues),
    },
  };
}

export function computeContractNegotiationStats(
  issues: IssueEntry[],
  profileName: ReviewProfileName,
): ContractNegotiationStats {
  const bucket = {
    negotiatedIssues: 0,
    approvedIssues: 0,
    firstPassApprovals: 0,
    revisedIssues: 0,
    blockingConcernIssues: 0,
    totalRounds: 0,
  };

  for (const issue of issues) {
    const planRuns = resolveLatestCompletedContractNegotiationRuns(issue);
    if (planRuns.length === 0) continue;

    const latestRun = planRuns[planRuns.length - 1]!;
    const effectiveProfile = latestRun.reviewProfile ?? resolveEffectiveReviewProfile(issue);
    if (effectiveProfile.primary !== profileName) continue;

    bucket.negotiatedIssues += 1;
    bucket.totalRounds += planRuns.length;
    if (latestRun.decisionStatus === "approved") bucket.approvedIssues += 1;
    if (planRuns.length === 1 && planRuns[0]?.decisionStatus === "approved") bucket.firstPassApprovals += 1;
    if (planRuns.some((entry) => entry.decisionStatus === "revise" || entry.appliedRefinement)) bucket.revisedIssues += 1;
    if (planRuns.some((entry) => (entry.blockingConcernsCount ?? 0) > 0)) bucket.blockingConcernIssues += 1;
  }

  return {
    ...bucket,
    approvalRate: rate(bucket.approvedIssues, bucket.negotiatedIssues),
    firstPassApprovalRate: rate(bucket.firstPassApprovals, bucket.negotiatedIssues),
    revisionRate: rate(bucket.revisedIssues, bucket.negotiatedIssues),
    blockingConcernRate: rate(bucket.blockingConcernIssues, bucket.negotiatedIssues),
    avgRoundsPerIssue: rate(bucket.totalRounds, bucket.negotiatedIssues),
  };
}

export function recommendCheckpointPolicyForIssue(
  issues: IssueEntry[],
  issue: IssueEntry,
  currentCheckpointPolicy: CheckpointPolicy,
  minSamples = 3,
): AdaptiveCheckpointPolicyRecommendation | null {
  if (issue.plan?.harnessMode !== "contractual") {
    if (currentCheckpointPolicy !== "final_only") {
      const profile = resolveEffectiveReviewProfile(issue);
      return {
        checkpointPolicy: "final_only",
        profile,
        basis: "heuristic",
        rationale: "Non-contractual plans must not request checkpoint review.",
      };
    }
    return null;
  }

  const profile = resolveEffectiveReviewProfile(issue);
  const complexity = issue.plan?.estimatedComplexity ?? "medium";
  const lowScope = complexity === "trivial" || complexity === "low";

  // Trivial/low tasks never get checkpoint review — the overhead isn't justified.
  if (lowScope) {
    if (currentCheckpointPolicy !== "final_only") {
      return {
        checkpointPolicy: "final_only",
        profile,
        basis: "heuristic",
        rationale: `Disabled checkpoint review because ${complexity} complexity does not warrant an intermediate review pass.`,
      };
    }
    return null;
  }

  const highCheckpointRisk = HIGH_CHECKPOINT_PROFILES.has(profile.primary);
  const stats = computeCheckpointPolicyStats(issues, profile.primary);
  const finalOnly = stats.final_only;
  const checkpointed = stats.checkpointed;
  const checkpointedSamplesReady = checkpointed.reviewedIssues >= minSamples;
  const finalOnlySamplesReady = finalOnly.reviewedIssues >= minSamples;

  if (currentCheckpointPolicy !== "checkpointed" && highCheckpointRisk) {
    if (checkpointedSamplesReady && (checkpointed.checkpointFailureRate ?? 0) >= 0.15) {
      return {
        checkpointPolicy: "checkpointed",
        profile,
        basis: "historical",
        rationale: `Enabled checkpoint review for ${profile.primary}: checkpointed runs caught blocking issues before final review in ${Math.round((checkpointed.checkpointFailureRate ?? 0) * 100)}% of ${checkpointed.reviewedIssues} comparable issue(s).`,
      };
    }
    if (!checkpointedSamplesReady) {
      return {
        checkpointPolicy: "checkpointed",
        profile,
        basis: "heuristic",
        rationale: `Enabled checkpoint review because ${profile.primary} changes are high-risk enough to benefit from an intermediate gate before final review.`,
      };
    }
  }

  if (checkpointedSamplesReady && finalOnlySamplesReady) {
    const gateLift = (checkpointed.gatePassRate ?? 0) - (finalOnly.gatePassRate ?? 0);
    const firstPassLift = (checkpointed.firstPassPassRate ?? 0) - (finalOnly.firstPassPassRate ?? 0);
    const checkpointCatchRate = checkpointed.checkpointFailureRate ?? 0;

    if (
      currentCheckpointPolicy !== "checkpointed"
      && (checkpointCatchRate >= 0.18 || gateLift >= 0.08 || firstPassLift >= 0.1)
    ) {
      return {
        checkpointPolicy: "checkpointed",
        profile,
        basis: "historical",
        rationale: `Enabled checkpoint review for ${profile.primary}: checkpointed runs show ${Math.round(checkpointCatchRate * 100)}% checkpoint catch rate, ${Math.round(gateLift * 100)}pp final gate lift, and ${Math.round(firstPassLift * 100)}pp first-pass lift over final-only contractual runs.`,
      };
    }

    if (
      currentCheckpointPolicy === "checkpointed"
      && !highCheckpointRisk
      && checkpointCatchRate <= 0.05
      && (finalOnly.gatePassRate ?? 0) >= ((checkpointed.gatePassRate ?? 0) - 0.05)
      && (finalOnly.firstPassPassRate ?? 0) >= ((checkpointed.firstPassPassRate ?? 0) - 0.05)
    ) {
      return {
        checkpointPolicy: "final_only",
        profile,
        basis: "historical",
        rationale: `Disabled checkpoint review for ${profile.primary}: checkpointed runs almost never catch issues before final review (${Math.round(checkpointCatchRate * 100)}%), while final-only contractual runs stay within 5pp on final gate and first-pass outcomes.`,
      };
    }
  }

  return null;
}

export function recommendHarnessModeForIssue(
  issues: IssueEntry[],
  issue: IssueEntry,
  currentMode: HarnessMode,
  minSamples = 3,
): AdaptiveHarnessModeRecommendation | null {
  const profile = resolveEffectiveReviewProfile(issue);
  const complexity = issue.plan?.estimatedComplexity ?? "medium";
  const stats = computeHarnessModeStats(issues, profile.primary);
  const negotiation = computeContractNegotiationStats(issues, profile.primary);
  const highRisk = HIGH_RISK_PROFILES.has(profile.primary);
  const lowScope = complexity === "trivial" || complexity === "low";
  const negotiationSamplesReady = negotiation.negotiatedIssues >= minSamples;
  const highRiskNegotiationPressure = negotiationSamplesReady
    && ((negotiation.blockingConcernRate ?? 0) >= 0.15 || (negotiation.revisionRate ?? 0) >= 0.3);
  const generalNegotiationPressure = negotiationSamplesReady
    && !lowScope
    && (
      (negotiation.blockingConcernRate ?? 0) >= 0.25
      || (negotiation.revisionRate ?? 0) >= 0.4
      || (negotiation.avgRoundsPerIssue ?? 0) >= 1.6
    );
  const negotiationLowValue = negotiationSamplesReady
    && (negotiation.firstPassApprovalRate ?? 0) >= 0.9
    && (negotiation.blockingConcernRate ?? 1) <= 0.08
    && (negotiation.revisionRate ?? 1) <= 0.15;

  if (highRisk && currentMode !== "contractual") {
    // Low-scope work never gets contractual — even on high-risk profiles.
    // A file path containing "auth" shouldn't trigger full contract negotiation
    // when the actual task is trivial (e.g., installing a missing dependency).
    if (lowScope) {
      if (currentMode === "solo") {
        return {
          mode: "standard",
          profile,
          basis: "heuristic",
          rationale: `Upgraded from solo to standard for ${profile.primary} (high-risk profile), but kept lightweight because complexity is ${complexity}.`,
        };
      }
      return null; // standard is fine for low-scope high-risk
    }
    if (highRiskNegotiationPressure) {
      return {
        mode: "contractual",
        profile,
        basis: "historical",
        rationale: `Switched to contractual for ${profile.primary}: contract negotiation found blocking concerns in ${Math.round((negotiation.blockingConcernRate ?? 0) * 100)}% of ${negotiation.negotiatedIssues} comparable issue(s) and forced revisions in ${Math.round((negotiation.revisionRate ?? 0) * 100)}%.`,
      };
    }
    const contractual = stats.contractual;
    if (contractual.reviewedIssues >= minSamples) {
      return {
        mode: "contractual",
        profile,
        basis: "historical",
        rationale: `Switched to contractual for ${profile.primary}: historical gate pass ${Math.round((contractual.gatePassRate ?? 0) * 100)}% across ${contractual.reviewedIssues} reviewed issue(s).`,
      };
    }
    return {
      mode: "contractual",
      profile,
      basis: "heuristic",
      rationale: `Switched to contractual because ${profile.primary} is a high-risk profile and needs stronger contract negotiation plus skeptical review semantics.`,
    };
  }

  if (profile.primary === "general-quality" && lowScope) {
    const solo = stats.solo;
    if (solo.reviewedIssues >= minSamples && (solo.gatePassRate ?? 0) >= 0.95 && (solo.reviewReworkRate ?? 1) <= 0.1) {
      if (currentMode !== "solo") {
        return {
          mode: "solo",
          profile,
          basis: "historical",
          rationale: `Downgraded to solo for low-scope general work: solo gate pass ${Math.round((solo.gatePassRate ?? 0) * 100)}% with low rework over ${solo.reviewedIssues} reviewed issue(s).`,
        };
      }
      return null;
    }
  }

  if (currentMode !== "contractual" && generalNegotiationPressure) {
    return {
      mode: "contractual",
      profile,
      basis: "historical",
      rationale: `Switched to contractual for ${profile.primary}: contract negotiation found blocking concerns in ${Math.round((negotiation.blockingConcernRate ?? 0) * 100)}% of ${negotiation.negotiatedIssues} comparable issue(s), with revisions required in ${Math.round((negotiation.revisionRate ?? 0) * 100)}% and ${Math.round((negotiation.avgRoundsPerIssue ?? 0) * 10) / 10} rounds per issue on average.`,
    };
  }

  const standard = stats.standard;
  const contractual = stats.contractual;
  const contractualSamplesReady = contractual.reviewedIssues >= minSamples;
  const standardSamplesReady = standard.reviewedIssues >= minSamples;

  if (contractualSamplesReady && standardSamplesReady) {
    const contractualGateLift = (contractual.gatePassRate ?? 0) - (standard.gatePassRate ?? 0);
    const contractualFirstPassLift = (contractual.firstPassPassRate ?? 0) - (standard.firstPassPassRate ?? 0);
    if (currentMode !== "contractual" && (contractualGateLift >= 0.12 || contractualFirstPassLift >= 0.15)) {
      return {
        mode: "contractual",
        profile,
        basis: "historical",
        rationale: `Switched to contractual for ${profile.primary}: first-pass lift ${Math.round(contractualFirstPassLift * 100)}pp and gate lift ${Math.round(contractualGateLift * 100)}pp over standard.`,
      };
    }
    if (
      currentMode === "contractual"
      && !highRisk
      && !lowScope
      && negotiationLowValue
      && (standard.gatePassRate ?? 0) >= ((contractual.gatePassRate ?? 0) - 0.05)
      && (standard.firstPassPassRate ?? 0) >= ((contractual.firstPassPassRate ?? 0) - 0.05)
    ) {
      return {
        mode: "standard",
        profile,
        basis: "historical",
        rationale: `Downgraded to standard for ${profile.primary}: contract negotiation approved on first pass in ${Math.round((negotiation.firstPassApprovalRate ?? 0) * 100)}% of ${negotiation.negotiatedIssues} comparable issue(s), and standard review performance stays within 5pp of contractual.`,
      };
    }
  }

  if (!highRisk && currentMode === "solo" && !lowScope) {
    return {
      mode: "standard",
      profile,
      basis: "heuristic",
      rationale: `Upgraded from solo to standard because ${complexity} complexity should keep an automated reviewer in the loop.`,
    };
  }

  return null;
}

export function computeReviewRouteStats(
  issues: IssueEntry[],
  profileName: ReviewProfileName,
): Record<string, ReviewRouteStats> {
  const buckets: Record<string, Omit<ReviewRouteStats, "gatePassRate" | "blockingFailRate">> = {};

  for (const issue of issues) {
    const reviewRun = resolveLatestCompletedReviewRun(issue, "final");
    if (!reviewRun) continue;
    const effectiveProfile = reviewRun.reviewProfile ?? resolveEffectiveReviewProfile(issue);
    if (effectiveProfile.primary !== profileName) continue;

    const routeKey = serializeReviewRouteSnapshot(reviewRun.routing);
    const bucket = buckets[routeKey] ||= {
      reviewedIssues: 0,
      completedReviewedIssues: 0,
      gatePasses: 0,
      blockingFailRuns: 0,
      advisoryFailRuns: 0,
    };
    bucket.reviewedIssues += 1;
    if (isCompletedIssue(issue)) bucket.completedReviewedIssues += 1;
    if (reviewRun.blockingVerdict === "PASS") bucket.gatePasses += 1;
    if (reviewRun.blockingVerdict === "FAIL") bucket.blockingFailRuns += 1;
    if ((reviewRun.advisoryFailedCriteriaCount ?? 0) > 0) bucket.advisoryFailRuns += 1;
  }

  return Object.fromEntries(
    Object.entries(buckets).map(([routeKey, bucket]) => [
      routeKey,
      {
        ...bucket,
        gatePassRate: rate(bucket.gatePasses, bucket.reviewedIssues),
        blockingFailRate: rate(bucket.blockingFailRuns, bucket.reviewedIssues),
      },
    ]),
  );
}

export function recommendReviewRouteForIssue(
  issues: IssueEntry[],
  issue: IssueEntry,
  candidates: AgentProviderDefinition[],
  minSamples = 3,
): AdaptiveReviewRouteRecommendation | null {
  if (candidates.length === 0) return null;
  const profile = resolveEffectiveReviewProfile(issue);
  const routeStats = computeReviewRouteStats(issues, profile.primary);

  const scored = candidates.map((candidate) => {
    const routeKey = buildReviewRouteKey(candidate);
    const stats = routeStats[routeKey];
    const affinity = ROUTE_AFFINITY[profile.primary][candidate.provider] ?? 0;
    const historicalScore = stats
      ? ((stats.gatePassRate ?? 0) * 4) - ((stats.blockingFailRate ?? 0) * 3) + Math.min(stats.reviewedIssues, 6) * 0.15
      : 0;
    return {
      candidate,
      routeKey,
      stats,
      score: affinity + historicalScore,
      affinity,
    };
  }).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.routeKey.localeCompare(right.routeKey);
  });

  const current = scored[0];
  if (!current) return null;

  if (current.stats && current.stats.reviewedIssues >= minSamples) {
    return {
      candidate: current.candidate,
      profile,
      basis: "historical",
      rationale: `Adaptive reviewer route for ${profile.primary}: ${current.routeKey} has ${Math.round((current.stats.gatePassRate ?? 0) * 100)}% gate pass over ${current.stats.reviewedIssues} reviewed issue(s).`,
    };
  }

  return {
    candidate: current.candidate,
    profile,
    basis: "heuristic",
    rationale: `Adaptive reviewer route for ${profile.primary}: preferred ${current.candidate.provider} based on profile affinity while historical samples are still sparse.`,
  };
}
