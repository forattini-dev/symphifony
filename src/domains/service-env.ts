export type ServiceEnvironment = Record<string, string>;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidServiceEnvKey(key: string): boolean {
  return ENV_KEY_PATTERN.test(key);
}

export function normalizeServiceEnvironment(value: unknown): {
  env: ServiceEnvironment;
  errors: string[];
} {
  if (value === undefined || value === null) {
    return { env: {}, errors: [] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { env: {}, errors: ["Environment must be an object map of KEY -> value."] };
  }

  const env: ServiceEnvironment = {};
  const errors: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (!isValidServiceEnvKey(key)) {
      errors.push(`Invalid environment variable name: ${rawKey}`);
      continue;
    }
    env[key] = rawValue === undefined || rawValue === null ? "" : String(rawValue);
  }

  return { env, errors };
}

export function mergeServiceEnvironment(
  globalEnv?: ServiceEnvironment,
  serviceEnv?: ServiceEnvironment,
): ServiceEnvironment {
  return {
    ...(globalEnv ?? {}),
    ...(serviceEnv ?? {}),
  };
}

export function shellQuoteEnvValue(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildServiceCommand(
  command: string,
  globalEnv?: ServiceEnvironment,
  serviceEnv?: ServiceEnvironment,
  enforcedEnv?: ServiceEnvironment,
): string {
  const baseCommand = command.trim();
  if (!baseCommand) return "";

  const env = {
    ...mergeServiceEnvironment(globalEnv, serviceEnv),
    ...(enforcedEnv ?? {}),
  };
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${shellQuoteEnvValue(value)}`);
  return assignments.length > 0 ? `${assignments.join(" ")} ${baseCommand}` : baseCommand;
}
