# Herd — Improvement Proposal

Deep code analysis of the full codebase (~1400 LOC across 4 source files).
Organized by priority within each category.

---

## Bugs

### B1. Unbounded `outputBuffer` memory leak
**`server.js:361`** — Each WebSocket session appends all terminal output to `outputBuffer` indefinitely. Only the last 800 chars are ever used (in `generateTitle()`). A long-running session producing megabytes of output will consume memory that's never freed.

**Fix:** Cap the buffer. After appending, trim to the last ~2KB:
```js
outputBuffer += str;
if (outputBuffer.length > 2048) outputBuffer = outputBuffer.slice(-2048);
```

### B2. Race condition in summary generation
**`server.js:193-206`** — Multiple concurrent `GET /api/projects/:id/sessions` requests will all call `generateMissingSummaries()` for the same sessions, firing duplicate Haiku API calls. There's no in-flight tracking.

**Fix:** Maintain a `Set` of session IDs currently being summarized. Skip any already in-flight:
```js
const summarizing = new Set();
// in generateMissingSummaries:
const uncached = sessions.filter(s => !summaryCache[s.id] && !summarizing.has(s.id) && s.preview);
uncached.forEach(s => summarizing.add(s.id));
// after each completes: summarizing.delete(s.id);
```

### B3. Keyboard shortcuts declared but not implemented
**`public/app.js:67-69`** — Comments mention Ctrl+T (new session) and Ctrl+Tab/Ctrl+Shift+Tab (switch tabs) but only Ctrl+W is actually wired up.

**Fix:** Implement them or remove the misleading comments. At minimum, Ctrl+Tab cycling is expected behavior:
```js
if (e.ctrlKey && e.key === 'Tab') {
  e.preventDefault();
  const ids = [...this.tabs.keys()];
  const idx = ids.indexOf(this.activeTabId);
  const next = e.shiftKey
    ? ids[(idx - 1 + ids.length) % ids.length]
    : ids[(idx + 1) % ids.length];
  this.switchTab(next);
}
```

### B4. WebSocket path not enforced
**`server.js:286`** — The `WebSocketServer` is attached to the HTTP server globally, accepting connections on **any** URL path. The client connects to `/ws`, but connections to `/api/projects` (or any other path) would also be upgraded to WebSocket.

**Fix:** Filter on the upgrade path:
```js
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
// Create WSS with noServer: true
const wss = new WebSocketServer({ noServer: true });
```

### B5. `summaries.json` grows forever
**`server.js:159-165`** — Session summaries are cached permanently. When projects are deleted or sessions are cleaned up, their summary entries remain. Over months of use, this file accumulates stale data.

**Fix:** Periodically prune summaries that no longer have corresponding JSONL files. Could be done lazily during `GET /api/projects`.

### B6. No `resume` parameter validation
**`server.js:289`** — The `resume` query parameter is passed directly as a CLI argument to `claude --resume <id>`. While `spawn` doesn't invoke a shell (so no injection), the value isn't validated to be a UUID format. Arbitrary strings get passed as arguments.

**Fix:** Validate format before use:
```js
if (resume && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resume)) {
  ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID format' }));
  ws.close(); return;
}
```

### B7. Session list silently truncated at 30
**`server.js:257`** — `.slice(0, 30)` silently drops older sessions. Projects with 50+ sessions show only the latest 30 with no indication that more exist.

**Fix:** Either implement pagination, or at minimum return a `truncated: true` flag and total count so the UI can inform the user.

### B8. `encodeProjectPath` produces wrong directory names
**`server.js:103,397`** — When resuming a session, the code calls `encodeProjectPath(projectPath)` to locate the JSONL directory. This function only replaces `/` with `-`, but Claude Code's actual encoder also converts dots and other characters to dashes. Real proof: the directory `-Users-pd--Trash-mia-evals` on disk has a double-dash (encoding `.Trash`), which `encodeProjectPath` would never produce — it would emit `-Users-pd-.Trash-mia-evals` instead. Any project path containing dots, dashes, or underscores in directory names will fail to resolve, silently losing the session title on resume.

**Fix:** Don't re-encode. Look up the actual directory name by decoding all candidates:
```js
const dirs = fs.readdirSync(PROJECTS_DIR);
const encodedProject = dirs.find(d => decodeProjectPath(d) === projectPath);
```

### B9. Dead code: `userShell` variable
**`server.js:284`** — `const userShell = process.env.SHELL || '/bin/zsh'` is defined but never referenced. Leftover from when sessions spawned an interactive shell instead of launching `claude` directly.

**Fix:** Delete the line.

---

## Missing Features

### F1. Project/session search
No way to filter the sidebar when you have dozens of projects. A simple text filter at the top of the sidebar that matches project names and session previews.

### F2. WebSocket reconnection
**`public/app.js:308-314`** — When the WebSocket disconnects, the terminal just shows `[disconnected]` and is permanently dead. Network blips, server restarts, or laptop sleep/wake all kill sessions irreversibly.

**Proposal:** Implement automatic reconnection with exponential backoff. For resume-capable sessions (those with a `sessionId`), reconnect by creating a new WebSocket with the same `resume` parameter. Show a reconnection overlay on the terminal.

### F3. Confirm before closing tab with active process
**`public/app.js:349`** — `closeTab()` immediately kills the terminal/process with no confirmation. Users can accidentally Ctrl+W a running Claude session with unsaved work.

**Proposal:** If `tab.alive`, show a brief confirmation or require double-Ctrl+W within 2 seconds.

### F4. Project path tooltip / display
Sidebar shows short project names (`user/repo`) but never the full path. For projects with the same repo name under different parent directories, they appear identical.

**Proposal:** Show full path in a tooltip on the project header. Could also add a small breadcrumb-style display when a project is expanded.

### F5. Refresh project list without page reload
No mechanism to discover new projects or sessions without reloading the page. If you start a new Claude session from the terminal, it won't appear until refresh.

**Proposal:** Add a refresh button in the sidebar header. Optionally, poll or use `fs.watch` on the server side with a push notification.

### F6. Tab context menu
No right-click menu on tabs. Common operations like "Close Others", "Close to the Right", "Copy Session ID" have no affordance.

### F7. Browser notifications for finished tabs
Background tabs that finish (green pulse) are easy to miss if the browser window isn't visible. Use the Notifications API to alert the user.

### F8. Sidebar highlights active project
When a tab is active, the corresponding project in the sidebar isn't visually highlighted. With many projects open, it's hard to know which project the current tab belongs to.

### F9. Session status indicator in sidebar
Sessions in the sidebar don't indicate whether they're currently running in a tab. The `finished` green highlight exists but there's no "active" or "running" indicator.

### F10. Favicon
No favicon is set. The browser tab shows a generic icon. A simple `>_` favicon (even an SVG data URI) would help identify tabs.

---

## Refactoring

### R1. God object `Herd`
**`public/app.js`** — The entire frontend is a single 520-line class handling: theme management, project listing, session loading, tab lifecycle, terminal setup, WebSocket management, sidebar resize, and DOM rendering. This makes it hard to modify any one concern without reading the whole class.

**Proposal:** Extract into focused modules:
- `ThemeManager` — theme state, CSS/xterm theme application
- `TabManager` — tab create/close/switch/render, tab state
- `ProjectList` — fetch/render projects and sessions, sidebar logic
- `TerminalSession` — xterm + WebSocket lifecycle per tab

This can be done incrementally, even without a bundler, by just splitting the class into multiple classes in the same file.

### R2. Duplicated ANSI stripping
`server.js:368` and `public/app.js:505` both have ANSI-stripping regexes that are slightly different. The server version strips two patterns; the client strips three (including control chars `[\x00-\x1f]`).

**Fix:** Use consistent logic. The server should also strip control characters to avoid sending garbage to Haiku.

### R3. Inline HTML string building
**`public/app.js:137-145, 173-181`** — Projects and sessions are rendered via template literal HTML concatenation. This is fragile (escaping issues, hard to maintain) and mixes logic with presentation.

**Proposal:** Extract small render functions that create DOM elements programmatically, or at minimum use a `createElement` helper pattern. This also eliminates the manual `esc()` dance.

### R4. Magic numbers
Numerous unnamed constants throughout:
- `200` — output threshold to mark tab as having activity (`app.js:256`)
- `5000` — idle timeout before marking tab as finished (`app.js:266`)
- `16384` — bytes to read from session JSONL (`server.js:121`)
- `30` — max sessions returned (`server.js:257`)
- `150` — max preview text length (`server.js:144`)
- `10000` — xterm scrollback lines (`app.js:226`)
- `500` — max sidebar drag width (`app.js:483`)

**Fix:** Define named constants at module level for clarity and easy tuning.

### R5. Fallback path decoder is dead-weight duplication
**`server.js:76-101`** — The fallback greedy decoder after `solve()` returns null is essentially a simplified copy of the backtracking solver. It handles deleted projects where the path no longer exists on disk.

**Proposal:** Simplify to a single pass: if `solve()` fails, just do `'/' + parts.join('/')` as a display-only fallback. The elaborate greedy re-walk of the filesystem yields marginal benefit for deleted project names.

---

## Polish

### P1. Loading state for new sessions
When clicking "+ new session", there's no visual feedback until Claude produces output (which can take several seconds for startup). The terminal area is blank.

**Proposal:** Show a subtle "Connecting..." overlay or spinner on the terminal wrapper until the first `output` message arrives.

### P2. Terminal padding inconsistency
**`public/style.css:328`** — `padding: 2px 0 0 4px` leaves no bottom or right padding, making text touch the edges.

**Fix:** `padding: 4px` on all sides.

### P3. Sidebar width persistence
The sidebar can be dragged to resize, but the width resets on page reload.

**Fix:** Save to `localStorage` in the `mouseup` handler and restore in `setupResize()`.

### P4. Tab bar scrolling with many tabs
**`public/style.css:225-228`** — Tab overflow scrolling hides the scrollbar (`scrollbar-width: none`), so users can't see there are more tabs or easily scroll to them.

**Proposal:** Add scroll arrows or at least show scroll indicators when tabs overflow.

### P5. Empty state could be more useful
**`public/index.html:29-37`** — The empty state shows generic text. Could display recent sessions across all projects (a "Recent" quick-access list) or keyboard shortcut hints.

### P6. Server listens on 0.0.0.0 by default
**`server.js:462`** — `server.listen(PORT)` without a host binds to all interfaces. Since this app spawns shell processes and has no auth, it should default to localhost only.

**Fix:** `server.listen(PORT, '127.0.0.1', ...)` — users who need network access can override via env var.

### P7. Graceful shutdown
**`server.js:453-458`** — `cleanup()` kills terminal processes and immediately calls `process.exit()`. This doesn't close WebSocket connections gracefully or drain HTTP responses.

**Fix:** Close the `wss` and `server` before exiting, with a short timeout:
```js
function cleanup() {
  for (const [, term] of terminals) try { term.proc.kill('SIGTERM'); } catch {}
  wss.close();
  server.close(() => process.exit());
  setTimeout(() => process.exit(1), 3000);
}
```

### P8. CDN failure resilience
All three xterm dependencies (xterm, fit-addon, web-links-addon) are loaded from jsdelivr CDN. If the CDN is unavailable (offline, corporate firewall), the app is completely broken with no error message.

**Proposal:** Either vendor the xterm files locally, or add fallback error handling that shows a clear message when xterm fails to load.

### P9. `beforeunload` warning
No warning when closing/reloading the page with active sessions. Users can accidentally kill running sessions.

**Fix:**
```js
window.addEventListener('beforeunload', e => {
  if ([...this.tabs.values()].some(t => t.alive)) {
    e.preventDefault();
    e.returnValue = '';
  }
});
```

### P10. No CSP or security headers
The Express server doesn't set any security headers. At minimum: `X-Content-Type-Options`, `X-Frame-Options`, and a basic CSP that allows the CDN origin.

---

## Security

### S1. Bind to localhost by default
Covered in P6 above. This is the single most important security issue — the server currently exposes unauthenticated shell access on all network interfaces.

### S2. Add basic security headers
```js
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
```

### S3. Rate limit the Haiku API proxy
`generateSummary()` calls the Anthropic API on behalf of the user. Multiple rapid session-list loads could trigger excessive API calls. The race condition fix (B2) partially addresses this, but a simple rate limiter (e.g., max 10 calls/minute) would add defense in depth.

---

## Summary of priorities

| Priority | Items | Impact |
|----------|-------|--------|
| **Critical** | S1 (localhost binding), B1 (memory leak), B8 (broken path encoding) | Security / stability |
| **High** | B2 (race condition), B3 (shortcuts), B4 (WS path), F2 (reconnection), P9 (beforeunload) | UX / correctness |
| **Medium** | F1 (search), F3 (close confirm), F5 (refresh), P1 (loading state), P3 (sidebar persist), P6 (localhost), B6 (resume validation) | Features / polish |
| **Low** | B9 (dead code), R1-R5 (refactoring), F4-F10 (nice-to-haves), P2/P4/P5/P7/P8/P10 | Code quality / DX |
