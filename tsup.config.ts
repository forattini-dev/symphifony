import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "agent/run-local": "src/boot.ts",
    "agent/cli-wrapper": "src/agents/cli-wrapper.ts",
    "agent/pty-daemon": "src/agents/pty-daemon.ts",
    "mcp/server": "src/mcp/server.ts",
  },
  format: "esm",
  target: "node23",
  outDir: "dist",
  // clean: false — old chunks must survive while the running process still
  // references them via dynamic import(). clean:true deletes them mid-flight
  // causing ERR_MODULE_NOT_FOUND on lazy imports (FSM transitions, commands).
  clean: false,
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
