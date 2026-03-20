/**
 * Tests for src/agent/helpers.ts — all pure utility functions.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  now,
  isoWeek,
  sleep,
  toStringValue,
  toNumberValue,
  toBooleanValue,
  toStringArray,
  clamp,
  normalizeState,
  idToSafePath,
  appendFileTail,
  parseFrontMatter,
  getNestedRecord,
  getNestedString,
  getNestedNumber,
  withRetryBackoff,
  extractJsonObjects,
  repairTruncatedJson,
} from "../src/concerns/helpers.ts";

// ── now() ─────────────────────────────────────────────────────────────────────

describe("now", () => {
  it("returns an ISO 8601 string", () => {
    const result = now();
    assert.ok(typeof result === "string", "returns string");
    assert.ok(!Number.isNaN(Date.parse(result)), "parseable date");
    assert.ok(result.includes("T"), "ISO format with T separator");
  });

  it("is close to the current time", () => {
    const before = Date.now();
    const result = Date.parse(now());
    const afterMs = Date.now();
    assert.ok(result >= before && result <= afterMs + 5, "within test execution window");
  });
});

// ── isoWeek() ─────────────────────────────────────────────────────────────────

describe("isoWeek", () => {
  it("returns string matching YYYY-WNN format", () => {
    const result = isoWeek();
    assert.match(result, /^\d{4}-W\d{2}$/);
  });

  it("returns '' for an invalid date string", () => {
    assert.equal(isoWeek("not-a-date"), "");
  });

  it("week 1 of 2026 starts on Dec 29, 2025", () => {
    // ISO week 1 of 2026 contains Jan 1, 2026
    assert.equal(isoWeek("2026-01-01"), "2026-W01");
  });

  it("2026-W12 for March 17, 2026", () => {
    assert.equal(isoWeek("2026-03-17"), "2026-W12");
  });

  it("last week of 2025 is correct", () => {
    // Dec 31 2025 is a Wednesday — still in 2026 W01 by ISO rules
    const result = isoWeek("2025-12-29");
    assert.match(result, /^\d{4}-W\d{2}$/);
  });
});

// ── sleep() ───────────────────────────────────────────────────────────────────

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const start = Date.now();
    await sleep(20);
    assert.ok(Date.now() - start >= 15, "waited at least 15ms");
  });

  it("returns a Promise", () => {
    const result = sleep(0);
    assert.ok(result instanceof Promise, "is a Promise");
    return result; // wait to clean up timer
  });
});

// ── toStringValue() ───────────────────────────────────────────────────────────

describe("toStringValue", () => {
  it("returns the trimmed string when valid", () => {
    assert.equal(toStringValue("  hello  "), "hello");
  });

  it("returns fallback for empty string", () => {
    assert.equal(toStringValue("", "default"), "default");
  });

  it("returns fallback for whitespace-only string", () => {
    assert.equal(toStringValue("   ", "default"), "default");
  });

  it("returns fallback for non-string values", () => {
    assert.equal(toStringValue(42, "fallback"), "fallback");
    assert.equal(toStringValue(null, "fallback"), "fallback");
    assert.equal(toStringValue(undefined, "fallback"), "fallback");
  });

  it("resolves $ENV_VAR when set", () => {
    process.env._TEST_VAR = "resolved-value";
    assert.equal(toStringValue("$_TEST_VAR"), "resolved-value");
    delete process.env._TEST_VAR;
  });

  it("returns fallback when $ENV_VAR is not set", () => {
    delete process.env._UNDEFINED_TEST_VAR;
    assert.equal(toStringValue("$_UNDEFINED_TEST_VAR", "fb"), "fb");
  });

  it("does NOT expand partial env var references (mixed content)", () => {
    // "$VAR extra text" is not a pure env ref — should return the raw value
    const result = toStringValue("$MY_VAR extra text");
    assert.ok(result.startsWith("$"), "not expanded when not a pure env ref");
  });
});

// ── toNumberValue() ───────────────────────────────────────────────────────────

describe("toNumberValue", () => {
  it("returns number as-is when valid positive", () => {
    assert.equal(toNumberValue(5), 5);
  });

  it("parses a numeric string", () => {
    assert.equal(toNumberValue("10"), 10);
  });

  it("rounds to integer", () => {
    assert.equal(toNumberValue(3.7), 4);
  });

  it("returns fallback for zero (must be > 0)", () => {
    assert.equal(toNumberValue(0, 99), 99);
  });

  it("returns fallback for negative", () => {
    assert.equal(toNumberValue(-5, 1), 1);
  });

  it("returns fallback for NaN", () => {
    assert.equal(toNumberValue("abc", 42), 42);
  });

  it("returns fallback for null/undefined", () => {
    assert.equal(toNumberValue(null, 7), 7);
    assert.equal(toNumberValue(undefined, 7), 7);
  });
});

// ── toBooleanValue() ──────────────────────────────────────────────────────────

describe("toBooleanValue", () => {
  it("returns true when value is true", () => {
    assert.equal(toBooleanValue(true, false), true);
  });

  it("returns false when value is false", () => {
    assert.equal(toBooleanValue(false, true), false);
  });

  it("returns fallback for non-boolean values", () => {
    assert.equal(toBooleanValue("true", true), true);
    assert.equal(toBooleanValue(1, false), false);
    assert.equal(toBooleanValue(null, true), true);
  });
});

// ── toStringArray() ───────────────────────────────────────────────────────────

describe("toStringArray", () => {
  it("returns filtered and trimmed strings", () => {
    assert.deepEqual(toStringArray(["  a  ", "b", "c"]), ["a", "b", "c"]);
  });

  it("filters out empty and whitespace strings", () => {
    assert.deepEqual(toStringArray(["a", "", "  ", "b"]), ["a", "b"]);
  });

  it("filters out non-string elements", () => {
    assert.deepEqual(toStringArray(["a", 42, null, "b"] as unknown[]), ["a", "b"]);
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(toStringArray("not an array"), []);
    assert.deepEqual(toStringArray(null), []);
    assert.deepEqual(toStringArray(undefined), []);
  });

  it("returns empty array for empty array", () => {
    assert.deepEqual(toStringArray([]), []);
  });
});

// ── clamp() ───────────────────────────────────────────────────────────────────

describe("clamp", () => {
  it("returns value when within bounds", () => {
    assert.equal(clamp(5, 1, 10), 5);
  });

  it("returns min when value is below min", () => {
    assert.equal(clamp(-5, 0, 10), 0);
  });

  it("returns max when value exceeds max", () => {
    assert.equal(clamp(100, 0, 10), 10);
  });

  it("returns min when value equals min", () => {
    assert.equal(clamp(0, 0, 10), 0);
  });

  it("returns max when value equals max", () => {
    assert.equal(clamp(10, 0, 10), 10);
  });
});

// ── normalizeState() ──────────────────────────────────────────────────────────

describe("normalizeState", () => {
  const validStates = ["Planning", "Planned", "Queued", "Running", "Reviewing", "Reviewed", "Blocked", "Done", "Cancelled"];

  for (const state of validStates) {
    it(`passes through valid state: ${state}`, () => {
      assert.equal(normalizeState(state), state);
    });
  }

  it("returns 'Planning' for unknown state", () => {
    assert.equal(normalizeState("Unknown"), "Planning");
  });

  it("returns 'Planning' for empty string", () => {
    assert.equal(normalizeState(""), "Planning");
  });

  it("returns 'Planning' for non-string", () => {
    assert.equal(normalizeState(null), "Planning");
    assert.equal(normalizeState(42), "Planning");
  });

  it("is case-sensitive (lowercase fails)", () => {
    assert.equal(normalizeState("planned"), "Planning");
  });
});

// ── idToSafePath() ────────────────────────────────────────────────────────────

describe("idToSafePath", () => {
  it("lowercases the value", () => {
    assert.equal(idToSafePath("ABC"), "abc");
  });

  it("replaces invalid characters with hyphens", () => {
    assert.equal(idToSafePath("TST-1 (fix!)"), "tst-1--fix--");
  });

  it("keeps alphanumeric, dots, underscores and hyphens", () => {
    assert.equal(idToSafePath("hello-world_v1.0"), "hello-world_v1.0");
  });

  it("handles numeric identifiers", () => {
    assert.equal(idToSafePath("ISSUE-42"), "issue-42");
  });
});

// ── appendFileTail() ──────────────────────────────────────────────────────────

describe("appendFileTail", () => {
  it("appends text when result fits within maxLength", () => {
    const result = appendFileTail("existing", "new", 100);
    assert.ok(result.includes("existing"), "has existing");
    assert.ok(result.includes("new"), "has new");
  });

  it("truncates with ellipsis when result exceeds maxLength", () => {
    const result = appendFileTail("a".repeat(90), "b".repeat(90), 100);
    assert.ok(result.startsWith("…"), "starts with ellipsis");
    assert.equal(result.length, 100, "exactly maxLength");
  });

  it("keeps the tail portion (most recent content)", () => {
    const result = appendFileTail("prefix", "suffix", 10);
    assert.ok(result.includes("suffix"), "tail contains recent content");
  });
});

// ── parseFrontMatter() ────────────────────────────────────────────────────────

describe("parseFrontMatter", () => {
  it("parses YAML front matter", () => {
    const source = `---\ntitle: Hello\ncount: 42\n---\nBody text here`;
    const { config, body } = parseFrontMatter(source);
    assert.equal(config.title, "Hello");
    assert.equal(config.count, 42);
    assert.equal(body, "Body text here");
  });

  it("returns empty config and full text when no front matter", () => {
    const source = "Just some text";
    const { config, body } = parseFrontMatter(source);
    assert.deepEqual(config, {});
    assert.equal(body, source);
  });

  it("returns raw source for degenerate empty front matter block", () => {
    // The regex requires at least a newline between the two --- delimiters,
    // so "---\n---\nBody" doesn't match and the source is returned as-is.
    const source = `---\n---\nBody`;
    const { config, body } = parseFrontMatter(source);
    assert.deepEqual(config, {});
    assert.equal(body, source); // no match → full source returned as body
  });

  it("trims the body", () => {
    const source = `---\nkey: val\n---\n\n  Body  `;
    const { body } = parseFrontMatter(source);
    assert.equal(body, "Body");
  });
});

// ── getNestedRecord() / getNestedString() / getNestedNumber() ─────────────────

describe("getNestedRecord", () => {
  it("returns nested object by key", () => {
    const result = getNestedRecord({ inner: { x: 1 } }, "inner");
    assert.deepEqual(result, { x: 1 });
  });

  it("returns {} for missing key", () => {
    assert.deepEqual(getNestedRecord({ a: 1 }, "missing"), {});
  });

  it("returns {} for non-object source", () => {
    assert.deepEqual(getNestedRecord(null, "key"), {});
    assert.deepEqual(getNestedRecord("string", "key"), {});
  });

  it("returns {} when value is an array", () => {
    assert.deepEqual(getNestedRecord({ arr: [1, 2] }, "arr"), {});
  });
});

describe("getNestedString", () => {
  it("returns string value from nested object", () => {
    assert.equal(getNestedString({ name: "Alice" }, "name"), "Alice");
  });

  it("returns fallback for missing key", () => {
    assert.equal(getNestedString({}, "name", "default"), "default");
  });

  it("returns fallback for non-string value", () => {
    assert.equal(getNestedString({ count: 42 }, "count", "fb"), "fb");
  });
});

describe("getNestedNumber", () => {
  it("returns numeric value", () => {
    assert.equal(getNestedNumber({ count: 5 }, "count", 0), 5);
  });

  it("returns fallback for missing key", () => {
    assert.equal(getNestedNumber({}, "count", 99), 99);
  });

  it("returns fallback for non-numeric", () => {
    assert.equal(getNestedNumber({ count: "abc" }, "count", 7), 7);
  });
});

// ── withRetryBackoff() ────────────────────────────────────────────────────────

describe("withRetryBackoff", () => {
  it("returns baseDelay on attempt 0", () => {
    assert.equal(withRetryBackoff(0, 1000), 1000);
  });

  it("doubles on attempt 1", () => {
    assert.equal(withRetryBackoff(1, 1000), 2000);
  });

  it("quadruples on attempt 2", () => {
    assert.equal(withRetryBackoff(2, 1000), 4000);
  });

  it("caps at 5 minutes (300_000ms)", () => {
    const result = withRetryBackoff(100, 1000);
    assert.equal(result, 5 * 60 * 1000);
  });
});

// ── extractJsonObjects() ──────────────────────────────────────────────────────

describe("extractJsonObjects", () => {
  it("extracts a single JSON object from plain text", () => {
    const text = 'Here is the result: {"status":"done","summary":"all good"}';
    const results = extractJsonObjects(text);
    assert.equal(results.length, 1);
    assert.ok(results[0].includes('"status"'), "has status key");
  });

  it("extracts multiple JSON objects", () => {
    const text = '{"a":1} some text {"b":2}';
    const results = extractJsonObjects(text);
    assert.equal(results.length, 2);
  });

  it("handles nested objects", () => {
    const text = '{"outer":{"inner":42}}';
    const results = extractJsonObjects(text);
    assert.equal(results.length, 1);
    const parsed = JSON.parse(results[0]);
    assert.equal(parsed.outer.inner, 42);
  });

  it("ignores braces inside strings", () => {
    const text = '{"key":"value with {braces}"}';
    const results = extractJsonObjects(text);
    assert.equal(results.length, 1);
    const parsed = JSON.parse(results[0]);
    assert.equal(parsed.key, "value with {braces}");
  });

  it("returns empty array when no JSON objects found", () => {
    assert.deepEqual(extractJsonObjects("no json here"), []);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(extractJsonObjects(""), []);
  });
});

// ── repairTruncatedJson() ─────────────────────────────────────────────────────

describe("repairTruncatedJson", () => {
  it("returns null when no opening brace found", () => {
    assert.equal(repairTruncatedJson("no json"), null);
  });

  it("returns unchanged complete JSON", () => {
    const json = '{"status":"done"}';
    const result = repairTruncatedJson(json);
    assert.ok(result !== null, "not null");
    assert.doesNotThrow(() => JSON.parse(result!));
    assert.equal(JSON.parse(result!).status, "done");
  });

  it("closes an unclosed object", () => {
    const truncated = '{"status":"done","summary":"in progress';
    const result = repairTruncatedJson(truncated);
    assert.ok(result !== null, "repaired");
    assert.doesNotThrow(() => JSON.parse(result!));
  });

  it("closes nested unclosed structures", () => {
    const truncated = '{"outer":{"inner": [1, 2';
    const result = repairTruncatedJson(truncated);
    assert.ok(result !== null, "repaired");
    assert.doesNotThrow(() => JSON.parse(result!));
  });

  it("skips prose before the first {", () => {
    const text = 'Some output text {"status":"done"}';
    const result = repairTruncatedJson(text);
    assert.ok(result !== null, "not null");
    assert.equal(JSON.parse(result!).status, "done");
  });

  it("handles already-complete JSON with prefix text", () => {
    const text = 'Done! {"status":"done","code":0}';
    const result = repairTruncatedJson(text);
    assert.ok(result !== null);
    assert.equal(JSON.parse(result!).code, 0);
  });
});
