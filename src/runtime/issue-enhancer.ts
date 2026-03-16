import { appendFileTail, getNestedRecord, getNestedString } from "./helpers.ts";
import { logger } from "./logger.ts";
import { detectAvailableProviders, normalizeAgentProvider, resolveAgentCommand } from "./providers.ts";
import type { RuntimeConfig, WorkflowDefinition } from "./types.ts";
import { env } from "node:process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type EnhancementField = "title" | "description";

type EnhanceIssuePayload = {
  field: EnhancementField;
  title: string;
  description: string;
  provider?: string;
  preferredProvider?: string;
};

type EnhanceResult = {
  field: EnhancementField;
  value: string;
  provider: string;
};

function getProviderCommand(
  provider: string,
  config: RuntimeConfig,
  workflowDefinition: WorkflowDefinition | null,
): string {
  const workflowConfig = workflowDefinition ? workflowDefinition.config : {};
  const codexCommand = getNestedString(getNestedRecord(workflowConfig, "codex"), "command");
  const claudeCommand = getNestedString(getNestedRecord(workflowConfig, "claude"), "command");
  return resolveAgentCommand(provider, config.agentCommand || "", codexCommand, claudeCommand);
}

function buildPrompt(field: EnhancementField, title: string, description: string): string {
  if (field === "title") {
    return [
      "You are helping improve issue metadata for a software execution queue.",
      "Rewrite the title for clarity, actionability, and specificity.",
      "Return strict JSON only with this schema:",
      '{ "field": "title", "value": "..." }',
      "",
      `Current title: ${title || "(empty)"}`,
      `Description context: ${description || "(empty)"}`,
      "",
      "Rules:",
      "- Keep it concise and suitable as a task title.",
      "- Use imperative language when possible.",
      "- Do not include markdown, quotes, or extra explanation.",
      "- The value should be in Portuguese if the input is in Portuguese; otherwise in English.",
    ].join("\n");
  }

  return [
    "You are helping improve issue metadata for a software execution queue.",
    "Rewrite the description to be clearer, complete, and directly actionable.",
    "Return strict JSON only with this schema:",
    '{ "field": "description", "value": "..." }',
    "",
    `Current title: ${title || "(empty)"}`,
    `Current description: ${description || "(empty)"}`,
    "",
    "Rules:",
    "- Keep it concise but include meaningful acceptance criteria.",
    "- Use plain text only, with short paragraphs or bullet style.",
    "- Avoid markdown wrappers, quotes, and extra explanation.",
    "- The value should be in Portuguese if the input is in Portuguese; otherwise in English.",
  ].join("\n");
}

function parseEnhancerOutput(raw: string, expectedField: EnhancementField): string {
  const text = raw.trim();
  if (!text) {
    throw new Error("AI provider returned an empty response.");
  }

  const candidates = extractJsonCandidates(
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim() ?? text,
  );
  for (const candidate of candidates) {
    const value = parseCandidate(candidate, expectedField);
    if (value) return value;
  }

  const cleanedRaw = text.trim();
  const trimmed = cleanedRaw.replace(/^\"|\"$/g, "").trim();
  if (trimmed) {
    const candidatesFromRaw = extractJsonCandidates(trimmed);
    for (const candidate of candidatesFromRaw) {
      const value = parseCandidate(candidate, expectedField);
      if (value) return value;
    }
  }

  const fallback = cleanedRaw.replace(/^`+\s*|\s*`+$/g, "").trim();
  if (!fallback) {
    throw new Error("AI provider response could not be parsed.");
  }
  return fallback;
}

function parseCandidate(raw: string, expectedField: EnhancementField): string {
  const candidate = raw.trim();
  if (!candidate) return "";

  try {
    const parsed = JSON.parse(candidate) as {
      field?: string;
      value?: unknown;
      text?: unknown;
      result?: unknown;
    };
    const value =
      typeof parsed.value === "string" ? parsed.value.trim() :
      typeof parsed.text === "string" ? parsed.text.trim() :
      "";
    const field = parsed.field;
    const isPlaceholder = /^\.{2,}$/.test(value);
    if (value && !isPlaceholder && (!field || field === expectedField)) {
      return value;
    }
    if (typeof parsed.result === "string") {
      const nested = parsed.result.trim();
      if (nested) {
        const nestedClean = nested.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
        for (const nestedCandidate of extractJsonCandidates(nestedClean)) {
          const parsedNested = parseCandidate(nestedCandidate, expectedField);
          if (parsedNested) return parsedNested;
        }
      }
    }
  } catch {
    // ignore parse errors for heuristic parsing
  }
  return "";
}

function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
      continue;
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

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

async function runProviderCommand(
  command: string,
  provider: string,
  prompt: string,
  title: string,
  description: string,
  field: EnhancementField,
  timeoutMs: number,
): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), "fifony-enhance-"));
  const promptFile = join(tempDir, "fifony-enhance-prompt.md");
  const issuePayloadFile = join(tempDir, "fifony-issue.json");
  const resultFile = join(tempDir, "fifony-result.txt");
  const envFile = join(tempDir, "fifony-enhance-env.sh");
  writeFileSync(promptFile, `${prompt}\n`, "utf8");
  writeFileSync(issuePayloadFile, JSON.stringify({ title, description, field }, null, 2), "utf8");

  const envLines = [
    `export FIFONY_ISSUE_TITLE=${JSON.stringify(title)}`,
    `export FIFONY_ISSUE_DESCRIPTION=${JSON.stringify(description)}`,
    `export FIFONY_ENHANCE_FIELD=${JSON.stringify(field)}`,
    "export FIFONY_PROMPT_FILE=" + JSON.stringify(promptFile),
    "export FIFONY_PROMPT=" + JSON.stringify(prompt),
    "export FIFONY_ISSUE_JSON=" + JSON.stringify(issuePayloadFile),
    "export FIFONY_AGENT_PROVIDER=" + JSON.stringify(provider),
    "export FIFONY_RESULT_FILE=" + JSON.stringify(resultFile),
  ];

  const processEnv = Object.entries(env)
    .map(([key, value]) => {
      if (typeof value !== "string") return `export ${key}=${JSON.stringify("")}`;
      return `export ${key}=${JSON.stringify(value)}`;
    })
    .join("\n");

  writeFileSync(envFile, `${processEnv}\n${envLines.join("\n")}\n`, "utf8");

  const wrappedCommand = `. "${envFile}" && ${command}`;
  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let output = "";
    let timeout = false;

    const child = spawn(wrappedCommand, {
      shell: true,
      cwd: tempDir,
    });

    if (child.stdin) child.stdin.end();

    child.stdout?.on("data", (chunk) => {
      output = appendFileTail(output, String(chunk), 12_000);
    });
    child.stderr?.on("data", (chunk) => {
      output = appendFileTail(output, String(chunk), 12_000);
    });

    const timer = setTimeout(() => {
      timeout = true;
      child.kill("SIGTERM");
    }, Math.max(timeoutMs, 1_000));

    child.on("error", () => {
      clearTimeout(timer);
      rmSync(tempDir, { recursive: true, force: true });
      reject(new Error("Could not execute AI command."));
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timeout) {
        rmSync(tempDir, { recursive: true, force: true });
        reject(new Error(`Enhance command timeout after ${Date.now() - startedAt}ms.`));
        return;
      }

      const commandOutput = readProviderOutput(resultFile, output);
      rmSync(tempDir, { recursive: true, force: true });

      if (code !== 0) {
        const providerOutput = appendFileTail(commandOutput, "", 12_000);
        const reason = providerOutput.trim()
          ? ` Enhance command output: ${providerOutput.slice(0, 1200)}`
          : "";
        reject(new Error(`Enhance command failed (exit ${code ?? "unknown"}).${reason}`));
        return;
      }
      resolve(commandOutput);
    });
  });
}

export async function enhanceIssueField(
  payload: EnhanceIssuePayload,
  config: RuntimeConfig,
  workflowDefinition: WorkflowDefinition | null,
): Promise<EnhanceResult> {
  const field: EnhancementField = payload.field === "description" ? "description" : "title";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  const requestedProvider = normalizeAgentProvider(
    typeof payload.preferredProvider === "string" ? payload.preferredProvider : payload.provider ?? config.agentProvider,
  );
  const providers = detectAvailableProviders();
  const availableSet = new Set(providers.filter((entry) => entry.available).map((entry) => entry.name));
  const orderedProviders: string[] = [];
  const addProvider = (candidate: string) => {
    if (availableSet.has(candidate) && !orderedProviders.includes(candidate)) {
      orderedProviders.push(candidate);
    }
  };

  addProvider(requestedProvider);
  addProvider("codex");
  addProvider("claude");

  if (!orderedProviders.length) {
    const known = providers.map((entry) => `${entry.name}:${entry.available ? "available" : "missing"}`).join(", ");
    throw new Error(`No AI provider available (codex/claude). Detected: ${known}`);
  }

  const prompt = buildPrompt(field, title, description);
  const errors: string[] = [];

  for (const selectedProvider of orderedProviders) {
    const command = getProviderCommand(selectedProvider, config, workflowDefinition);
    if (!command) {
      errors.push(`Provider "${selectedProvider}" has no command.`);
      continue;
    }

    try {
      const output = await runProviderCommand(
        command,
        selectedProvider,
        prompt,
        title,
        description,
        field,
        config.commandTimeoutMs,
      );
      logger.info({ provider: selectedProvider, field, rawOutput: output.slice(0, 2000) }, "Enhance raw output");
      const value = parseEnhancerOutput(output, field);
      logger.info({ provider: selectedProvider, field, parsedValue: value }, "Enhance parsed value");
      return { field, value, provider: selectedProvider };
    } catch (error) {
      errors.push(
        `Provider "${selectedProvider}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(`Could not enhance issue field. ${errors.join(" | ")}`);
}
