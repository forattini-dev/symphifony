import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempRoot: string;

before(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "fifony-wiki-test-"));
  process.env.FIFONY_PERSISTENCE = tempRoot;
});

after(() => {
  delete process.env.FIFONY_PERSISTENCE;
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test("ensureWikiInitialized creates dirs, schema, index, log", async () => {
  const { ensureWikiInitialized, WIKI_PATHS } = await import("../src/domains/wiki.ts");
  const bootstrapped = ensureWikiInitialized();
  assert.equal(bootstrapped, true);
  assert.ok(existsSync(WIKI_PATHS.root));
  assert.ok(existsSync(WIKI_PATHS.schema));
  assert.ok(existsSync(WIKI_PATHS.index));
  assert.ok(existsSync(WIKI_PATHS.log));
  assert.ok(existsSync(WIKI_PATHS.modules));
  assert.ok(existsSync(WIKI_PATHS.files));
  assert.ok(existsSync(WIKI_PATHS.features));
  assert.ok(existsSync(WIKI_PATHS.patterns));
  assert.ok(existsSync(WIKI_PATHS.gotchas));

  const schema = readFileSync(WIKI_PATHS.schema, "utf8");
  assert.match(schema, /Wiki Schema/);
});

test("ensureWikiInitialized is idempotent and does not overwrite", async () => {
  const { ensureWikiInitialized, WIKI_PATHS } = await import("../src/domains/wiki.ts");
  writeFileSync(WIKI_PATHS.schema, "USER EDITED SCHEMA", "utf8");
  const bootstrapped = ensureWikiInitialized();
  assert.equal(bootstrapped, false);
  const schema = readFileSync(WIKI_PATHS.schema, "utf8");
  assert.equal(schema, "USER EDITED SCHEMA");
});

test("appendWikiLog formats lines for grep", async () => {
  const { appendWikiLog, WIKI_PATHS } = await import("../src/domains/wiki.ts");
  appendWikiLog("ingest", "ISSUE-42", "added auth refactor notes");
  appendWikiLog("query", "ISSUE-43", "consulted patterns/auth-flow");
  const log = readFileSync(WIKI_PATHS.log, "utf8");
  assert.match(log, /^## \[\d{4}-\d{2}-\d{2}\] ingest \| ISSUE-42 \| added auth refactor notes$/m);
  assert.match(log, /^## \[\d{4}-\d{2}-\d{2}\] query \| ISSUE-43 \| consulted patterns\/auth-flow$/m);
});

test("appendWikiLog flattens multi-line summary", async () => {
  const { appendWikiLog, WIKI_PATHS } = await import("../src/domains/wiki.ts");
  appendWikiLog("lint", "weekly", "found contradiction\nbetween modules/foo and gotchas/bar");
  const log = readFileSync(WIKI_PATHS.log, "utf8");
  assert.match(log, /lint \| weekly \| found contradiction between modules\/foo and gotchas\/bar/);
});

test("readWikiIndex returns the file content", async () => {
  const { readWikiIndex, WIKI_PATHS } = await import("../src/domains/wiki.ts");
  writeFileSync(WIKI_PATHS.index, "# Custom Index\n- [foo](modules/foo.md) — bar\n", "utf8");
  const content = readWikiIndex();
  assert.match(content ?? "", /Custom Index/);
});

test("wikiStats counts pages across subdirs", async () => {
  const { wikiStats, WIKI_PATHS } = await import("../src/domains/wiki.ts");
  writeFileSync(join(WIKI_PATHS.modules, "alpha.md"), "x", "utf8");
  writeFileSync(join(WIKI_PATHS.files, "src__foo.md"), "y", "utf8");
  writeFileSync(join(WIKI_PATHS.patterns, "retry-loop.md"), "z", "utf8");
  // non-md sibling that should be ignored
  writeFileSync(join(WIKI_PATHS.modules, "ignore.txt"), "n", "utf8");
  const stats = wikiStats();
  assert.equal(stats.initialized, true);
  assert.equal(stats.pageCount, 3);
  assert.ok(stats.lastModified !== null);
});
