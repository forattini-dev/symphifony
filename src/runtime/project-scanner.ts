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

const ANALYSIS_PROMPT = `Analyze this project directory and return a JSON object with:
- "description": A 2-sentence description of what this project does
- "domains": An array of relevant domain tags from this list: frontend, backend, mobile, devops, database, ai-ml, security, testing, games, ecommerce, fintech, healthcare, education, saas, design, product, marketing, embedded, blockchain, spatial-computing. Only include domains that clearly apply.
- "stack": An array of key technologies/frameworks used (e.g., "react", "typescript", "express", "postgresql")
- "suggestedAgents": Based on the domains, suggest which specialist agents would help from this list: frontend-developer, backend-architect, database-optimizer, security-engineer, devops-automator, mobile-app-builder, ai-engineer, ui-designer, ux-architect, code-reviewer, technical-writer, sre, data-engineer, software-architect, game-designer

Return ONLY valid JSON, no markdown, no explanation.`;

function buildFallbackAnalysis(targetRoot: string): ProjectAnalysis {
  let packageName = "";
  let packageDescription = "";
  const pkgPath = join(targetRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      packageName = typeof pkg.name === "string" ? pkg.name : "";
      packageDescription = typeof pkg.description === "string" ? pkg.description : "";
    } catch {
      // ignore
    }
  }

  let readmeExcerpt = "";
  const readmePath = join(targetRoot, "README.md");
  if (existsSync(readmePath)) {
    try {
      readmeExcerpt = readFileSync(readmePath, "utf8").slice(0, 300).trim();
    } catch {
      // ignore
    }
  }

  const description = packageDescription
    ? `${packageName ? packageName + ": " : ""}${packageDescription}`
    : readmeExcerpt
      ? readmeExcerpt.split("\n").filter(Boolean).slice(0, 2).join(". ")
      : "A software project.";

  // Infer basic domains from package.json dependencies
  const domains: string[] = [];
  const stack: string[] = [];

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const allDeps = {
        ...((pkg.dependencies as Record<string, string>) ?? {}),
        ...((pkg.devDependencies as Record<string, string>) ?? {}),
      };
      const depNames = Object.keys(allDeps);

      if (depNames.some((d) => /react|vue|angular|svelte|next|nuxt/.test(d))) {
        domains.push("frontend");
      }
      if (depNames.some((d) => /express|fastify|hono|koa|nest/.test(d))) {
        domains.push("backend");
      }
      if (depNames.some((d) => /react-native|expo/.test(d))) {
        domains.push("mobile");
      }
      if (depNames.some((d) => /typescript|tsup|tsx/.test(d))) {
        stack.push("typescript");
      }
      if (depNames.some((d) => /react/.test(d))) {
        stack.push("react");
      }
      if (depNames.some((d) => /vite/.test(d))) {
        stack.push("vite");
      }
    } catch {
      // ignore
    }
  }

  return {
    description,
    domains: domains.length ? domains : ["backend"],
    stack: stack.length ? stack : ["javascript"],
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
    domains,
    stack,
    suggestedAgents,
    source: "cli",
  };
}

export async function analyzeProjectWithCli(
  provider: string,
  targetRoot: string,
): Promise<ProjectAnalysis> {
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

  const tempDir = mkdtempSync(join(tmpdir(), "symphifony-scan-"));
  const promptFile = join(tempDir, "symphifony-scan-prompt.txt");
  writeFileSync(promptFile, ANALYSIS_PROMPT, "utf8");

  // Build environment with prompt file path
  const processEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") processEnv[key] = value;
  }
  processEnv.SYMPHIFONY_PROMPT_FILE = promptFile;

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
          "-p", ANALYSIS_PROMPT,
        ];
      } else if (normalizedProvider === "codex") {
        command = "codex";
        args = ["exec", "--skip-git-repo-check", "<", promptFile];
        // For codex, wrap in shell to handle stdin redirection
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
      }, 45_000);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn ${normalizedProvider}: ${err.message}`));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`CLI analysis timed out after 45s`));
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
