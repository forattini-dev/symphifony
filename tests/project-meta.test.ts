import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeState } from "../src/domains/issues.ts";
import { deriveConfig } from "../src/domains/config.ts";
import {
  SETTING_ID_PROJECT_NAME,
  buildQueueTitle as buildBackendQueueTitle,
  detectProjectName,
  resolveProjectMetadata,
} from "../src/domains/project.ts";
import {
  buildProjectDraft,
  buildQueueTitle as buildFrontendQueueTitle,
  resolveProjectMeta,
} from "../app/src/project-meta.js";

describe("backend project metadata", () => {
  it("prioritizes the saved project name over cwd detection", () => {
    const metadata = resolveProjectMetadata([
      {
        id: SETTING_ID_PROJECT_NAME,
        scope: "system",
        value: "Acme Control",
        source: "user",
        updatedAt: "2026-03-19T00:00:00.000Z",
      },
    ], "/workspaces/fallback-name");

    assert.equal(metadata.projectName, "Acme Control");
    assert.equal(metadata.detectedProjectName, "fallback-name");
    assert.equal(metadata.projectNameSource, "saved");
    assert.equal(metadata.queueTitle, "fifony: Acme Control");
  });

  it("falls back to the current directory name when no saved config exists", () => {
    const metadata = resolveProjectMetadata([], "/tmp/my-service");

    assert.equal(metadata.projectName, "my-service");
    assert.equal(metadata.detectedProjectName, "my-service");
    assert.equal(metadata.projectNameSource, "detected");
    assert.equal(metadata.queueTitle, "fifony: my-service");
  });

  it("keeps compatibility with a legacy saved project setting", () => {
    const metadata = resolveProjectMetadata([
      {
        id: "runtime.projectName",
        scope: "runtime",
        value: "Legacy Workspace",
        source: "user",
        updatedAt: "2026-03-19T00:00:00.000Z",
      },
    ], "/tmp/current-dir");

    assert.equal(metadata.projectName, "Legacy Workspace");
    assert.equal(metadata.detectedProjectName, "current-dir");
    assert.equal(metadata.projectNameSource, "saved");
    assert.equal(metadata.queueTitle, "fifony: Legacy Workspace");
  });

  it("returns missing metadata when detection fails", () => {
    const metadata = resolveProjectMetadata([], "");

    assert.equal(metadata.projectName, "");
    assert.equal(metadata.detectedProjectName, "");
    assert.equal(metadata.projectNameSource, "missing");
    assert.equal(metadata.queueTitle, "fifony");
  });

  it("applies resolved project metadata to runtime state", () => {
    const projectMetadata = resolveProjectMetadata([
      {
        id: SETTING_ID_PROJECT_NAME,
        scope: "system",
        value: "Platform Ops",
        source: "user",
        updatedAt: "2026-03-19T00:00:00.000Z",
      },
    ], "/tmp/fallback");

    const state = buildRuntimeState(null, deriveConfig([]), projectMetadata);

    assert.equal(state.projectName, "Platform Ops");
    assert.equal(state.detectedProjectName, "fallback");
    assert.equal(state.projectNameSource, "saved");
    assert.equal(state.queueTitle, "fifony: Platform Ops");
  });

  it("normalizes queue titles consistently", () => {
    assert.equal(buildBackendQueueTitle("  Data   Platform  "), "fifony: Data Platform");
    assert.equal(detectProjectName("/srv/demo-app/"), "demo-app");
  });
});

describe("frontend project metadata", () => {
  it("builds onboarding draft from saved value first", () => {
    const draft = buildProjectDraft({
      savedProjectName: "Studio Core",
      detectedProjectName: "workspace-name",
    });

    assert.equal(draft.projectName, "Studio Core");
    assert.equal(draft.detectedProjectName, "workspace-name");
    assert.equal(draft.source, "saved");
    assert.equal(draft.requiresManualEntry, false);
  });

  it("requires manual input when no saved or detected name is available", () => {
    const draft = buildProjectDraft();

    assert.equal(draft.projectName, "");
    assert.equal(draft.source, "missing");
    assert.equal(draft.requiresManualEntry, true);
  });

  it("resolves frontend queue title from persisted settings", () => {
    const meta = resolveProjectMeta([
      { id: "system.projectName", value: "Billing Console" },
    ], {
      sourceRepoUrl: "/workspaces/billing-console",
      projectName: "billing-console",
      detectedProjectName: "billing-console",
      projectNameSource: "detected",
    });

    assert.equal(meta.projectName, "Billing Console");
    assert.equal(meta.detectedProjectName, "billing-console");
    assert.equal(meta.source, "saved");
    assert.equal(meta.queueTitle, "fifony: Billing Console");
  });

  it("uses the required final title format", () => {
    assert.equal(buildFrontendQueueTitle("  Queue   Alpha  "), "fifony: Queue Alpha");
  });
});
