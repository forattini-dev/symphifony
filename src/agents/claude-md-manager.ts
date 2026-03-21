import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredSkill, DiscoveredAgent, DiscoveredCommand } from "./skills.ts";

const BLOCK_START = "<!-- FIFONY:START — managed by fifony, do not edit manually -->";
const BLOCK_END = "<!-- FIFONY:END -->";
const BLOCK_PATTERN = /<!-- FIFONY:START[^>]*-->[\s\S]*?<!-- FIFONY:END -->/;

function buildManagedBlock(
  skills: DiscoveredSkill[],
  agents: DiscoveredAgent[],
  commands: DiscoveredCommand[],
): string {
  const lines: string[] = [
    BLOCK_START,
    "## Fifony — Installed Capabilities",
    "",
    "This workspace has fifony-managed agents and skills installed.",
    "",
  ];

  if (commands.length > 0) {
    lines.push(`**Commands**: ${commands.map((c) => `/${c.name}`).join(", ")}`);
  }
  if (skills.length > 0) {
    lines.push(`**Skills**: ${skills.map((s) => s.name).join(", ")}`);
  }
  if (agents.length > 0) {
    lines.push(`**Agents**: ${agents.map((a) => a.name).join(", ")}`);
  }

  lines.push("");
  lines.push("Use these capabilities when working on tasks. For details:");
  lines.push("- Skills: `.claude/skills/*/SKILL.md`");
  lines.push("- Agents: `.claude/agents/*.md`");
  lines.push("- Commands: `.claude/commands/*.md`");
  lines.push(BLOCK_END);

  return lines.join("\n");
}

/**
 * Update (or create) the managed capabilities block in CLAUDE.md at `targetRoot`.
 * Idempotent — only writes if the content actually changed.
 */
export function updateClaudeMdManagedBlock(
  targetRoot: string,
  skills: DiscoveredSkill[],
  agents: DiscoveredAgent[],
  commands: DiscoveredCommand[],
): void {
  if (skills.length === 0 && agents.length === 0 && commands.length === 0) return;

  const claudeMdPath = join(targetRoot, "CLAUDE.md");
  const newBlock = buildManagedBlock(skills, agents, commands);

  let existing = "";
  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, "utf8");
  }

  let updated: string;
  if (BLOCK_PATTERN.test(existing)) {
    updated = existing.replace(BLOCK_PATTERN, newBlock);
  } else if (existing) {
    updated = `${existing.trimEnd()}\n\n${newBlock}\n`;
  } else {
    updated = `${newBlock}\n`;
  }

  // Only write if content changed
  if (updated === existing) return;

  writeFileSync(claudeMdPath, updated, "utf8");
}
