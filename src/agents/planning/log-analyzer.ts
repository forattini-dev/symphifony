import { appendFileTail, extractJsonObjects } from "../../concerns/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { detectAvailableProviders, resolveProviderCapabilities } from "../providers.ts";
import type { RuntimeConfig, ServiceHealthcheck } from "../../types.ts";
import { resolvePlanStageConfig } from "./planning-prompts.ts";
import { ADAPTERS } from "../adapters/registry.ts";
import { env } from "node:process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGET_ROOT } from "../../concerns/constants.ts";

// ── JSON schemas ───────────────────────────────────────────────────────────────

const HEALTHCHECK_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    host: { type: "string" },
    port: { type: "number" },
    protocol: { type: "string", enum: ["http", "https", "tcp"] },
  },
  required: ["host", "port", "protocol"],
  additionalProperties: false,
});

const FIX_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    issueType: { type: "string", enum: ["bug", "chore", "feature"] },
  },
  required: ["title", "description", "issueType"],
  additionalProperties: false,
});

// ── Prompts ────────────────────────────────────────────────────────────────────

function buildHealthcheckPrompt(logTail: string, serviceName: string): string {
  return `You are analyzing the startup log of a service called "${serviceName}".

Your task: identify the host (IP address or hostname) and port where this service is listening for incoming connections.

Look for patterns like:
- "Listening on http://localhost:3000"
- "Server started on port 3000"
- "running on 0.0.0.0:8080"
- "started on 127.0.0.1:4000"
- Any URL or address/port combination that indicates where the service is reachable

Return ONLY a JSON object with this exact structure:
{"host": "localhost", "port": 3000, "protocol": "http"}

Use protocol "http" unless you clearly see "https" or it's a raw TCP service (then use "tcp").
If you cannot find a clear host+port in the log, return: {"host": "localhost", "port": 0, "protocol": "tcp"}

SERVICE LOG (last lines):
\`\`\`
${logTail}
\`\`\``;
}

function buildFixPrompt(logTail: string, serviceName: string): string {
  return `You are analyzing the error log of a service called "${serviceName}" that appears to have a problem.

Your task: identify the root cause of the problem and create a clear issue report for a developer to investigate.

Return ONLY a JSON object with this exact structure:
{
  "title": "Short descriptive title of the problem (max 80 chars)",
  "description": "Clear description of what went wrong, what error was observed, and what might need to be investigated. Include relevant error messages, file paths, or commands from the log.",
  "issueType": "bug"
}

issueType should be "bug" for crashes/errors, "chore" for config/dependency issues, "feature" for missing functionality.

SERVICE LOG (last lines):
\`\`\`
${logTail}
\`\`\``;
}

// ── One-shot CLI runner (mirrors issue-enhancer pattern) ─────────────────────

function readProviderOutput(resultFile: string, fallback: string): string {
  if (existsSync(resultFile)) {
    try {
      return readFileSync(resultFile, "utf8").trim();
    } catch {
      // ignore, keep fallback
    }
  }
  return fallback;
}

async function runOneShot(
  command: string,
  provider: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), "fifony-log-analyze-"));
  const promptFile = join(tempDir, "prompt.md");
  const resultFile = join(tempDir, "result.txt");
  writeFileSync(promptFile, `${prompt}\n`, "utf8");

  const spawnEnv = {
    ...env,
    FIFONY_PROMPT_FILE: promptFile,
    FIFONY_PROMPT: prompt,
    FIFONY_AGENT_PROVIDER: provider,
    FIFONY_RESULT_FILE: resultFile,
  };

  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let output = "";
    let timedOut = false;

    const child = spawn(command, { shell: true, cwd: TARGET_ROOT, env: spawnEnv });
    if (child.stdin) child.stdin.end();

    child.stdout?.on("data", (chunk: Buffer) => {
      output = appendFileTail(output, String(chunk), 12_000);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output = appendFileTail(output, String(chunk), 12_000);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, Math.max(timeoutMs, 1_000));

    child.on("error", () => {
      clearTimeout(timer);
      rmSync(tempDir, { recursive: true, force: true });
      reject(new Error("Could not execute AI command."));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const commandOutput = readProviderOutput(resultFile, output);
      rmSync(tempDir, { recursive: true, force: true });

      if (timedOut) {
        reject(new Error(`Log analysis timed out after ${Date.now() - startedAt}ms.`));
        return;
      }
      if (code !== 0 && !commandOutput.trim()) {
        reject(new Error(`Log analysis command failed (exit ${code ?? "unknown"}) with no output.`));
        return;
      }
      if (code !== 0) {
        logger.warn({ exitCode: code, provider }, "[LogAnalyzer] Provider exited non-zero but produced output — attempting to use it");
      }
      resolve(commandOutput);
    });
  });
}

// ── JSON extraction ────────────────────────────────────────────────────────────

function extractJsonFromOutput<T>(raw: string): T | null {
  const text = raw.trim();
  if (!text) return null;

  // Try code blocks first (last-to-first to skip echoed prompt)
  const codeBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)]
    .map((m) => m[1].trim())
    .reverse();

  for (const block of codeBlocks) {
    for (const candidate of extractJsonObjects(block)) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // try next
      }
    }
  }

  // Try raw JSON objects from end of output
  const candidates = extractJsonObjects(text).reverse();
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try next
    }
  }

  return null;
}

// ── Provider setup ─────────────────────────────────────────────────────────────

async function resolveProvider(config: RuntimeConfig) {
  const { provider: selectedProvider, model: selectedModel } = await resolvePlanStageConfig(config);

  const providers = detectAvailableProviders();
  const isAvailable = providers.some((p) => p.name === selectedProvider && p.available);
  if (!isAvailable) {
    const known = providers.map((e) => `${e.name}:${e.available ? "ok" : "missing"}`).join(", ");
    throw new Error(`Plan provider "${selectedProvider}" is not available. Detected: ${known}`);
  }

  const adapter = ADAPTERS[selectedProvider];
  if (!adapter) throw new Error(`No adapter for provider "${selectedProvider}".`);

  return { provider: selectedProvider, model: selectedModel, adapter };
}

function truncateLog(log: string, maxLines: number): string {
  const lines = log.split("\n");
  return lines.length > maxLines ? lines.slice(-maxLines).join("\n") : log;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function analyzeLogForHealthcheck(
  logTail: string,
  serviceName: string,
  config: RuntimeConfig,
): Promise<ServiceHealthcheck | null> {
  const { provider, model, adapter } = await resolveProvider(config);
  const caps = resolveProviderCapabilities(provider);
  const command = adapter.buildCommand({
    model,
    readOnly: true,
    jsonSchema: caps.structuredOutput.mode !== "none" ? HEALTHCHECK_JSON_SCHEMA : undefined,
  });

  const prompt = buildHealthcheckPrompt(truncateLog(logTail, 150), serviceName);
  const timeoutMs = config.commandTimeoutMs ?? 60_000;

  logger.debug({ provider, serviceName }, "[LogAnalyzer] Detecting healthcheck config from log");

  const raw = await runOneShot(command, provider, prompt, timeoutMs);
  const result = extractJsonFromOutput<{ host: string; port: number; protocol: string }>(raw);

  if (!result?.port || result.port <= 0) {
    logger.debug({ provider, serviceName }, "[LogAnalyzer] Could not extract host/port from log");
    return null;
  }

  const protocol = result.protocol === "https" ? "https" : result.protocol === "tcp" ? "tcp" : "http";
  const host = result.host || "localhost";
  const port = result.port;

  const healthcheck: ServiceHealthcheck = protocol === "tcp"
    ? { type: "tcp", port }
    : { type: "http", endpoint: `${protocol}://${host}:${port}/health`, port };

  logger.info({ provider, serviceName, healthcheck }, "[LogAnalyzer] Healthcheck config detected");
  return healthcheck;
}

export type FixSuggestion = {
  title: string;
  description: string;
  issueType: "bug" | "chore" | "feature";
};

export async function analyzeLogForFix(
  logTail: string,
  serviceName: string,
  config: RuntimeConfig,
): Promise<FixSuggestion | null> {
  const { provider, model, adapter } = await resolveProvider(config);
  const caps = resolveProviderCapabilities(provider);
  const command = adapter.buildCommand({
    model,
    readOnly: true,
    jsonSchema: caps.structuredOutput.mode !== "none" ? FIX_JSON_SCHEMA : undefined,
  });

  const prompt = buildFixPrompt(truncateLog(logTail, 100), serviceName);
  const timeoutMs = config.commandTimeoutMs ?? 60_000;

  logger.debug({ provider, serviceName }, "[LogAnalyzer] Analyzing log for fix suggestion");

  const raw = await runOneShot(command, provider, prompt, timeoutMs);
  const result = extractJsonFromOutput<{ title: string; description: string; issueType: string }>(raw);

  if (!result?.title) {
    logger.debug({ provider, serviceName }, "[LogAnalyzer] Could not extract fix suggestion from log");
    return null;
  }

  const issueType = ["bug", "chore", "feature"].includes(result.issueType ?? "")
    ? (result.issueType as "bug" | "chore" | "feature")
    : "bug";

  return {
    title: result.title.slice(0, 120),
    description: result.description ?? "",
    issueType,
  };
}
