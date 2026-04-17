/**
 * LLM Wiki — persistent compounding knowledge base, maintained by claude CLI.
 *
 * Layers:
 *   - Raw sources (immutable): completed issue artifacts already stored in `.fifony/`.
 *   - Wiki (`.fifony/wiki/`): markdown files written/updated by the curator agent.
 *   - Schema (`.fifony/wiki/SCHEMA.md`): conventions the curator follows.
 *
 * This module owns filesystem layout, schema bootstrap, and append-only logging.
 * Spawn/CLI orchestration lives in the curator adapter (separate concern).
 */

import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WIKI_ROOT } from "../concerns/constants.ts";
import { logger } from "../concerns/logger.ts";

const WIKI_SUBDIRS = ["modules", "files", "features", "patterns", "gotchas"] as const;

export const WIKI_PATHS = {
  root: WIKI_ROOT,
  schema: join(WIKI_ROOT, "SCHEMA.md"),
  index: join(WIKI_ROOT, "index.md"),
  log: join(WIKI_ROOT, "log.md"),
  modules: join(WIKI_ROOT, "modules"),
  files: join(WIKI_ROOT, "files"),
  features: join(WIKI_ROOT, "features"),
  patterns: join(WIKI_ROOT, "patterns"),
  gotchas: join(WIKI_ROOT, "gotchas"),
} as const;

export type WikiLogKind = "ingest" | "query" | "lint";

const SCHEMA_TEMPLATE = `# Wiki Schema

You maintain a persistent knowledge wiki for this project. You read raw issue
artifacts (plans, execution transcripts, review reports, diffs) and integrate
the lasting knowledge into a compounding set of markdown pages. The wiki is
the long-term memory shared across all future planning, execution, and review.

## Layout

\`\`\`
.fifony/wiki/
  SCHEMA.md          ← this file
  index.md           ← catalog of all pages, by category, with one-line summaries
  log.md             ← append-only chronological record of ingest/query/lint runs
  modules/<name>.md  ← per logical module: purpose, conventions, gotchas
  files/<safe>.md    ← hot files (touched repeatedly): invariants, recurring bugs
  features/<name>.md ← cross-cutting features/areas: history, decisions
  patterns/<name>.md ← recurring failure or success patterns worth remembering
  gotchas/<name>.md  ← race conditions, env quirks, foot-guns
\`\`\`

File names are kebab-case. \`files/\` use the path with \`/\` replaced by \`__\`.

## Page format

Each page starts with YAML frontmatter:

\`\`\`yaml
---
type: module | file | feature | pattern | gotcha
title: Human-readable title
sources: [issue-identifier, …]   # issues that contributed to this page
pinned: false                    # true = lint will not flag as stale
updated: YYYY-MM-DD
---
\`\`\`

Body is freeform markdown. Use \`[[wiki-link]]\` style cross-refs to other pages.

## Operations

### Ingest

Triggered on issue merge. Input: the issue artifact bundle. Process:
1. Read the issue's plan, execution transcript, grading report, diff stat.
2. Identify which existing pages are affected (modules touched, files changed,
   features impacted) and which new pages are needed.
3. For each affected page: update — don't overwrite. Preserve prior knowledge,
   integrate the new findings, mark contradictions explicitly.
4. Append a one-line entry to log.md:
   \`## [YYYY-MM-DD] ingest | <issue-identifier> | <one-line summary>\`
5. Refresh index.md if pages were added.

A typical ingest touches 5–15 pages. Don't be lazy — the wiki only stays useful
if cross-references are kept current.

### Query

When asked to surface relevant context for a new issue, read index.md first,
identify candidate pages by topic and touched files, drill into them, and
return a synthesized digest. Cite the pages you used. Don't re-derive from
raw sources unless the wiki has gaps — fill the gap as a side effect.

### Lint

Periodic health check. Look for: contradictions between pages, claims
superseded by newer issues, orphan pages with no inbound links, missing
cross-refs, important concepts mentioned but lacking their own page.
File findings as a new fifony issue if action is warranted; otherwise patch
in place.

## Conventions

- Be terse. The wiki is read by humans and by other LLM sessions; both prefer
  signal over prose. Lead with the conclusion. Cite the issue identifier.
- Never delete content silently. Mark superseded claims with \`<!-- superseded by <issue> -->\`.
- Pages with \`pinned: true\` survive lint cleanups. Use sparingly.
- The raw issue artifacts are the source of truth. The wiki is a derived,
  maintained synthesis. If the two ever conflict, raw wins and the wiki page
  needs an update entry in log.md.
`;

export function ensureWikiInitialized(): boolean {
  if (!existsSync(WIKI_PATHS.root)) {
    mkdirSync(WIKI_PATHS.root, { recursive: true });
    logger.info({ path: WIKI_PATHS.root }, "[Wiki] Created wiki root");
  }
  for (const sub of WIKI_SUBDIRS) {
    const dir = join(WIKI_PATHS.root, sub);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  let bootstrapped = false;
  if (!existsSync(WIKI_PATHS.schema)) {
    writeFileSync(WIKI_PATHS.schema, SCHEMA_TEMPLATE, "utf8");
    bootstrapped = true;
  }
  if (!existsSync(WIKI_PATHS.index)) {
    writeFileSync(
      WIKI_PATHS.index,
      "# Wiki Index\n\nNo pages yet. The curator will populate this as issues are ingested.\n",
      "utf8",
    );
    bootstrapped = true;
  }
  if (!existsSync(WIKI_PATHS.log)) {
    writeFileSync(
      WIKI_PATHS.log,
      "# Wiki Log\n\nChronological record of curator activity. Newest entries appended below.\n\n",
      "utf8",
    );
    bootstrapped = true;
  }

  if (bootstrapped) {
    logger.info({ path: WIKI_PATHS.root }, "[Wiki] Bootstrapped schema/index/log");
  }
  return bootstrapped;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function appendWikiLog(kind: WikiLogKind, subject: string, summary: string): void {
  ensureWikiInitialized();
  const line = `## [${todayStamp()}] ${kind} | ${subject} | ${summary.replace(/\n+/g, " ").trim()}\n`;
  appendFileSync(WIKI_PATHS.log, line, "utf8");
}

export function readWikiIndex(): string | null {
  ensureWikiInitialized();
  try {
    return readFileSync(WIKI_PATHS.index, "utf8");
  } catch {
    return null;
  }
}

export interface WikiStats {
  initialized: boolean;
  pageCount: number;
  lastModified: number | null;
}

export function wikiStats(): WikiStats {
  if (!existsSync(WIKI_PATHS.root)) {
    return { initialized: false, pageCount: 0, lastModified: null };
  }
  let count = 0;
  let latest = 0;
  for (const sub of WIKI_SUBDIRS) {
    const dir = join(WIKI_PATHS.root, sub);
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        count += 1;
        const mtime = statSync(join(dir, entry)).mtimeMs;
        if (mtime > latest) latest = mtime;
      }
    } catch {}
  }
  return { initialized: true, pageCount: count, lastModified: latest || null };
}
