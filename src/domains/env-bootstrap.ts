import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { logger } from "../concerns/logger.ts";

export type BootstrapOptions = {
  timeout?: number;
  maxSize?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SIZE = 4_000;
const BUILD_MARKERS = [
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "Cargo.toml",
  "Makefile",
  "Dockerfile",
];
const PACKAGE_MANAGER_MARKERS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
];

function runInWorktree(command: string, worktreePath: string, timeoutMs: number): string | null {
  try {
    return execSync(command, {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 512_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    logger.debug({ err: String(error), command, worktreePath }, "[EnvBootstrap] command failed");
    return null;
  }
}

function truncateBlock(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 16))}[...truncated]`;
}

function formatSection(title: string, lines: string[]): string {
  if (!lines.length) return "";
  return `## ${title}\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function budgetSections(sections: Array<{ title: string; lines: string[] }>, maxSize: number): string {
  if (sections.length === 0) return "";
  const reservePerSection = Math.max(160, Math.floor(maxSize / sections.length));
  const blocks = sections
    .map(({ title, lines }) => formatSection(title, lines))
    .filter(Boolean)
    .map((block) => truncateBlock(block, reservePerSection));
  return truncateBlock(blocks.join("\n\n"), maxSize);
}

function safeTopLevelListing(worktreePath: string): string[] {
  try {
    const entries = readdirSync(worktreePath, { withFileTypes: true })
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((left, right) => left.localeCompare(right));
    if (entries.length <= 24) return entries;
    return [...entries.slice(0, 24), `... (${entries.length - 24} more entries)`];
  } catch {
    return ["Unable to read top-level workspace entries."];
  }
}

function safeDetectedFiles(worktreePath: string, names: string[]): string[] {
  return names
    .filter((name) => existsSync(join(worktreePath, name)))
    .map((name) => relative(worktreePath, join(worktreePath, name)) || name);
}

function safeEnvFileNames(worktreePath: string): string[] {
  try {
    const envFiles = readdirSync(worktreePath)
      .filter((name) => /^\.env(\..*)?$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    return envFiles.length > 0 ? envFiles : ["No .env* files detected in workspace root."];
  } catch {
    return ["Unable to inspect .env* file names."];
  }
}

function detectWorkspaceInfo(worktreePath: string): string[] {
  const packageJsonPath = join(worktreePath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return ["No root package.json detected."];
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      workspaces?: string[] | { packages?: string[] };
    };
    const lines = [];
    if (pkg.name) {
      lines.push(`package name: ${pkg.name}`);
    }
    const workspaces = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : Array.isArray(pkg.workspaces?.packages)
        ? pkg.workspaces.packages
        : [];
    if (workspaces.length > 0) {
      lines.push(`root workspaces: ${workspaces.join(", ")}`);
      lines.push(`current package path: ${worktreePath}`);
    } else {
      lines.push("No workspaces field detected in root package.json.");
    }
    return lines;
  } catch {
    return ["Unable to parse root package.json."];
  }
}

function detectToolVersions(worktreePath: string, timeoutMs: number): string[] {
  const commands: Array<[string, string]> = [
    ["node", "node --version"],
    ["pnpm", "pnpm --version"],
    ["python", "python --version"],
    ["go", "go version"],
    ["rustc", "rustc --version"],
    ["gcc", "gcc --version"],
  ];

  return commands
    .map(([label, command]) => {
      const output = runInWorktree(command, worktreePath, timeoutMs);
      if (!output) return null;
      return `${label}: ${output.split("\n")[0]!.trim()}`;
    })
    .filter((entry): entry is string => Boolean(entry));
}

export function gatherEnvironmentSnapshot(
  worktreePath: string,
  options: BootstrapOptions = {},
): string {
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const detectedBuildFiles = safeDetectedFiles(worktreePath, BUILD_MARKERS);
  const detectedPackageManagers = safeDetectedFiles(worktreePath, PACKAGE_MANAGER_MARKERS);
  const toolVersions = detectToolVersions(worktreePath, timeoutMs);

  const sections = [
    {
      title: "Working Directory",
      lines: [`cwd: ${worktreePath}`],
    },
    {
      title: "Top-level Workspace Entries",
      lines: safeTopLevelListing(worktreePath),
    },
    {
      title: "Detected Build & Config Files",
      lines: detectedBuildFiles.length > 0
        ? detectedBuildFiles
        : ["No common build/config markers detected."],
    },
    {
      title: "Language & Tool Versions",
      lines: toolVersions.length > 0
        ? toolVersions
        : ["No recognized language/tool binaries detected in PATH."],
    },
    {
      title: "Package Manager Signals",
      lines: detectedPackageManagers.length > 0
        ? detectedPackageManagers
        : ["No package manager lockfiles detected."],
    },
    {
      title: "Workspace Layout",
      lines: detectWorkspaceInfo(worktreePath),
    },
    {
      title: "Environment Files",
      lines: safeEnvFileNames(worktreePath),
    },
  ];

  return budgetSections(sections, maxSize);
}
