import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type FifonyIntegration = {
  id: "agency-agents" | "impeccable";
  kind: "agents" | "skills";
  installed: boolean;
  locations: string[];
  items: string[];
  summary: string;
};

function listNames(basePath: string): string[] {
  if (!existsSync(basePath)) {
    return [];
  }

  return readdirSync(basePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function readSkillSummary(skillPath: string): string {
  try {
    const skillFile = join(skillPath, "SKILL.md");
    if (!existsSync(skillFile)) {
      return "";
    }
    const contents = readFileSync(skillFile, "utf8");
    const firstParagraph = contents
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => !line.startsWith("#"));
    return firstParagraph ?? "";
  } catch {
    return "";
  }
}

export function discoverIntegrations(workspaceRoot: string): FifonyIntegration[] {
  const home = homedir();
  const agentLocations = [
    resolve(workspaceRoot, ".codex", "agents"),
    resolve(workspaceRoot, "agents"),
    join(home, ".codex", "agents"),
    join(home, ".claude", "agents"),
  ];
  const skillLocations = [
    resolve(workspaceRoot, ".codex", "skills"),
    resolve(workspaceRoot, ".claude", "skills"),
    join(home, ".codex", "skills"),
    join(home, ".claude", "skills"),
  ];

  const agencyItems = agentLocations
    .flatMap((location) => listNames(location).map((name) => ({ location, name })))
    .filter(({ name }) => name.startsWith("agency-"))
    .map(({ location, name }) => `${name} @ ${location}`);

  const impeccableItems = skillLocations
    .flatMap((location) => listNames(location).map((name) => ({ location, name })))
    .filter(({ name }) =>
      name === "teach-impeccable"
      || name === "frontend-design"
      || name === "polish"
      || name === "audit"
      || name === "critique"
      || name.includes("impeccable")
    )
    .map(({ location, name }) => {
      const summary = readSkillSummary(join(location, name));
      return summary ? `${name} @ ${location} — ${summary}` : `${name} @ ${location}`;
    });

  return [
    {
      id: "agency-agents",
      kind: "agents",
      installed: agencyItems.length > 0,
      locations: agentLocations.filter((location) => existsSync(location)),
      items: agencyItems,
      summary: agencyItems.length > 0
        ? "Local specialized agent profiles are available for planner/executor/reviewer roles."
        : "No agency agent profiles were detected in the standard local locations.",
    },
    {
      id: "impeccable",
      kind: "skills",
      installed: impeccableItems.length > 0,
      locations: skillLocations.filter((location) => existsSync(location)),
      items: impeccableItems,
      summary: impeccableItems.length > 0
        ? "Frontend and design-oriented skills are available for review and polish workflows."
        : "No impeccable-related skills were detected in the standard local skill directories.",
    },
  ];
}

export function buildIntegrationSnippet(integrationId: string, workspaceRoot: string): string {
  if (integrationId === "agency-agents") {
    return [
      "---",
      "agent:",
      "  providers:",
      "    - provider: claude",
      "      role: planner",
      "      profile: agency-senior-project-manager",
      "    - provider: codex",
      "      role: executor",
      "      profile: agency-senior-developer",
      "    - provider: claude",
      "      role: reviewer",
      "      profile: agency-code-reviewer",
      "codex:",
      '  command: "codex"',
      "claude:",
      '  command: "claude"',
      "---",
      "",
      "Use local agency agent profiles discovered from workspace or home directories.",
      `Workspace: ${workspaceRoot}`,
    ].join("\n");
  }

  if (integrationId === "impeccable") {
    return [
      "# Impeccable integration idea",
      "",
      "Use impeccable-oriented skills as a frontend review layer around Fifony issues.",
      "",
      "Suggested pattern:",
      "",
      "1. Use `agency-senior-developer` or `codex` as executor.",
      "2. Route UI-heavy issues to a reviewer prompt that explicitly asks for impeccable-style critique.",
      "3. Expose the resulting review through the Fifony MCP prompts or as a follow-up review issue.",
      "",
      "Suggested labels:",
      "- frontend",
      "- ui",
      "- design-system",
      "",
      "Suggested reviewer prompt seed:",
      "\"Review this implementation using impeccable standards for frontend quality, polish, hierarchy, spacing, responsiveness, and interaction clarity.\"",
    ].join("\n");
  }

  return "Unknown integration.";
}
