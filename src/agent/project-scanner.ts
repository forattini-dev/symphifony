import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { env } from "node:process";
import { logger } from "./logger.ts";
import { detectAvailableProviders } from "./providers.ts";
import { appendFileTail } from "./helpers.ts";
import { renderPrompt } from "../prompting.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type ProjectScanResult = {
  root: string;
  files: {
    claudeMd: boolean;
    claudeDir: boolean;
    codexDir: boolean;
    readmeMd: boolean;
    packageJson: boolean;
    workflowMd: boolean;
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
    workflowMd: check("WORKFLOW.md"),
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

// ── Analysis cache ────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { getSettingStateResource } from "./store.ts";

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
    if (analysis) {
      logger.info(
        { provider: normalizedProvider, domains: analysis.domains, stack: analysis.stack },
        "CLI project analysis completed",
      );
      // Cache the result for future use
      await saveCachedAnalysis(targetRoot, analysis);
      return analysis;
    }

    logger.warn(
      { provider: normalizedProvider, rawOutput: output.slice(0, 500) },
      "CLI returned unparseable output, using fallback",
    );
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
