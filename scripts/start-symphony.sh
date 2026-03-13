#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SCRIPT_TS="$SCRIPT_DIR/run-symphony-local.ts"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/start-symphony.sh [options]

Local-first Symphony bootstrap (TypeScript-only, no Linear, no Elixir):
  --port <n>              Start dashboard on HTTP port
  --concurrency <n>       Maximum parallel local runners (default: SYMPHONY_WORKER_CONCURRENCY or 2)
  --attempts <n>          Max attempts per issue (default: SYMPHONY_MAX_ATTEMPTS or 3)
  --poll <ms>             Scheduler polling interval (default: SYMPHONY_POLL_INTERVAL_MS or 1200)
  --once                   Run one batch locally and exit
  --help                   Show this message

Environment:
  SYMPHONY_TRACKER_KIND            memory (required)
  SYMPHONY_MEMORY_ISSUES_FILE      JSON file with local issues
  SYMPHONY_MEMORY_ISSUES_JSON       Inline JSON with local issues
  SYMPHONY_AGENT_COMMAND            Optional local command for real Codex execution

Examples:
  ./scripts/start-symphony.sh --once
  ./scripts/start-symphony.sh --port 4040 --concurrency 2
USAGE
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${SYMPHONY_TRACKER_KIND:-memory}" != "memory" ]]; then
  echo "SYMPHONY_TRACKER_KIND must be set to 'memory' for this fork." >&2
  exit 1
fi

if [[ ! -f "$RUN_SCRIPT_TS" ]]; then
  echo "Runtime script missing: $RUN_SCRIPT_TS" >&2
  exit 1
fi

cd "$SCRIPT_DIR/.."

if command -v pnpm >/dev/null 2>&1 && pnpm exec tsx --version >/dev/null 2>&1; then
  exec pnpm exec tsx "$RUN_SCRIPT_TS" "$@"
fi

if command -v tsx >/dev/null 2>&1; then
  exec tsx "$RUN_SCRIPT_TS" "$@"
fi

echo "tsx not found. Run pnpm install first." >&2
exit 1
