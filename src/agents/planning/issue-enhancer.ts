import { appendFileTail, extractJsonObjects } from "../../concerns/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { detectAvailableProviders } from "../providers.ts";
import type { RuntimeConfig } from "../../types.ts";
import { renderPrompt } from "../prompting.ts";
import { resolvePlanStageConfig, getPlanCommand } from "./planning-prompts.ts";
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
    return renderPrompt("issue-enhancer-title", context);
  }

  return renderPrompt("issue-enhancer-description", context);
}

export function parseEnhancerOutput(raw: string, expectedField: EnhancementField): string {
  const text = raw.trim();
  if (!text) {
    throw new Error("AI provider returned an empty response.");
  }

  const candidates = extractJsonObjects(
    text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim() ?? text,
  );
  for (const candidate of candidates) {
    const value = parseCandidate(candidate, expectedField);
    if (value) return value;
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

  // For Codex: inject --image flags before the stdin redirect
  let effectiveCommand = command;
  if (provider === "codex" && images?.length) {
    const imageFlags = images.map((p) => `--image "${p}"`).join(" ");
    effectiveCommand = command.replace('< "$FIFONY_PROMPT_FILE"', `${imageFlags} < "$FIFONY_PROMPT_FILE"`);
  }

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
      cwd: tempDir,
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
  _workflowDefinition: null,
): Promise<EnhanceResult> {
  const field: EnhancementField = payload.field === "description" ? "description" : "title";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const description = typeof payload.description === "string" ? payload.description.trim() : "";
  const issueType = typeof payload.issueType === "string" ? payload.issueType.trim() : undefined;
  const images = Array.isArray(payload.images) ? payload.images.filter((p): p is string => typeof p === "string") : undefined;

  // Use the same provider/model as the plan stage — single source of truth
  const { provider: selectedProvider, model: planModel } = await resolvePlanStageConfig(config);

  const providers = detectAvailableProviders();
  const isAvailable = providers.some((p) => p.name === selectedProvider && p.available);
  if (!isAvailable) {
    const known = providers.map((entry) => `${entry.name}:${entry.available ? "available" : "missing"}`).join(", ");
    throw new Error(`Configured plan provider "${selectedProvider}" is not available. Detected: ${known}`);
  }

  const command = getPlanCommand(selectedProvider, planModel, images);
  if (!command) {
    throw new Error(`No command configured for plan provider "${selectedProvider}".`);
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
  logger.info({ provider: selectedProvider, model: planModel, field, rawOutput: output.slice(0, 2000) }, "Enhance raw output");
  const value = parseEnhancerOutput(output, field);
  logger.info({ provider: selectedProvider, field, parsedValue: value.slice(0, 500) }, "Enhance parsed value");
  return { field, value, provider: selectedProvider };
}
