import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

export default defineConfig(({ command }) => ({
  // In build mode, assets go under /assets/ so they don't collide with routes
  // In dev mode, base must be / for the router to work
  base: command === "build" ? "/assets/" : "/",
  plugins: [
    TanStackRouterVite({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    react(),
  ],
  root: "app",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": "http://localhost:4000",
      "/ws": { target: "ws://localhost:4000", ws: true },
      "/docs": "http://localhost:4000",
      "/health": "http://localhost:4000",
    },
  },
}));
