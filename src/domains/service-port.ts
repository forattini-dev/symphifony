import { createServer } from "node:net";
import type { RuntimeConfig, ServiceEntry } from "../types.ts";

const MIN_SERVICE_PORT = 12_000;
const MAX_SERVICE_PORT = 65_535;

// Managed services are expected to bind to PORT. When the user does not provide
// one explicitly, Fifony allocates and persists a free local port above 12000.

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailableServicePort(
  usedPorts: Iterable<number>,
  minPort = MIN_SERVICE_PORT,
): Promise<number> {
  const reserved = new Set<number>([...usedPorts].filter((port) => Number.isFinite(port) && port > 0));
  for (let port = Math.max(minPort, MIN_SERVICE_PORT); port <= MAX_SERVICE_PORT; port += 1) {
    if (reserved.has(port)) continue;
    if (await canListen(port)) return port;
  }
  throw new Error("No available service port found above 12000.");
}

export function collectReservedPorts(config: RuntimeConfig, services: ServiceEntry[] = []): Set<number> {
  const ports = new Set<number>();
  for (const service of services) {
    if (service.port && service.port > 0) ports.add(service.port);
  }
  if (config.reverseProxyPort && config.reverseProxyPort > 0) ports.add(config.reverseProxyPort);
  if (config.meshProxyPort && config.meshProxyPort > 0) ports.add(config.meshProxyPort);
  const dashboardPort = Number(config.dashboardPort ?? 0);
  if (dashboardPort > 0) ports.add(dashboardPort);
  return ports;
}

export async function assignServicePort(
  entry: ServiceEntry,
  reservedPorts: Set<number>,
): Promise<ServiceEntry> {
  if (entry.port && entry.port > 0) {
    reservedPorts.add(entry.port);
    return entry;
  }
  const port = await findAvailableServicePort(reservedPorts);
  reservedPorts.add(port);
  return { ...entry, port };
}
