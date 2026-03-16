import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type AgentCatalogEntry = {
  name: string;
  displayName: string;
  description: string;
  emoji: string;
  domains: string[];
  source: string;
  content: string;
};

export type SkillCatalogEntry = {
  name: string;
  displayName: string;
  description: string;
  domains: string[];
  source: string;
  installType: "reference" | "bundled";
  url?: string;
  content?: string;
};

export type InstallResult = {
  installed: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
};

// ── Catalog loaders ──────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveFixturePath(filename: string): string {
  // In dev (ts source): src/runtime/ -> src/fixtures/
  // In dist (compiled): dist/ -> src/fixtures/ (via PACKAGE_ROOT)
  const candidates = [
    join(__dirname, "..", "fixtures", filename),
    join(__dirname, "../..", "src", "fixtures", filename),
    join(__dirname, "../../..", "src", "fixtures", filename),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // Fallback: return the first candidate path (will error on read)
  return candidates[0];
}

export function loadAgentCatalog(): AgentCatalogEntry[] {
  try {
    const filePath = resolveFixturePath("agent-catalog.json");
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as AgentCatalogEntry[];
  } catch (error) {
    logger.error({ err: error }, "Failed to load agent catalog");
    return [];
  }
}

export function loadSkillCatalog(): SkillCatalogEntry[] {
  try {
    const filePath = resolveFixturePath("skill-catalog.json");
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as SkillCatalogEntry[];
  } catch (error) {
    logger.error({ err: error }, "Failed to load skill catalog");
    return [];
  }
}

// ── Filter by domains ────────────────────────────────────────────────────────

export function filterByDomains<T extends { domains: string[] }>(
  catalog: T[],
  domains: string[],
): T[] {
  const domainSet = new Set(domains.map((d) => d.toLowerCase().trim()));
  if (domainSet.size === 0) return catalog;

  const scored = catalog.map((entry) => {
    const matchCount = entry.domains.filter((d) => domainSet.has(d.toLowerCase())).length;
    return { entry, matchCount };
  });

  // Include only entries that match at least one domain, sorted by match count descending
  return scored
    .filter((item) => item.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount)
    .map((item) => item.entry);
}

// ── Install agents ───────────────────────────────────────────────────────────

export function installAgents(
  targetRoot: string,
  agentNames: string[],
  catalog: AgentCatalogEntry[],
): InstallResult {
  const result: InstallResult = { installed: [], skipped: [], errors: [] };
  const catalogMap = new Map(catalog.map((entry) => [entry.name, entry]));
  const agentsDir = join(targetRoot, ".claude", "agents");

  // Ensure directory exists
  try {
    mkdirSync(agentsDir, { recursive: true });
  } catch (error) {
    logger.error({ err: error, path: agentsDir }, "Failed to create agents directory");
    result.errors.push({ name: "_directory", error: `Failed to create ${agentsDir}` });
    return result;
  }

  for (const name of agentNames) {
    const entry = catalogMap.get(name);
    if (!entry) {
      result.errors.push({ name, error: "Agent not found in catalog" });
      continue;
    }

    const filePath = join(agentsDir, `${name}.md`);
    if (existsSync(filePath)) {
      result.skipped.push(name);
      continue;
    }

    try {
      writeFileSync(filePath, entry.content, "utf8");
      result.installed.push(name);
      logger.info({ agent: name, path: filePath }, "Agent installed");
    } catch (error) {
      result.errors.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

// ── Install skills ───────────────────────────────────────────────────────────

export function installSkills(
  targetRoot: string,
  skillNames: string[],
  catalog: SkillCatalogEntry[],
): InstallResult {
  const result: InstallResult = { installed: [], skipped: [], errors: [] };
  const catalogMap = new Map(catalog.map((entry) => [entry.name, entry]));
  const skillsDir = join(targetRoot, ".claude", "skills");

  // Ensure directory exists
  try {
    mkdirSync(skillsDir, { recursive: true });
  } catch (error) {
    logger.error({ err: error, path: skillsDir }, "Failed to create skills directory");
    result.errors.push({ name: "_directory", error: `Failed to create ${skillsDir}` });
    return result;
  }

  for (const name of skillNames) {
    const entry = catalogMap.get(name);
    if (!entry) {
      result.errors.push({ name, error: "Skill not found in catalog" });
      continue;
    }

    const skillDir = join(skillsDir, name);
    const filePath = join(skillDir, "SKILL.md");
    if (existsSync(filePath)) {
      result.skipped.push(name);
      continue;
    }

    try {
      mkdirSync(skillDir, { recursive: true });

      if (entry.installType === "bundled" && entry.content) {
        writeFileSync(filePath, entry.content, "utf8");
      } else {
        // For reference skills, create a SKILL.md pointing to the external source
        const referenceContent = [
          `# ${entry.displayName}`,
          "",
          entry.description,
          "",
          `**Source**: ${entry.source}`,
          entry.url ? `**URL**: ${entry.url}` : "",
          "",
          `> This skill references an external resource. Install it from the source above.`,
        ]
          .filter(Boolean)
          .join("\n");
        writeFileSync(filePath, referenceContent, "utf8");
      }

      result.installed.push(name);
      logger.info({ skill: name, path: filePath, type: entry.installType }, "Skill installed");
    } catch (error) {
      result.errors.push({
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
