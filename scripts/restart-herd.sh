#!/usr/bin/env bash

set -euo pipefail

PORT="${PORT:-3456}"
LOG_FILE="${LOG_FILE:-/tmp/herd.log}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

existing_pids="$(lsof -tiTCP:${PORT} 2>/dev/null || true)"
if [ -n "${existing_pids}" ]; then
  kill -9 ${existing_pids} 2>/dev/null || true
  while lsof -tiTCP:${PORT} >/dev/null 2>&1; do
    sleep 0.3
  done
fi

nohup node "${ROOT_DIR}/server.js" >"${LOG_FILE}" 2>&1 </dev/null &

echo "herd restarted on port ${PORT}"
echo "log file: ${LOG_FILE}"
