# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Herd is a web-based terminal multiplexer for Claude Code sessions. It lets you browse, resume, and manage Claude Code sessions across all your projects from a single browser tab. It scans `~/.claude/projects/` for session history (JSONL files).

## Commands

- `npm install` — install dependencies
- `npm start` — run the server (default http://localhost:3456, configurable via `PORT` env var)
- `npm test` — run Playwright browser tests (`test/hub.test.mjs`)
- **Restart server from Claude Code**: `lsof -ti:3456 | xargs kill -9 2>/dev/null; while lsof -ti:3456 >/dev/null 2>&1; do sleep 0.3; done; nohup node server.js > /tmp/herd.log 2>&1 &` — must be a single foreground Bash call, never use `run_in_background` (it kills child processes on cleanup)

No linter or build step configured. Tests use Playwright (devDependency).

## Architecture

Single-process Node.js server (`server.js`) serving a vanilla JS frontend (`public/`).

**Backend (`server.js`):**
- Express serves static files from `public/` and two REST endpoints:
  - `GET /api/projects` — lists projects from `~/.claude/projects/`, sorted by recency. Lazily prunes stale summary cache entries
  - `GET /api/projects/:id/sessions` — returns `{ sessions, total, truncated }` (max 30 sessions). Path traversal is blocked by validating resolved path stays inside `PROJECTS_DIR`
- WebSocket server (`noServer: true`) only upgrades connections on `/ws` path. Spawns terminal processes via macOS `script -q /dev/null` as a PTY wrapper (no native node-pty dependency). New sessions launch `claude` directly; resumed sessions use `claude --resume <id>`
- Claude binary is resolved once at startup from common paths or `which claude`
- Project paths are encoded/decoded between the filesystem dash-separated format in `~/.claude/projects/` and real paths using a backtracking solver (`decodeProjectPath`) that validates against the actual filesystem. `findEncodedDir()` reverse-lookups the encoded directory name for a given real path
- Security: binds to `127.0.0.1` by default (configurable via `HOST` env var), sets `X-Content-Type-Options` and `X-Frame-Options` headers, validates `resume` parameter as UUID format
- Haiku summaries: spawns `claude -p --model haiku` to generate 2-4 word session names (no API key needed), cached in `summaries.json` on disk. Background-generates missing summaries when sessions are fetched. Tracks in-flight requests to prevent duplicate calls
- Auto-naming: buffers terminal output (capped at 2KB) and periodically sends it to Haiku via CLI for tab title generation (max 5 renames over 30 minutes per session). Live titles are persisted to the summary cache on disk
- Session ID detection: for new (non-resumed) sessions, the server discovers the session ID by scanning the project dir for recently-created JSONL files, then notifies the client via a `ready` message
- JSONL parsing: reads session files line-by-line with chunked I/O (up to 20 lines, 64KB chunks) instead of a fixed 16KB buffer
- Graceful shutdown: SIGINT/SIGTERM kill terminal processes, close WebSocket server, then close HTTP server with a 3s timeout

**Frontend (`public/app.js`, `public/index.html`, `public/style.css`):**
- Single `Herd` class manages all state — project list, tabs, terminals, theme, search
- Each tab holds an xterm.js terminal instance connected to the server via WebSocket
- Tabs track `alive`, `unread`, and `finished` states; background tabs with 5s output idle are marked finished (green pulse)
- Terminal auto-refit: each terminal uses a `ResizeObserver` on its container to refit on any size change (window resize, sidebar drag, etc.)
- Smart scroll: output writes preserve scroll position when the user has scrolled up; auto-scrolls only when already at the bottom
- "+" button in tab bar creates a new session in the most recent active project
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

- **No native dependencies for PTY**: uses macOS `script` command instead of node-pty, which means terminal resize is limited (SIGWINCH is sent but underlying PTY size is fixed at initial dimensions)
- **macOS only**: the `script` invocation (`script -q /dev/null`) is macOS-specific
- **No bundler**: vanilla JS served directly, xterm from CDN
- **Localhost only by default**: no auth, so binds to `127.0.0.1`. Override with `HOST` env var
- **No API key needed**: Haiku summaries use the `claude` CLI (`claude -p --model haiku`), which handles its own auth
