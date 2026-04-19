# GEMINI.md

This file provides guidance to the Gemini CLI when working with code in this repository.

## Architecture overview
Herd is a web-based terminal multiplexer for Claude Code, OpenAI Codex, and Gemini CLI sessions. It lets you browse, resume, and manage sessions across all your projects from a single browser tab. It scans for session histories in `~/.claude/projects/`, `~/.codex/sessions/`, and `~/.gemini/tmp/`, merging them into a unified project view based on the real working directory.

## Core tasks & behaviors
- **Restart server from Gemini CLI**: The server runs on port 3456. To restart it correctly, run `lsof -ti:3456 | xargs kill -9 2>/dev/null; while lsof -ti:3456 >/dev/null 2>&1; do sleep 0.3; done; nohup node server.js > /tmp/herd.log 2>&1 &` — must be a single foreground Bash call.
- **NEVER use `npm restart`** — the package.json script uses kill, but we need the loop + nohup to avoid the web session being killed.
- **Do not introduce a native `node-pty` dependency** — Herd intentionally uses macOS `script -q /dev/null` as a PTY wrapper to avoid native build issues.

## File structure
- `server.js` — Node.js Express/WebSocket backend. Serves the web UI, scans CLI session directories, handles WebSocket upgrades, and spawns terminal processes via `script`.
- `public/` — Frontend vanilla JS (`app.js`), CSS (`style.css`), and HTML (`index.html`). No build step.
- `scripts/` — Helper bash scripts.
- `summaries.json` — Local cache for Haiku-generated session summaries. Never edit manually.

## API Endpoints
- `GET /api/projects` — lists projects from all agents, merged by real path, sorted by name.
- `GET /api/sessions?project=<realPath>` — unified sessions endpoint for a given project path.
- `GET /api/recent-sessions?limit=N` — most recent sessions across all projects.
- `GET /api/summary-events` — SSE endpoint for broadcasting live Haiku summary updates.

## Multi-Agent Integration
- **Agents**: Claude Code via `claude`, Codex via `codex`, Gemini CLI via `gemini`.
- **Merging**: Projects are grouped by their canonical `cwd` (realPath) across all providers.
- **WebSocket**: Connections include an `agent=claude|codex|gemini` parameter to determine which binary to spawn.
- **Precedence**: `claudeBin`, `codexBin`, and `geminiBin` are resolved once at startup. If a binary is missing, its UI should be hidden without breaking the rest of the application.