# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Herd is a web-based terminal multiplexer for Claude Code, Codex, and Gemini CLI sessions. It lets you browse, resume, and manage sessions across all your projects from a single browser tab. It scans `~/.claude/projects/` for Claude Code history, `~/.codex/sessions/` for OpenAI Codex history, and `~/.gemini/tmp/` for Gemini CLI logs (JSONL files), merging them into a unified project view.

## Commands

- `npm install` — install dependencies
- `npm start` — run the server (default http://localhost:3456, configurable via `PORT` env var)
- `npm test` — run Playwright browser tests (`test/hub.test.mjs`)
- **Restart server from Claude Code**: `lsof -ti:3456 | xargs kill -9 2>/dev/null; while lsof -ti:3456 >/dev/null 2>&1; do sleep 0.3; done; nohup node server.js > /tmp/herd.log 2>&1 &` — must be a single foreground Bash call, never use `run_in_background` (it kills child processes on cleanup)

No linter or build step configured. Tests use Playwright (devDependency).

## Architecture

Single-process Node.js server (`server.js`) serving a vanilla JS frontend (`public/`).

**Backend (`server.js`):**
- Express serves static files from `public/` and REST endpoints:
  - `GET /api/projects` — lists projects from `~/.claude/projects/`, `~/.codex/sessions/`, and `~/.gemini/tmp/`, merged by real path, sorted by name. Lazily prunes stale summary cache entries
  - `GET /api/projects/:id/sessions` — returns `{ sessions, total, truncated }` (max 30 sessions). Path traversal is blocked by validating resolved path stays inside `PROJECTS_DIR`
  - `GET /api/sessions?project=<realPath>` — unified sessions endpoint that works with real paths (also serves Codex and Gemini sessions for the project)
  - `GET /api/recent-sessions?limit=N` — most recent sessions across all projects (Claude, Codex, and Gemini), max 50
  - `GET /api/token-usage` — 30-day token usage/cost breakdown by model and day, computed from JSONL usage data. Includes model-specific pricing (Opus, Sonnet, Haiku) with cache tier breakdowns. Cached for 5 minutes
  - `GET /api/summary-events` — SSE stream for real-time summary updates (session names update in-place without re-rendering)
  - `POST /api/regenerate-summaries` — force re-generation of summaries (single session, per-project, or all)
  - `POST /api/pick-folder` — triggers native macOS folder picker via `osascript` for adding arbitrary project directories (POST because it has UI side effects; cross-origin blocked by Origin check)
- WebSocket server (`noServer: true`) only upgrades connections on `/ws` path. Spawns terminal processes through `node-pty` for a real PTY with full resize (`ioctl TIOCSWINSZ`) support. Supports `agent=claude`, `agent=codex`, and `agent=gemini` parameters. New sessions launch `claude`/`codex`/`gemini` directly; resumed sessions use `--resume <id>`
- Claude, Codex, and Gemini binaries resolved once at startup from common paths or `which`
- Codex integration: scans `~/.codex/sessions/YYYY/MM/DD/*.jsonl` for Codex rollout files. Parses `session_meta` and `event_msg` entries to extract session IDs, cwds, and previews. Cached by `(filePath, mtimeMs)` for incremental rescans
- Gemini integration: scans `~/.gemini/tmp/<project-hash>/logs.json` files. Groups entries by session ID, extracts cwd and preview from message history. Cached by `(filePath, mtimeMs)`. Loads `~/.gemini/.env` into a scoped object (not `process.env`) to avoid side-effects
- Project paths are encoded/decoded between the filesystem dash-separated format in `~/.claude/projects/` and real paths using a backtracking solver (`decodeProjectPath`) that validates against the actual filesystem. `findEncodedDir()` reverse-lookups the encoded directory name for a given real path
- Security: binds to `127.0.0.1` by default (configurable via `HOST` env var), sets `X-Content-Type-Options` and `X-Frame-Options` headers, validates `resume` parameter as UUID format. Origin header is checked on WebSocket upgrades and on non-GET / expensive REST routes to prevent cross-origin shell hijack and CSRF; missing/`null` Origin (non-browser clients like curl) is allowed. Reverse-proxy / HTTPS deployments must set `ALLOWED_ORIGINS` (comma-separated) to the external origin(s)
- Haiku summaries: spawns `claude -p --model haiku` to generate 2-4 word session names (no API key needed), cached in `summaries.json` on disk with timestamps. Background-generates missing summaries when sessions are fetched. Stale summaries (session modified after generation, with 5-min cooldown) are automatically re-generated. Tracks in-flight requests to prevent duplicate calls
- Auto-naming: buffers terminal output (capped at 2KB) and periodically sends it to Haiku via CLI for tab title generation (max 5 renames over 30 minutes per session). Live titles are persisted to the summary cache on disk
- Session ID detection: for new (non-resumed) sessions, the server discovers the session ID by scanning the project dir for recently-created JSONL files, then notifies the client via a `ready` message
- JSONL parsing: reads session files line-by-line with chunked I/O (up to 20 lines, 64KB chunks) instead of a fixed 16KB buffer
- Token usage computation: scans all JSONL files from last 30 days, extracts `usage` fields from messages, applies per-model pricing with cache tier breakdowns (5m ephemeral, 1h ephemeral, cache reads)
- Graceful shutdown: SIGINT/SIGTERM kill terminal processes, close WebSocket server, then close HTTP server with a 3s timeout

**Frontend (`public/app.js`, `public/index.html`, `public/style.css`):**
- Single `Herd` class manages all state — project list, tabs, terminals, theme, search
- Each tab holds an xterm.js terminal instance connected to the server via WebSocket
- Tabs track `alive`, `unread`, and `finished` states; background tabs with 5s output idle are marked finished (green pulse)
- Terminal auto-refit: each terminal uses a `ResizeObserver` on its container to refit on any size change (window resize, sidebar drag, etc.)
- Smart scroll: output writes preserve scroll position when the user has scrolled up; auto-scrolls only when already at the bottom
- "+" button in tab bar creates a new session in the most recent active project
- Recent sessions: "Recent" section at top of sidebar shows 20 most recent sessions across all projects with project labels, supports Claude, Codex, and Gemini
- SSE live updates: listens on `/api/summary-events` via EventSource; updates session names in-place in both project and recent sections without full re-render
- Token usage badge: sidebar header shows 30-day cost/token summary; clicking opens a popup with per-model breakdown, stats (tokens, sessions, API calls), and a 14-day daily cost sparkline chart
- Add project button: "+" in sidebar header opens native macOS folder picker to add arbitrary project directories
- Session cache updated in-memory when live titles arrive, so sidebar re-renders show current names
- Search/filter: sidebar text input filters projects by name and sessions by summary/preview text. Auto-expands projects that match only by session content
- WebSocket reconnection: auto-reconnects with exponential backoff (up to 30s) for sessions that have a `sessionId`
- Keyboard shortcuts: Ctrl+W (close tab), Ctrl+T (new session in active project), Ctrl+PageDown/PageUp (cycle tabs)
- xterm.js and addons (fit, web-links) loaded from CDN
- Theme system: dark/light/auto with CSS custom properties and matching xterm color schemes
- Sidebar is resizable via drag handle, width persisted in localStorage
- `beforeunload` warning prevents accidental page close with active sessions
- Active project highlighted in sidebar with accent border

## Key Design Decisions

- **Real PTY via node-pty**: previously used macOS `script -q /dev/null` to avoid native deps, but macOS 26 (Darwin 25) tightened `script` so it now errors with `tcgetattr/ioctl: Operation not supported on socket` when stdin isn't a TTY. Migrated to `node-pty`, which also gives us real `resize()` support
- **macOS-focused but portable**: no longer depends on `script`, so node-pty's platform support (macOS/Linux/Windows) applies — still only tested on macOS
- **No bundler**: vanilla JS served directly, xterm from CDN
- **Localhost only by default**: no auth, so binds to `127.0.0.1`. Override with `HOST` env var
- **No API key needed**: Haiku summaries use the `claude` CLI (`claude -p --model haiku`), which handles its own auth
- **Multi-agent**: Claude Code, Codex, and Gemini CLI sessions are unified under the same project view. Sessions are namespaced by agent (`claude`/`codex`/`gemini`) in the summary cache and WebSocket protocol (Claude uses plain IDs for backward compat)
- **Token usage is estimated**: costs are computed from JSONL usage fields using hardcoded model pricing, not from actual billing. Labeled "API equivalent" in the UI
