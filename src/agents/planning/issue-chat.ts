import { appendFileTail } from "../../concerns/helpers.ts";
import { logger } from "../../concerns/logger.ts";
import { detectAvailableProviders, resolveProviderCapabilities } from "../providers.ts";
import type { RuntimeConfig } from "../../types.ts";
import { resolveChatStageConfig } from "./planning-prompts.ts";
import { ADAPTERS } from "../adapters/registry.ts";
import { env } from "node:process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGET_ROOT } from "../../concerns/constants.ts";

// ── One-shot CLI runner (same pattern as log-analyzer) ──────────────────────

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
  const tempDir = mkdtempSync(join(tmpdir(), "fifony-chat-"));
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
        reject(new Error(`Chat command timed out after ${Date.now() - startedAt}ms.`));
        return;
      }
      if (code !== 0 && !commandOutput.trim()) {
        reject(new Error(`Chat command failed (exit ${code ?? "unknown"}) with no output.`));
        return;
      }
      if (code !== 0) {
        logger.warn({ exitCode: code, provider }, "[Chat] Provider exited non-zero but produced output — attempting to use it");
      }
      resolve(commandOutput);
    });
  });
}

// ── Prompt builder ──────────────────────────────────────────────────────────

function buildChatPrompt(payload: {
  title: string;
  description: string;
  plan?: { summary?: string; steps?: Array<{ action?: string; title?: string }> } | null;
  message: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}): string {
  const { title, description, plan, message, history } = payload;

  const planSection = plan
    ? `Plan summary: ${plan.summary ?? "(none)"}\nSteps: ${plan.steps?.map((s) => s.action || s.title || "").filter(Boolean).join(", ") ?? "(none)"}`
    : "No plan yet.";

  const historySection = history?.length
    ? history.map((m) => `${m.role}: ${m.content}`).join("\n")
    : "";

  return `You are a helpful assistant discussing issue "${title}".

## Issue Context
Title: ${title}
Description: ${description || "(none provided)"}
${planSection}

${historySection ? `## Conversation\n${historySection}\n` : ""}user: ${message}

Respond concisely and helpfully. Focus on the issue context.`;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Strip CLI chrome (headers, metadata, prompt echo) from provider output.
 * Each provider dumps different metadata around the actual response.
 */
function stripProviderChrome(raw: string, provider: string): string {
  let text = raw;

  if (provider === "codex") {
    // Codex PTY output: headers → "user\n<prompt>" → "codex\n<response>" → "tokens used N"
    // The response often appears TWICE (once in stream, once in final summary).
    // Strategy: find the LAST "codex\n" marker, extract to "tokens used", then
    // if result is duplicated (first half === second half), deduplicate.

    // Remove everything before the last "codex\n" marker
    const codexMarker = text.lastIndexOf("\ncodex\n");
    if (codexMarker >= 0) {
      text = text.slice(codexMarker + "\ncodex\n".length);
    } else {
      // Try without leading newline (might be at start)
      const altMarker = text.lastIndexOf("codex\n");
      if (altMarker >= 0) {
        text = text.slice(altMarker + "codex\n".length);
      }
    }

    // Remove "tokens used N,NNN" anywhere in the text (not just trailing)
    text = text.replace(/tokens used[\s\d,]+/gi, "");

    // Remove Codex metadata lines
    text = text.replace(/^Reading prompt from stdin.*$/gm, "");
    text = text.replace(/^OpenAI Codex v[\d.]+.*$/gm, "");
    text = text.replace(/^-+$/gm, "");
    text = text.replace(/^workdir:.*$/gm, "");
    text = text.replace(/^model:.*$/gm, "");
    text = text.replace(/^provider:.*$/gm, "");
    text = text.replace(/^approval:.*$/gm, "");
    text = text.replace(/^sandbox:.*$/gm, "");
    text = text.replace(/^reasoning effort:.*$/gm, "");
    text = text.replace(/^reasoning summaries:.*$/gm, "");
    text = text.replace(/^session id:.*$/gm, "");
    text = text.replace(/^user\n/gm, "");

    // Deduplicate if the text is repeated (Codex sometimes echoes response twice)
    const trimmed = text.trim();
    const half = Math.floor(trimmed.length / 2);
    if (half > 50) {
      const first = trimmed.slice(0, half).trim();
      const second = trimmed.slice(half).trim();
      if (first === second) {
        text = first;
      }
    }
  }

  if (provider === "claude") {
    // Claude with --output-format json wraps in { "result": "..." }
    // Try to extract the result field
    try {
      const parsed = JSON.parse(text.trim());
      if (parsed && typeof parsed === "object" && typeof parsed.result === "string") {
        return parsed.result;
      }
    } catch { /* not JSON, use as-is */ }
  }

  if (provider === "gemini") {
    // Gemini may prefix with metadata lines before the actual response
    // Strip everything before the first non-metadata line
    const lines = text.split("\n");
    const contentStart = lines.findIndex((l) =>
      l.trim() && !l.startsWith("Model:") && !l.startsWith("Thinking") && !l.startsWith("─"),
    );
    if (contentStart > 0) {
      text = lines.slice(contentStart).join("\n");
    }
  }

  // Generic cleanup: remove ANSI escape codes
  text = text.replace(/\x1b\[[0-9;]*m/g, "");

  return text.trim();
}

export async function chatWithIssue(
  payload: {
    issueId: string;
    title: string;
    description: string;
    plan?: { summary?: string; steps?: Array<{ action?: string; title?: string }> } | null;
    message: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
  },
  config: RuntimeConfig,
): Promise<{ response: string; provider: string }> {
  const { provider: selectedProvider, model: selectedModel } = await resolveChatStageConfig(config);

  const providers = detectAvailableProviders();
  const isAvailable = providers.some((p) => p.name === selectedProvider && p.available);
  if (!isAvailable) {
    const known = providers.map((e) => `${e.name}:${e.available ? "ok" : "missing"}`).join(", ");
    throw new Error(`Chat provider "${selectedProvider}" is not available. Detected: ${known}`);
  }

  const adapter = ADAPTERS[selectedProvider];
  if (!adapter) throw new Error(`No adapter for provider "${selectedProvider}".`);

  const caps = resolveProviderCapabilities(selectedProvider);
  const command = adapter.buildCommand({
    model: selectedModel,
    readOnly: caps.readOnlyExecution !== "none",
  });

  const prompt = buildChatPrompt(payload);
  const timeoutMs = config.commandTimeoutMs ?? 60_000;

  logger.debug({ provider: selectedProvider, issueId: payload.issueId }, "[Chat] Running chat command");

  const raw = await runOneShot(command, selectedProvider, prompt, timeoutMs);

  // Strip CLI chrome (headers, metadata, prompt echo) from the raw output
  const response = stripProviderChrome(raw, selectedProvider).trim();
  if (!response) {
    throw new Error("AI provider returned an empty response.");
  }

  logger.info({ provider: selectedProvider, model: selectedModel, issueId: payload.issueId, responseLength: response.length }, "[Chat] Chat response received");

  return { response, provider: selectedProvider };
}
