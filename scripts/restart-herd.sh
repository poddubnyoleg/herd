#!/usr/bin/env bash

set -euo pipefail

PORT="${PORT:-3456}"
LOG_FILE="${LOG_FILE:-/tmp/herd.log}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "${RPC_PROXY_DEST_OVERRIDE:-}" ]; then
  echo "error: restart-herd.sh cannot start Herd inside a sandboxed shell (Seatbelt blocks ~/.claude, ~/.gemini, and Keychain access)" >&2
  exit 1
fi

if [ -f "$HOME/.gemini/.env" ]; then
  export $(grep -v '^#' "$HOME/.gemini/.env" | xargs)
fi

# Parent agent TUIs (Grok, Claude) export these so *their* children stay
# monochrome. A Herd started from inside one would otherwise spawn every
# PTY with NO_COLOR and Claude's splash renders as a black silhouette.
unset NO_COLOR FORCE_COLOR CLICOLOR CLICOLOR_FORCE
export CLICOLOR=1
export COLORTERM="${COLORTERM:-truecolor}"

existing_pids="$(lsof -tiTCP:${PORT} 2>/dev/null || true)"
if [ -n "${existing_pids}" ]; then
  kill -9 ${existing_pids} 2>/dev/null || true
  while lsof -tiTCP:${PORT} >/dev/null 2>&1; do
    sleep 0.3
  done
fi

node -e '
  const { spawn } = require("child_process");
  const fs = require("fs");
  const out = fs.openSync(process.argv[2], "w");
  const child = spawn(process.execPath, [process.argv[1]], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
' "${ROOT_DIR}/server.js" "${LOG_FILE}"

for _ in {1..20}; do
  if lsof -tiTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

new_pid="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)"
if [ -z "${new_pid}" ]; then
  echo "error: herd failed to listen on port ${PORT}" >&2
  exit 1
fi

echo "herd restarted on port ${PORT} (pid ${new_pid})"
echo "log file: ${LOG_FILE}"
