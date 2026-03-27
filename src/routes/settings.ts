import type { JsonRecord, RuntimeState, WorkflowConfig } from "../types.ts";
import { logger } from "../concerns/logger.ts";
import {
  getVapidPublicKey,
  addSubscription,
  removeSubscription,
  getSubscriptionCount,
  SETTING_ID_PUSH_SUBSCRIPTIONS,
  type PushSubscriptionData,
} from "../domains/web-push.ts";
import { now, clamp } from "../concerns/helpers.ts";
import { addEvent } from "../domains/issues.ts";
import { persistState } from "../persistence/store.ts";
import { detectAvailableProviders, discoverModels } from "../agents/providers.ts";
import { warmEmbeddingProvider } from "../agents/embedding-provider.ts";
import type { RouteRegistrar } from "./http.ts";
import {
  buildDefaultWorkflowConfig,
  getWorkflowConfig,
  loadRuntimeSettings,
  persistSetting,
  persistWorkerConcurrencySetting,
  persistWorkflowConfig,
} from "../persistence/settings.ts";

export function registerSettingsRoutes(
  app: RouteRegistrar,
  state: RuntimeState,
): void {
  // POST /api/settings/:id — upsert a runtime setting by ID.
  // Note: the s3db settings resource handles GET /api/settings (list) and
  // GET /api/settings/:id (get), but its custom POST /:id route is not reachable
  // through s3db's routing layer, so we register it here explicitly.
  app.post("/api/settings/:id", async (c) => {
    const { updateSetting } = await import("../persistence/resources/settings.resource.js");
    return updateSetting(c);
  });

  app.post("/api/config/concurrency", async (c) => {
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

  app.post("/api/providers/embeddings/warmup", async (c) => {
    try {
      const result = await warmEmbeddingProvider();
      const message = result.kind === "disabled"
        ? "Embeddings are disabled; skipping local model warmup."
        : result.kind === "remote"
        ? `Remote embedding provider ${result.model || "configured"} is active; no local download is required.`
        : result.source === "migrated-legacy-cache"
        ? `Local embedding model ${result.model} is ready after migrating the legacy workspace cache to ${result.cacheDir}.`
        : result.source === "existing-cache"
        ? `Local embedding model ${result.model} is ready from the shared cache at ${result.cacheDir}.`
        : `Local embedding model ${result.model} downloaded to ${result.cacheDir}.`;

      state.updatedAt = now();
      addEvent(state, undefined, "manual", message);
      await persistState(state);

      return c.json({ ok: true, ...result, message });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ err: error }, "[Embeddings] Warmup failed");
      state.updatedAt = now();
      addEvent(state, undefined, "manual", `Embedding warmup failed: ${message}`);
      await persistState(state);
      return c.json({ ok: false, error: message }, 502);
    }
  });

  app.get("/api/config/workflow", async (c) => {
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

  app.get("/api/config/models", async (c) => {
    const providers = detectAvailableProviders();
    const models = await discoverModels(providers);
    return c.json({ ok: true, models });
  });

  app.post("/api/config/workflow", async (c) => {
    try {
      const payload = await c.req.json() as JsonRecord;
      const workflow = payload.workflow as Partial<WorkflowConfig> | undefined;
      if (!workflow?.plan?.provider || !workflow?.execute?.provider || !workflow?.review?.provider) {
        return c.json({ ok: false, error: "Invalid workflow config. Each stage needs provider, model, and effort." }, 400);
      }
      await persistWorkflowConfig(workflow as WorkflowConfig);
      addEvent(state, undefined, "manual", `Workflow config updated: plan=${workflow.plan.provider}/${workflow.plan.model}, execute=${workflow.execute.provider}/${workflow.execute.model}, review=${workflow.review.provider}/${workflow.review.model}.`);
      return c.json({ ok: true, workflow });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // ── Web Push endpoints ──────────────────────────────────────────────────

  app.get("/api/push/vapid-public-key", (c) => {
    const key = getVapidPublicKey();
    if (!key) return c.json({ ok: false, error: "Web push not configured" }, 503);
    return c.json({ ok: true, publicKey: key });
  });

  app.post("/api/push/subscribe", async (c) => {
    const body = await c.req.json() as { subscription?: PushSubscriptionData };
    const sub = body?.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return c.json({ ok: false, error: "Invalid push subscription" }, 400);
    }
    const persist = async (subs: PushSubscriptionData[]) => {
      await persistSetting(SETTING_ID_PUSH_SUBSCRIPTIONS, subs, { source: "system" });
    };
    await addSubscription(sub, persist);
    return c.json({ ok: true, subscriptions: getSubscriptionCount() });
  });

  app.post("/api/push/unsubscribe", async (c) => {
    const body = await c.req.json() as { endpoint?: string };
    if (!body?.endpoint) {
      return c.json({ ok: false, error: "Endpoint is required" }, 400);
    }
    const persist = async (subs: PushSubscriptionData[]) => {
      await persistSetting(SETTING_ID_PUSH_SUBSCRIPTIONS, subs, { source: "system" });
    };
    await removeSubscription(body.endpoint, persist);
    return c.json({ ok: true });
  });
}
