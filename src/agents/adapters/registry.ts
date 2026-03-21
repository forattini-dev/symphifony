import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../../types.ts";
import type { CompiledExecution } from "./types.ts";

/** Normalized options passed to every provider's buildCommand. */
export type ProviderCommandOptions = {
  model?: string;
  effort?: string;
  addDirs?: string[];
  /** Images to attach — passed via CLI flag (codex --image) or embedded in prompt (claude/gemini) */
  imagePaths?: string[];
  /** JSON schema for structured output (claude --json-schema) */
  jsonSchema?: string;
  /** Disable tool access — for planning runs where tools break --json-schema (claude only) */
  noToolAccess?: boolean;
  /** Maximum dollar budget for the run (claude --max-budget-usd) */
  maxBudgetUsd?: number;
  /** Read-only mode — disables file edits (claude --permission-mode plan, gemini --approval-mode plan) */
  readOnly?: boolean;
  /** Enable web search (codex --search) */
  search?: boolean;
};

export type ProviderAdapter = {
  /** Build the CLI command string for execution/planning */
  buildCommand(options: ProviderCommandOptions): string;
  /** Build the CLI command string for review */
  buildReviewCommand(reviewer: AgentProviderDefinition, config?: RuntimeConfig): string;
  /** Compile full execution payload for the provider */
  compile(
    issue: IssueEntry,
    provider: AgentProviderDefinition,
    plan: IssuePlan,
    config: RuntimeConfig,
    workspacePath: string,
    skillContext: string,
    capabilitiesManifest?: string,
  ): Promise<CompiledExecution>;
};

import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { geminiAdapter } from "./gemini.ts";

export const ADAPTERS: Record<string, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
};
