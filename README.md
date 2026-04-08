# Herd

Web-based terminal multiplexer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions.

Browse, resume, and manage Claude Code sessions across all your projects from a single browser tab.

## Features

- **Project sidebar** — all projects with Claude Code history, sorted by recency
- **Search/filter** — filter projects by name and sessions by summary/preview text
- **Session browser** — recent sessions per project with AI-generated summaries
- **Terminal tabs** — multiple concurrent Claude Code terminals with tab management
- **Resume sessions** — click any past session to `claude --resume` it
- **Auto-naming** — tabs named by Haiku from terminal output
- **Double-click rename** — manual tab naming
- **Theme system** — dark, light, and auto (system) themes
- **Keyboard shortcuts** — Ctrl+W (close tab), Ctrl+T (new session), Ctrl+PageDown/PageUp (cycle tabs)
- **New tab button** — "+" button in tab bar for quick session creation
- **Smart scroll** — auto-scrolls output only when you're at the bottom; preserves position when scrolled up
- **Auto-reconnect** — WebSocket reconnection with exponential backoff on disconnect
- **Resizable sidebar** — drag to resize, width persisted across reloads
- **Finished tab indicator** — green pulse on background tabs that finish while you're away

## Setup

```bash
npm install
```

## Usage

```bash
npm start
# → http://localhost:3456
```

Open in browser. Click a project to see sessions. Click "+ new session" to launch Claude Code in that project's directory, or click an existing session to resume it.

Configure with environment variables:

- `PORT` — server port (default: `3456`)
- `HOST` — bind address (default: `127.0.0.1`)

## Testing

```bash
npm test
```

Tests use [Playwright](https://playwright.dev/) for browser-level integration testing.

## How it works

- Scans `~/.claude/projects/` for session history (JSONL files)
- Decodes project paths from Claude Code's dash-separated directory naming via a backtracking solver
- Parses first user message from each session for preview text
- Uses Claude Haiku to generate 2-4 word session summaries (cached in `summaries.json`)
- Spawns real PTY via macOS `script` command (no native dependencies)
- xterm.js in the browser for terminal rendering
- WebSocket per terminal for real-time I/O

## Stack

- **Backend**: Node.js, Express, WebSocket (`ws`)
- **Frontend**: Vanilla JS, xterm.js (CDN)
- **PTY**: macOS `script -q /dev/null` (no native dependencies)
- **Naming**: Claude Haiku via `claude` CLI (no API key needed)
- **Tests**: Playwright

## Limitations

- **macOS only** — the `script -q /dev/null` PTY wrapper is macOS-specific
- **Terminal resize** — SIGWINCH is sent but underlying PTY size is fixed at initial dimensions (full resize requires node-pty)
- **No auth** — binds to localhost only; not intended for network exposure
