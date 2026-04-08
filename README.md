# Claude Hub

Web-based terminal multiplexer for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions.

Browse, resume, and manage Claude Code sessions across all your projects from a single browser tab.

## Features

- **Project sidebar** — all projects with Claude Code history, sorted by recency
- **Session browser** — recent sessions per project with AI-generated summaries
- **Terminal tabs** — multiple concurrent terminals (real shell via PTY)
- **Resume sessions** — click any past session to `claude --resume` it
- **Auto-naming** — tabs named by Haiku from terminal output
- **Double-click rename** — manual tab naming

## Setup

```bash
npm install
```

Create `.env` with your API key (for Haiku auto-naming):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Or copy from your existing project:

```bash
cp /path/to/your/project/.env .env
```

## Usage

```bash
npm start
# → http://localhost:3456
```

Open in browser. Click a project to see sessions. "New session" opens an interactive shell in that project's directory — run `claude`, `git`, or anything else.

## How it works

- Scans `~/.claude/projects/` for session history (JSONL files)
- Parses first user message from each session for preview
- Uses Claude Haiku to generate 2-4 word session summaries (cached in `summaries.json`)
- Spawns real PTY via macOS `script` command
- xterm.js in the browser for terminal rendering

## Stack

- **Backend**: Node.js, Express, WebSocket (`ws`)
- **Frontend**: Vanilla JS, xterm.js (CDN)
- **PTY**: macOS `script -q /dev/null` (no native dependencies)
- **Naming**: Claude Haiku via Anthropic API
