# Implementation Proposal: Integrate pi.dev into Herd

> **Status:** Draft  
> **Date:** 2026-04-20  
> **Default Model:** GLM-5.1 via OpenRouter (`z-ai/glm-5.1`)

---

## 1. Executive Summary

Add [pi.dev](https://pi.dev) (the `pi` coding agent, npm: `@mariozechner/pi-coding-agent`) as a fourth agent type in Herd alongside Claude Code, Codex, and Gemini CLI. Pi is a minimal terminal coding harness that supports multiple LLM providers via its own provider system. The user's default configuration uses **GLM-5.1** on **OpenRouter** — a $0.95/$3.15 per-million-token model from Z.ai with a 202K context window, extended thinking, and tool-use support.

Integration follows the same patterns already established for Codex and Gemini: session history scanning, project merging, PTY-based terminal spawning, summary generation, and sidebar rendering.

---

## 2. Research Findings

### 2.1 pi.dev Agent Overview

| Aspect | Detail |
|--------|--------|
| **Package** | `@mariozechner/pi-coding-agent` (global npm) |
| **Binary** | `pi` (resolved via `which pi`) |
| **Session dir** | `~/.pi/agent/sessions/` |
| **Session format** | JSONL, v3 tree-structured with `id`/`parentId` |
| **Provider system** | Multi-provider: Anthropic, OpenAI, Google, OpenRouter, 20+ more |
| **Custom models** | `~/.pi/agent/models.json` for adding custom providers/models |
| **Auth** | `~/.pi/agent/auth.json` (API keys + OAuth tokens) |
| **Settings** | `~/.pi/agent/settings.json` (default provider/model/thinking level) |
| **Resume** | `pi --session <path-or-uuid>` or `pi --continue` or `pi --resume` (interactive picker) |
| **Non-interactive** | `pi -p "prompt"` for one-shot |
| **RPC mode** | `pi --mode rpc` for JSON protocol over stdin/stdout |
| **SDK** | `createAgentSession()` from `@mariozechner/pi-coding-agent` |

### 2.2 pi Session Storage

**Directory structure:**
```
~/.pi/agent/sessions/
  --Users-pd-Documents-Personal-herd--/
    2026-04-20T10-47-33-320Z_019daa80-aec7-7390-a080-0026572d808b.jsonl
    2026-04-20T11-06-20-136Z_019daa91-e068-72cf-88da-baf35a1c2ac7.jsonl
  --Users-pd-Documents-gpt_meditation--/
    ...
```

**Key differences from Claude/Codex/Gemini:**
- **Path encoding:** Double-dash prefix AND suffix (`--<path>--`) vs Claude's single-dash prefix (`-<path>`)
- **Filename format:** `<ISO-timestamp>_<UUIDv7>.jsonl` — timestamp is embedded in filename
- **Session UUID:** UUIDv7 format (time-sortable), stored both in filename AND first line header; filename UUID and header `id` **always match** (verified in pi's `createBranchedSession` / `forkFrom` — both call `createSessionId()` once and use the result for both filename and header)
- **Session header:** `{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/real/path"}`. Branched/forked sessions additionally have `parentSession: "<source-path>"`.
- **Message entries:** `{"type":"message","id":"hex8","parentId":"hex8","timestamp":"...","message":{...}}`

### 2.3 pi Session JSONL Entry Types

| Entry Type | Description | Fields of Interest |
|------------|-------------|-------------------|
| `session` | Header (first line) | `id`, `version`, `timestamp`, `cwd` |
| `model_change` | Model switch event | `provider`, `modelId` |
| `thinking_level_change` | Thinking level change | `thinkingLevel` |
| `message` | Conversation message | `message.role`, `message.content`, `message.usage`, `message.model`, `message.provider` |
| `compaction` | Context compaction | `summary`, `tokensBefore` |
| `branch_summary` | Branch summary | `fromId`, `summary` |
| `session_info` | User-set session name | `name` |
| `custom` | Extension state | `customType`, `data` |
| `custom_message` | Extension-injected msg | `customType`, `content` |
| `label` | Bookmark/marker | `targetId`, `label` |

**Message roles:** `user`, `assistant`, `toolResult`, `bashExecution`, `custom`, `branchSummary`, `compactionSummary`

**Usage format (in assistant messages):**
```json
// Google (provider = "google") — cost is populated
"usage": {
  "input": 3737, "output": 73, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 3810,
  "cost": { "input": 0.007474, "output": 0.000876, "cacheRead": 0, "cacheWrite": 0, "total": 0.00835 }
}

// OpenRouter (provider = "openrouter") — cost is always zero
"usage": {
  "input": 4051, "output": 88, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 4139,
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
}
```

Verified empirically against the user's session store (2026-04-20): **117/117** OpenRouter messages reported `cost.total = 0`; **9/9** Google messages had non-zero costs. Token usage integration is deferred for now (see Section 4.9) — we cannot rely on pi's per-message cost for OpenRouter sessions and must compute from `input`/`output`/`cacheRead` fields using our own pricing table.

### 2.4 GLM-5.1 on OpenRouter

| Parameter | Value |
|-----------|-------|
| **Model ID** | `z-ai/glm-5.1` |
| **Provider** | OpenRouter |
| **Context window** | 202,752 tokens |
| **Max completion** | 65,535 tokens |
| **Input price** | $0.95 / M tokens |
| **Output price** | $3.15 / M tokens |
| **Cache read** | $0.475 / M tokens |
| **Modality** | text → text |
| **Reasoning** | Yes (extended thinking) |
| **Tool use** | Yes (parallel tool calls supported) |
| **API** | OpenAI-compatible (`openai-completions`) |

Source: `GET https://openrouter.ai/api/v1/models` on 2026-04-20 — `context_length: 202752`, `top_provider.max_completion_tokens: 65535`, `pricing.prompt: "0.00000095"`, `pricing.completion: "0.00000315"`, `pricing.input_cache_read: "0.000000475"`.

**Note:** The user's local `~/.pi/agent/models.json` declares `contextWindow: 128000` and `maxTokens: 8192` — smaller than OpenRouter's actual capability. Pi uses the values from `models.json` when sizing requests, so the effective limits per this user are the local ones. Herd should not hardcode either number; any UI that shows context-window fractions must read from pi's config or the session's `model_change` entries.

**Comparison with other Herd agents:**

| Agent | Default Model | Input $/M | Output $/M | Context |
|-------|---------------|-----------|------------|---------|
| Claude | Opus 4.6 | $5.00 | $25.00 | 1M |
| Codex | o4-mini | $1.10 | $4.40 | 200K |
| Gemini | Gemini 3.1 Pro | varies | varies | 1M+ |
| **Pi (GLM-5.1)** | **GLM-5.1** | **$0.95** | **$3.15** | **203K** |

GLM-5.1 is the cheapest coding-capable model in Herd's lineup, making pi an attractive option for routine tasks.

### 2.5 User's Current pi Configuration

From `~/.pi/agent/settings.json`:
```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "z-ai/glm-5.1",
  "defaultThinkingLevel": "high",
  "hideThinkingBlock": true
}
```

From `~/.pi/agent/models.json`:
```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "OPENROUTER_API_KEY",
      "api": "openai-completions",
      "models": [
        {
          "id": "z-ai/glm-5.1",
          "name": "GLM 5.1 (OpenRouter)",
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192,
          "reasoning": true
        }
      ]
    }
  }
}
```

The user already has pi configured with GLM-5.1 as default. Integration should respect this configuration and not hardcode the model — pi will use whatever the user's settings specify.

---

## 3. Architecture

### 3.1 Design Principles

Follow the established patterns from Codex/Gemini integration:
1. **Scan session history** from `~/.pi/agent/sessions/` on server startup and API calls
2. **Merge into unified project view** by matching `cwd` fields against existing project paths
3. **Spawn via node-pty** inside a shell (same as Claude/Codex/Gemini)
4. **Summary generation** using existing Haiku pipeline (pi sessions need summaries too)
5. **Badge/icon** with distinct visual identity in sidebar
6. **Minimal changes** — extend, don't refactor

**Binary-missing policy:** `scanPiSessions()` returns early when `!piBin` — matching `scanCodexSessions` (`server.js:96`) and `scanGeminiSessions` (`server.js:211`). Users without pi installed see no pi history; consistent with existing behavior.

### 3.2 Component Changes

```
┌─────────────────────────────────────────────────────────────────┐
│                        server.js                                 │
├─────────────────────────────────────────────────────────────────┤
│ 1. PI_SESSIONS_DIR constant                                      │
│ 2. piBin resolver (like claudeBin/codexBin/geminiBin)            │
│ 3. piIndex scanner (like codexIndex/geminiIndex)                 │
│ 4. parsePiSession() function                                      │
│ 5. Agent validation: add 'pi' to allowed agents                   │
│ 6. WS launch command for pi                                       │
│ 7. Session ID detection for new pi sessions                      │
│ 8. Summary cache key: "pi:<uuid>"                                │
│ 9. piAvailable flag on projects                                 │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        public/app.js                             │
├─────────────────────────────────────────────────────────────────┤
│ 1. piAvailable tracking (like codexAvailable/geminiAvailable)    │
│ 2. "pi" button in new-session-actions                            │
│ 3. badge-pi CSS class references                                 │
│ 4. Agent 'pi' in createTab/newSessionInLastProject               │
│ 5. pi session rendering in sidebar                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        public/style.css                          │
├─────────────────────────────────────────────────────────────────┤
│ 1. .badge-pi styling (color, shape)                              │
│ 2. .new-session-pi button styling                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Detailed Implementation

### 4.1 Server: Session Directory & Binary Resolution

```javascript
// Add alongside existing CLAUDE_DIR/CODEX_SESSIONS_DIR/GEMINI_TMP_DIR
const PI_DIR = path.join(os.homedir(), '.pi', 'agent');
const PI_SESSIONS_DIR = path.join(PI_DIR, 'sessions');

// Resolve pi binary (same pattern as codex/gemini)
const piBin = (() => {
  const { execSync } = require('child_process');
  try { return execSync('/bin/sh -lc "which pi"', { encoding: 'utf8' }).trim(); }
  catch { return null; }
})();
console.log(`  Pi binary: ${piBin || '(not installed)'}`);
```

### 4.2 Server: pi Session Index

Pi session directories use `--<dashed-path>--` encoding (double-dash prefix and suffix). Each directory contains JSONL files with the naming format `<ISO-timestamp>_<UUID>.jsonl`.

```javascript
const piIndex = new Map(); // sessionId -> { id, cwd, mtime, date, preview, jsonlPath }

function scanPiSessions() {
  if (!piBin) return;
  try { fs.statSync(PI_SESSIONS_DIR); } catch { return; }

  const seen = new Set();
  const dirs = readdirSafe(PI_SESSIONS_DIR);

  for (const dirName of dirs) {
    const projDir = path.join(PI_SESSIONS_DIR, dirName);
    if (!isDir(projDir)) continue;

    for (const file of readdirSafe(projDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projDir, file);
      seen.add(filePath);
      try {
        const stat = fs.statSync(filePath);
        const cached = piIndex.get(filePath);
        if (cached && cached.mtime === stat.mtimeMs) continue;
        const info = parsePiSession(filePath, stat);
        if (info) piIndex.set(filePath, info);
      } catch {}
    }
  }

  // Prune deleted files
  for (const key of piIndex.keys()) {
    if (!seen.has(key)) piIndex.delete(key);
  }
}
```

### 4.3 Server: Parse pi Session JSONL

Pi's JSONL format is different from Claude's. Key parsing differences:
- First line is a `session` header with `cwd` and `id` (not a user message)
- Messages are wrapped in `{"type":"message","message":{...}}` entries (not bare message objects)
- User messages have `content` as array of content blocks (not plain string)
- Session names come from `session_info` entries
- Model/provider come from `model_change` entries

```javascript
function parsePiSession(filePath, stat) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const CHUNK_SIZE = 65536;
    const MAX_LINES = 25;
    const lines = [];
    let remainder = '';
    let offset = 0;
    while (lines.length < MAX_LINES) {
      const buf = Buffer.alloc(CHUNK_SIZE);
      const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const chunk = remainder + buf.toString('utf8', 0, bytesRead);
      const parts = chunk.split('\n');
      remainder = parts.pop();
      for (const part of parts) {
        if (part.trim()) lines.push(part);
        if (lines.length >= MAX_LINES) break;
      }
    }

    let id = null, cwd = null, preview = null, sessionName = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Session header: extract ID and CWD
        if (entry.type === 'session') {
          id = entry.id;
          cwd = entry.cwd;
        }

        // User-set session name (takes priority over preview)
        if (entry.type === 'session_info' && entry.name) {
          sessionName = entry.name;
        }

        // First user message for preview
        if (!preview && entry.type === 'message' && entry.message?.role === 'user') {
          const content = entry.message.content;
          let text = '';
          if (typeof content === 'string') text = content;
          else if (Array.isArray(content)) {
            text = content
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join(' ');
          }
          if (text && text.length > 3) {
            preview = text.slice(0, 150).replace(/\n/g, ' ').trim();
          }
        }
      } catch {}
    }

    if (!id || !cwd) return null;

    let realCwd = cwd;
    try { realCwd = fs.realpathSync(cwd); } catch {}

    return {
      id, // UUID from session header (always matches filename UUID — see Section 2.2)
      cwd: realCwd,
      mtime: stat.mtimeMs,
      date: stat.mtime.toISOString(),
      preview: sessionName || preview,
      jsonlPath: filePath,
    };
  } finally {
    fs.closeSync(fd);
  }
}
```

### 4.4 Server: pi Path Decoding

Pi encodes paths as `--<dashed>--` (double-dash prefix AND suffix). To recover the real path, strip the leading `--` and trailing `--`, then decode dashes similarly to Claude's `decodeProjectPath`:

```javascript
function decodePiProjectPath(encoded) {
  // Strip leading -- and trailing --
  let raw = encoded;
  if (raw.startsWith('--')) raw = raw.slice(2);
  if (raw.endsWith('--')) raw = raw.slice(0, -2);

  // Reuse Claude's backtracking decoder on the stripped path
  return decodeProjectPath(raw);
}
```

**Encoding detail (verified):** Unlike Claude's format, pi preserves `_` literally in encoded directory names (e.g. `--Users-pd-Documents-gpt_meditation--` → `/Users/pd/Documents/gpt_meditation`). The backtracking solver at `server.js:304` handles this correctly because segments without internal dashes match on the first pass with no `_`/`.` fallback needed — reuse is safe but over-powered. Smoke test during implementation: verify `decodePiProjectPath('--Users-pd-Documents-gpt_meditation--')` and `decodePiProjectPath('--Users-pd-Documents-Personal-herd--')` both resolve correctly against real disk state.

### 4.5 Server: Merge pi into Projects & Sessions

In `GET /api/projects`, add pi sessions alongside Claude/Codex/Gemini:

```javascript
// Pi projects grouped by cwd
for (const entry of piIndex.values()) {
  const key = canon(entry.cwd);
  const existing = projectMap.get(key);
  if (existing) {
    existing.piCount++;
    if (entry.mtime > existing.latestMtime) existing.latestMtime = entry.mtime;
  } else {
    const exists = fs.existsSync(key);
    projectMap.set(key, {
      path: key, name: getProjectName(key), exists,
      claudeCount: 0, codexCount: 0, geminiCount: 0, piCount: 1,
      latestMtime: entry.mtime, claudeEncoded: null,
    });
  }
}
```

**Required changes to existing `projectMap.set(...)` sites** (so `existing.piCount++` never touches an undefined field):

- `server.js:854` — Claude-path initializer: add `piCount: 0`
- `server.js:871` — Codex initializer: add `piCount: 0`
- `server.js:888` — Gemini initializer: add `piCount: 0`
- `server.js:901` — update `sessionCount` formula from `p.claudeCount + p.codexCount + p.geminiCount` to include `+ p.piCount`

Add `piAvailable` flag to project response (mirror of `codexAvailable` / `geminiAvailable` at `server.js:903-904`):
```javascript
projects.push({
  ...p,
  piAvailable: !!piBin,
});
```

In `serveSessions()`, add pi sessions:
```javascript
// Pi sessions
for (const entry of piIndex.values()) {
  if (entry.cwd !== projectPath && canonOf(entry.cwd) !== canonQuery) continue;
  const key = summaryCacheKey('pi', entry.id);
  allSessions.push({
    id: entry.id, agent: 'pi', date: entry.date, mtime: entry.mtime,
    preview: entry.preview,
    summary: getSummaryText(key),
    jsonlPath: entry.jsonlPath,
  });
}
```

### 4.6 Server: WebSocket Terminal Launch for pi

In the WS `connection` handler, add `pi` to the agent validation and launch logic:

```javascript
// Validate agent
if (agent !== 'claude' && agent !== 'codex' && agent !== 'gemini' && agent !== 'pi') {
  ws.send(JSON.stringify({ type: 'error', message: 'Invalid agent' }));
  ws.close();
  return;
}
if (agent === 'pi' && !piBin) {
  ws.send(JSON.stringify({ type: 'error', message: 'Pi is not installed' }));
  ws.close();
  return;
}
```

Launch command for pi:
```javascript
if (agent === 'pi') {
  if (resume) {
    // pi --session accepts partial UUIDs (not just file paths).
    // resolveSessionPath() searches current project first, then globally.
    // This is simpler than looking up jsonlPath from piIndex.
    launchCmd = `${setSize}${piBin} --session ${resume}\n`;
  } else {
    launchCmd = `${setSize}${piBin}\n`;
  }
}
```

**Why `--session <uuid>` instead of `--session <path>`:** Pi's `resolveSessionPath()` (verified in `dist/main.js:106`) accepts partial UUIDs and resolves them via `s.id.startsWith(sessionArg)` — current project first, then global across all projects. This eliminates the need to look up `jsonlPath` from `piIndex` at resume time. If no match is found, pi prints `No session found matching '<arg>'` and exits(1).

**Edge case (verified):** If a session is found in a *different* project's directory, pi prints `Session found in different project: <cwd>` and prompts interactively: `Fork this session into current directory? [y/N]` (verified literal strings in `dist/main.js:187-188`). If the user answers `n` (or anything other than `y`/`yes`), pi prints `Aborted.` and exits(0) — it does **not** hang the PTY. Since we spawn the PTY with the correct `cwd`, the local branch of `resolveSessionPath` wins and this prompt should not fire in practice; but if a user manually copies a session file into a different project, we get a clean abort rather than a stuck terminal.

### 4.7 Server: Summary Cache Key for pi

```javascript
function summaryCacheKey(agent, id) {
  if (agent === 'codex') return `codex:${id}`;
  if (agent === 'gemini') return `gemini:${id}`;
  if (agent === 'pi') return `pi:${id}`;
  return id; // Claude: plain ID for backward compat
}
```

### 4.8 Server: pi Session ID Detection (New Sessions)

When a new pi session is created, detect the session ID by scanning `~/.pi/agent/sessions/<project-dir>/` for recently-created files:

```javascript
if (agent === 'pi') {
  if (!encodedDir) return null;
  // Pi's session dir uses --<dashed-path>-- encoding
  // Find the matching pi session directory
  const piDirs = readdirSafe(PI_SESSIONS_DIR);
  for (const dirName of piDirs) {
    const decoded = decodePiProjectPath(dirName);
    if (decoded !== resolvedProject) continue;
    const projDir = path.join(PI_SESSIONS_DIR, dirName);
    try {
      const files = fs.readdirSync(projDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const filePath = path.join(projDir, f);
          const stat = fs.statSync(filePath);
          return { name: f, path: filePath, mtime: stat.mtimeMs };
        })
        .filter(f => f.mtime >= sessionStart - 5000)
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        // Read first line to get session ID
        const header = JSON.parse(
          fs.readFileSync(files[0].path, 'utf8').split('\n')[0]
        );
        if (header.type === 'session' && header.id) {
          sessionId = header.id;
          const entry = terminals.get(termId);
          if (entry) entry.sessionId = sessionId;
          try { ws.send(JSON.stringify({ type: 'ready', termId, sessionId })); } catch {}
        }
      }
    } catch {}
  }
}
```

### 4.9 Server: Token Usage for pi Sessions — DEFERRED

Token usage integration for pi sessions is **deferred** to a follow-up. Key challenges:

- **`computeTokenUsage()` currently only scans Claude's `PROJECTS_DIR`** — adding pi requires a separate scanning loop over `PI_SESSIONS_DIR`
- **Pi's `usage` field names differ from Claude's**: `usage.input`/`usage.output`/`usage.cacheRead`/`usage.cacheWrite` vs Claude's `usage.input_tokens`/`usage.output_tokens`/`usage.cache_read_input_tokens`/`usage.cache_creation_input_tokens`
- **OpenRouter returns `cost.total = 0`** for all messages — pi's own cost calculation cannot be used as-is; we'd need our own `MODEL_PRICING` entries for pi models
- Pi supports arbitrary models via `models.json` — we'd need pricing for each or a fallback strategy

When implemented, the approach should:
1. Add a scanning loop for `PI_SESSIONS_DIR` parallel to the existing `PROJECTS_DIR` scan
2. Map pi's field names to the `computeTokenUsage()` aggregation structure
3. Add pricing entries for common pi models (GLM-5.1, Gemini models) to `MODEL_PRICING`
4. Use pi's `usage.cost.total` as fallback only when we have no pricing data for the model

### 4.10 Server: Haiku Summary Generation for pi

**Decision: dedicated `getPiUserMessages(jsonlPath)`** rather than branching inside `getUserMessages`. Pi's entry wrapping (`{type:"message", message:{role, content}}`) and content-block array differ enough from Claude's format that a union parser would be harder to reason about than two parallel ones. This keeps `getUserMessages` unchanged and avoids regressions for Claude sessions.

```javascript
function getPiUserMessages(jsonlPath) {
  const messages = [];
  // Chunked line read (same pattern as parsePiSession / getUserMessages) up to MAX_LINES
  for (const line of readJsonlLines(jsonlPath)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
    const content = entry.message.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.filter(c => c.type === 'text').map(c => c.text).join(' ');
    }
    if (text && text.length > 3 && !text.startsWith('You are a')) {
      messages.push(text.slice(0, 300).replace(/\n/g, ' ').trim());
    }
  }
  return messages;
}
```

Call sites that select by agent (Haiku naming, summary regen) branch on `agent === 'pi'` to dispatch to `getPiUserMessages`; existing Claude/Codex/Gemini paths remain untouched.

### 4.11 Frontend: Badge & Button

**badge-pi styling** (in `style.css`):
```css
.badge-pi {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #000000; /* black — distinct from claude (amber), codex (blue), gemini (purple) */
}
```

**New session button** (in `app.js`, `toggleProject()`):
```javascript
const piBtn = this.piAvailable
  ? '<button class="new-session-btn new-session-pi" data-agent="pi"><span class="badge-pi"></span> pi</button>'
  // Note: lowercase 'pi' per convention
  : '';
container.innerHTML = `
  <div class="new-session-actions">
    <button class="new-session-btn new-session-claude" data-agent="claude">...</button>
    ${codexBtn}${geminiBtn}${piBtn}
  </div>
  ...
`;
```

### 4.12 Frontend: pi Availability Flag

In `loadProjects()`:
```javascript
this.piAvailable = this.projects.some(p => p.piAvailable);
```

### 4.13 Frontend: Recent Sessions

Add pi sessions to `GET /api/recent-sessions` response (server-side), already handled by adding pi to `allSessions` array. Frontend rendering works automatically since it renders by `agent` field.

### 4.14 Frontend: Tab Rendering

Tabs already render `badge-${tab.agent}` — adding `.badge-pi` CSS is sufficient.

---

## 5. pi-Specific Considerations

### 5.1 Session Resume Strategy

Pi's `--session` flag accepts **both file paths and partial UUIDs** — its `resolveSessionPath()` function resolves partial UUID matches automatically (searching the current project first, then globally). This is simpler than the `--resume <uuid>` approach used by Claude and Codex:

```bash
# All of these work with --session:
pi --session 019daa80-aec7-7390-a080-0026572d808b   # full UUID
pi --session 019daa80                                # partial UUID
pi --session ~/.pi/agent/sessions/--path--/file.jsonl  # file path
```

For Herd's resume flow, we pass the full session UUID directly:
```bash
pi --session <sessionId>
```

No file path lookup from `piIndex` is needed — pi resolves the UUID internally.

**Edge case (verified in pi source):** If `resolveSessionPath()` finds the session in a different project's directory, pi logs `Session found in different project: <cwd>` and prompts `Fork this session into current directory? [y/N]`. A `n` answer results in a clean `Aborted.` + `exit(0)`. Since we spawn the PTY with the correct `cwd`, the local match branch always wins for well-formed resumes.

### 5.2 pi Session Name (session_info)

Pi supports user-set session names via `/name <name>` command, which writes a `session_info` entry. When present, this should be used as the display name instead of the first user message preview. The `parsePiSession()` function already handles this by preferring `sessionName` over `preview`.

### 5.3 pi's Multi-Provider Nature

Pi can use any provider — the default in the user's config is OpenRouter/GLM-5.1, but users may switch mid-session (`model_change` entries track this). The integration should:
- Not hardcode "GLM-5.1" anywhere in the code
- Display the actual model from `model_change` entries when available
- Use whatever provider/model pi is configured for (respect `~/.pi/agent/settings.json`)

### 5.4 pi's TUI Behavior

Pi has a rich TUI (Ink-based, similar to Gemini's). Like Gemini, it may emit regular "heartbeat" repaints. The existing Gemini-specific heartbeat detection logic (chunk counting over a 2s window) should apply to pi as well — no changes needed.

### 5.5 pi's env variables

Pi reads `OPENROUTER_API_KEY` from the environment. Unlike Gemini (which reads `~/.gemini/.env`), pi uses standard environment variables and `~/.pi/agent/auth.json`. No special env loading is needed — `process.env` is already inherited by the PTY shell.

---

## 6. Implementation Checklist

### Server (`server.js`)

- [ ] Add `PI_DIR`, `PI_SESSIONS_DIR` constants
- [ ] Add `piBin` binary resolver
- [ ] Add `piIndex` Map and `scanPiSessions()` function
- [ ] Add `parsePiSession()` JSONL parser
- [ ] Add `decodePiProjectPath()` path decoder
- [ ] Add `piBin` logging on startup
- [ ] Call `scanPiSessions()` in initial scan and in `GET /api/projects`
- [ ] Add `piCount: 0` to the three existing `projectMap.set(...)` initializers (`server.js:854, 871, 888`)
- [ ] Update `sessionCount` formula at `server.js:901` to include `p.piCount`
- [ ] Add `piAvailable` flag to project API response
- [ ] Add pi sessions to `serveSessions()` response
- [ ] Add pi sessions to `GET /api/recent-sessions` response
- [ ] Add pi sessions to summary pruning logic
- [ ] Add `'pi'` to agent validation whitelist
- [ ] Add pi launch command in WS handler
- [ ] Add pi session ID detection in `detectSessionId()`
- [ ] Add `summaryCacheKey` support for `'pi'` agent
- [ ] Add `getPiUserMessages(jsonlPath)` and dispatch from Haiku naming / summary regen when `agent === 'pi'`
- [ ] Add pi resume support (`--session <uuid>`)
- [ ] Add pi-specific auto-naming text extraction (`getJsonlNamingText()`)

### Frontend (`public/app.js`)

- [ ] Add `piAvailable` tracking in `loadProjects()`
- [ ] Add pi button in `toggleProject()` new-session-actions
- [ ] Ensure `badge-pi` renders in session items and tabs
- [ ] Ensure `newSessionInLastProject()` supports `agent: 'pi'`
- [ ] Test recent sessions rendering for pi entries

### Frontend (`public/style.css`)

- [ ] Add `.badge-pi` styling (color: rose/red)
- [ ] Add `.new-session-pi` button styling (if needed)

### Testing

- [ ] Verify pi session scanning with existing sessions in `~/.pi/agent/sessions/`
- [ ] Verify project merging (pi + Claude sessions in same project)
- [ ] Verify new pi session launch from sidebar
- [ ] Verify pi session resume from sidebar
- [ ] Verify pi session auto-naming via Haiku
- [ ] (Deferred) Verify pi token usage in dashboard
- [ ] Verify pi not installed: graceful "not installed" message
- [ ] Verify pi sessions appear in "Recent" section
- [ ] Smoke-test `decodePiProjectPath` against `--Users-pd-Documents-gpt_meditation--` (underscore in segment) and `--Users-pd-Documents-Personal-herd--` (nested path)
- [ ] Measure pi TUI repaint/heartbeat rate against Herd's 2s / 4-chunk "finished" detector; tune thresholds if false-green triggers appear

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| pi JSONL format changes between versions | Parser reads `version` field from header; handle v1/v2/v3 gracefully. Current version is 3. |
| pi session directories use different encoding than Claude | `decodePiProjectPath()` handles `--path--` wrapping, reuses proven backtracking solver |
| pi not installed on all machines | `piBin` is null-checked everywhere, `piAvailable` flag hides pi UI when absent |
| GLM-5.1 model pricing changes on OpenRouter | Token usage deferred — will need `MODEL_PRICING` entries when implemented |
| pi's `--session` resume with a UUID not found locally | Pi's `resolveSessionPath()` searches globally and may prompt to fork — should not happen since PTY cwd matches the project |
| pi's TUI heartbeat triggers false "finished" detection | Existing chunk-rate detection (4+ chunks per 2s window) should work — monitor |
| pi session files are large (tool output, thinking) | Chunked line reading with MAX_LINES cap already handles this |

---

## 8. Future Enhancements (Out of Scope)

- **Token usage for pi sessions:** Add pi session scanning to `computeTokenUsage()`, map pi's `usage` field names (`input`/`output`/`cacheRead`/`cacheWrite`) to the aggregation structure, and add `MODEL_PRICING` entries for common pi models.
- **pi SDK integration:** Use `createAgentSession()` directly instead of spawning a PTY process. Would enable richer event handling (tool calls, thinking blocks) but requires significant refactoring of the terminal model.
- **pi RPC mode:** Use `pi --mode rpc` for structured JSON communication instead of raw PTY output. Would enable precise session state tracking but requires bidirectional stdin/stdout protocol handling.
- **Multi-model display:** Show model changes within a pi session (from `model_change` entries) in the sidebar.
- **pi session export:** Add HTML export button for pi sessions (pi has `--export` built-in).
- **Cross-agent session sharing:** Allow resuming a Claude session in pi or vice versa (very complex, low value).

---

## 9. Research Verification

Research performed 2026-04-20 against pi `0.67.68` (`/Users/pd/.nvm/versions/node/v22.17.1/lib/node_modules/@mariozechner/pi-coding-agent`) and the user's actual session store.

| Claim | Status | Source |
|-------|--------|--------|
| Package `@mariozechner/pi-coding-agent` exists and provides `pi` binary | ✓ Verified | `which pi` → resolves; pi `--version` → `0.67.68` |
| Session dir at `~/.pi/agent/sessions/` with `--<path>--` encoded subdirs | ✓ Verified | `ls ~/.pi/agent/sessions/` shows `--Users-pd-Documents-Personal-herd--`, etc. |
| Filename format `<ISO-timestamp>_<UUIDv7>.jsonl` | ✓ Verified | Real filenames e.g. `2026-04-20T10-47-33-320Z_019daa80-aec7-7390-a080-0026572d808b.jsonl` |
| Session header schema (`type`, `version`, `id`, `timestamp`, `cwd`) | ✓ Verified | First line of real session files matches; also generated by `createBranchedSession` / `forkFrom` in `dist/core/session-manager.js` |
| Filename UUID and header `id` always match | ✓ Verified | `dist/core/session-manager.js:888-895` and `:1027-1035` — both call `createSessionId()` once, use result in both filename and header. Proposal's earlier "may differ" claim removed. |
| All 11 entry types exist (`session`, `model_change`, `thinking_level_change`, `message`, `compaction`, `branch_summary`, `session_info`, `custom`, `custom_message`, `label`) | ✓ Verified | Emitters for every type found in `dist/core/session-manager.js`. Only 5 of 11 occur in the user's current data (`session`, `model_change`, `thinking_level_change`, `message`, `custom`) — the rest require specific commands (`/name`, compaction, branch summary, labels) to be emitted. |
| `pi --session <partial-uuid>` resolves via prefix match | ✓ Verified | `dist/main.js:106-126` — `filter((s) => s.id.startsWith(sessionArg))` on local list, then global |
| "Fork this session into current directory?" prompt behavior | ✓ Verified | `dist/main.js:187-193` — exact string match; `n` → `Aborted.` + `exit(0)` (no PTY hang) |
| `pi --continue` / `pi --resume` / `pi --session` / `--fork` flags | ✓ Verified | `pi --help` output and `dist/main.js:164-217` |
| `--mode rpc`, `-p`/`--print`, `createAgentSession()` SDK | ✓ Verified | `pi --help` lists `--mode rpc` and `-p`; SDK entry exists at package root |
| GLM-5.1 context 202,752 / max-completion 65,535 / $0.95 in / $3.15 out / $0.475 cache-read | ✓ Verified | `GET https://openrouter.ai/api/v1/models` → `z-ai/glm-5.1` entry on 2026-04-20 |
| User's `models.json` uses smaller limits (128K / 8K) | ✓ Verified | `cat ~/.pi/agent/models.json` |
| Claude Opus 4.6 pricing $5 in / $25 out / 1M context | ✓ Verified | platform.claude.com/docs/en/docs/about-claude/pricing (fetched 2026-04-20) |
| OpenAI o4-mini pricing $1.10 in / $4.40 out / 200K context | ✓ Verified | Web search 2026-04-20; also on pricepertoken.com listing |
| OpenRouter sessions have `cost.total = 0`, Google sessions non-zero | ✓ Verified | 117/117 openrouter messages vs 9/9 google messages in user's store |

### Still unverified / to check during implementation

- **`session_info`, `compaction`, `branch_summary`, `label` entries at runtime** — emitters exist in pi source but user has not exercised `/name`, context compaction, branches, or labels. The `parsePiSession` / `getPiUserMessages` logic should be smoke-tested with at least one session that has each.
- **`parentSession` header field** — present in forked/branched headers per source (`dist/core/session-manager.js:898, 1033-1037`). Not used by this integration, but if we ever show session lineage in the sidebar we already have the data.
- **Heartbeat repaint rate from pi's Ink TUI vs Herd's 2s / 4-chunk "finished" detector** — assumed equivalent to Gemini. Needs a running pi session to measure before we trust the existing detection to flag idle green/blue correctly.
- **Codex row in the comparison table (Section 2.4)** — `o4-mini` is Codex CLI's historical default; the current Herd codebase does not hardcode it. Re-check whichever model Codex CLI actually spawns in this environment before citing this row as the comparison baseline.
