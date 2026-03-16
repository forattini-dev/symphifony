import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/dashboard",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/state": "http://localhost:4000",
      "/status": "http://localhost:4000",
      "/issues": "http://localhost:4000",
      "/events": "http://localhost:4000",
      "/providers": "http://localhost:4000",
      "/parallelism": "http://localhost:4000",
      "/config": "http://localhost:4000",
      "/refresh": "http://localhost:4000",
      "/health": "http://localhost:4000",
      "/live": "http://localhost:4000",
      "/diff": "http://localhost:4000",
      "/docs": "http://localhost:4000",
      "/ws": { target: "ws://localhost:4000", ws: true },
    },
  },
});
