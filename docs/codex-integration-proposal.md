# Codex Integration Proposal

## Goal

From the user's point of view:

- a project can contain sessions from either Claude or Codex
- the user can start a new session with either client
- each session row shows which agent created it
- resuming a session launches the correct client automatically

## Research Summary

### Herd today

Claude-specific in three places:

- discovery: `server.js` scans `~/.claude/projects/`
- launch/resume: `server.js` always spawns `claude` or `claude --resume <id>`
- UI: `public/app.js` treats every session as the same provider

### Codex CLI

Verified against `codex-cli 0.118.0`:

- `codex resume [SESSION_ID]` resumes a session (subcommand, not a flag)
- `-C, --cd <DIR>` sets working directory; available on both top-level and per-subcommand
- `--no-alt-screen` disables alternate screen mode (useful if TUI renders poorly in xterm.js)
- binary resolves via `which codex`

### Codex session storage

Rollout files live at `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<UUID>.jsonl`.

Line 1 of every rollout is a `session_meta` event containing everything Herd needs:

```json
{
  "type": "session_meta",
  "payload": {
    "id": "019d2193-2768-7421-918b-959ed03bd6ed",
    "cwd": "/Users/pd/health",
    "timestamp": "2026-03-24T20:39:45.261Z",
    "model_provider": "openai",
    "cli_version": "0.116.0"
  }
}
```

The first real user input appears as an `event_msg` with `payload.type === "user_message"` and a flat `payload.message` string (typically within the first 10 lines). Earlier `role: "user"` entries in the rollout carry injected context (AGENTS.md, permissions) and must be skipped.

A SQLite database exists at `~/.codex/state_5.sqlite` but we do not use it:

- the `_5` suffix is a schema version; upgrades would silently break Herd
- its `title` column is byte-identical to `first_user_message` in all observed rows (not a summary)
- concurrent-writer concerns (WAL mode helps but requires `PRAGMA busy_timeout` and read-only opens)
- adds a native dependency (`better-sqlite3`) which contradicts Herd's no-native-deps stance

Session IDs are UUID v7, matching Herd's existing UUID validation regex.

## Recommendation

Implement Codex as a second local CLI provider, symmetric with Claude: same JSONL scanning, same Haiku renamer, same session-id detection pattern.

Do not use `codex app-server` in v1.

## User Experience

### Project sidebar

- One project list merging Claude and Codex sessions under the same project path
- Sessions sorted by recency regardless of provider
- Provider badge (colored dot or small glyph) before each session label

### New session

Two small buttons per project header: one for Claude, one for Codex. Ctrl+T defaults to the last-used provider for the active project.

No split-button or dropdown menu needed.

### Resume

Clicking a session launches the correct provider. The session already knows its agent.

### Tabs

Same provider badge in tab labels to disambiguate when both providers are open.

## Backend Design

No provider registry or abstraction layer. Two providers are handled with a simple branch on `agent`. Introduce the abstraction if a third provider appears.

### 1. Codex binary resolution

Mirror Claude's startup resolution (`server.js:37-49`):

```js
const codexBin = (() => {
  const { execSync } = require('child_process');
  try { return execSync('/bin/sh -lc "which codex"', { encoding: 'utf8' }).trim(); }
  catch { return null; }
})();
```

`codexBin === null` means Codex is not installed; hide all Codex UI.

### 2. Codex rollout index

Build an in-memory cache on first use:

- scan `~/.codex/sessions/**/*.jsonl`
- read only line 1 of each file to extract `cwd` from `session_meta.payload`
- extract preview by scanning for first `event_msg` with `payload.type === "user_message"`
- cache entries keyed by `(filePath, mtimeMs)` — on subsequent scans, stat files and only re-read changed ones
- group by `cwd` to build the Codex project list

### 3. Shared session parser

Parameterize the existing `getSessionInfo` (`server.js:139`) with a pluggable message extractor:

- Claude: current logic — `entry.type === 'user' && entry.message.content` with content-array unwrapping
- Codex: `entry.type === 'event_msg' && entry.payload?.type === 'user_message'` returning `entry.payload.message`

Same chunked-line I/O (20 lines, 64KB cap). One function, two extractors.

### 4. Project listing

`GET /api/projects` returns one merged list:

- Claude projects: current `~/.claude/projects/` scan (unchanged)
- Codex projects: unique `cwd` values from the rollout index
- Merge by real path, deduplicate, sort by name

Response shape stays close to today's:

```js
{ path, name, exists, sessionCount, latestMtime }
```

The real project path is the identifier. No `sha1(path)`, no synthetic id.

### 5. Sessions endpoint

`GET /api/sessions?project=<path>` replaces `GET /api/projects/:id/sessions`:

- loads Claude sessions from the encoded dir (existing code via `findEncodedDir`)
- loads Codex sessions from the rollout index filtered by `cwd === path`
- merges into one array with normalized shape:

```js
{
  id: string,
  agent: "claude" | "codex",
  date: string,
  mtime: number,
  preview: string | null,
  summary: string | null,
}
```

Sorts by recency. Preserves the existing truncation contract (`{ sessions, total, truncated }`).

`agent` + `id` is unique. Use `${agent}:${id}` for DOM ids, map keys, and persisted tab state.

### 6. Launch and resume

WebSocket upgrade adds an `agent` query param.

Validation (before selecting a binary):

- `agent` must be `"claude"` or `"codex"` — reject otherwise
- `resume` UUID validation unchanged (`server.js:379`)

Commands:

| | Claude | Codex |
|---|---|---|
| New session | `claude` (current) | `codex -C <cwd>` |
| Resume | `claude --resume <id>` (current) | `codex resume -C <cwd> <id>` |

Always use the subcommand-local `-C` for Codex resume (not `codex -C <cwd> resume <id>`) because top-level flags are not guaranteed to propagate to subcommands in clap.

### 7. Session-id detection

Reuse the existing mtime-based scan (`server.js:494-513`). For Codex:

- scan `~/.codex/sessions/YYYY/MM/DD/` for today's date
- parse UUID from filename: `rollout-<ISO>-<UUID>.jsonl`
- same 5-second mtime window, same `ready` message to the client

### 8. Haiku renamer

Reuse the existing renamer for both providers (`server.js:205-238`). Namespace summary cache keys as `${agent}:${id}` to avoid collisions.

Codex does not need its own naming strategy — the first user message feeds into the same Haiku prompt, producing the same 2-4 word tab titles.

## Frontend Design

### 1. Session rendering

Prepend a provider badge span to each session row. Two CSS classes: `.badge-claude`, `.badge-codex`.

### 2. Tab state

Persist `agent` alongside `sessionId` and `projectPath` in localStorage. Without this, restored tabs cannot reconnect through the correct binary.

### 3. Create/resume calls

Thread `agent` through:

- `createTab(projectPath, name, resumeId, agent)`
- sidebar session click handlers
- new-session button handlers
- WebSocket query params

### 4. Styling

- provider badge (small colored dot, CSS only)
- second `+` button per project header
- badge in tab labels

## Phased Plan

### Phase 1: backend

- Codex binary resolution
- rollout index (scan, cache by mtime, cwd extraction)
- parameterized `getSessionInfo` extractor
- merged `/api/projects` response
- new `/api/sessions?project=<path>` endpoint
- `agent` validation and plumbing in WebSocket upgrade
- Codex launch/resume commands
- Codex session-id detection
- summary cache key namespacing

### Phase 2: frontend

- provider badge in sidebar sessions and tabs
- second `+` button per project header
- `agent` threaded through `createTab` and persisted in tab state
- resume wiring for correct provider

### Phase 3: tests and polish

- Playwright tests for mixed-provider project/session listing
- Playwright tests for starting Claude vs Codex sessions
- Playwright tests for resuming the correct provider
- Playwright tests for tab restore after refresh
- README update

## Risks and Open Questions

- **Rollout scan startup cost**: reads one line per Codex JSONL file. Trivial for typical corpora. The mtime-cached index handles incrementality for large collections.
- **`session_meta` schema drift**: if Codex changes the event shape, the scanner silently returns zero sessions. Log a warning at startup if the first rollout lacks expected fields.
- **Moved project directories**: old Codex rollouts still point at a previous `cwd`. Show those projects with `exists: false` (already done for Claude).
- **Codex TUI in xterm.js**: may render poorly under Herd's `script`-based PTY. If so, add `--no-alt-screen` to the launch command. Test empirically, don't assume upfront.
- **Long previews**: raw first user messages can exceed 200 chars. The Haiku renamer normalizes to 2-4 words; sidebar preview text is already clamped.

## Files to Touch

- `server.js`
- `public/app.js`
- `public/style.css`
- `public/index.html`
- `test/hub.test.mjs`

## Acceptance Criteria

- expanding a project shows a mixed list of Claude and Codex sessions
- every session row shows a provider badge
- starting either provider is a one-click action per project
- resuming a session launches the correct provider
- restored tabs reconnect through the correct provider after page refresh
- existing Claude-only behavior does not regress
