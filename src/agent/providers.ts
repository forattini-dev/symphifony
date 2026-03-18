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
  WorkflowDefinition,
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
            label: m.display_name || m.slug,
            tier: m.description || (m.visibility === "list" ? "Supported" : "Legacy"),
          }));
      }
    }
  } catch {
    // Cache unreadable — fall through to API
  }

  // 2. Fallback: OpenAI API filtered to gpt-5.*
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    if (!Array.isArray(data.data)) return [];

    return data.data
      .map((m) => m.id)
      .filter((id) => /^gpt-5/i.test(id))
      .filter((id) => !/(chat-latest|search-api|-\d{4}-\d{2}-\d{2}|-pro)/i.test(id))
      .sort()
      .map((id) => ({ id, provider: "codex", label: id, tier: "OpenAI model" }));
  } catch {
    return [];
  }
}

/**
 * Discover Claude models from multiple sources (no hardcoding):
 *
 * 1. Anthropic API /v1/models (if ANTHROPIC_API_KEY is set)
 * 2. Extract model IDs embedded in the Claude CLI binary via `strings`
 *    — the binary contains all supported model IDs as string literals
 * 3. Parallel CLI probe as last resort (slow but works with OAuth)
 */
async function fetchAnthropicModels(): Promise<DiscoveredModel[]> {
  // 1. Try Anthropic API (fast, authoritative — but requires API key)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        if (Array.isArray(data.data) && data.data.length > 0) {
          const models = extractClaudeModels(data.data.map((m) => m.id));
          if (models.length > 0) return models;
        }
      }
    } catch { /* fall through */ }
  }

  // 2. Extract from Claude CLI binary (fast, no network, no tokens)
  //    The compiled binary embeds model IDs as string literals.
  //    `strings <binary> | grep claude-` extracts them.
  try {
    // Resolve the real binary path (symlink → actual file)
    const binaryPath = execFileSync("readlink", ["-f", execFileSync("which", ["claude"], { encoding: "utf8", timeout: 3000 }).trim()], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();

    if (binaryPath && existsSync(binaryPath)) {
      const stringsOutput = execFileSync("strings", [binaryPath], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 50_000_000,
      });

      // Extract model IDs matching "claude-{family}-{version}" pattern
      const modelIds = new Set<string>();
      for (const line of stringsOutput.split("\n")) {
        const trimmed = line.trim();
        // Match exact model IDs: claude-{opus|sonnet|haiku}-{version}
        if (/^claude-(opus|sonnet|haiku)-\d+-\d+$/.test(trimmed)) {
          modelIds.add(trimmed);
        }
      }

      const models = extractClaudeModels([...modelIds]);
      if (models.length > 0) return models;
    }
  } catch {
    // strings not available or binary not readable — fall through
  }

  // 3. Last resort: parallel CLI probe (slow ~15s, burns minimal tokens)
  try {
    const aliases = [
      { alias: "opus", tier: "Most capable" },
      { alias: "sonnet", tier: "Balanced" },
      { alias: "haiku", tier: "Fast" },
    ];

    const probeOne = (alias: string): Promise<string | null> =>
      new Promise((resolve) => {
        try {
          const child = spawn("claude", [
            "--print", "--output-format", "json", "--model", alias,
            "--max-turns", "1", "--no-session-persistence", "reply ok",
          ], { stdio: ["pipe", "pipe", "pipe"], timeout: 20_000 });
          let stdout = "";
          child.stdout?.on("data", (chunk: Buffer) => { stdout += String(chunk); });
          child.on("close", () => {
            try {
              const parsed = JSON.parse(stdout.trim()) as { model?: string; modelUsage?: Record<string, unknown> };
              resolve(parsed.model || Object.keys(parsed.modelUsage || {})[0] || null);
            } catch { resolve(null); }
          });
          child.on("error", () => resolve(null));
          child.stdin?.end();
        } catch { resolve(null); }
      });

    const results = await Promise.all(aliases.map(async ({ alias, tier }) => {
      const modelId = await probeOne(alias);
      return modelId ? { id: modelId, provider: "claude" as const, label: modelId, tier } : null;
    }));

    const discovered = results.filter((m): m is DiscoveredModel => m !== null);
    if (discovered.length > 0) return discovered;
  } catch { /* CLI not available */ }

  return [];
}

/**
 * Filter and classify Claude model IDs into a sorted, deduplicated list.
 * Keeps only the latest version of each family (opus, sonnet, haiku).
 */
function extractClaudeModels(ids: string[]): DiscoveredModel[] {
  // Group by family, keep highest version
  const families = new Map<string, { id: string; version: number }>();

  for (const id of ids) {
    if (!id.startsWith("claude-")) continue;
    // Skip dated snapshots and @-versioned variants
    if (/@/.test(id) || /\[\d+m\]/.test(id)) continue;
    if (/\d{8}$/.test(id)) continue; // e.g. claude-opus-4-20250514

    let family = "unknown";
    if (/opus/i.test(id)) family = "opus";
    else if (/sonnet/i.test(id)) family = "sonnet";
    else if (/haiku/i.test(id)) family = "haiku";
    else continue;

    // Extract version: claude-opus-4-6 → 4.6, claude-sonnet-4 → 4.0
    const versionMatch = id.match(/(\d+)(?:-(\d+))?$/);
    const version = versionMatch
      ? parseFloat(`${versionMatch[1]}.${versionMatch[2] || "0"}`)
      : 0;

    const existing = families.get(family);
    if (!existing || version > existing.version) {
      families.set(family, { id, version });
    }
  }

  const tierMap: Record<string, string> = {
    opus: "Most capable",
    sonnet: "Balanced",
    haiku: "Fast",
  };

  // Sort: opus first (most capable), then sonnet, then haiku
  const order = ["opus", "sonnet", "haiku"];
  return order
    .filter((f) => families.has(f))
    .map((f) => {
      const { id } = families.get(f)!;
      return { id, provider: "claude", label: id, tier: tierMap[f] || "Standard" };
    });
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
  workflowDefinition: WorkflowDefinition | null,
): AgentProviderDefinition[] {
  if (workflowDefinition?.agentProviders?.length) {
    return workflowDefinition.agentProviders;
  }

  return [
    {
      provider: state.config.agentProvider,
      role: "executor",
      command: state.config.agentCommand,
      profile: workflowDefinition?.agentProfile ?? "",
      profilePath: workflowDefinition?.agentProfilePath ?? "",
      profileInstructions: workflowDefinition?.agentProfileInstructions ?? "",
    },
  ];
}

export function getCapabilityRoutingOptions(
  workflowDefinition: WorkflowDefinition | null,
): CapabilityResolverOptions {
  const routingConfig = workflowDefinition ? getNestedRecord(workflowDefinition.config, "routing") : {};
  const overridesRaw = Array.isArray(routingConfig.overrides) ? routingConfig.overrides : [];

  return {
    enabled: routingConfig.enabled === false ? false : true,
    overrides: overridesRaw
      .filter((entry): entry is JsonRecord => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
      .map((entry) => ({
        match: {
          labels: toStringArray((entry.match as JsonRecord | undefined)?.labels),
          terms: toStringArray((entry.match as JsonRecord | undefined)?.terms),
          category: toStringValue((entry.match as JsonRecord | undefined)?.category),
          paths: toStringArray((entry.match as JsonRecord | undefined)?.paths),
        },
        category: toStringValue(entry.category),
        rationale: toStringArray(entry.rationale),
        overlays: toStringArray(entry.overlays),
        providers: Array.isArray(entry.providers)
          ? (entry.providers as unknown[])
              .filter((provider): provider is JsonRecord => Boolean(provider) && typeof provider === "object" && !Array.isArray(provider))
              .map((provider) => ({
                provider: normalizeAgentProvider(toStringValue(provider.provider || provider.name || "codex")),
                role: normalizeAgentRole(toStringValue(provider.role, "executor")),
                profile: toStringValue(provider.profile),
                reason: toStringValue(provider.reason, "Workflow routing override."),
              }))
          : undefined,
      })),
  };
}

export function getCapabilityPriorityMap(
  workflowDefinition: WorkflowDefinition | null,
): Record<string, number> {
  const defaults: Record<string, number> = {
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

  const routingConfig = workflowDefinition ? getNestedRecord(workflowDefinition.config, "routing") : {};
  const customPriorities = getNestedRecord(routingConfig, "priorities");

  for (const [category, value] of Object.entries(customPriorities)) {
    if (typeof category !== "string" || !category.trim()) continue;
    defaults[category] = toNumberValue(value, defaults[category] ?? 100);
  }

  return defaults;
}

export function getIssueCapabilityPriority(
  issue: IssueEntry,
  workflowDefinition: WorkflowDefinition | null,
): number {
  const category = issue.capabilityCategory?.trim() || "default";
  const priorities = getCapabilityPriorityMap(workflowDefinition);
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
  workflowDefinition: WorkflowDefinition | null,
  workflowConfig?: WorkflowConfig | null,
): AgentProviderDefinition[] {
  const baseProviders = getBaseAgentProviders(state, workflowDefinition);
  const resolution = resolveTaskCapabilities(
    {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      labels: issue.labels,
      paths: issue.paths,
    },
    getCapabilityRoutingOptions(workflowDefinition),
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
