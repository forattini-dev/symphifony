import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AgentProviderDefinition,
  AgentProviderRole,
  DetectedProvider,
  EffortConfig,
  IssueEntry,
  JsonRecord,
  PipelineStageConfig,
  ReasoningEffort,
  RuntimeState,
  WorkflowConfig,
} from "./types.ts";
import { TARGET_ROOT } from "./constants.ts";
import {
  toStringValue,
  toStringArray,
  toNumberValue,
  getNestedRecord,
  getNestedString,
} from "./helpers.ts";
import { logger } from "./logger.ts";
import {
  resolveTaskCapabilities,
  mergeCapabilityProviders,
  type CapabilityResolverOptions,
} from "../routing/capability-resolver.ts";

export function resolveAgentProfile(name: string): { profilePath: string; instructions: string } {
  const normalized = name.trim();
  if (!normalized) return { profilePath: "", instructions: "" };

  const candidates = [
    join(TARGET_ROOT, ".codex", "agents", `${normalized}.md`),
    join(TARGET_ROOT, ".codex", "agents", normalized, "AGENT.md"),
    join(TARGET_ROOT, "agents", `${normalized}.md`),
    join(TARGET_ROOT, "agents", normalized, "AGENT.md"),
    join(homedir(), ".codex", "agents", `${normalized}.md`),
    join(homedir(), ".codex", "agents", normalized, "AGENT.md"),
    join(homedir(), ".claude", "agents", `${normalized}.md`),
    join(homedir(), ".claude", "agents", normalized, "AGENT.md"),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return {
      profilePath: candidate,
      instructions: readFileSync(candidate, "utf8").trim(),
    };
  }

  return { profilePath: "", instructions: "" };
}

export function normalizeAgentProvider(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "claude" || normalized === "codex") return normalized;
  if (!normalized) return "codex";
  return normalized;
}

export function normalizeAgentRole(value: string): AgentProviderRole {
  const normalized = value.trim().toLowerCase();
  if (normalized === "planner" || normalized === "executor" || normalized === "reviewer") {
    return normalized;
  }
  return "executor";
}

export function resolveAgentCommand(
  provider: string,
  explicitCommand: string,
  codexCommand: string,
  claudeCommand: string,
  reasoningEffort?: string,
): string {
  if (explicitCommand.trim()) return explicitCommand.trim();
  if (provider === "claude" && claudeCommand.trim()) return claudeCommand.trim();
  if (provider === "codex" && codexCommand.trim()) return codexCommand.trim();
  return getProviderDefaultCommand(provider, reasoningEffort);
}

/** Resolve the effective reasoning effort for a given role, considering issue override and global defaults. */
export function resolveEffort(
  role: string,
  issueEffort?: EffortConfig,
  globalEffort?: EffortConfig,
): ReasoningEffort | undefined {
  // Issue-level per-role override takes highest priority
  const roleKey = role as keyof EffortConfig;
  if (issueEffort?.[roleKey]) return issueEffort[roleKey];
  // Issue-level default
  if (issueEffort?.default) return issueEffort.default;
  // Global per-role
  if (globalEffort?.[roleKey]) return globalEffort[roleKey];
  // Global default
  return globalEffort?.default;
}

import { buildClaudeCommand, buildCodexCommand, CLAUDE_RESULT_SCHEMA } from "./adapters/commands.ts";

export function getProviderDefaultCommand(provider: string, reasoningEffort?: string, model?: string): string {
  if (provider === "codex") return buildCodexCommand({ model, reasoningEffort });
  if (provider === "claude") return buildClaudeCommand({ model, jsonSchema: CLAUDE_RESULT_SCHEMA });
  return "";
}

let cachedProviders: DetectedProvider[] | null = null;
let providersCachedAt = 0;
const PROVIDER_CACHE_TTL = 60_000;

export function detectAvailableProviders(): DetectedProvider[] {
  if (cachedProviders && Date.now() - providersCachedAt < PROVIDER_CACHE_TTL) {
    return cachedProviders;
  }

  const providers: DetectedProvider[] = [];

  for (const name of ["claude", "codex"]) {
    try {
      const path = execFileSync("which", [name], { encoding: "utf8", timeout: 5000 }).trim();
      providers.push({ name, available: true, path });
    } catch {
      providers.push({ name, available: false, path: "" });
    }
  }

  cachedProviders = providers;
  providersCachedAt = Date.now();
  return providers;
}

export function invalidateProviderCache(): void {
  cachedProviders = null;
  providersCachedAt = 0;
}

// ── Model discovery ─────────────────────────────────────────────────────────

export type DiscoveredModel = {
  id: string;
  provider: string;
  label: string;
  tier: string;
};

/** Cache: { models, fetchedAt } per provider */
const modelCache = new Map<string, { models: DiscoveredModel[]; fetchedAt: number }>();
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch models from the OpenAI /v1/models API.
 * Filters to models relevant for Codex CLI usage (chat/reasoning models).
 */
/**
 * Read Codex CLI's own model list from ~/.codex/models_cache.json.
 *
 * The Codex CLI fetches and caches its supported models locally.
 * This is the authoritative source — same data the /model picker uses.
 * We read it directly: zero hardcoding, always up-to-date with the CLI version.
 *
 * Falls back to OpenAI /v1/models API (filtered to gpt-5.*) if cache doesn't exist.
 */
/**
 * Read the user's configured default model from ~/.codex/config.toml.
 * Returns the model string (e.g. "gpt-5.4") and reasoning effort if present.
 */
export function readCodexConfig(): { model?: string; reasoningEffort?: string } {
  try {
    const configPath = join(homedir(), ".codex", "config.toml");
    if (!existsSync(configPath)) return {};
    const raw = readFileSync(configPath, "utf8");
    const model = raw.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    const reasoningEffort = raw.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
    return { model, reasoningEffort };
  } catch {
    return {};
  }
}

/**
 * Read the user's configured default model from ~/.claude/settings.json.
 * Returns the model alias/ID (e.g. "sonnet", "opus").
 */
function readClaudeConfig(): { model?: string } {
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (!existsSync(settingsPath)) return {};
    const raw = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(raw) as { model?: string };
    return { model: typeof settings.model === "string" ? settings.model : undefined };
  } catch {
    return {};
  }
}

async function fetchCodexModels(): Promise<DiscoveredModel[]> {
  // 1. Try ~/.codex/models_cache.json (authoritative — from the CLI itself)
  const cachePath = join(homedir(), ".codex", "models_cache.json");
  try {
    if (existsSync(cachePath)) {
      const raw = readFileSync(cachePath, "utf8");
      const cache = JSON.parse(raw) as {
        models?: Array<{
          slug: string;
          display_name?: string;
          description?: string;
          visibility?: string;
          priority?: number;
          supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
        }>;
      };

      if (Array.isArray(cache.models) && cache.models.length > 0) {
        return cache.models
          // Show "list" models first, then "hide" (legacy) — sorted by CLI priority
          .sort((a, b) => {
            const visA = a.visibility === "list" ? 0 : 1;
            const visB = b.visibility === "list" ? 0 : 1;
            if (visA !== visB) return visA - visB;
            return (a.priority ?? 99) - (b.priority ?? 99);
          })
          .map((m) => ({
            id: m.slug,
            provider: "codex",
            label: m.slug,
            tier: m.description || (m.visibility === "list" ? "Supported" : "Legacy"),
          }));
      }
    }
  } catch {
    // Cache unreadable
  }

  return [];
}

/**
 * Discover Claude models from the CLI.
 *
 * Strategy: use the stable aliases that the Claude CLI maintains itself
 * (opus → latest opus, sonnet → latest sonnet, haiku → latest haiku).
 *
 * Why aliases instead of version-pinned IDs extracted from the binary:
 * - Aliases always point to the current production model — no stale IDs
 * - No `strings` parsing, no binary inspection, no network calls
 * - When Anthropic releases a new version, the alias updates automatically
 *
 * The actual resolved model ID (e.g. claude-sonnet-4-6) is captured from
 * the `modelUsage` field in the CLI JSON response after each run.
 */
async function fetchAnthropicModels(): Promise<DiscoveredModel[]> {
  // Verify the CLI is reachable before returning anything
  try {
    execFileSync("which", ["claude"], { encoding: "utf8", timeout: 3000 });
  } catch {
    return [];
  }

  // These aliases are maintained by Anthropic in the Claude CLI itself.
  // They always resolve to the current production model for each family.
  return [
    { id: "opus",   provider: "claude", label: "claude/opus (latest)",   tier: "Most capable" },
    { id: "sonnet", provider: "claude", label: "claude/sonnet (latest)",  tier: "Balanced" },
    { id: "haiku",  provider: "claude", label: "claude/haiku (latest)",   tier: "Fast" },
  ];
}


/**
 * Discover available models for all detected providers.
 * Results are cached for 5 minutes.
 */
export async function discoverModels(providers: DetectedProvider[]): Promise<Record<string, DiscoveredModel[]>> {
  const result: Record<string, DiscoveredModel[]> = {};

  const tasks: Array<{ name: string; fetch: () => Promise<DiscoveredModel[]> }> = [];

  for (const p of providers) {
    if (!p.available) continue;
    const cached = modelCache.get(p.name);
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
      result[p.name] = cached.models;
      continue;
    }
    if (p.name === "codex") tasks.push({ name: "codex", fetch: fetchCodexModels });
    if (p.name === "claude") tasks.push({ name: "claude", fetch: fetchAnthropicModels });
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.fetch()));
  for (let i = 0; i < tasks.length; i++) {
    const res = settled[i];
    let models = res.status === "fulfilled" ? res.value : [];

    // Promote the user's configured CLI default model to the top of the list
    if (tasks[i].name === "codex") {
      const { model: configuredModel } = readCodexConfig();
      if (configuredModel) {
        const idx = models.findIndex((m) => m.id === configuredModel);
        if (idx > 0) {
          // Move to front
          models = [models[idx], ...models.slice(0, idx), ...models.slice(idx + 1)];
        } else if (idx === -1) {
          // Not in list yet — add it
          models = [{ id: configuredModel, provider: "codex", label: configuredModel, tier: "Configured default" }, ...models];
        }
      }
    }

    if (tasks[i].name === "claude") {
      const { model: configuredModel } = readClaudeConfig();
      if (configuredModel) {
        // Claude config uses aliases ("sonnet", "opus") — find matching model by id/prefix
        const idx = models.findIndex((m) => m.id === configuredModel || m.id.includes(configuredModel));
        if (idx > 0) {
          models = [models[idx], ...models.slice(0, idx), ...models.slice(idx + 1)];
        }
      }
    }

    result[tasks[i].name] = models;
    modelCache.set(tasks[i].name, { models, fetchedAt: Date.now() });
  }

  return result;
}

export function resolveDefaultProvider(detected: DetectedProvider[]): string {
  const available = detected.filter((p) => p.available);
  if (available.length === 0) return "";
  if (available.some((p) => p.name === "codex")) return "codex";
  return available[0].name;
}

export function resolveWorkflowAgentProviders(
  config: JsonRecord,
  fallbackProvider: string,
  fallbackProfile: string,
  explicitCommand: string,
): AgentProviderDefinition[] {
  const agentConfig = getNestedRecord(config, "agent");
  const codexConfig = getNestedRecord(config, "codex");
  const claudeConfig = getNestedRecord(config, "claude");
  const providersRaw = (agentConfig.providers ?? []) as unknown;
  const providers: AgentProviderDefinition[] = [];

  if (Array.isArray(providersRaw)) {
    for (const entry of providersRaw) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as JsonRecord;
      const provider = normalizeAgentProvider(
        toStringValue(record.provider) || toStringValue(record.name) || fallbackProvider,
      );
      const role = normalizeAgentRole(toStringValue(record.role, "executor"));
      const profile = toStringValue(record.profile, role === "executor" ? fallbackProfile : "");
      const resolvedProfile = resolveAgentProfile(profile);
      const command = resolveAgentCommand(
        provider,
        toStringValue(record.command),
        getNestedString(codexConfig, "command"),
        getNestedString(claudeConfig, "command"),
      );

      providers.push({
        provider,
        role,
        command,
        profile,
        profilePath: resolvedProfile.profilePath,
        profileInstructions: resolvedProfile.instructions,
      });
    }
  }

  if (providers.length > 0) return providers;

  const resolvedProfile = resolveAgentProfile(fallbackProfile);
  return [
    {
      provider: fallbackProvider,
      role: "executor",
      command: resolveAgentCommand(
        fallbackProvider,
        explicitCommand,
        getNestedString(codexConfig, "command"),
        getNestedString(claudeConfig, "command"),
      ),
      profile: fallbackProfile,
      profilePath: resolvedProfile.profilePath,
      profileInstructions: resolvedProfile.instructions,
    },
  ];
}

export function getBaseAgentProviders(
  state: RuntimeState,
): AgentProviderDefinition[] {
  return [
    {
      provider: state.config.agentProvider,
      role: "executor",
      command: state.config.agentCommand,
      profile: "",
      profilePath: "",
      profileInstructions: "",
    },
  ];
}

export function getCapabilityRoutingOptions(): CapabilityResolverOptions {
  // Provider/model/effort overrides from user settings are applied via
  // applyWorkflowConfigToProviders after capability classification.
  return { enabled: true, overrides: [] };
}

export function getCapabilityPriorityMap(): Record<string, number> {
  return {
    security: 0,
    bugfix: 1,
    backend: 2,
    devops: 3,
    "frontend-ui": 4,
    architecture: 5,
    documentation: 6,
    default: 7,
    "workflow-disabled": 8,
  };
}

export function getIssueCapabilityPriority(
  issue: IssueEntry,
  _workflowDefinition: null,
): number {
  const category = issue.capabilityCategory?.trim() || "default";
  const priorities = getCapabilityPriorityMap();
  return priorities[category] ?? 100;
}

export function applyCapabilityMetadata(
  issue: IssueEntry,
  resolution: ReturnType<typeof resolveTaskCapabilities>,
): void {
  issue.capabilityCategory = resolution.category;
  issue.capabilityOverlays = [...resolution.overlays];
  issue.capabilityRationale = [...resolution.rationale];

  const baseLabels = (issue.labels ?? []).filter((label) => !label.startsWith("capability:") && !label.startsWith("overlay:"));
  const derivedLabels = [
    resolution.category ? `capability:${resolution.category}` : "",
    ...resolution.overlays.map((overlay) => `overlay:${overlay}`),
  ].filter(Boolean);

  issue.labels = [...new Set([...baseLabels, ...derivedLabels])];
}

/** Map AgentProviderRole to WorkflowConfig stage key */
function roleToStageKey(role: AgentProviderRole): keyof WorkflowConfig {
  switch (role) {
    case "planner": return "plan";
    case "executor": return "execute";
    case "reviewer": return "review";
  }
}

/**
 * Apply user's WorkflowConfig (from Settings → Workflow) to provider definitions.
 * Overrides provider, model, and effort for each role when a WorkflowConfig is present.
 */
export function applyWorkflowConfigToProviders(
  providers: AgentProviderDefinition[],
  workflowConfig: WorkflowConfig | null,
): AgentProviderDefinition[] {
  if (!workflowConfig) return providers;

  return providers.map((provider) => {
    const stageKey = roleToStageKey(provider.role);
    const stageConfig: PipelineStageConfig | undefined = workflowConfig[stageKey];
    if (!stageConfig) return provider;

    const newProvider = stageConfig.provider || provider.provider;
    const newModel = stageConfig.model || undefined;
    const newEffort = stageConfig.effort || provider.reasoningEffort;

    // Rebuild command with the configured provider, model, and effort
    const command = getProviderDefaultCommand(newProvider, newEffort, newModel);

    return {
      ...provider,
      provider: newProvider,
      model: newModel,
      command: command || provider.command,
      reasoningEffort: newEffort,
    };
  });
}

export function getEffectiveAgentProviders(
  state: RuntimeState,
  issue: IssueEntry,
  _workflowDefinition: null,
  workflowConfig?: WorkflowConfig | null,
): AgentProviderDefinition[] {
  const baseProviders = getBaseAgentProviders(state);
  const resolution = resolveTaskCapabilities(
    {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      labels: issue.labels,
      paths: issue.paths,
    },
    getCapabilityRoutingOptions(),
  );
  applyCapabilityMetadata(issue, resolution);

  const merged = mergeCapabilityProviders(baseProviders, resolution).map((provider) => {
    const resolvedProfile = resolveAgentProfile(provider.profile ?? "");
    const suggestion = resolution.providers.find(
      (entry) => entry.provider === provider.provider && entry.role === provider.role,
    );

    const effort = resolveEffort(provider.role, issue.effort, state.config.defaultEffort);

    // Keep existing command (effort is metadata, not a CLI flag)
    const command = provider.command;

    return {
      ...provider,
      command,
      profilePath: resolvedProfile.profilePath,
      profileInstructions: resolvedProfile.instructions,
      selectionReason: suggestion?.reason ?? resolution.rationale.join(" "),
      overlays: resolution.overlays,
      capabilityCategory: resolution.category,
      reasoningEffort: effort,
    };
  });

  // Apply user's WorkflowConfig overrides (Settings → Workflow)
  return applyWorkflowConfigToProviders(merged, workflowConfig ?? null);
}
