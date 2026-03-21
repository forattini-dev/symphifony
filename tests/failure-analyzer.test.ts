/**
 * Tests for failure-analyzer.ts — extracts structured insights from raw CLI
 * output to feed back into re-execute prompts (learning loop).
 *
 * Uses realistic output fixtures matching real TypeScript, test runner,
 * lint, git, and process failure patterns.
 *
 * Run with: pnpm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFailureInsights } from "../src/agents/failure-analyzer.ts";
import type { FailureInsight } from "../src/agents/failure-analyzer.ts";

// ══════════════════════════════════════════════════════════════════════════════
// TypeScript compilation errors
// ══════════════════════════════════════════════════════════════════════════════

describe("extractFailureInsights: TypeScript errors", () => {
  it("detects TS error with file and line", () => {
    const output = `
src/db/pool.ts(42,5): error TS2339: Property 'connect' does not exist on type 'Pool'.
src/db/pool.ts(58,12): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.

Found 2 errors in 1 file.
`;
    const insight = extractFailureInsights(output, 1);
    assert.equal(insight.errorType, "typescript");
    assert.ok(insight.errorMessage.includes("TS2339"), "has TS error code");
    assert.ok(insight.filesInvolved.includes("src/db/pool.ts"), "extracts file path");
    assert.ok(insight.rootCause.includes("TypeScript compilation failed"));
    assert.ok(insight.suggestion.includes("type"));
  });

  it("detects tsc-style error output", () => {
    const output = `error TS6133: 'unused' is declared but its value is never read.`;
    const insight = extractFailureInsights(output);
    assert.equal(insight.errorType, "typescript");
    assert.equal(insight.failedCommand, "tsc (TypeScript compiler)");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Test runner failures
// ══════════════════════════════════════════════════════════════════════════════

describe("extractFailureInsights: test failures", () => {
  it("detects node:test failure", () => {
    const output = `
▶ database pool
  ✔ creates a pool (2ms)
  ✖ handles connection timeout (5ms)
    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    + actual - expected
    + undefined
    - 'connected'
        at TestContext.<anonymous> (tests/db/pool.test.ts:42:12)

ℹ tests 2
ℹ pass 1
ℹ fail 1
`;
    const insight = extractFailureInsights(output, 1);
    assert.equal(insight.errorType, "test");
    assert.ok(insight.errorMessage.includes("AssertionError"), "has assertion error");
    assert.ok(insight.filesInvolved.some(f => f.includes("pool.test.ts")), "extracts test file");
    assert.ok(insight.suggestion.includes("test"));
  });

  it("detects FAIL keyword from jest/vitest", () => {
    const output = `
 FAIL  tests/utils.test.ts
  ● sum function › adds numbers correctly
    expect(received).toBe(expected)
    Expected: 5
    Received: 4
`;
    const insight = extractFailureInsights(output, 1);
    assert.equal(insight.errorType, "test");
    assert.ok(insight.filesInvolved.some(f => f.includes("utils.test.ts")));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Lint errors
// ══════════════════════════════════════════════════════════════════════════════

describe("extractFailureInsights: lint errors", () => {
  it("detects eslint errors", () => {
    const output = `
/home/user/project/src/api/routes.ts
  12:5  error  'req' is defined but never used  @typescript-eslint/no-unused-vars
  45:1  error  Missing return type on function  @typescript-eslint/explicit-function-return-type

✖ 2 problems (2 errors, 0 warnings)

ESLint found too many errors.
`;
    const insight = extractFailureInsights(output, 1);
    assert.equal(insight.errorType, "lint");
    assert.equal(insight.failedCommand, "eslint");
    assert.ok(insight.suggestion.includes("lint"));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Runtime errors
// ══════════════════════════════════════════════════════════════════════════════

describe("extractFailureInsights: runtime errors", () => {
  it("detects TypeError", () => {
    const output = `
TypeError: Cannot read properties of undefined (reading 'map')
    at processResults (src/handlers/search.ts:67:24)
    at async handleSearch (src/handlers/search.ts:42:18)
`;
    const insight = extractFailureInsights(output, 1);
    assert.equal(insight.errorType, "runtime");
    assert.ok(insight.errorMessage.includes("Cannot read properties of undefined"));
    assert.ok(insight.filesInvolved.some(f => f.includes("src/handlers/search.ts")));
    assert.ok(insight.rootCause.includes("Runtime error"));
  });

  it("detects ReferenceError", () => {
    const output = `ReferenceError: pgBouncer is not defined\n    at createPool (src/db/pool.ts:12:5)`;
    const insight = extractFailureInsights(output);
    assert.equal(insight.errorType, "runtime");
    assert.ok(insight.errorMessage.includes("pgBouncer is not defined"));
  });

  it("detects SyntaxError", () => {
    const output = `SyntaxError: Unexpected token '{' at src/config.ts:5:12`;
    const insight = extractFailureInsights(output);
    assert.equal(insight.errorType, "runtime");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Build / npm errors
// ══════════════════════════════════════════════════════════════════════════════

describe("extractFailureInsights: build errors", () => {
  it("detects npm ERR!", () => {
    const output = `
npm ERR! code ELIFECYCLE
npm ERR! errno 1
npm ERR! fifony@0.1.27 build: tsup
npm ERR! Exit status 1
`;
    const insight = extractFailureInsights(output, 1);
    assert.equal(insight.errorType, "build");
    assert.ok(insight.suggestion.includes("build") || insight.suggestion.includes("dependency"));
  });

  it("detects pnpm script failure", () => {
    const output = `pnpm run build failed with exit code 2\nERR! ELIFECYCLE`;
    const insight = extractFailureInsights(output, 2);
    assert.equal(insight.errorType, "build");
    assert.equal(insight.failedCommand, "pnpm build");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Git errors
// ══════════════════════════════════════════════════════════════════════════════

describe("extractFailureInsights: git errors", () => {
  it("detects git merge conflict", () => {
    const output = `
Auto-merging src/db/pool.ts
CONFLICT (content): Merge conflict in src/db/pool.ts
Automatic merge failed; fix conflicts and then commit the result.
`;
    const insight = extractFailureInsights(output, 1);
    assert.equal(insight.errorType, "git");
    assert.ok(insight.errorMessage.includes("CONFLICT"), "captures conflict message");
    assert.ok(insight.filesInvolved.some(f => f.includes("src/db/pool.ts")));
    assert.ok(insight.suggestion.includes("conflict"));
  });

  it("detects git fatal error", () => {
    const output = `fatal: not a git repository (or any of the parent directories): .git`;
    const insight = extractFailureInsights(output);
    assert.equal(insight.errorType, "git");
    assert.ok(insight.errorMessage.includes("fatal:"));
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Timeout / process killed
// ══════════════════════════════════════════════════════════════════════════════

describe("extractFailureInsights: timeout / process errors", () => {
  it("detects SIGTERM (process killed)", () => {
    const output = `Running agent...\n\nProcess received SIGTERM — killed after timeout.`;
    const insight = extractFailureInsights(output);
    assert.equal(insight.errorType, "timeout");
    assert.equal(insight.failedCommand, "process (timeout/killed)");
    assert.ok(insight.suggestion.includes("slow") || insight.suggestion.includes("simplify"));
  });

  it("detects timeout message", () => {
    const output = `Command timed out after 300s. No output for 5 minutes.`;
    const insight = extractFailureInsights(output);
    assert.equal(insight.errorType, "timeout");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// Unknown / fallback
// ══════════════════════════════════════════════════════════════════════════════

describe("extractFailureInsights: unknown errors", () => {
  it("returns process for non-zero exit code with no recognizable pattern", () => {
    const insight = extractFailureInsights("something went wrong but no pattern matches", 1);
    assert.equal(insight.errorType, "process");
  });

  it("returns unknown for no exit code and no recognizable pattern", () => {
    const insight = extractFailureInsights("something happened but no pattern matches");
    assert.equal(insight.errorType, "unknown");
  });

  it("returns process type when exit code is non-zero but no pattern", () => {
    const insight = extractFailureInsights("", 42);
    assert.equal(insight.errorType, "process");
    assert.ok(insight.rootCause.includes("42"), "includes exit code");
  });

  it("handles empty output gracefully", () => {
    const insight = extractFailureInsights("");
    assert.equal(insight.errorType, "unknown");
    assert.equal(insight.filesInvolved.length, 0);
  });

  it("handles null/undefined exit code", () => {
    const insight = extractFailureInsights("some output", null);
    assert.equal(insight.errorType, "unknown");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// File path extraction
// ══════════════════════════════════════════════════════════════════════════════

describe("extractFailureInsights: file extraction", () => {
  it("extracts multiple file paths from stack trace", () => {
    const output = `
Error: Connection failed
    at Pool.connect (src/db/pool.ts:42:5)
    at Retry.attempt (src/utils/retry.ts:18:12)
    at main (src/index.ts:10:3)
`;
    const insight = extractFailureInsights(output);
    assert.ok(insight.filesInvolved.includes("src/db/pool.ts"));
    assert.ok(insight.filesInvolved.includes("src/utils/retry.ts"));
    assert.ok(insight.filesInvolved.includes("src/index.ts"));
  });

  it("ignores node_modules paths", () => {
    const output = `at Object.<anonymous> (node_modules/pg/lib/pool.js:42:5)\nat Pool (src/db/pool.ts:10:3)`;
    const insight = extractFailureInsights(output);
    assert.ok(!insight.filesInvolved.some(f => f.includes("node_modules")), "no node_modules");
    assert.ok(insight.filesInvolved.includes("src/db/pool.ts"), "project file included");
  });

  it("extracts test file paths", () => {
    const output = `FAIL tests/db/pool.test.ts\n  ✖ some test`;
    const insight = extractFailureInsights(output);
    assert.ok(insight.filesInvolved.some(f => f.includes("tests/db/pool.test.ts")));
  });

  it("limits extracted paths to 10", () => {
    const paths = Array.from({ length: 20 }, (_, i) => `src/file${i}/index.ts`);
    const output = paths.map(p => `at func (${p}:1:1)`).join("\n");
    const insight = extractFailureInsights(output);
    assert.ok(insight.filesInvolved.length <= 10, "should cap at 10 paths");
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// End-to-end: real CLI output → insights (no buildEnrichedRetryContext — dead code removed)
// ══════════════════════════════════════════════════════════════════════════════

describe("end-to-end: output → insight extraction", () => {
  it("TypeScript failure produces actionable insight", () => {
    const rawOutput = `
> pnpm typecheck

src/db/pool.ts(42,5): error TS2339: Property 'connect' does not exist on type 'PoolConfig'.
src/db/pool.ts(58,12): error TS2345: Argument of type 'string' is not assignable.

Found 2 errors in 1 file.
 ELIFECYCLE  Command failed with exit code 2.
`;
    const insight = extractFailureInsights(rawOutput, 2);
    assert.equal(insight.errorType, "typescript");
    assert.ok(insight.filesInvolved.includes("src/db/pool.ts"));
    assert.ok(insight.suggestion.length > 0);
  });

  it("test failure produces actionable insight", () => {
    const rawOutput = `
▶ database pool
  ✔ creates a pool (2ms)
  ✖ handles connection timeout (15ms)
    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
        at TestContext.<anonymous> (tests/db/pool.test.ts:42:12)

ℹ tests 2
ℹ pass 1
ℹ fail 1
`;
    const insight = extractFailureInsights(rawOutput, 1);
    assert.equal(insight.errorType, "test");
    assert.ok(insight.filesInvolved.some(f => f.includes("pool.test.ts")));
  });

  it("git conflict produces actionable insight with all conflicting files", () => {
    const rawOutput = `
Auto-merging src/config.ts
CONFLICT (content): Merge conflict in src/config.ts
Auto-merging src/routes.ts
CONFLICT (content): Merge conflict in src/routes.ts
Automatic merge failed; fix conflicts and then commit the result.
`;
    const insight = extractFailureInsights(rawOutput, 1);
    assert.equal(insight.errorType, "git");
    assert.ok(insight.filesInvolved.length >= 2, "extracts both conflicting files");
  });
});
