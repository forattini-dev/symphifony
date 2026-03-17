import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

export default defineConfig(({ command }) => ({
  // In build mode, assets go under /assets/ so they don't collide with routes
  // In dev mode, base must be / for the router to work
  base: command === "build" ? "/assets/" : "/",
  plugins: [
    tailwindcss(),
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
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/@tanstack/react-query/") ||
            id.includes("node_modules/@tanstack/react-router/")
          ) {
            return "vendor";
          }
        },
      },
    },
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
