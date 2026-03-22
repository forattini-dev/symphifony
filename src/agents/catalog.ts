import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../concerns/logger.ts";
import { listReferenceRepositories, collectArtifacts } from "../domains/project.js";

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

export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) result[key] = value;
  }
  return result;
}

export function loadAgentCatalog(): AgentCatalogEntry[] {
  const entries: AgentCatalogEntry[] = [];
  try {
    const repos = listReferenceRepositories();
    for (const repo of repos) {
      if (!repo.present || !repo.synced) continue;
      const artifacts = collectArtifacts(repo.path, repo.id).filter((a) => a.kind === "agent");
      for (const artifact of artifacts) {
        try {
          const content = readFileSync(artifact.sourcePath, "utf8");
          const fm = parseFrontmatter(content);
          entries.push({
            name: artifact.targetName,
            displayName: fm.name || artifact.targetName,
            description: fm.description || "",
            emoji: fm.emoji || "\u{1F916}",
            domains: fm.domains ? fm.domains.split(",").map((d) => d.trim()).filter(Boolean) : [],
            source: repo.id,
            content,
          });
        } catch (err) {
          logger.warn({ err, path: artifact.sourcePath }, "Failed to read agent file");
        }
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to load agent catalog from repositories");
  }
  return entries;
}

export function loadSkillCatalog(): SkillCatalogEntry[] {
  return [];
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
