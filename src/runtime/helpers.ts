import { appendFileSync, readFileSync } from "node:fs";
import { env } from "node:process";
import { parse as parseYaml } from "yaml";
import type { IssueState, JsonRecord } from "./types.ts";
import { ALLOWED_STATES, DEBUG_BOOT } from "./constants.ts";

export function now(): string {
  return new Date().toISOString();
}

/** Returns ISO week string like "2026-W12" for a given date (defaults to now). */
export function isoWeek(date?: Date | string): string {
  const d = date ? new Date(date) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  // ISO week: week starts Monday, week 1 contains Jan 4
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = tmp.getUTCDay() || 7; // Monday=1 ... Sunday=7
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveEnvVar(value: string): string {
  if (!value.startsWith("$")) return value;
  const varName = value.slice(1);
  const resolved = env[varName];
  return resolved && resolved.trim().length > 0 ? resolved.trim() : "";
}

export function expandPath(value: string): string {
  let result = value;
  // ~ home expansion
  if (result.startsWith("~")) {
    result = result.replace(/^~/, env.HOME || env.USERPROFILE || "~");
  }
  // $VAR expansion for path values
  if (result.includes("$")) {
    result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, varName: string) => {
      return env[varName] || "";
    });
  }
  return result;
}

export function toStringValue(value: unknown, fallback = ""): string {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  const trimmed = value.trim();
  // Resolve $VAR_NAME indirection (full value is a single env var reference)
  if (trimmed.startsWith("$") && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    const resolved = resolveEnvVar(trimmed);
    return resolved.length > 0 ? resolved : fallback;
  }
  return trimmed;
}

export function toNumberValue(value: unknown, fallback = 1): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

export function toBooleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeState(value: unknown): IssueState {
  const raw = typeof value === "string" ? value.trim() : "";
  // Legacy migration: "In Progress" → "Running"
  if (raw === "In Progress") return "Running";
  if ((ALLOWED_STATES as readonly string[]).includes(raw)) {
    return raw as IssueState;
  }
  return "Todo";
}

export function parseEnvNumber(name: string, fallback: number): number {
  return toNumberValue(env[name], fallback);
}

export function parseIntArg(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parsePositiveIntEnv(name: string, fallback: number): number {
  const source = env[name];
  if (!source) return fallback;
  return parseIntArg(source, fallback);
}

export function withRetryBackoff(attempt: number, baseDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** attempt, 5 * 60 * 1000);
}

export function idToSafePath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

export function appendFileTail(target: string, text: string, maxLength: number): string {
  const merged = `${target}\n${text}`;
  if (merged.length <= maxLength) return merged;
  return `…${merged.slice(-(maxLength - 1))}`;
}

export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function parseFrontMatter(source: string): { config: JsonRecord; body: string } {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { config: {}, body: source.trim() };
  }

  const rawConfig = parseYaml(match[1]) as unknown;
  const config = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
    ? rawConfig as JsonRecord
    : {};

  return { config, body: match[2].trim() };
}

export function getNestedRecord(source: unknown, key: string): JsonRecord {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const value = (source as JsonRecord)[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function getNestedString(source: unknown, key: string, fallback = ""): string {
  if (!source || typeof source !== "object" || Array.isArray(source)) return fallback;
  return toStringValue((source as JsonRecord)[key], fallback);
}

export function getNestedNumber(source: unknown, key: string, fallback: number): number {
  if (!source || typeof source !== "object" || Array.isArray(source)) return fallback;
  return toNumberValue((source as JsonRecord)[key], fallback);
}

export function appendLog(logPath: string, entry: string): void {
  appendFileSync(logPath, `${now()} [fifony-local-ts] ${entry}\n`, "utf8");
}

export function debugBoot(message: string): void {
  if (!DEBUG_BOOT) return;
  console.error(`[FIFONY_DEBUG_BOOT] ${message}`);
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
