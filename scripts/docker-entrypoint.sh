#!/usr/bin/env bash
# Container boot (see Dockerfile). Starts as root only to hand the volume —
# mounted root-owned — to the herd user, then drops privileges for the server
# and every PTY it spawns.
set -euo pipefail

log() { echo "[boot] $*"; }

for d in /data/home /data/work /data/herd; do
  mkdir -p "$d"
  [ "$(stat -c %U "$d")" = herd ] || chown -R herd:herd "$d"
done

# A fresh HOME has no ~/.claude.json, and without hasCompletedOnboarding the
# interactive TUI runs first-time setup instead of picking up the token.
if [ ! -f /data/home/.claude.json ]; then
  echo '{"hasCompletedOnboarding":true}' > /data/home/.claude.json
  chown herd:herd /data/home/.claude.json
fi

# Claude settings: deploy/claude/settings.json supplies defaults (model, effort)
# that /model and friends may override and keep; the status line always
# follows the image, so a script change ships with the next deploy.
gosu herd node -e '
const fs = require("fs"), dir = "/data/home/.claude", p = dir + "/settings.json";
const seed = require("/app/deploy/claude/settings.json");
let cur = {};
if (fs.existsSync(p)) {
  try { cur = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { console.error("[boot] ~/.claude/settings.json is not valid JSON; left untouched"); process.exit(0); }
}
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(p, JSON.stringify({ ...seed, ...cur, statusLine: seed.statusLine }, null, 2) + "\n");
' || log "WARNING: could not merge Claude settings"

[ -n "${HERD_PASSWORD:-}" ] || log "WARNING: HERD_PASSWORD is unset — the server will refuse to start."
[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || log "WARNING: CLAUDE_CODE_OAUTH_TOKEN is unset — run /login in a Claude tab."

exec gosu herd node /app/server.js
