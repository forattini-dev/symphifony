import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveConfig, validateConfig } from "../src/domains/config.ts";
import type { RuntimeConfig } from "../src/types.ts";

describe("worker concurrency validation", () => {
  it("accepts concurrency 10", () => {
    const config = deriveConfig(["node", "boot", "--concurrency", "10"]);
    assert.equal(config.workerConcurrency, 10);
  });

  it("clamps concurrency above 10", () => {
    const config = deriveConfig(["node", "boot", "--concurrency", "11"]);
    assert.equal(config.workerConcurrency, 10);
  });

  it("persists concurrent configuration upper bound in validation", () => {
    const config: RuntimeConfig = {
      pollIntervalMs: 1200,
      workerConcurrency: 11,
      commandTimeoutMs: 60_000,
      maxAttemptsDefault: 3,
      maxTurns: 4,
      retryDelayMs: 5_000,
      staleInProgressTimeoutMs: 300_000,
      logLinesTail: 12_000,
      maxConcurrentByState: {},
      agentProvider: "codex",
      agentCommand: "",
      defaultEffort: { default: "medium" },
      runMode: "filesystem",
    };
    const errors = validateConfig(config);
    assert.ok(errors.some((item) => item.includes("workerConcurrency out of range")));
  });
});

