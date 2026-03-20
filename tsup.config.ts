import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "agent/run-local": "src/boot.ts",
    "agent/cli-wrapper": "src/agents/cli-wrapper.ts",
    "mcp/server": "src/mcp/server.ts",
  },
  format: "esm",
  target: "node23",
  outDir: "dist",
  clean: true,
  splitting: true,
  sourcemap: true,
  // Don't bundle node_modules — they're installed as dependencies
  noExternal: [],
  external: [
    "s3db.js",
    "s3db.js/lite",
    "s3db.js/plugins/index",
    "pino",
    "pino-pretty",
    "yaml",
    "cli-args-parser",
    "raffel",
    "vite",
  ],
});
