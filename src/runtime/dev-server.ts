/**
 * Development server that runs Vite dev server alongside the API.
 * Uses dynamic import so vite (devDependency) is only loaded when --dev is used.
 */
import { resolve } from "node:path";
import { PACKAGE_ROOT } from "./constants.ts";
import { logger } from "./logger.ts";

const VITE_CONFIG_PATH = resolve(PACKAGE_ROOT, "app/vite.config.js");

export async function startDevFrontend(apiPort: number, devPort: number): Promise<void> {
  let createViteServer: typeof import("vite").createServer;
  try {
    const vite = await import("vite");
    createViteServer = vite.createServer;
  } catch {
    logger.warn("Vite not installed (devDependency). Run 'pnpm install' in the project to enable --dev mode.");
    return;
  }

  try {
    const server = await createViteServer({
      configFile: VITE_CONFIG_PATH,
      server: {
        port: devPort,
        host: true,
        proxy: {
          "/api": `http://localhost:${apiPort}`,
          "/ws": { target: `ws://localhost:${apiPort}`, ws: true },
          "/docs": `http://localhost:${apiPort}`,
          "/health": `http://localhost:${apiPort}`,
          "/manifest.webmanifest": `http://localhost:${apiPort}`,
          "/service-worker.js": `http://localhost:${apiPort}`,
          "/icon.svg": `http://localhost:${apiPort}`,
          "/icon-maskable.svg": `http://localhost:${apiPort}`,
          "/offline.html": `http://localhost:${apiPort}`,
        },
      },
    });

    await server.listen();
    logger.info(`Dev frontend available at http://localhost:${devPort}`);
  } catch (error) {
    logger.warn(`Failed to start Vite dev server: ${String(error)}`);
  }
}
