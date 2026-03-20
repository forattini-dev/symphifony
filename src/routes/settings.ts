import type { JsonRecord, RuntimeState, RuntimeSettingScope, RuntimeSettingSource } from "../types.ts";
import { logger } from "../concerns/logger.ts";
import { now, clamp } from "../concerns/helpers.ts";
import { addEvent } from "../domains/issues.ts";
import { persistState } from "../persistence/store.ts";
import { detectAvailableProviders, discoverModels } from "../agents/providers.ts";
import { resolveProjectMetadata, SETTING_ID_PROJECT_NAME } from "../domains/project.ts";
import {
  applyPersistedSettings,
  buildDefaultWorkflowConfig,
  getWorkflowConfig,
  inferSettingScope,
  loadRuntimeSettings,
  persistSetting,
  persistWorkerConcurrencySetting,
  persistWorkflowConfig,
  RUNTIME_CONFIG_SETTING_IDS,
} from "../persistence/settings.ts";

const VALID_SETTING_SCOPES = new Set<RuntimeSettingScope>(["runtime", "providers", "ui", "system"]);
const VALID_SETTING_SOURCES = new Set<RuntimeSettingSource>(["user", "detected", "workflow", "system"]);

export function registerSettingsRoutes(
  app: any,
  state: RuntimeState,
): void {
  app.get("/api/settings", async (c: any) => {
    const settings = await loadRuntimeSettings();
    return c.json({ settings });
  });

  app.get("/api/settings/:id", async (c: any) => {
    const settingId = c.req?.param ? c.req.param("id") : "";
    const settings = await loadRuntimeSettings();
    const setting = settings.find((entry) => entry.id === settingId);
    if (!setting) {
      return c.json({ ok: false, error: "Setting not found" }, 404);
    }
    return c.json({ ok: true, setting });
  });

  app.post("/api/settings/:id", async (c: any) => {
    const settingId = c.req?.param ? c.req.param("id") : "";
    if (!settingId) {
      return c.json({ ok: false, error: "Setting id is required" }, 400);
    }

    const payload = await c.req.json() as JsonRecord;
    const scopeValue = typeof payload.scope === "string" ? payload.scope : inferSettingScope(settingId);
    const sourceValue = typeof payload.source === "string" ? payload.source : "user";

    if (!VALID_SETTING_SCOPES.has(scopeValue as RuntimeSettingScope)) {
      return c.json({ ok: false, error: "Invalid setting scope" }, 400);
    }

    if (!VALID_SETTING_SOURCES.has(sourceValue as RuntimeSettingSource)) {
      return c.json({ ok: false, error: "Invalid setting source" }, 400);
    }

    const setting = await persistSetting(settingId, payload.value, {
      scope: scopeValue as RuntimeSettingScope,
      source: sourceValue as RuntimeSettingSource,
    });
    if (settingId === SETTING_ID_PROJECT_NAME) {
      const settings = await loadRuntimeSettings();
      const projectMetadata = resolveProjectMetadata(settings, state.sourceRepoUrl);
      state.projectName = projectMetadata.projectName;
      state.detectedProjectName = projectMetadata.detectedProjectName;
      state.projectNameSource = projectMetadata.projectNameSource;
      state.queueTitle = projectMetadata.queueTitle;
      state.updatedAt = now();
      addEvent(state, undefined, "manual", `Project title updated to ${projectMetadata.queueTitle}.`);
      await persistState(state);
    }
    if (RUNTIME_CONFIG_SETTING_IDS.has(settingId)) {
      state.config = applyPersistedSettings(state.config, [setting]);
      state.updatedAt = now();
      addEvent(state, undefined, "manual", `Runtime setting ${settingId} updated.`);
      await persistState(state);
    }
    return c.json({ ok: true, setting });
  });

  app.post("/api/config/concurrency", async (c: any) => {
    const payload = await c.req.json() as JsonRecord;
    const value = typeof payload.concurrency === "number" ? payload.concurrency : undefined;
    if (!value || value < 1 || value > 10) {
      return c.json({ ok: false, error: "concurrency must be between 1 and 10" }, 400);
    }
    state.config.workerConcurrency = clamp(Math.round(value), 1, 10);
    state.updatedAt = now();
    addEvent(state, undefined, "manual", `Worker concurrency updated to ${state.config.workerConcurrency}.`);
    await persistWorkerConcurrencySetting(state.config.workerConcurrency);
    await persistState(state);
    return c.json({ ok: true, workerConcurrency: state.config.workerConcurrency });
  });

  app.get("/api/config/workflow", async (c: any) => {
    const settings = await loadRuntimeSettings();
    const saved = getWorkflowConfig(settings);
    const includeDetails = c.req.query("details") === "1";
    if (!includeDetails) {
      const providers = detectAvailableProviders();
      const workflow = saved || buildDefaultWorkflowConfig(providers);
      return c.json({ ok: true, workflow, isDefault: !saved });
    }
    const providers = detectAvailableProviders();
    const models = await discoverModels(providers);
    const defaultConfig = buildDefaultWorkflowConfig(providers, models);
    return c.json({ ok: true, workflow: saved || defaultConfig, isDefault: !saved, providers, models });
  });

  app.get("/api/config/models", async (c: any) => {
    const providers = detectAvailableProviders();
    const models = await discoverModels(providers);
    return c.json({ ok: true, models });
  });

  app.post("/api/config/workflow", async (c: any) => {
    try {
      const payload = await c.req.json() as JsonRecord;
      const workflow = payload.workflow as any;
      if (!workflow?.plan?.provider || !workflow?.execute?.provider || !workflow?.review?.provider) {
        return c.json({ ok: false, error: "Invalid workflow config. Each stage needs provider, model, and effort." }, 400);
      }
      await persistWorkflowConfig(workflow);
      addEvent(state, undefined, "manual", `Workflow config updated: plan=${workflow.plan.provider}/${workflow.plan.model}, execute=${workflow.execute.provider}/${workflow.execute.model}, review=${workflow.review.provider}/${workflow.review.model}.`);
      return c.json({ ok: true, workflow });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}
