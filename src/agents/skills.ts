import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type DiscoveredSkill = {
  name: string;
  content: string;
};

export type DiscoveredAgent = {
  name: string;
  description: string;
};

export type DiscoveredCommand = {
  name: string;
  description: string;
};

export function discoverSkills(workspacePath: string): DiscoveredSkill[] {
  const home = homedir();
  const codePath = existsSync(join(workspacePath, "worktree")) ? join(workspacePath, "worktree") : workspacePath;
  const searchPaths = [
    resolve(codePath, ".codex", "skills"),
    resolve(codePath, ".claude", "skills"),
    join(home, ".codex", "skills"),
    join(home, ".claude", "skills"),
  ];

  const seen = new Set<string>();
  const skills: DiscoveredSkill[] = [];

  for (const basePath of searchPaths) {
    if (!existsSync(basePath)) continue;

    for (const entry of readdirSync(basePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;

      const skillFile = join(basePath, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;

      try {
        const content = readFileSync(skillFile, "utf8").trim();
        if (content) {
          seen.add(entry.name);
          skills.push({ name: entry.name, content });
        }
      } catch {
        // skip unreadable skills
      }
    }
  }

  return skills;
}

export function buildSkillContext(skills: DiscoveredSkill[]): string {
  if (skills.length === 0) return "";

  const sections = skills.map((skill) =>
    `### Skill: ${skill.name}\n${skill.content}`
  );

  return `## Available Skills\n\n${sections.join("\n\n")}`;
}

/** Extract the first non-empty line from markdown content as a description. */
function extractFirstLine(content: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.replace(/^#+\s*/, "").trim();
    if (trimmed && !trimmed.startsWith("---")) return trimmed;
  }
  return "";
}

/** Discover agent definitions from .claude/agents/ and .codex/agents/ directories. */
export function discoverAgents(workspacePath: string): DiscoveredAgent[] {
  const home = homedir();
  const codePath = existsSync(join(workspacePath, "worktree")) ? join(workspacePath, "worktree") : workspacePath;
  const searchPaths = [
    resolve(codePath, ".claude", "agents"),
    resolve(codePath, ".codex", "agents"),
    join(home, ".claude", "agents"),
    join(home, ".codex", "agents"),
  ];

  const seen = new Set<string>();
  const agents: DiscoveredAgent[] = [];

  for (const basePath of searchPaths) {
    if (!existsSync(basePath)) continue;

    for (const entry of readdirSync(basePath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.replace(/\.md$/, "");
      if (seen.has(name)) continue;

      try {
        const content = readFileSync(join(basePath, entry.name), "utf8").trim();
        if (content) {
          seen.add(name);
          agents.push({ name, description: extractFirstLine(content) });
        }
      } catch {
        // skip unreadable
      }
    }
  }

  return agents;
}

/** Discover slash commands from .claude/commands/ and .codex/commands/ directories. */
export function discoverCommands(workspacePath: string): DiscoveredCommand[] {
  const home = homedir();
  const codePath = existsSync(join(workspacePath, "worktree")) ? join(workspacePath, "worktree") : workspacePath;
  const searchPaths = [
    resolve(codePath, ".claude", "commands"),
    resolve(codePath, ".codex", "commands"),
    join(home, ".claude", "commands"),
    join(home, ".codex", "commands"),
  ];

  const seen = new Set<string>();
  const commands: DiscoveredCommand[] = [];

  for (const basePath of searchPaths) {
    if (!existsSync(basePath)) continue;

    for (const entry of readdirSync(basePath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.replace(/\.md$/, "");
      if (seen.has(name)) continue;

      try {
        const content = readFileSync(join(basePath, entry.name), "utf8").trim();
        if (content) {
          seen.add(name);
          commands.push({ name, description: extractFirstLine(content) });
        }
      } catch {
        // skip unreadable
      }
    }
  }

  return commands;
}

const MAX_CAPABILITIES_ITEMS = 40;

/** Build a concise markdown manifest of all discovered capabilities. */
export function buildCapabilitiesManifest(
  skills: DiscoveredSkill[],
  agents: DiscoveredAgent[],
  commands: DiscoveredCommand[],
): string {
  if (skills.length === 0 && agents.length === 0 && commands.length === 0) return "";

  const sections: string[] = ["## Your Capabilities"];
  let itemCount = 0;

  if (commands.length > 0) {
    sections.push("");
    sections.push("### Slash Commands");
    sections.push("You have these commands available. Invoke with `/command-name`:");
    const show = commands.slice(0, MAX_CAPABILITIES_ITEMS);
    for (const cmd of show) {
      sections.push(`- \`/${cmd.name}\`${cmd.description ? ` — ${cmd.description}` : ""}`);
      itemCount++;
    }
    if (commands.length > show.length) {
      sections.push(`- ...and ${commands.length - show.length} more available`);
    }
  }

  if (skills.length > 0) {
    const remaining = Math.max(5, MAX_CAPABILITIES_ITEMS - itemCount);
    sections.push("");
    sections.push("### Skills");
    sections.push("Specialized procedures available for this workspace:");
    const show = skills.slice(0, remaining);
    for (const skill of show) {
      sections.push(`- **${skill.name}**`);
      itemCount++;
    }
    if (skills.length > show.length) {
      sections.push(`- ...and ${skills.length - show.length} more available`);
    }
  }

  if (agents.length > 0) {
    const remaining = Math.max(5, MAX_CAPABILITIES_ITEMS - itemCount);
    sections.push("");
    sections.push("### Subagents");
    sections.push("You can delegate to these specialist agents via the Agent tool:");
    const show = agents.slice(0, remaining);
    for (const agent of show) {
      sections.push(`- **${agent.name}**${agent.description ? ` — ${agent.description}` : ""}`);
    }
    if (agents.length > show.length) {
      sections.push(`- ...and ${agents.length - show.length} more available`);
    }
  }

  sections.push("");
  sections.push("When a task matches a capability above, USE IT instead of doing everything manually.");

  return sections.join("\n");
}
