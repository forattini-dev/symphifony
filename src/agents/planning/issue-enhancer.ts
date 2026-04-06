import { appendFileTail, extractJsonObjects } from "../../concerns/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { detectAvailableProviders, resolveProviderCapabilities } from "../providers.ts";
import type { RuntimeConfig } from "../../types.ts";
import { renderPrompt } from "../prompting.ts";
import { resolveEnhanceStageConfig } from "./planning-prompts.ts";
import { ADAPTERS } from "../adapters/registry.ts";
import { env } from "node:process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGET_ROOT } from "../../concerns/constants.ts";


export type EnhancementField = "title" | "description";

type EnhanceIssuePayload = {
  field: EnhancementField;
  title: string;
  description: string;
  issueType?: string;
  images?: string[];
  provider?: string;
  preferredProvider?: string;
};

type EnhanceResult = {
  field: EnhancementField;
  value: string;
  provider: string;
};

async function buildPrompt(field: EnhancementField, title: string, description: string, issueType?: string, images?: string[]): Promise<string> {
  const context = {
    title: title || "(empty)",
    description: description || "(empty)",
    issueType: issueType || "blank",
    images: images?.length ? images : undefined,
  };

  if (field === "title") {
    return renderPrompt("planning-issue-enhancer-title", context);
  }

  return renderPrompt("planning-issue-enhancer-description", context);
}

export function parseEnhancerOutput(raw: string, expectedField: EnhancementField): string {
  const text = raw.trim();
  if (!text) {
    throw new Error("AI provider returned an empty response.");
  }

  // Extract ALL code blocks — iterate last-to-first because the CLI echoes the prompt
  // (which contains a placeholder example) before the real response.
  const codeBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map((m) => m[1].trim()).reverse();
  for (const block of codeBlocks) {
    for (const candidate of extractJsonObjects(block)) {
      const value = parseCandidate(candidate, expectedField);
      if (value) return value;
    }
  }

  const sourceText = codeBlocks[0] ?? text;
  const candidates = extractJsonObjects(sourceText);
  for (const candidate of candidates) {
    const value = parseCandidate(candidate, expectedField);
    if (value) return value;
  }

  // Fallback: CLI tools (e.g. Codex) echo the full prompt to stdout which may
  // contain unbalanced braces (CSS snippets, error stack traces, etc.) that
  // corrupt extractJsonObjects' depth tracker.  Try extracting from each
  // `{"field"` occurrence starting from the end — the real response is last.
  const fieldRe = /\{\s*"field"/g;
  const starts: number[] = [];
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(sourceText)) !== null) starts.push(fm.index);
  for (let i = starts.length - 1; i >= 0; i--) {
    for (const candidate of extractJsonObjects(sourceText.slice(starts[i]))) {
      const value = parseCandidate(candidate, expectedField);
      if (value) return value;
    }
  }

  const cleanedRaw = text.trim();
  const trimmed = cleanedRaw.replace(/^\"|\"$/g, "").trim();
  if (trimmed) {
    const candidatesFromRaw = extractJsonObjects(trimmed);
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
      response?: unknown;
    };
    const value =
      typeof parsed.value === "string" ? parsed.value.trim() :
      typeof parsed.text === "string" ? parsed.text.trim() :
      "";
    const field = parsed.field;
    const isPlaceholder = /^\.{2,}$/.test(value) || /^<REPLACE_/.test(value) || /^your improved /i.test(value);
    if (value && !isPlaceholder && (!field || field === expectedField)) {
      return value;
    }
    // Check nested JSON in result/response fields (Gemini CLI wraps output in {response:"..."})
    const nestedSource =
      typeof parsed.result === "string" ? parsed.result :
      typeof parsed.response === "string" ? parsed.response :
      undefined;
    if (nestedSource) {
      const nested = nestedSource.trim();
      if (nested) {
        const nestedClean = nested.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
        for (const nestedCandidate of extractJsonObjects(nestedClean)) {
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
  images?: string[],
): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), "fifony-enhance-"));
  const promptFile = join(tempDir, "fifony-enhance-prompt.md");
  const issuePayloadFile = join(tempDir, "fifony-issue.json");
  const resultFile = join(tempDir, "fifony-result.txt");
  writeFileSync(promptFile, `${prompt}\n`, "utf8");
  writeFileSync(issuePayloadFile, JSON.stringify({ title, description, field }, null, 2), "utf8");

  const effectiveCommand = command;

  const spawnEnv = {
    ...env,
    FIFONY_ISSUE_TITLE: title,
    FIFONY_ISSUE_DESCRIPTION: description,
    FIFONY_ENHANCE_FIELD: field,
    FIFONY_PROMPT_FILE: promptFile,
    FIFONY_PROMPT: prompt,
    FIFONY_ISSUE_JSON: issuePayloadFile,
    FIFONY_AGENT_PROVIDER: provider,
    FIFONY_RESULT_FILE: resultFile,
    ...(images?.length ? { FIFONY_IMAGE_PATHS: images.join(",") } : {}),
  };

  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let output = "";
    let timeout = false;

    const child = spawn(effectiveCommand, {
      shell: true,
      cwd: TARGET_ROOT,
      env: spawnEnv,
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
        // Some CLIs (e.g. codex exec) exit non-zero but still produce useful output.
        // Try to use the output anyway — the caller's parser will validate it.
        if (commandOutput.trim()) {
          logger.warn({ exitCode: code, provider }, `[Enhance] Provider exited ${code} but produced output — attempting to use it`);
          resolve(commandOutput);
          return;
        }
        reject(new Error(`Enhance command failed (exit ${code ?? "unknown"}) with no output.`));
        return;
      }
      resolve(commandOutput);
    });
  });
}

export async function enhanceIssueField(
  payload: EnhanceIssuePayload,
  config: RuntimeConfig,
  _workflowDefinition: null,
): Promise<EnhanceResult> {
  const field: EnhancementField = payload.field === "description" ? "description" : "title";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  const issueType = typeof payload.issueType === "string" ? payload.issueType.trim() : undefined;
  const images = Array.isArray(payload.images) ? payload.images.filter((p): p is string => typeof p === "string") : undefined;

  // Use enhance-specific config, falling back to plan stage config
  const { provider: selectedProvider, model: selectedModel, effort: selectedEffort } = await resolveEnhanceStageConfig(config);

  const providers = detectAvailableProviders();
  const isAvailable = providers.some((p) => p.name === selectedProvider && p.available);
  if (!isAvailable) {
    const known = providers.map((entry) => `${entry.name}:${entry.available ? "available" : "missing"}`).join(", ");
    throw new Error(`Configured plan provider "${selectedProvider}" is not available. Detected: ${known}`);
  }

  const adapter = ADAPTERS[selectedProvider];
  if (!adapter) {
    throw new Error(`No adapter configured for plan provider "${selectedProvider}".`);
  }

  const ENHANCE_JSON_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
      field: { type: "string", enum: ["title", "description"] },
      value: { type: "string" },
    },
    required: ["field", "value"],
    additionalProperties: false,
  });

  const capabilities = resolveProviderCapabilities(selectedProvider);

  const command = adapter.buildCommand({
    model: selectedModel,
    effort: selectedEffort ?? "low",
    imagePaths: capabilities.imageInput === "cli-flag" ? images : undefined,
    jsonSchema: capabilities.structuredOutput.mode === "json-schema" ? ENHANCE_JSON_SCHEMA : undefined,
    noToolAccess: capabilities.structuredOutput.requiresToolDisable && capabilities.readOnlyExecution === "none",
    readOnly: capabilities.readOnlyExecution !== "none",
  });
  if (!command) {
    throw new Error(`Adapter returned empty command for provider "${selectedProvider}".`);
  }

  const prompt = await buildPrompt(field, title, description, issueType, images);

  const output = await runProviderCommand(
    command,
    selectedProvider,
    prompt,
    title,
    description,
    field,
    config.commandTimeoutMs,
    images,
  );
  logger.info({ provider: selectedProvider, model: selectedModel, field, rawOutput: output.slice(0, 2000) }, "Enhance raw output");
  const value = parseEnhancerOutput(output, field);
  logger.info({ provider: selectedProvider, field, parsedValue: value.slice(0, 500) }, "Enhance parsed value");
  return { field, value, provider: selectedProvider };
}
