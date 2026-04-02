import { createClient } from "vaulter";
import { join } from "node:path";
import { STATE_ROOT } from "../concerns/constants.ts";
import { logger } from "../concerns/logger.ts";
import type { VariableEntry } from "../types.ts";

export const VAULTER_PROJECT = "fifony";
export const VAULTER_ENV = "local";

let _client: ReturnType<typeof createClient> | null = null;

export async function initVaulterClient(): Promise<void> {
  const dbPath = join(STATE_ROOT, "secrets.db");
  const client = createClient({ connectionString: `file://${dbPath}` });
  await client.connect();
  _client = client;
  logger.debug({ dbPath }, "[Vaulter] Connected");
}

export function getVaulterClient(): ReturnType<typeof createClient> {
  if (!_client) throw new Error("[Vaulter] Client not initialized");
  return _client;
}

export async function loadAllFromVaulter(): Promise<VariableEntry[]> {
  const records = await getVaulterClient().list({
    project: VAULTER_PROJECT,
    environment: VAULTER_ENV,
  });
  return records.map((r) => ({
    id: `${r.service ?? "global"}:${r.key}`,
    key: r.key,
    value: r.value ?? "",
    scope: r.service ?? "global",
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : (r.updatedAt as string | null | undefined) ?? new Date().toISOString(),
  }));
}

export async function upsertVariableInVaulter(entry: VariableEntry): Promise<void> {
  const isGlobal = entry.scope === "global";
  await getVaulterClient().set({
    key: entry.key,
    value: entry.value,
    project: VAULTER_PROJECT,
    environment: VAULTER_ENV,
    ...(isGlobal ? {} : { service: entry.scope }),
  });
}

export async function deleteVariableFromVaulter(id: string): Promise<void> {
  const colonIdx = id.indexOf(":");
  if (colonIdx === -1) throw new Error(`Invalid variable id: ${id}`);
  const scope = id.slice(0, colonIdx);
  const key = id.slice(colonIdx + 1);
  await getVaulterClient().delete(
    key,
    VAULTER_PROJECT,
    VAULTER_ENV,
    scope === "global" ? undefined : scope,
  );
}
