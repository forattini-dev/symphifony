import type { IssueEntry, AgentProviderDefinition, RuntimeConfig, IssuePlan } from "../../types.ts";
import type { CompiledExecution } from "./types.ts";

/** Normalized options passed to every provider's buildCommand. */
export type ProviderCommandOptions = {
  model?: string;
  effort?: string;
  addDirs?: string[];
  /** Images to attach (codex only) */
  imagePaths?: string[];
  /** JSON schema for structured output (claude only) */
  jsonSchema?: string;
  /** Disable tool access — for planning runs where tools break --json-schema (claude only) */
  noToolAccess?: boolean;
};

export type ProviderAdapter = {
  /** Build the CLI command string for execution/planning */
  buildCommand(options: ProviderCommandOptions): string;
  /** Build the CLI command string for review */
  buildReviewCommand(reviewer: AgentProviderDefinition): string;
  /** Compile full execution payload for the provider */
  compile(
    issue: IssueEntry,
    provider: AgentProviderDefinition,
    plan: IssuePlan,
    config: RuntimeConfig,
    workspacePath: string,
    skillContext: string,
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
