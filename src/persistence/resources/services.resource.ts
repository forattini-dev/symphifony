import { S3DB_SERVICES_RESOURCE } from "../../concerns/constants.ts";
import type { ServiceEntry, RuntimeState } from "../../types.ts";
import { normalizeServiceEnvironment } from "../../domains/service-env.ts";
import { assignServicePort, collectReservedPorts } from "../../domains/service-port.ts";
import { getApiRuntimeContextOrThrow } from "../plugins/api-runtime-context.ts";

type ServiceApiDeps = {
  replacePersistedService: (entry: ServiceEntry) => Promise<void>;
  deletePersistedService: (id: string) => Promise<void>;
  replaceAllServices: (entries: ServiceEntry[]) => Promise<void>;
};

type ApiContext = {
  req: {
    param: (name: string) => string | undefined;
    json: () => Promise<unknown>;
  };
  json: (body: unknown, status?: number) => Response;
};

function respond(c: unknown, body: unknown, status = 200): Response {
  return (c as ApiContext).json(body, status);
}

async function loadServiceApiDeps(): Promise<ServiceApiDeps> {
  const {
    replacePersistedService,
    deletePersistedService,
    replaceAllServices,
  } = await import("../store.ts");

  return {
    replacePersistedService,
    deletePersistedService,
    replaceAllServices,
  };
}

function parseServiceId(c: unknown): string | null {
  const value = (c as ApiContext)?.req?.param?.("id");
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getRuntimeState(): RuntimeState {
  return getApiRuntimeContextOrThrow().state;
}

function normalizeServiceEntry(value: unknown): { entry?: ServiceEntry; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Service entry must be an object." };
  }

  const entry = value as ServiceEntry;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  const cwd = typeof entry.cwd === "string" ? entry.cwd.trim() : "";
  const envResult = normalizeServiceEnvironment(entry.env);

  if (!id || !name || !command) {
    return { error: "id, name, and command are required" };
  }
  if (envResult.errors.length > 0) {
    return { error: envResult.errors[0] };
  }

  return {
    entry: {
      ...entry,
      id,
      name,
      command,
      cwd: cwd || undefined,
      env: Object.keys(envResult.env).length > 0 ? envResult.env : undefined,
    },
  };
}

export async function listServiceConfigs(c: unknown): Promise<Response> {
  const state = getRuntimeState();
  return respond(c, { ok: true, services: state.config.services ?? [] });
}

export async function replaceServiceConfigs(
  c: unknown,
  deps?: ServiceApiDeps,
): Promise<Response> {
  const state = getRuntimeState();
  const apiDeps = deps ?? await loadServiceApiDeps();

  try {
    const body = await (c as ApiContext).req.json() as { services: unknown };
    if (!Array.isArray(body.services)) {
      return respond(c, { ok: false, error: "Invalid services array" }, 400);
    }

    const entries = body.services as ServiceEntry[];
    const normalizedEntries: ServiceEntry[] = [];
    const reservedPorts = collectReservedPorts(state.config, []);
    for (const entry of entries) {
      const normalized = normalizeServiceEntry(entry);
      if (!normalized.entry) {
        return respond(c, { ok: false, error: normalized.error ?? "Invalid service entry" }, 400);
      }
      normalizedEntries.push(await assignServicePort(normalized.entry, reservedPorts));
    }
    await apiDeps.replaceAllServices(normalizedEntries);
    state.config.services = normalizedEntries;
    return respond(c, { ok: true, services: normalizedEntries });
  } catch (error) {
    return respond(c, { ok: false, error: String(error) }, 500);
  }
}

export async function upsertServiceConfig(
  c: unknown,
  deps?: ServiceApiDeps,
): Promise<Response> {
  const state = getRuntimeState();
  const apiDeps = deps ?? await loadServiceApiDeps();
  const id = parseServiceId(c);
  if (!id) return respond(c, { ok: false, error: "Service id is required." }, 400);

  try {
    const rawEntry = await (c as ApiContext).req.json() as ServiceEntry;
    const normalized = normalizeServiceEntry(rawEntry);
    if (!normalized.entry) {
      return respond(c, { ok: false, error: normalized.error ?? "Invalid service entry" }, 400);
    }
    const existing = state.config.services ?? [];
    const reservedPorts = collectReservedPorts(
      state.config,
      existing.filter((service) => service.id !== id),
    );
    const entry = await assignServicePort(normalized.entry, reservedPorts);

    await apiDeps.replacePersistedService(entry);
    const idx = existing.findIndex((service) => service.id === id);
    if (idx >= 0) existing[idx] = entry;
    else existing.push(entry);
    state.config.services = existing;
    return respond(c, { ok: true, service: entry });
  } catch (error) {
    return respond(c, { ok: false, error: String(error) }, 500);
  }
}

export async function deleteServiceConfig(
  c: unknown,
  deps?: ServiceApiDeps,
): Promise<Response> {
  const state = getRuntimeState();
  const apiDeps = deps ?? await loadServiceApiDeps();
  const id = parseServiceId(c);
  if (!id) return respond(c, { ok: false, error: "Service id is required." }, 400);

  await apiDeps.deletePersistedService(id);
  state.config.services = (state.config.services ?? []).filter((entry) => entry.id !== id);
  return respond(c, { ok: true, id });
}

export default {
  name: S3DB_SERVICES_RESOURCE,
  attributes: {
    id: "string|required",
    name: "string|required",
    command: "string|required",
    cwd: "string|optional",
    env: "json|optional",
    autoStart: "json|optional",
    updatedAt: "datetime|required",
  },
  asyncPartitions: false,
  behavior: "body-overflow",
  paranoid: false,
  timestamps: false,
  api: {
    auth: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    description: "Managed service configuration entries",
    "GET /": async (c: unknown) => listServiceConfigs(c),
    "POST /config": async (c: unknown) => replaceServiceConfigs(c),
    "PUT /:id": async (c: unknown) => upsertServiceConfig(c),
    "DELETE /:id": async (c: unknown) => deleteServiceConfig(c),
  },
};
