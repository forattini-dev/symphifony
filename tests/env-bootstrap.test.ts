import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherEnvironmentSnapshot } from "../src/domains/env-bootstrap.ts";

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "fifony-env-bootstrap-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "bootstrap-workspace",
    workspaces: ["packages/*"],
  }, null, 2), "utf8");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeFileSync(join(dir, ".env.local"), "SECRET_TOKEN=shh-keep-me-hidden\n", "utf8");
  mkdirSync(join(dir, "packages"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const boot = true;\n", "utf8");
  return dir;
}

describe("environment bootstrap", () => {
  it("generates deterministic snapshot with monorepo and secret-safe sections", () => {
    const workspace = makeWorkspace();
    try {
      const snapshot = gatherEnvironmentSnapshot(workspace, { maxSize: 4_000 });
      assert.match(snapshot, /Working Directory/);
      assert.match(snapshot, /Detected Build & Config Files/);
      assert.match(snapshot, /package\.json/);
      assert.match(snapshot, /pnpm-lock\.yaml/);
      assert.match(snapshot, /root workspaces: packages\/\*/);
      assert.match(snapshot, /\.env\.local/);
      assert.doesNotMatch(snapshot, /SECRET_TOKEN=shh-keep-me-hidden/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("enforces size budget deterministically", () => {
    const workspace = makeWorkspace();
    try {
      for (let index = 0; index < 40; index += 1) {
        writeFileSync(join(workspace, `file-${index}.txt`), "x\n", "utf8");
      }
      const snapshot = gatherEnvironmentSnapshot(workspace, { maxSize: 240 });
      assert.ok(snapshot.length <= 240, "snapshot should respect configured max size");
      assert.match(snapshot, /\[\.\.\.truncated\]/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("times out slow tool commands and continues with remaining sections", () => {
    const workspace = makeWorkspace();
    const binDir = mkdtempSync(join(tmpdir(), "fifony-env-bin-"));
    const originalPath = process.env.PATH ?? "";
    try {
      writeFileSync(join(binDir, "node"), "#!/bin/sh\nsleep 2\necho vslow\n", "utf8");
      chmodSync(join(binDir, "node"), 0o755);
      process.env.PATH = `${binDir}:${originalPath}`;

      const snapshot = gatherEnvironmentSnapshot(workspace, { timeout: 10, maxSize: 4_000 });
      assert.match(snapshot, /Package Manager Signals/);
      assert.doesNotMatch(snapshot, /^- node:/m);
    } finally {
      process.env.PATH = originalPath;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
