import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type DiscoveredSkill = {
  name: string;
  content: string;
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
