import type { ProxyTelemetryCollector } from "raffel";

type CreateProxyTelemetryFn = (config?: { rateWindowMs?: number }) => ProxyTelemetryCollector;

async function loadCreateProxyTelemetry(): Promise<CreateProxyTelemetryFn> {
  const raffel = await import("raffel");
  const publicFactory = (raffel as { createProxyTelemetry?: CreateProxyTelemetryFn }).createProxyTelemetry;
  if (typeof publicFactory === "function") {
    return publicFactory;
  }

  const internal = await import("../../node_modules/raffel/dist/proxy/telemetry.js");
  const internalFactory = (internal as { createProxyTelemetry?: CreateProxyTelemetryFn }).createProxyTelemetry;
  if (typeof internalFactory === "function") {
    return internalFactory;
  }

  throw new Error("Raffel proxy telemetry factory is unavailable.");
}

export async function createRaffelProxyTelemetry(config?: { rateWindowMs?: number }): Promise<ProxyTelemetryCollector> {
  const factory = await loadCreateProxyTelemetry();
  return factory(config);
}
