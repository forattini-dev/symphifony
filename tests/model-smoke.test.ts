/**
 * Smoke tests: verify every available Claude and Codex model can respond.
 *
 * Strategy (cheap + fast):
 *  - Minimal prompt: "Reply with the exact text: PONG" (< 10 input tokens)
 *  - Claude: --output-format json (captures tokens from modelUsage)
 *  - Codex: exec --skip-git-repo-check (captures tokens from "tokens used" line)
 *  - Success = exit 0 + output contains "PONG" + token count > 0
 *  - Timeout: 90s per model
 *
 * Model lists are discovered dynamically at runtime — no hardcoded IDs.
 * If a model disappears from the CLI/cache, the test disappears too.
 * If a new model appears, it gets a test automatically.
 *
 * Effort tests run on the FIRST available model only (one per effort level)
 * to keep costs minimal while verifying the flag reaches the CLI.
 *
 * Run all:     pnpm test tests/model-smoke.test.ts
 * Run claude:  pnpm test --test-name-pattern "claude" tests/model-smoke.test.ts
 * Run codex:   pnpm test --test-name-pattern "codex" tests/model-smoke.test.ts
 *
 * Requires the respective CLIs to be authenticated and available.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { extractPlanTokenUsage } from "../src/agents/planning/planning-parser.ts";

const TIMEOUT_MS = 90_000;
const PROMPT = "Reply with the exact text: PONG";

// ── Model discovery ───────────────────────────────────────────────────────────

type CodexModelEntry = {
  slug: string;
  visibility?: string;
  supported_reasoning_levels?: Array<{ effort: string; description?: string }>;
};

function getCodexModelEntries(): CodexModelEntry[] {
  try {
    const cachePath = join(homedir(), ".codex", "models_cache.json");
    if (!existsSync(cachePath)) return [];
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
      models?: CodexModelEntry[];
    };
    return (cache.models ?? []).filter((m) => m.visibility === "list");
  } catch {
    return [];
  }
}

// Claude CLI maintains stable aliases that always resolve to the current production model.
// No binary parsing needed — the CLI itself is the source of truth.
function getClaudeModels(): string[] {
  try {
    execFileSync("which", ["claude"], { encoding: "utf8", timeout: 3000 });
    return ["opus", "sonnet", "haiku"];
  } catch {
    return [];
  }
}

// ── CLI runners ───────────────────────────────────────────────────────────────

type RunResult = {
  ok: boolean;
  output: string;
  tokens: ReturnType<typeof extractPlanTokenUsage>;
  error?: string;
};

function runClaude(model: string): RunResult {
  const result = spawnSync(
    "claude",
    ["--print", "--no-session-persistence", "--output-format", "json", "--model", model],
    {
      input: PROMPT,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
  const output = (result.stdout || "") + (result.stderr || "");
  if (result.error) return { ok: false, output, tokens: null, error: result.error.message };
  if (result.status !== 0) return { ok: false, output, tokens: null, error: `exit ${result.status}` };

  // --output-format json puts the response in .result or .structured_output
  let replied = false;
  try {
    const parsed = JSON.parse(output.trim()) as { result?: string };
    replied = typeof parsed.result === "string" && parsed.result.toUpperCase().includes("PONG");
  } catch {
    replied = output.toUpperCase().includes("PONG");
  }

  return { ok: replied, output, tokens: extractPlanTokenUsage(output) };
}

function runCodex(model: string, effort?: string): RunResult {
  const tmpDir = mkdtempSync(join(tmpdir(), "fifony-smoke-"));
  const promptFile = join(tmpDir, "prompt.txt");
  try {
    writeFileSync(promptFile, PROMPT, "utf8");
    const effortFlag = effort ? `-c reasoning_effort="${effort}"` : "";
    const cmd = [
      "codex", "exec", "--skip-git-repo-check",
      `--model "${model}"`,
      effortFlag,
      `< "${promptFile}"`,
    ].filter(Boolean).join(" ");

    const result = spawnSync("bash", ["-c", cmd], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      cwd: tmpDir,
    });
    const output = (result.stdout || "") + (result.stderr || "");
    if (result.error) return { ok: false, output, tokens: null, error: result.error.message };
    if (result.status !== 0) return { ok: false, output, tokens: null, error: `exit ${result.status}` };

    return {
      ok: output.toUpperCase().includes("PONG"),
      output,
      tokens: extractPlanTokenUsage(output),
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Assertions ────────────────────────────────────────────────────────────────

function assertSmoke(label: string, result: RunResult) {
  const snippet = result.output.slice(0, 600);
  assert.ok(result.ok, `${label} — did not reply PONG or failed: ${result.error ?? ""}\n${snippet}`);
  assert.ok(
    result.tokens !== null && result.tokens.totalTokens > 0,
    `${label} — token count not captured (totalTokens=0 or null)\n${snippet}`,
  );
}

// ── Test suites ───────────────────────────────────────────────────────────────

const claudeModels = getClaudeModels();
const codexEntries = getCodexModelEntries();
const codexModels = codexEntries.map((m) => m.slug);

// ── Claude: one test per dynamically-discovered model ──

describe("claude / model smoke tests", {
  skip: claudeModels.length === 0 ? "no claude models discovered" : false,
}, () => {
  for (const model of claudeModels) {
    it(`claude / ${model}`, { timeout: TIMEOUT_MS + 10_000 }, () => {
      assertSmoke(`claude/${model}`, runClaude(model));
    });
  }
});

// ── Codex: one test per dynamically-discovered model ──

describe("codex / model smoke tests", {
  skip: codexModels.length === 0 ? "no codex models discovered" : false,
}, () => {
  for (const model of codexModels) {
    it(`codex / ${model}`, { timeout: TIMEOUT_MS + 10_000 }, () => {
      assertSmoke(`codex/${model}`, runCodex(model));
    });
  }
});

// ── Codex: effort levels — first model only, per supported effort ──
// Reads effort levels from models_cache.json → supported_reasoning_levels.
// If the cache has no effort info, defaults to ["low", "medium", "high"].
// Only uses the first available model to keep costs minimal.

describe("codex / effort smoke tests", {
  skip: codexEntries.length === 0 ? "no codex models discovered" : false,
}, () => {
  const firstEntry = codexEntries[0];
  const firstModel = firstEntry?.slug ?? "";

  // Intersect cache-advertised levels with the efforts we actually send to the CLI.
  // The models_cache.json sometimes lists levels (e.g. "xhigh") that the API
  // doesn't actually accept for a given model — we filter to the safe set.
  const KNOWN_EFFORTS = new Set(["low", "medium", "high"]);
  const advertisedEfforts =
    firstEntry?.supported_reasoning_levels?.map((r) => r.effort).filter((e) => KNOWN_EFFORTS.has(e)) ??
    ["low", "medium", "high"];
  const supportedEfforts = advertisedEfforts.length > 0 ? advertisedEfforts : ["low", "medium", "high"];

  for (const effort of supportedEfforts) {
    it(`codex / ${firstModel} / effort=${effort}`, { timeout: TIMEOUT_MS + 10_000 }, () => {
      assertSmoke(`codex/${firstModel}/effort=${effort}`, runCodex(firstModel, effort));
    });
  }
});

// ── Claude: no effort smoke test (effort is embedded in prompt, not a CLI flag) ──
// For completeness: verify that a claude call with a known-cheap model works.
// One test using the last model in the list (typically haiku — fastest/cheapest).

describe("claude / cheapest model quick check", {
  skip: claudeModels.length === 0 ? "no claude models discovered" : false,
}, () => {
  // haiku is the fastest/cheapest Claude family alias
  const cheapest = claudeModels.includes("haiku") ? "haiku" : claudeModels.at(-1)!;

  it(`claude / ${cheapest} / quick`, { timeout: TIMEOUT_MS + 10_000 }, () => {
    const result = runClaude(cheapest);
    const snippet = result.output.slice(0, 600);
    assert.ok(result.ok, `failed: ${result.error ?? ""}\n${snippet}`);
    // Tokens may or may not be present depending on Claude CLI version — soft check
    if (result.tokens !== null) {
      assert.ok(result.tokens.totalTokens > 0, `unexpected zero tokens\n${snippet}`);
    }
  });
});
