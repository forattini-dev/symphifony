import { resolve } from "node:path";
import { PACKAGE_ROOT } from "../../concerns/constants.ts";
import { logger } from "../../concerns/logger.ts";

export async function startDevFrontend(apiPort: number, devPort: number): Promise<void> {
  const VITE_CONFIG_PATH = resolve(PACKAGE_ROOT, "app/vite.config.js");
  let createViteServer: typeof import("vite").createServer;
  try {
    const vite = await import("vite");
    createViteServer = vite.createServer;
  } catch {
    logger.warn("Vite not installed (devDependency). Run 'pnpm install' in the project to enable --dev mode.");
    return;
  }

  // Wait for the API server to be ready before starting the proxy
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`http://localhost:${apiPort}/api/health`);
      if (res.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  try {
    const server = await createViteServer({
      configFile: VITE_CONFIG_PATH,
      customLogger: {
        info: (msg: string) => logger.info(`[Vite] ${msg}`),
        warn: (msg: string) => logger.warn(`[Vite] ${msg}`),
        warnOnce: (msg: string) => logger.warn(`[Vite] ${msg}`),
        error: (msg: string) => {
          if (msg.includes("ws proxy error") || msg.includes("ws proxy socket error")) {
            logger.debug(`[Vite] ${msg.split("\n")[0]} (transient, suppressed)`);
            return;
          }
          logger.error(`[Vite] ${msg}`);
        },
        hasErrorLogged: () => false,
        clearScreen: () => {},
        hasWarned: false,
      },
      server: {
        port: devPort,
        host: true,
        proxy: {
          "/api": `http://localhost:${apiPort}`,
          "/ws": {
            target: `ws://localhost:${apiPort}`,
            ws: true,
            configure: (proxy) => {
              const silence = (err: any) => {
                logger.debug(`[Vite] WS proxy transient: ${err.code || err.message}`);
              };
              proxy.on("error", silence);
              proxy.on("proxyReqWs", (_proxyReq: any, _req: any, socket: any) => {
                socket.on("error", silence);
              });
            },
          },
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
