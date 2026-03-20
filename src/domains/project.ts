import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative as relativePath, resolve } from "node:path";
import { env } from "node:process";

import { appendFileTail } from "../concerns/helpers.ts";
import { logger } from "../concerns/logger.ts";
import { detectAvailableProviders } from "../agents/providers.ts";
import { renderPrompt } from "../agents/prompting.ts";
import { getSettingStateResource } from "../persistence/store.ts";
import type { ProjectNameSource, RuntimeSettingRecord } from "../types.ts";

// ── Project metadata ─────────────────────────────────────────────────────────

export const SETTING_ID_PROJECT_NAME = "system.projectName";
export const LEGACY_PROJECT_SETTING_IDS = [
  "runtime.projectName",
  "ui.projectName",
  "projectName",
  "project.name",
];

export type ProjectMetadata = {
  projectName: string;
  detectedProjectName: string;
  projectNameSource: ProjectNameSource;
  queueTitle: string;
};

export function normalizeProjectName(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/\s+/g, " ")
    : "";
}

export function detectProjectName(targetRoot: string): string {
  const normalizedPath = typeof targetRoot === "string"
    ? targetRoot.trim().replace(/[\\/]+$/, "")
    : "";
  if (!normalizedPath) return "";
  return normalizeProjectName(basename(normalizedPath));
}

export function readSavedProjectName(settings: RuntimeSettingRecord[]): string {
  const settingIds = [SETTING_ID_PROJECT_NAME, ...LEGACY_PROJECT_SETTING_IDS];

  for (const id of settingIds) {
    const value = normalizeProjectName(settings.find((setting) => setting.id === id)?.value);
    if (value) {
      return value;
    }
  }

  return "";
}

export function buildQueueTitle(projectName: string): string {
  const normalizedProjectName = normalizeProjectName(projectName);
  return normalizedProjectName ? `fifony: ${normalizedProjectName}` : "fifony";
}

export function resolveProjectMetadata(
  settings: RuntimeSettingRecord[],
  targetRoot: string,
): ProjectMetadata {
  const savedProjectName = readSavedProjectName(settings);
  const detectedProjectName = detectProjectName(targetRoot);
  const projectName = savedProjectName || detectedProjectName;

  return {
    projectName,
    detectedProjectName,
    projectNameSource: savedProjectName ? "saved" : detectedProjectName ? "detected" : "missing",
    queueTitle: buildQueueTitle(projectName),
  };
}

// ── Project scanner ──────────────────────────────────────────────────────────

export type ProjectScanResult = {
  root: string;
  files: {
    claudeMd: boolean;
    claudeDir: boolean;
    codexDir: boolean;
    readmeMd: boolean;
    packageJson: boolean;
    agentsMd: boolean;
    claudeAgentsDir: boolean;
    claudeSkillsDir: boolean;
    codexAgentsDir: boolean;
    codexSkillsDir: boolean;
  };
  existingAgents: string[];
  existingSkills: string[];
  readmeExcerpt: string;
  packageName: string;
  packageDescription: string;
};

export type ProjectAnalysis = {
  description: string;
  language: string;
  domains: string[];
  stack: string[];
  suggestedAgents: string[];
  source: "cli" | "fallback";
};

// ── Filesystem scan (no CLI needed) ──────────────────────────────────────────

export function scanProjectFiles(targetRoot: string): ProjectScanResult {
  const check = (rel: string) => existsSync(join(targetRoot, rel));

  const files = {
    claudeMd: check("CLAUDE.md"),
    claudeDir: check(".claude"),
    codexDir: check(".codex"),
    readmeMd: check("README.md"),
    packageJson: check("package.json"),
    cargoToml: check("Cargo.toml"),
    pyprojectToml: check("pyproject.toml"),
    goMod: check("go.mod"),
    buildGradle: check("build.gradle") || check("build.gradle.kts"),
    gemfile: check("Gemfile"),
    dockerfile: check("Dockerfile"),
    agentsMd: check("AGENTS.md"),
    claudeAgentsDir: check(".claude/agents"),
    claudeSkillsDir: check(".claude/skills"),
    codexAgentsDir: check(".codex/agents"),
    codexSkillsDir: check(".codex/skills"),
  };

  // List existing agents
  const existingAgents: string[] = [];
  for (const agentDir of [".claude/agents", ".codex/agents"]) {
    const fullPath = join(targetRoot, agentDir);
    if (!existsSync(fullPath)) continue;
    try {
      const entries = readdirSync(fullPath);
      for (const entry of entries) {
        if (entry.endsWith(".md")) {
          existingAgents.push(basename(entry, ".md"));
        }
      }
    } catch {
      // ignore read errors
    }
  }

  // List existing skills
  const existingSkills: string[] = [];
  for (const skillDir of [".claude/skills", ".codex/skills"]) {
    const fullPath = join(targetRoot, skillDir);
    if (!existsSync(fullPath)) continue;
    try {
      const entries = readdirSync(fullPath);
      for (const entry of entries) {
        const skillFile = join(fullPath, entry, "SKILL.md");
        if (existsSync(skillFile)) {
          existingSkills.push(entry);
        }
      }
    } catch {
      // ignore read errors
    }
  }

  // Read README excerpt
  let readmeExcerpt = "";
  const readmePath = join(targetRoot, "README.md");
  if (existsSync(readmePath)) {
    try {
      const content = readFileSync(readmePath, "utf8");
      readmeExcerpt = content.slice(0, 200).trim();
    } catch {
      // ignore read errors
    }
  }

  // Read package.json name + description
  let packageName = "";
  let packageDescription = "";
  const pkgPath = join(targetRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      packageName = typeof pkg.name === "string" ? pkg.name : "";
      packageDescription = typeof pkg.description === "string" ? pkg.description : "";
    } catch {
      // ignore parse errors
    }
  }

  return {
    root: targetRoot,
    files,
    existingAgents: [...new Set(existingAgents)],
    existingSkills: [...new Set(existingSkills)],
    readmeExcerpt,
    packageName,
    packageDescription,
  };
}

// ── CLI-based analysis ───────────────────────────────────────────────────────

// Detect language from build files present in the project root
const BUILD_FILE_SIGNALS: Record<string, { language: string; stack: string[] }> = {
  "package.json": { language: "javascript", stack: ["node"] },
  "Cargo.toml": { language: "rust", stack: ["cargo"] },
  "pyproject.toml": { language: "python", stack: ["python"] },
  "setup.py": { language: "python", stack: ["python"] },
  "requirements.txt": { language: "python", stack: ["pip"] },
  "Pipfile": { language: "python", stack: ["pipenv"] },
  "go.mod": { language: "go", stack: ["go"] },
  "build.gradle": { language: "java", stack: ["gradle"] },
  "build.gradle.kts": { language: "kotlin", stack: ["gradle"] },
  "pom.xml": { language: "java", stack: ["maven"] },
  "Gemfile": { language: "ruby", stack: ["bundler"] },
  "mix.exs": { language: "elixir", stack: ["mix"] },
  "pubspec.yaml": { language: "dart", stack: ["flutter"] },
  "CMakeLists.txt": { language: "c++", stack: ["cmake"] },
  "Makefile": { language: "unknown", stack: ["make"] },
  "Dockerfile": { language: "unknown", stack: ["docker"] },
  "composer.json": { language: "php", stack: ["composer"] },
  "Package.swift": { language: "swift", stack: ["spm"] },
  "deno.json": { language: "typescript", stack: ["deno"] },
  "bun.lockb": { language: "typescript", stack: ["bun"] },
};

function buildFallbackAnalysis(targetRoot: string): ProjectAnalysis {
  // Read any available project description
  let description = "";
  let readmeExcerpt = "";

  for (const readmeFile of ["README.md", "README.rst", "README.txt", "README"]) {
    const p = join(targetRoot, readmeFile);
    if (existsSync(p)) {
      try {
        readmeExcerpt = readFileSync(p, "utf8").slice(0, 300).trim();
        break;
      } catch { /* ignore */ }
    }
  }

  // Try package.json description (JS/TS projects)
  const pkgPath = join(targetRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const name = typeof pkg.name === "string" ? pkg.name : "";
      const desc = typeof pkg.description === "string" ? pkg.description : "";
      if (desc) description = name ? `${name}: ${desc}` : desc;
    } catch { /* ignore */ }
  }

  // Try Cargo.toml description (Rust)
  const cargoPath = join(targetRoot, "Cargo.toml");
  if (!description && existsSync(cargoPath)) {
    try {
      const content = readFileSync(cargoPath, "utf8");
      const descMatch = content.match(/^description\s*=\s*"([^"]+)"/m);
      const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
      if (descMatch) description = nameMatch ? `${nameMatch[1]}: ${descMatch[1]}` : descMatch[1];
    } catch { /* ignore */ }
  }

  // Try pyproject.toml description (Python)
  const pyprojectPath = join(targetRoot, "pyproject.toml");
  if (!description && existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, "utf8");
      const descMatch = content.match(/^description\s*=\s*"([^"]+)"/m);
      const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
      if (descMatch) description = nameMatch ? `${nameMatch[1]}: ${descMatch[1]}` : descMatch[1];
    } catch { /* ignore */ }
  }

  if (!description) {
    description = readmeExcerpt
      ? readmeExcerpt.split("\n").filter(Boolean).slice(0, 2).join(". ")
      : "A software project.";
  }

  // Detect language and stack from build files
  let language = "unknown";
  const stack: string[] = [];

  for (const [file, signal] of Object.entries(BUILD_FILE_SIGNALS)) {
    if (existsSync(join(targetRoot, file))) {
      if (language === "unknown" && signal.language !== "unknown") {
        language = signal.language;
      }
      for (const s of signal.stack) {
        if (!stack.includes(s)) stack.push(s);
      }
    }
  }

  return {
    description,
    language,
    domains: [],
    stack: stack.length ? stack : [language],
    suggestedAgents: ["code-reviewer", "software-architect"],
    source: "fallback",
  };
}

function parseAnalysisOutput(raw: string): ProjectAnalysis | null {
  const text = raw.trim();
  if (!text) return null;

  // Try to extract JSON from the output (may be wrapped in markdown or Claude JSON envelope)
  let jsonText = text;

  // Handle Claude --output-format json envelope: { "result": "..." }
  try {
    const envelope = JSON.parse(text);
    if (typeof envelope.result === "string") {
      jsonText = envelope.result.trim();
    } else if (envelope.description || envelope.domains) {
      // Already the analysis object
      return validateAnalysis(envelope);
    }
  } catch {
    // not a JSON envelope, proceed
  }

  // Strip markdown fences if present
  const fenced = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    jsonText = fenced[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonText);
    return validateAnalysis(parsed);
  } catch {
    // try to find JSON object in the text
    const match = jsonText.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return validateAnalysis(parsed);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function validateAnalysis(parsed: Record<string, unknown>): ProjectAnalysis | null {
  if (!parsed || typeof parsed !== "object") return null;

  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  const language = typeof parsed.language === "string" ? parsed.language.trim().toLowerCase() : "";
  const domains = Array.isArray(parsed.domains)
    ? (parsed.domains as unknown[]).filter((d): d is string => typeof d === "string")
    : [];
  const stack = Array.isArray(parsed.stack)
    ? (parsed.stack as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const suggestedAgents = Array.isArray(parsed.suggestedAgents)
    ? (parsed.suggestedAgents as unknown[]).filter((a): a is string => typeof a === "string")
    : [];

  if (!description && domains.length === 0 && stack.length === 0) return null;

  return {
    description: description || "A software project.",
    language,
    domains,
    stack,
    suggestedAgents,
    source: "cli",
  };
}

function isBlockedProjectAnalysisResponse(analysis: ProjectAnalysis): boolean {
  const normalized = `${analysis.description || ""}`.toLowerCase();
  const indicators = [
    "could not inspect the repository files",
    "local command execution is blocked",
    "please provide access",
    "paste the key files",
    "failed to inspect",
    "unable to access the repository",
  ];
  return indicators.some((indicator) => normalized.includes(indicator));
}

// ── Analysis cache ────────────────────────────────────────────────────────────

const ANALYSIS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function computeProjectHash(targetRoot: string): string {
  const buildFiles = Object.keys(BUILD_FILE_SIGNALS);
  const found = buildFiles.filter((f) => existsSync(join(targetRoot, f))).sort();
  return createHash("sha256").update(found.join(",")).digest("hex").slice(0, 16);
}

async function loadCachedAnalysis(targetRoot: string): Promise<ProjectAnalysis | null> {
  const resource = getSettingStateResource();
  if (!resource) return null;
  const hash = computeProjectHash(targetRoot);
  const key = `project-analysis:${hash}`;
  try {
    const record = await resource.get(key);
    if (!record?.value) return null;
    const cached = record.value as { analysis: ProjectAnalysis; updatedAt: string };
    if (!cached.analysis || !cached.updatedAt) return null;
    if (Date.now() - Date.parse(cached.updatedAt) > ANALYSIS_CACHE_TTL_MS) return null;
    return cached.analysis;
  } catch {
    return null;
  }
}

async function saveCachedAnalysis(targetRoot: string, analysis: ProjectAnalysis): Promise<void> {
  const resource = getSettingStateResource();
  if (!resource) return;
  const hash = computeProjectHash(targetRoot);
  const key = `project-analysis:${hash}`;
  try {
    await resource.replace(key, {
      id: key,
      scope: "system",
      source: "detected",
      value: { analysis, updatedAt: new Date().toISOString() },
    });
  } catch {
    // non-critical
  }
}

export { buildFallbackAnalysis };

export async function analyzeProjectWithCli(
  provider: string,
  targetRoot: string,
  options?: { forceRefresh?: boolean },
): Promise<ProjectAnalysis> {
  // Check cache first
  if (!options?.forceRefresh) {
    const cached = await loadCachedAnalysis(targetRoot);
    if (cached) {
      logger.info("Using cached project analysis.");
      return cached;
    }
  }

  const normalizedProvider = provider.trim().toLowerCase();
  const providers = detectAvailableProviders();
  const providerInfo = providers.find((p) => p.name === normalizedProvider && p.available);

  if (!providerInfo) {
    logger.warn(
      { provider: normalizedProvider },
      "Requested CLI provider not available, using fallback analysis",
    );
    return buildFallbackAnalysis(targetRoot);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "fifony-scan-"));
  const promptFile = join(tempDir, "fifony-scan-prompt.txt");
  const analysisPrompt = await renderPrompt("project-analysis");
  writeFileSync(promptFile, analysisPrompt, "utf8");

  // Build environment with prompt file path
  const processEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") processEnv[key] = value;
  }
  processEnv.FIFONY_PROMPT_FILE = promptFile;

  try {
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      let args: string[];
      let command: string;

      if (normalizedProvider === "claude") {
        command = "claude";
        args = [
          "--print",
          "--no-session-persistence",
          "--output-format", "json",
          "-p", analysisPrompt,
        ];
      } else if (normalizedProvider === "codex") {
        command = "sh";
        args = ["-c", `codex exec --skip-git-repo-check < "${promptFile}"`];
      } else {
        reject(new Error(`Unsupported provider: ${normalizedProvider}`));
        return;
      }

      const child = spawn(command, args, {
        cwd: targetRoot,
        env: processEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (child.stdin) child.stdin.end();

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = appendFileTail(stdout, chunk.toString("utf8"), 64_000);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = appendFileTail(stderr, chunk.toString("utf8"), 16_000);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, 120_000);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn ${normalizedProvider}: ${err.message}`));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`CLI analysis timed out after 120s`));
          return;
        }
        if (code !== 0) {
          logger.debug(
            { provider: normalizedProvider, code, stderr: stderr.slice(0, 500) },
            "CLI analysis command exited with non-zero code",
          );
        }
        resolve(stdout);
      });
    });

    const analysis = parseAnalysisOutput(output);
    if (analysis && !isBlockedProjectAnalysisResponse(analysis)) {
      logger.info(
        { provider: normalizedProvider, domains: analysis.domains, stack: analysis.stack },
        "CLI project analysis completed",
      );
      // Cache the result for future use
      await saveCachedAnalysis(targetRoot, analysis);
      return analysis;
    }

    if (!analysis) {
      logger.warn(
        { provider: normalizedProvider, rawOutput: output.slice(0, 500) },
        "CLI returned unparseable output, using fallback",
      );
    } else {
      logger.warn(
        { provider: normalizedProvider, blockedAnalysis: analysis.description },
        "CLI analysis returned blocked/insufficient context response, using fallback",
      );
    }
    return buildFallbackAnalysis(targetRoot);
  } catch (error) {
    logger.warn(
      { err: error, provider: normalizedProvider },
      "CLI analysis failed, using fallback",
    );
    return buildFallbackAnalysis(targetRoot);
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

// ── Reference repositories ───────────────────────────────────────────────────

type ArtifactKind = "agent" | "skill";

type RepositoryReferenceInput = {
  id: string;
  name: string;
  url: string;
  description: string;
  fallbackUrls?: string[];
};

export type ReferenceImportKind = "all" | "agents" | "skills";

export type ReferenceRepositoryStatus = {
  id: string;
  name: string;
  url: string;
  path: string;
  present: boolean;
  synced: boolean;
  error?: string;
  remote?: string;
  branch?: string;
  artifactCounts?: {
    agents: number;
    skills: number;
  };
};

export type ReferenceSyncResult = {
  id: string;
  path: string;
  action: "cloned" | "updated" | "failed";
  message: string;
};

type ReferenceArtifact = {
  kind: ArtifactKind;
  sourcePath: string;
  targetName: string;
};

type ReferenceArtifactCollector = (repoPath: string) => ReferenceArtifact[];

export type ReferenceImportSummary = {
  repositoryId: string;
  localPath: string;
  requestedKind: ReferenceImportKind;
  dryRun: boolean;
  importedAgents: string[];
  importedSkills: string[];
  skippedAgents: string[];
  skippedSkills: string[];
  errors: Array<{ kind: ArtifactKind; targetName: string; error: string }>;
};

const DEFAULT_REFERENCE_REPOSITORIES: RepositoryReferenceInput[] = [
  {
    id: "ring",
    name: "LerianStudio/ring",
    url: "https://github.com/LerianStudio/ring.git",
    description: "Massive reference library for agents, skills, commands, and engineering standards.",
    fallbackUrls: ["git@github.com:LerianStudio/ring.git"],
  },
  {
    id: "agency-agents",
    name: "msitarzewski/agency-agents",
    url: "https://github.com/msitarzewski/agency-agents.git",
    description: "Reference agent set focused on frontend, backend, QA, and review roles.",
  },
  {
    id: "impeccable",
    name: "pbakaus/impeccable",
    url: "https://github.com/pbakaus/impeccable.git",
    description: "Frontend polish and impeccable-style quality workflows.",
  },
];

const REPOSITORY_ROOT = resolve(homedir(), ".fifony", "repositories");
const MAX_SCAN_DEPTH = 8;
const SKIP_DIRS = new Set([
  ".git",
  ".github",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "tmp",
  "temp",
]);
const AGENCY_AGENTS_EXCLUDED_DIRS = new Set([
  "examples",
  "strategy",
]);

const REFERENCE_REPOSITORY_PARSERS: Record<string, ReferenceArtifactCollector> = {
  ring: collectStandardArtifacts,
  "agency-agents": collectAgencyArtifacts,
  impeccable: collectImpeccableArtifacts,
};

function runGit(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 120_000,
  }).toString().trim();
}

function slugify(value: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/(^-|-$)/g, "");
  return safe || "reference-item";
}

function uniqueSuffix(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  let i = 0;
  while (true) {
    const candidate = `${base}-${++i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function collectDirectoryEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readRepositoryLine(path: string): string | undefined {
  try {
    return runGit(["-C", path, "remote", "get-url", "origin"]);
  } catch {
    return undefined;
  }
}

function readCurrentBranch(path: string): string | undefined {
  try {
    return runGit(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return undefined;
  }
}

function isMarkdownFile(value: string, expectedName: string): boolean {
  const lower = value.toLowerCase();
  return lower.endsWith(".md") && lower !== expectedName;
}

function isReferenceFrontMatterFile(filePath: string): boolean {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }

  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return false;
  }

  const header = match[1];
  return /^name:\s*.+/im.test(header) && /^description:\s*.+/im.test(header);
}

function buildRelativeArtifactName(repoPath: string, sourcePath: string): string {
  const relative = sourcePath.startsWith(repoPath) ? relativePath(repoPath, sourcePath) : sourcePath;
  const parent = dirname(relative);
  const parentSlug = parent === "." ? "" : parent.split(/[/\\]/).map((segment) => slugify(segment)).filter(Boolean).join("__");
  const baseName = slugify(basename(relative, ".md"));
  return parentSlug ? `${parentSlug}__${baseName}` : baseName;
}

function collectAgentArtifacts(
  agentsDir: string,
  usedNames: Set<string>,
  out: ReferenceArtifact[],
): void {
  const parent = slugify(basename(dirname(agentsDir)));
  const entries = collectDirectoryEntries(agentsDir);

  for (const entry of entries) {
    const itemPath = join(agentsDir, entry.name);

    if (entry.isDirectory()) {
      const nestedAgentSpec = join(itemPath, "AGENT.md");
      if (existsSync(nestedAgentSpec)) {
        const name = uniqueSuffix(`${parent}__${slugify(entry.name)}`, usedNames);
        out.push({ kind: "agent", sourcePath: nestedAgentSpec, targetName: name });
      }
      continue;
    }

    if (!isMarkdownFile(entry.name, "readme.md")) {
      continue;
    }

    const baseName = basename(entry.name, ".md");
    if (baseName.trim().length === 0 || baseName.toLowerCase() === "changelog") {
      continue;
    }

    const name = uniqueSuffix(`${parent}__${slugify(baseName)}`, usedNames);
    out.push({ kind: "agent", sourcePath: itemPath, targetName: name });
  }
}

function collectSkillArtifacts(
  skillsDir: string,
  usedNames: Set<string>,
  out: ReferenceArtifact[],
): void {
  const parent = slugify(basename(dirname(skillsDir)));
  const entries = collectDirectoryEntries(skillsDir);

  for (const entry of entries) {
    const itemPath = join(skillsDir, entry.name);
    if (entry.isDirectory()) {
      const skillFile = join(itemPath, "SKILL.md");
      if (existsSync(skillFile)) {
        const name = uniqueSuffix(`${parent}__${slugify(entry.name)}`, usedNames);
        out.push({ kind: "skill", sourcePath: skillFile, targetName: name });
      }
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
      const name = uniqueSuffix(`${parent}__skill`, usedNames);
      out.push({ kind: "skill", sourcePath: itemPath, targetName: name });
    }
  }
}

function collectStandardArtifacts(repoPath: string): ReferenceArtifact[] {
  const agentsUsed = new Set<string>();
  const skillsUsed = new Set<string>();
  const artifacts: ReferenceArtifact[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: repoPath, depth: 0 }];

  while (queue.length > 0) {
    const state = queue.shift();
    if (!state) break;

    if (state.depth > MAX_SCAN_DEPTH) {
      continue;
    }

    const entries = collectDirectoryEntries(state.path);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const childPath = join(state.path, entry.name);
      if (entry.name === "agents") {
        collectAgentArtifacts(childPath, agentsUsed, artifacts);
      }

      if (entry.name === "skills") {
        collectSkillArtifacts(childPath, skillsUsed, artifacts);
      }

      queue.push({ path: childPath, depth: state.depth + 1 });
    }
  }

  return artifacts;
}

function collectAgencyArtifacts(repoPath: string): ReferenceArtifact[] {
  const agentsUsed = new Set<string>();
  const artifacts: ReferenceArtifact[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: repoPath, depth: 0 }];

  while (queue.length > 0) {
    const state = queue.shift();
    if (!state) break;

    if (state.depth > MAX_SCAN_DEPTH) {
      continue;
    }

    const entries = collectDirectoryEntries(state.path);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || AGENCY_AGENTS_EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        queue.push({ path: join(state.path, entry.name), depth: state.depth + 1 });
        continue;
      }

      if (!isMarkdownFile(entry.name, "readme.md") || !isReferenceFrontMatterFile(join(state.path, entry.name))) {
        continue;
      }

      const itemPath = join(state.path, entry.name);
      const targetName = uniqueSuffix(buildRelativeArtifactName(repoPath, itemPath), agentsUsed);
      artifacts.push({
        kind: "agent",
        sourcePath: itemPath,
        targetName,
      });
    }
  }

  return artifacts;
}

function collectImpeccableArtifacts(repoPath: string): ReferenceArtifact[] {
  const skillsUsed = new Set<string>();
  const artifacts: ReferenceArtifact[] = [];
  const sourceSkills = join(repoPath, "source", "skills");
  if (existsSync(sourceSkills)) {
    collectSkillArtifacts(sourceSkills, skillsUsed, artifacts);
    return artifacts;
  }

  const claudeSkills = join(repoPath, ".claude", "skills");
  if (existsSync(claudeSkills)) {
    collectSkillArtifacts(claudeSkills, skillsUsed, artifacts);
  }

  return artifacts;
}

export function collectArtifacts(repoPath: string, repositoryId?: string): ReferenceArtifact[] {
  const parser = repositoryId && REFERENCE_REPOSITORY_PARSERS[repositoryId]
    ? REFERENCE_REPOSITORY_PARSERS[repositoryId]
    : collectStandardArtifacts;
  return parser(repoPath);
}

function countArtifactKinds(artifacts: ReferenceArtifact[]): { agents: number; skills: number } {
  let agents = 0;
  let skills = 0;
  for (const artifact of artifacts) {
    if (artifact.kind === "agent") {
      agents += 1;
    } else {
      skills += 1;
    }
  }
  return { agents, skills };
}

export function getReferenceRepositoriesRoot(): string {
  return REPOSITORY_ROOT;
}

export function listReferenceRepositories(): ReferenceRepositoryStatus[] {
  return DEFAULT_REFERENCE_REPOSITORIES.map((repo) => {
    const path = join(REPOSITORY_ROOT, repo.id);
    const status: ReferenceRepositoryStatus = {
      id: repo.id,
      name: repo.name,
      url: repo.url,
      path,
      present: existsSync(path),
      synced: false,
    };

    if (!status.present) {
      return status;
    }

    if (!existsSync(join(path, ".git"))) {
      status.error = "Path exists but is not a git repo";
      return status;
    }

    status.remote = readRepositoryLine(path);
    status.branch = readCurrentBranch(path);
    status.synced = typeof status.remote === "string";
    if (status.synced) {
      const artifacts = collectArtifacts(path, repo.id);
      status.artifactCounts = countArtifactKinds(artifacts);
    }
    return status;
  });
}

export function resolveReferenceRepository(query: string): RepositoryReferenceInput | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return undefined;
  const normalizedWithoutGit = normalized.endsWith(".git") ? normalized.slice(0, -4) : normalized;

  return DEFAULT_REFERENCE_REPOSITORIES.find((repo) =>
    repo.id.toLowerCase() === normalizedWithoutGit
    || repo.name.toLowerCase() === normalizedWithoutGit
    || repo.url.toLowerCase() === normalized
    || repo.url.toLowerCase() === normalizedWithoutGit
    || repo.url.toLowerCase().endsWith(`/${normalizedWithoutGit}.git`)
    || repo.url.toLowerCase().endsWith(`/${normalizedWithoutGit}`),
  );
}

export function syncReferenceRepositories(
  repositoryId?: string,
): ReferenceSyncResult[] {
  const root = REPOSITORY_ROOT;
  mkdirSync(root, { recursive: true });
  const repos = repositoryId
    ? [resolveReferenceRepository(repositoryId)]
    : DEFAULT_REFERENCE_REPOSITORIES;
  const selected = repos.filter((repo): repo is RepositoryReferenceInput => Boolean(repo));
  if (repositoryId && selected.length === 0) {
    throw new Error(`Unknown reference repository: ${repositoryId}`);
  }

  const results: ReferenceSyncResult[] = [];

  for (const repo of selected) {
    const target = join(root, repo.id);
    const candidates = [repo.url, ...(repo.fallbackUrls ?? [])];

    if (!existsSync(target)) {
      let cloneError: string | undefined;
      for (const candidate of candidates) {
        try {
          runGit(["clone", "--depth", "1", candidate, target]);
          results.push({
            id: repo.id,
            path: target,
            action: "cloned",
            message: `Cloned ${candidate}`,
          });
          cloneError = undefined;
          break;
        } catch (error) {
          cloneError = error instanceof Error ? error.message : String(error);
        }
      }

      if (cloneError) {
        results.push({
          id: repo.id,
          path: target,
          action: "failed",
          message: cloneError,
        });
      }
      continue;
    }

    if (!existsSync(join(target, ".git"))) {
      results.push({
        id: repo.id,
        path: target,
        action: "failed",
        message: "Path exists but is not a git repository",
      });
      continue;
    }

    try {
      runGit(["-C", target, "fetch", "--all", "--prune"]);
      runGit(["-C", target, "pull", "--ff-only"]);
      results.push({
        id: repo.id,
        path: target,
        action: "updated",
        message: "Updated from remote",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: repo.id,
        path: target,
        action: "failed",
        message,
      });
    }
  }

  return results;
}

export function importReferenceArtifacts(
  repositoryId: string,
  workspaceRoot: string,
  options: {
    kind: ReferenceImportKind;
    overwrite: boolean;
    dryRun: boolean;
    importToGlobal: boolean;
  },
): ReferenceImportSummary {
  const repository = resolveReferenceRepository(repositoryId);
  if (!repository) {
    throw new Error(`Unknown reference repository: ${repositoryId}`);
  }

  const localPath = join(REPOSITORY_ROOT, repository.id);
  if (!existsSync(localPath)) {
    throw new Error(`Repository not synced yet: ${repository.id}. Run 'fifony onboarding sync --repository ${repository.id}' first.`);
  }

  const basePath = resolve(workspaceRoot);
  const targetBase = options.importToGlobal
    ? join(homedir(), ".codex")
    : join(basePath, ".codex");

  const agentsDir = join(targetBase, "agents");
  const skillsDir = join(targetBase, "skills");

  const artifacts = collectArtifacts(localPath, repository.id);
  const filtered = options.kind === "all"
    ? artifacts
    : artifacts.filter((artifact) => artifact.kind === options.kind.slice(0, -1));

  const summary: ReferenceImportSummary = {
    repositoryId: repository.id,
    localPath,
    requestedKind: options.kind,
    dryRun: options.dryRun,
    importedAgents: [],
    importedSkills: [],
    skippedAgents: [],
    skippedSkills: [],
    errors: [],
  };

  if (filtered.length === 0) {
    return summary;
  }

  if (!options.dryRun) {
    mkdirSync(targetBase, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
  }

  for (const artifact of filtered) {
    try {
      const source = readFileSync(artifact.sourcePath, "utf8");
      if (artifact.kind === "agent") {
        const target = join(agentsDir, `${artifact.targetName}.md`);
        if (!options.overwrite && existsSync(target)) {
          summary.skippedAgents.push(artifact.targetName);
          continue;
        }
        if (options.dryRun) {
          summary.importedAgents.push(artifact.targetName);
          continue;
        }
        writeFileSync(target, source, "utf8");
        summary.importedAgents.push(artifact.targetName);
      } else {
        const targetDir = join(skillsDir, artifact.targetName);
        const target = join(targetDir, "SKILL.md");
        if (!options.overwrite && existsSync(target)) {
          summary.skippedSkills.push(artifact.targetName);
          continue;
        }
        if (options.dryRun) {
          summary.importedSkills.push(artifact.targetName);
          continue;
        }
        mkdirSync(targetDir, { recursive: true });
        writeFileSync(target, source, "utf8");
        summary.importedSkills.push(artifact.targetName);
      }
    } catch (error) {
      summary.errors.push({
        kind: artifact.kind,
        targetName: artifact.targetName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}
