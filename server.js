const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

// Load ~/.gemini/.env into a scoped object (not process.env) to avoid side-effects
const geminiEnv = {};
try {
  const envPath = path.join(os.homedir(), '.gemini', '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        let value = match[2] || '';
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
        geminiEnv[match[1]] = value;
      }
    }
  }
} catch {}

// C2: Credential isolation for PTY children.
// Blacklist known-dangerous credential patterns (whitelist would break login
// shells that read NVM_DIR, CONDA_SHLVL, SSH_AUTH_SOCK, etc. from parent env).
// Then inject only the API key the specific agent needs, so a compromised
// Codex session cannot read the Anthropic key, and vice versa.
const DANGEROUS_ENV_PATTERNS = [
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN',
  'GITHUB_TOKEN', 'GH_TOKEN',
  'HEROKU_API_KEY',
  'DIGITALOCEAN_TOKEN',
  'AZURE_CLIENT_SECRET',
  'TF_VAR_', 'VAULT_TOKEN',
];
const AGENT_API_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];
function stripDangerousEnv(env) {
  const safe = { ...env };
  for (const key of Object.keys(safe)) {
    if (DANGEROUS_ENV_PATTERNS.some(p => key === p || key.startsWith(p + '_') || key.startsWith(p))) {
      delete safe[key];
    }
  }
  return safe;
}
function agentEnv(agent) {
  const base = stripDangerousEnv(process.env);
  for (const k of AGENT_API_KEYS) delete base[k];
  if (agent === 'codex'  && process.env.OPENAI_API_KEY)    base.OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
  if (agent === 'claude' && process.env.ANTHROPIC_API_KEY) base.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (agent === 'gemini') Object.assign(base, geminiEnv); // Gemini key lives in ~/.gemini/.env
  return base;
}

const PORT = process.env.PORT || 3456;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const GEMINI_TMP_DIR = path.join(os.homedir(), '.gemini', 'tmp');
const PI_DIR = path.join(os.homedir(), '.pi', 'agent');
const PI_SESSIONS_DIR = path.join(PI_DIR, 'sessions');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Heartbeat: browsers don't always deliver a clean close frame (sleep/wake,
// crash, network drop, fast refresh). Without pings, the server keeps the PTY
// alive until TCP keepalive (~2h) notices the dead socket — meanwhile the
// client's reconnect logic spawns a second PTY for the same session. Result:
// orphaned zsh/claude processes pile up. 30s pings + one missed pong →
// terminate → the connection's `close` handler kills the PTY.
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30_000);
wss.on('close', () => clearInterval(wsHeartbeat));

// C1/C1b: Origin allowlist. Browsers attach an Origin header on cross-origin
// requests; non-browser clients (curl, local scripts) do not. Since Herd binds
// to 127.0.0.1 by default, missing/null Origin is accepted — browser attackers
// cannot suppress Origin, so this is not a bypass. For reverse-proxy / HTTPS
// deployments, operators set ALLOWED_ORIGINS (comma-separated) explicitly.
function allowedOriginList() {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
}
function originAllowed(origin) {
  if (!origin || origin === 'null') return true; // non-browser / file:// clients
  return allowedOriginList().some(a => origin === a); // exact match, not startsWith
}

// B4 + C1: Only upgrade WebSocket on /ws path, and reject disallowed origins.
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  if (!originAllowed(req.headers.origin)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

// S2: Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// C1b: Origin-check state-changing or expensive/side-effectful routes.
// Also covers expensive idempotent GETs that would otherwise be
// cross-origin DoS/UX-abuse vectors (token-usage scans all JSONL).
const GUARDED_GET_PATHS = new Set(['/api/token-usage']);
app.use((req, res, next) => {
  const guarded = req.method !== 'GET' || GUARDED_GET_PATHS.has(req.path);
  if (guarded && !originAllowed(req.headers.origin)) {
    return res.status(403).end();
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Resolve claude binary once at startup
const claudeBin = (() => {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const { execSync } = require('child_process');
  try { return execSync('/bin/sh -lc "which claude"', { encoding: 'utf8' }).trim(); }
  catch { return 'claude'; }
})();
console.log(`  Claude binary: ${claudeBin}`);

// Resolve codex binary once at startup
const codexBin = (() => {
  const { execSync } = require('child_process');
  try { return execSync('/bin/sh -lc "which codex"', { encoding: 'utf8' }).trim(); }
  catch { return null; }
})();
console.log(`  Codex binary: ${codexBin || '(not installed)'}`);

// Resolve gemini binary once at startup
const geminiBin = (() => {
  const { execSync } = require('child_process');
  try { return execSync('/bin/sh -lc "which gemini"', { encoding: 'utf8' }).trim(); }
  catch { return null; }
})();
console.log(`  Gemini binary: ${geminiBin || '(not installed)'}`);

// Resolve pi binary once at startup
const piBin = (() => {
  const { execSync } = require('child_process');
  try { return execSync('/bin/sh -lc "which pi"', { encoding: 'utf8' }).trim(); }
  catch { return null; }
})();
console.log(`  Pi binary: ${piBin || '(not installed)'}`);

// --- Codex rollout index ---
// Scans ~/.codex/sessions/**/*.jsonl, reads line 1 (session_meta) to extract cwd/id.
// Cached by (filePath, mtimeMs) for incremental rescans.

const codexIndex = new Map(); // filePath -> { id, cwd, mtime, date, preview }

function scanCodexSessions() {
  if (!codexBin) return;
  try { fs.statSync(CODEX_SESSIONS_DIR); } catch { return; }

  const seen = new Set();
  // Walk YYYY/MM/DD dirs
  for (const year of readdirSafe(CODEX_SESSIONS_DIR)) {
    const yearDir = path.join(CODEX_SESSIONS_DIR, year);
    if (!isDir(yearDir)) continue;
    for (const month of readdirSafe(yearDir)) {
      const monthDir = path.join(yearDir, month);
      if (!isDir(monthDir)) continue;
      for (const day of readdirSafe(monthDir)) {
        const dayDir = path.join(monthDir, day);
        if (!isDir(dayDir)) continue;
        for (const file of readdirSafe(dayDir)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(dayDir, file);
          seen.add(filePath);
          try {
            const stat = fs.statSync(filePath);
            const cached = codexIndex.get(filePath);
            if (cached && cached.mtime === stat.mtimeMs) continue;
            const info = parseCodexRollout(filePath, stat);
            if (info) codexIndex.set(filePath, info);
          } catch {}
        }
      }
    }
  }
  // Prune deleted files
  for (const key of codexIndex.keys()) {
    if (!seen.has(key)) codexIndex.delete(key);
  }
}

function readdirSafe(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function parseCodexRollout(filePath, stat) {
  // Use chunked line reading — session_meta can be 15KB+ due to base_instructions
  const fd = fs.openSync(filePath, 'r');
  try {
    const CHUNK_SIZE = 65536;
    const MAX_LINES = 15;
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
    if (lines.length < MAX_LINES && remainder.trim()) lines.push(remainder);
    if (lines.length === 0) return null;

    let id = null, cwd = null, timestamp = null, preview = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'session_meta' && entry.payload) {
          id = entry.payload.id;
          cwd = entry.payload.cwd;
          timestamp = entry.payload.timestamp || entry.timestamp;
        }
        if (!preview && entry.type === 'event_msg' && entry.payload?.type === 'user_message' && entry.payload.message) {
          preview = entry.payload.message.slice(0, 150).replace(/\n/g, ' ').trim();
        }
        if (id && preview) break;
      } catch {}
    }
    if (!id || !cwd) return null;

    // Canonicalize cwd for reliable merging with Claude projects
    let realCwd = cwd;
    try { realCwd = fs.realpathSync(cwd); } catch {}

    return {
      id, cwd: realCwd, rawCwd: cwd,
      mtime: stat.mtimeMs,
      date: stat.mtime.toISOString(),
      preview,
      filePath,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Extract UUID from codex rollout filename: rollout-YYYY-MM-DDThh-mm-ss-<UUID>.jsonl
function codexFileSessionId(filename) {
  const m = filename.match(/rollout-[^-]+-[^-]+-[^T]+T[^-]+-[^-]+-[^-]+-(.+)\.jsonl$/);
  return m ? m[1] : null;
}

// Initial scan
scanCodexSessions();

// --- Gemini session index ---
const geminiFileCache = new Map(); // filePath -> { mtime, sessions: [...] }
const geminiIndex = new Map(); // sessionId -> { id, cwd, mtime, date, preview, logsFile }

function scanGeminiSessions() {
  if (!geminiBin) return;
  try { fs.statSync(GEMINI_TMP_DIR); } catch { return; }

  const seenFiles = new Set();
  const dirs = readdirSafe(GEMINI_TMP_DIR);
  
  for (const dirName of dirs) {
    const projDir = path.join(GEMINI_TMP_DIR, dirName);
    if (!isDir(projDir)) continue;

    let realCwd = null;
    try {
      const rootFile = path.join(projDir, '.project_root');
      realCwd = fs.readFileSync(rootFile, 'utf8').trim();
    } catch {}
    if (!realCwd) continue;

    try { realCwd = fs.realpathSync(realCwd); } catch {}

    const logsFile = path.join(projDir, 'logs.json');
    if (!fs.existsSync(logsFile)) continue;
    
    seenFiles.add(logsFile);
    try {
      const stat = fs.statSync(logsFile);
      const cached = geminiFileCache.get(logsFile);
      if (cached && cached.mtime === stat.mtimeMs) continue;

      const logs = JSON.parse(fs.readFileSync(logsFile, 'utf8'));
      if (!Array.isArray(logs)) continue;

      const chatsDir = path.join(projDir, 'chats');
      const chatSuffixes = new Set();
      try {
        for (const f of fs.readdirSync(chatsDir)) {
          const dash = f.lastIndexOf('-');
          if (dash !== -1) chatSuffixes.add(f.slice(dash + 1));
        }
      } catch {}

      const bySession = new Map();
      for (const entry of logs) {
        if (!entry.sessionId) continue;
        const shortId = entry.sessionId.substring(0, 8);
        if (!chatSuffixes.has(`${shortId}.json`)) continue;

        if (!bySession.has(entry.sessionId)) {
          bySession.set(entry.sessionId, {
            id: entry.sessionId,
            cwd: realCwd,
            mtime: new Date(entry.timestamp).getTime() || stat.mtimeMs,
            date: entry.timestamp || stat.mtime.toISOString(),
            preview: null,
            logsFile
          });
        }
        const session = bySession.get(entry.sessionId);
        if (!session.preview && entry.type === 'user' && entry.message) {
          session.preview = entry.message.slice(0, 150).replace(/\n/g, ' ').trim();
        }
        // update mtime/date to the latest entry
        const entryTime = new Date(entry.timestamp).getTime();
        if (entryTime && entryTime > session.mtime) {
          session.mtime = entryTime;
          session.date = entry.timestamp;
        }
      }

      geminiFileCache.set(logsFile, { mtime: stat.mtimeMs, sessions: Array.from(bySession.values()) });
    } catch {}
  }

  // Prune deleted files from cache
  for (const key of geminiFileCache.keys()) {
    if (!seenFiles.has(key)) geminiFileCache.delete(key);
  }

  // Rebuild geminiIndex
  geminiIndex.clear();
  for (const cacheEntry of geminiFileCache.values()) {
    for (const session of cacheEntry.sessions) {
      if (session.id && session.cwd) {
        geminiIndex.set(session.id, session);
      }
    }
  }
}

// Initial scan
scanGeminiSessions();

// --- Pi session index ---
const piIndex = new Map(); // filePath -> { id, cwd, mtime, date, preview, jsonlPath }

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
      id,
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

// Decode pi's --<dashed-path>-- encoding to a real filesystem path.
// Pi uses double-dash prefix AND suffix around the encoded path.
function decodePiProjectPath(encoded) {
  let raw = encoded;
  if (raw.startsWith('--')) raw = raw.slice(2);
  if (raw.endsWith('--')) raw = raw.slice(0, -2);
  // Reuse Claude's backtracking decoder on the stripped path
  return decodeProjectPath(raw);
}

// Initial scan
scanPiSessions();

// --- Path decoding ---

function decodeProjectPath(encoded) {
  const raw = encoded.startsWith('-') ? encoded.slice(1) : encoded;
  const parts = raw.split('-');

  // Backtracking decoder: tries '/' (path sep), '_', and '-' for each encoded dash.
  // Returns the first fully-valid path (every component exists on disk).
  function solve(i, dir) {
    if (i >= parts.length) {
      try { if (fs.existsSync(dir)) return dir; } catch {}
      return null;
    }

    let dashSegment = parts[i];
    for (let j = i + 1; j <= parts.length; j++) {
      // Build candidate segment names to try at this level
      const candidates = [dashSegment];
      if (j > i + 1) {
        candidates.push(parts.slice(i, j).join('_'));
        candidates.push(parts.slice(i, j).join('.'));
      }

      for (const seg of candidates) {
        const candidate = path.join(dir, seg);
        try {
          if (fs.statSync(candidate).isDirectory()) {
            const result = solve(j, candidate);
            if (result) return result;
          }
        } catch {}
      }

      if (j < parts.length) dashSegment += '-' + parts[j];
    }
    return null;
  }

  const result = solve(0, '/');
  if (result) return result;

  // Fallback: greedy decode for deleted projects (best-effort display path)
  let current = '/';
  let i = 0;
  while (i < parts.length) {
    let segment = parts[i];
    let j = i + 1;
    let matched = false;
    while (j <= parts.length) {
      const candidate = path.join(current, segment);
      try {
        if (fs.statSync(candidate).isDirectory()) {
          current = candidate;
          i = j;
          matched = true;
          break;
        }
      } catch {}
      if (j < parts.length) segment += '-' + parts[j];
      j++;
    }
    if (!matched) {
      current = path.join(current, parts.slice(i).join('-'));
      break;
    }
  }
  return current;
}

function findEncodedDir(projectPath) {
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR);
    return dirs.find(d => {
      try { return decodeProjectPath(d) === projectPath; }
      catch { return false; }
    }) || null;
  } catch { return null; }
}

function getProjectName(p) {
  const parts = p.split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return parts[parts.length - 1] || p;
}

// --- Session parsing ---

// Extract user messages from a JSONL file for naming purposes.
// Reads up to maxBytes from the file to find user messages.
function getUserMessages(jsonlPath, maxBytes = 256 * 1024) {
  const messages = [];
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(65536, maxBytes));
      let remainder = '';
      let offset = 0;
      let totalRead = 0;
      while (totalRead < maxBytes) {
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        totalRead += bytesRead;
        const chunk = remainder + buf.toString('utf8', 0, bytesRead);
        const parts = chunk.split('\n');
        remainder = parts.pop();
        for (const part of parts) {
          if (!part.trim()) continue;
          try {
            const entry = JSON.parse(part);
            if (entry.type === 'user' && entry.message?.content) {
              const text = typeof entry.message.content === 'string'
                ? entry.message.content
                : Array.isArray(entry.message.content)
                  ? (entry.message.content.find(c => c.type === 'text')?.text || '')
                  : '';
              if (text && text.length > 3 && !text.startsWith('You are a') && !text.includes('<local-command-caveat>') && !text.includes('<command-name>')) {
                messages.push(text.slice(0, 300).replace(/\n/g, ' ').trim());
              }
            }
          } catch {}
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return messages;
}

function getSessionInfo(jsonlPath) {
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const lines = [];
    try {
      const MAX_LINES = 20;
      const CHUNK_SIZE = 65536;
      let remainder = '';
      let offset = 0;
      while (lines.length < MAX_LINES) {
        const buffer = Buffer.alloc(CHUNK_SIZE);
        const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        const chunk = remainder + buffer.toString('utf8', 0, bytesRead);
        const parts = chunk.split('\n');
        remainder = parts.pop();
        for (const part of parts) {
          if (part.trim()) lines.push(part);
          if (lines.length >= MAX_LINES) break;
        }
      }
      if (lines.length < MAX_LINES && remainder.trim()) lines.push(remainder);
    } finally {
      fs.closeSync(fd);
    }

    let firstUserMessage = null;
    let timestamp = null;
    let slug = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!timestamp && entry.timestamp) timestamp = entry.timestamp;
        if (!slug && entry.slug) slug = entry.slug;
        if (entry.type === 'user' && entry.message?.content) {
          const text = typeof entry.message.content === 'string'
            ? entry.message.content
            : Array.isArray(entry.message.content)
              ? (entry.message.content.find(c => c.type === 'text')?.text || '')
              : '';
          if (text && text.length > 3 && !text.startsWith('You are a') && !text.includes('<local-command-caveat>') && !text.includes('<command-name>')) {
            firstUserMessage = text.slice(0, 150).replace(/\n/g, ' ').trim();
            break;
          }
        }
      } catch {}
    }

    return { firstUserMessage, timestamp, slug };
  } catch {
    return { firstUserMessage: null, timestamp: null, slug: null };
  }
}

// --- Haiku summaries ---

const SUMMARY_CACHE_PATH = path.join(__dirname, 'summaries.json');
let summaryCache = {};
try { summaryCache = JSON.parse(fs.readFileSync(SUMMARY_CACHE_PATH, 'utf8')); } catch {}

// H5: Debounced async writes. Rapid live-title updates or batch summary
// completions used to trigger multiple synchronous full-file writes within
// milliseconds — this coalesces them and keeps I/O off the event loop.
// Three call patterns:
//   - scheduleSaveSummary(): coalescing, fire-and-forget (live titles, prunes)
//   - flushSaveSummary():    promptly await a write (batch completion, regen)
//   - flushSaveSummarySync(): only on graceful shutdown, where the event loop
//                             is about to exit and async writes would be dropped
let saveSummaryTimer = null;
let saveSummaryInflight = null;
async function doSaveSummary() {
  if (saveSummaryInflight) { try { await saveSummaryInflight; } catch {} }
  saveSummaryInflight = fs.promises.writeFile(
    SUMMARY_CACHE_PATH,
    JSON.stringify(summaryCache, null, 2)
  ).catch(err => console.error('Failed to save summaries:', err.message))
   .finally(() => { saveSummaryInflight = null; });
  return saveSummaryInflight;
}
function scheduleSaveSummary() {
  if (saveSummaryTimer) return;
  saveSummaryTimer = setTimeout(() => {
    saveSummaryTimer = null;
    doSaveSummary();
  }, 500);
}
async function flushSaveSummary() {
  if (saveSummaryTimer) { clearTimeout(saveSummaryTimer); saveSummaryTimer = null; }
  await doSaveSummary();
}
function flushSaveSummarySync() {
  if (saveSummaryTimer) { clearTimeout(saveSummaryTimer); saveSummaryTimer = null; }
  try { fs.writeFileSync(SUMMARY_CACHE_PATH, JSON.stringify(summaryCache, null, 2)); } catch {}
}

// Summary cache entries: new format is { text, ts }, old format is plain string.
// Helpers provide backward-compatible access.
function getSummaryText(key) {
  const v = summaryCache[key];
  if (!v) return null;
  return typeof v === 'string' ? v : v.text;
}

function getSummaryTs(key) {
  const v = summaryCache[key];
  if (!v || typeof v === 'string') return 0; // old entries: treat as ancient
  return v.ts || 0;
}

function setSummary(key, text) {
  summaryCache[key] = { text, ts: Date.now() };
}

async function generateSummary(text) {
  if (!claudeBin || !text) return null;

  const prompt = `Name this chat session in 2-4 words based on the user's task or question. Lowercase, no punctuation. Focus on WHAT the user is doing, not which tools or editors they use. Never include words like "claude", "terminal", "session", "code editor", or project names unless the project itself is the topic. Reply with ONLY the name.\n\n"${text.slice(0, 1000)}"`;
  try {
    return await new Promise((resolve) => {
      execFile(claudeBin, ['-p', '--no-session-persistence', '--model', 'haiku', prompt], { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve(null);
        const result = stdout.trim();
        resolve(result || null);
      });
    });
  } catch {
    return null;
  }
}

// Separate prompt for live terminal output (noisier than JSONL previews)
async function generateLiveTitle(text) {
  if (!claudeBin || !text) return null;

  const prompt = `Below is cleaned terminal output from a coding session. Name the task in 2-4 words. Lowercase, no punctuation. Focus on the specific task (e.g. "fix login bug", "add search feature", "refactor api routes"). Do NOT use generic words like "terminal", "session", "development", "code editing", "project work", or tool/editor names. If there is no clear task yet, reply with just "new session". Reply with ONLY the name.\n\n"${text.slice(0, 1000)}"`;
  try {
    return await new Promise((resolve) => {
      execFile(claudeBin, ['-p', '--no-session-persistence', '--model', 'haiku', prompt], { timeout: 15000 }, (err, stdout) => {
        if (err) return resolve(null);
        const result = stdout.trim();
        resolve(result || null);
      });
    });
  } catch {
    return null;
  }
}

// B2: Track in-flight summary generation to prevent duplicate API calls
const summarizing = new Set();

// Summary cache keys are namespaced as "agent:id" for Codex and Gemini, plain id for Claude (backward compat)
function summaryCacheKey(agent, id) {
  if (agent === 'codex') return `codex:${id}`;
  if (agent === 'gemini') return `gemini:${id}`;
  if (agent === 'pi') return `pi:${id}`;
  return id;
}

// --- SSE for summary updates ---
const sseClients = new Set();

app.get('/api/summary-events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });
  res.write(':\n\n'); // heartbeat
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastSummaryUpdate(sessionId, agent, summary) {
  const data = JSON.stringify({ sessionId, agent, summary });
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch {}
  }
}

// Build richer naming text from all user messages in a JSONL file

// Extract user messages from a pi session JSONL file.
// Pi's entry wrapping ({type:"message", message:{role, content}}) differs from Claude's
// format, so a dedicated parser is cleaner than branching inside getUserMessages.
function getPiUserMessages(jsonlPath, maxBytes = 256 * 1024) {
  const messages = [];
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(Math.min(65536, maxBytes));
      let remainder = '';
      let offset = 0;
      let totalRead = 0;
      while (totalRead < maxBytes) {
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        totalRead += bytesRead;
        const chunk = remainder + buf.toString('utf8', 0, bytesRead);
        const parts = chunk.split('\n');
        remainder = parts.pop();
        for (const part of parts) {
          if (!part.trim()) continue;
          try {
            const entry = JSON.parse(part);
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
          } catch {}
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return messages;
}

function getNamingText(session) {
  if (session.agent === 'gemini' && session.logsFile) {
    try {
      const logs = JSON.parse(fs.readFileSync(session.logsFile, 'utf8'));
      const msgs = logs.filter(e => e.sessionId === session.id && e.type === 'user' && e.message && !e.message.startsWith('/'))
                       .map(e => e.message.slice(0, 300).replace(/\n/g, ' ').trim());
      if (msgs.length) {
        let text = '';
        for (const m of msgs) {
          if (text.length + m.length > 1500) break;
          text += (text ? ' | ' : '') + m;
        }
        if (text.length >= 10) return text;
      }
    } catch {}
  }
  if (session.agent === 'pi' && session.jsonlPath) {
    const msgs = getPiUserMessages(session.jsonlPath);
    if (msgs.length) {
      let text = '';
      for (const m of msgs) {
        if (text.length + m.length > 1500) break;
        text += (text ? ' | ' : '') + m;
      }
      if (text.length >= 10) return text;
    }
    return session.preview;
  }
  if (session.jsonlPath) {
    const msgs = getUserMessages(session.jsonlPath);
    if (msgs.length) {
      let text = '';
      for (const m of msgs) {
        if (text.length + m.length > 1500) break;
        text += (text ? ' | ' : '') + m;
      }
      if (text.length >= 10) return text;
    }
  }
  return session.preview;
}

const STALE_SUMMARY_AGE = 5 * 60_000; // re-check summaries 5 min after last generation

async function generateMissingSummaries(sessions) {
  const now = Date.now();
  const toGenerate = sessions.filter(s => {
    const key = summaryCacheKey(s.agent, s.id);
    if (summarizing.has(key) || !s.preview) return false;
    // No summary yet — needs one
    if (!summaryCache[key]) return true;
    // Has summary but session was modified after it was generated (stale)
    const ts = getSummaryTs(key);
    return s.mtime > ts && (now - ts) >= STALE_SUMMARY_AGE;
  });
  if (!toGenerate.length) return;

  toGenerate.forEach(s => summarizing.add(summaryCacheKey(s.agent, s.id)));

  // Process in parallel batches of 5
  for (let i = 0; i < toGenerate.length; i += 5) {
    const batch = toGenerate.slice(i, i + 5);
    await Promise.all(batch.map(async s => {
      const key = summaryCacheKey(s.agent, s.id);
      try {
        const summary = await generateSummary(getNamingText(s));
        if (summary) {
          setSummary(key, summary);
          broadcastSummaryUpdate(s.id, s.agent || 'claude', summary);
        }
      } finally {
        summarizing.delete(key);
      }
    }));
    await flushSaveSummary();
  }
}

// --- Token usage ---

const MODEL_PRICING = {
  'claude-opus-4-6':              { input: 5,     output: 25,    cache_write_5m: 6.25,  cache_write_1h: 10,    cache_read: 0.50 },
  'claude-opus-4-5':              { input: 5,     output: 25,    cache_write_5m: 6.25,  cache_write_1h: 10,    cache_read: 0.50 },
  'claude-opus-4-1':              { input: 15,    output: 75,    cache_write_5m: 18.75, cache_write_1h: 30,    cache_read: 1.50 },
  'claude-sonnet-4-6':            { input: 3,     output: 15,    cache_write_5m: 3.75,  cache_write_1h: 6,     cache_read: 0.30 },
  'claude-haiku-4-5-20251001':    { input: 1,     output: 5,     cache_write_5m: 1.25,  cache_write_1h: 2,     cache_read: 0.10 },
};
// Aliases for model strings that appear with different names
const MODEL_ALIASES = {
  'anthropic/claude-4.6-sonnet-20260217': 'claude-sonnet-4-6',
  'anthropic/claude-4.6-opus-20260205': 'claude-opus-4-6',
};
const DEFAULT_PRICING = MODEL_PRICING['claude-opus-4-6']; // user's default

let tokenUsageCache = null;
let tokenUsageCacheTime = 0;
const TOKEN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function computeTokenUsage() {
  const now = Date.now();
  if (tokenUsageCache && now - tokenUsageCacheTime < TOKEN_CACHE_TTL) return tokenUsageCache;

  const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const byModel = {};
  const byDate = {};
  let totalMessages = 0;
  let totalSessions = 0;

  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR).filter(d => { try { return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; } }); }
  catch { dirs = []; }

  for (const encoded of dirs) {
    const projDir = path.join(PROJECTS_DIR, encoded);
    let files;
    try { files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl')); } catch { continue; }

    for (const file of files) {
      const filePath = path.join(projDir, file);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      if (stat.mtime < cutoff) continue;

      let sessionHadUsage = false;
      try {
        const fd = fs.openSync(filePath, 'r');
        try {
          const CHUNK = 65536;
          let remainder = '';
          let offset = 0;
          let reading = true;
          while (reading) {
            const buf = Buffer.alloc(CHUNK);
            const bytesRead = fs.readSync(fd, buf, 0, CHUNK, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
            const chunk = remainder + buf.toString('utf8', 0, bytesRead);
            const parts = chunk.split('\n');
            remainder = parts.pop();
            for (const part of parts) {
              if (!part.trim()) continue;
              try {
                const entry = JSON.parse(part);
                // Check timestamp
                const ts = entry.timestamp;
                if (ts && typeof ts === 'string') {
                  try { if (new Date(ts) < cutoff) continue; } catch {}
                }
                const msg = entry.message;
                if (!msg || typeof msg !== 'object' || !msg.usage) continue;
                const usage = msg.usage;
                const rawModel = msg.model || 'unknown';
                const model = MODEL_ALIASES[rawModel] || rawModel;
                sessionHadUsage = true;
                totalMessages++;

                if (!byModel[model]) byModel[model] = { input: 0, output: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, messages: 0 };
                const m = byModel[model];
                m.input += usage.input_tokens || 0;
                m.output += usage.output_tokens || 0;
                m.cache_read += usage.cache_read_input_tokens || 0;
                // Break down cache write by duration if available
                const cc = usage.cache_creation;
                if (cc && typeof cc === 'object') {
                  m.cache_write_5m += cc.ephemeral_5m_input_tokens || 0;
                  m.cache_write_1h += cc.ephemeral_1h_input_tokens || 0;
                } else {
                  // Older format: all cache creation lumped together, assume 5m
                  m.cache_write_5m += usage.cache_creation_input_tokens || 0;
                }
                m.messages++;

                // Daily aggregation
                let dateKey = null;
                if (ts && typeof ts === 'string') {
                  try { dateKey = ts.slice(0, 10); } catch {}
                }
                if (dateKey) {
                  if (!byDate[dateKey]) byDate[dateKey] = { input: 0, output: 0, cache_write: 0, cache_read: 0, cost: 0 };
                  const d = byDate[dateKey];
                  d.input += usage.input_tokens || 0;
                  d.output += usage.output_tokens || 0;
                  d.cache_write += usage.cache_creation_input_tokens || 0;
                  d.cache_read += usage.cache_read_input_tokens || 0;

                  // Compute cost for this message
                  const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
                  const cw5m = cc?.ephemeral_5m_input_tokens || (cc ? 0 : (usage.cache_creation_input_tokens || 0));
                  const cw1h = cc?.ephemeral_1h_input_tokens || 0;
                  d.cost += ((usage.input_tokens || 0) * pricing.input
                    + (usage.output_tokens || 0) * pricing.output
                    + cw5m * pricing.cache_write_5m
                    + cw1h * pricing.cache_write_1h
                    + (usage.cache_read_input_tokens || 0) * pricing.cache_read) / 1_000_000;
                }
              } catch {}
            }
          }
        } finally { fs.closeSync(fd); }
      } catch {}
      if (sessionHadUsage) totalSessions++;
    }
  }

  // Compute costs per model
  const models = {};
  let totalCost = 0;
  let totalTokens = 0;
  for (const [model, m] of Object.entries(byModel)) {
    const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
    const cost = (m.input * pricing.input + m.output * pricing.output
      + m.cache_write_5m * pricing.cache_write_5m + m.cache_write_1h * pricing.cache_write_1h
      + m.cache_read * pricing.cache_read) / 1_000_000;
    const tokens = m.input + m.output + m.cache_write_5m + m.cache_write_1h + m.cache_read;
    models[model] = { ...m, cost, tokens };
    totalCost += cost;
    totalTokens += tokens;
  }

  // Daily array sorted by date
  const daily = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, ...d, tokens: d.input + d.output + d.cache_write + d.cache_read }));

  tokenUsageCache = { models, daily, totalCost, totalTokens, totalMessages, totalSessions };
  tokenUsageCacheTime = now;
  return tokenUsageCache;
}

app.get('/api/token-usage', (req, res) => {
  try {
    res.json(computeTokenUsage());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API ---

app.get('/api/projects', (req, res) => {
  try {
    // Rescan Codex and Gemini sessions for fresh data
    scanCodexSessions();
    scanGeminiSessions();
    scanPiSessions();

    const projectMap = new Map(); // realPath -> project info

    // Normalize to canonical real path so symlinked aliases (e.g.
    // ~/Documents/herd → ~/Documents/Personal/herd) collapse into one entry.
    const canon = p => {
      try { return fs.realpathSync(p); } catch { return p; }
    };

    // Claude projects from ~/.claude/projects/
    const dirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
      try { return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(); }
      catch { return false; }
    });

    for (const encoded of dirs) {
      const decoded = decodeProjectPath(encoded);
      const exists = fs.existsSync(decoded);
      const key = exists ? canon(decoded) : decoded;
      const projDir = path.join(PROJECTS_DIR, encoded);
      const jsonls = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
      if (jsonls.length === 0) continue;

      let latestMtime = 0;
      for (const f of jsonls) {
        try {
          const mt = fs.statSync(path.join(projDir, f)).mtimeMs;
          if (mt > latestMtime) latestMtime = mt;
        } catch {}
      }

      const existing = projectMap.get(key);
      if (existing) {
        existing.claudeCount += jsonls.length;
        if (latestMtime > existing.latestMtime) existing.latestMtime = latestMtime;
        // Prefer an encoded dir whose decoded path matches the canonical key
        if (!existing.claudeEncoded || decoded === key) existing.claudeEncoded = encoded;
      } else {
        projectMap.set(key, {
          path: key, name: getProjectName(key), exists,
          claudeCount: jsonls.length, codexCount: 0, geminiCount: 0, piCount: 0, latestMtime,
          claudeEncoded: encoded,
        });
      }
    }

    // Codex projects grouped by cwd
    for (const entry of codexIndex.values()) {
      const key = canon(entry.cwd);
      const existing = projectMap.get(key);
      if (existing) {
        existing.codexCount++;
        if (entry.mtime > existing.latestMtime) existing.latestMtime = entry.mtime;
      } else {
        const exists = fs.existsSync(key);
        projectMap.set(key, {
          path: key, name: getProjectName(key), exists,
          claudeCount: 0, codexCount: 1, geminiCount: 0, piCount: 0, latestMtime: entry.mtime,
          claudeEncoded: null,
        });
      }
    }

    // Gemini projects grouped by cwd
    for (const entry of geminiIndex.values()) {
      const key = canon(entry.cwd);
      const existing = projectMap.get(key);
      if (existing) {
        existing.geminiCount++;
        if (entry.mtime > existing.latestMtime) existing.latestMtime = entry.mtime;
      } else {
        const exists = fs.existsSync(key);
        projectMap.set(key, {
          path: key, name: getProjectName(key), exists,
          claudeCount: 0, codexCount: 0, geminiCount: 1, piCount: 0, latestMtime: entry.mtime,
          claudeEncoded: null,
        });
      }
    }

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
          claudeCount: 0, codexCount: 0, geminiCount: 0, piCount: 1, latestMtime: entry.mtime,
          claudeEncoded: null,
        });
      }
    }

    const projects = [...projectMap.values()]
      .map(p => ({
        path: p.path,
        name: p.name,
        exists: p.exists,
        sessionCount: p.claudeCount + p.codexCount + p.geminiCount + p.piCount,
        latestMtime: p.latestMtime,
        codexAvailable: !!codexBin,
        geminiAvailable: !!geminiBin,
        piAvailable: !!piBin,
        // Keep encoded id for backward compat with session endpoint
        id: p.claudeEncoded || null,
      }))
      .filter(p => p.sessionCount > 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(projects);

    // B5: Lazily prune stale summaries
    const allSessionKeys = new Set();
    for (const p of projectMap.values()) {
      if (p.claudeEncoded) {
        try {
          const projDir = path.join(PROJECTS_DIR, p.claudeEncoded);
          for (const f of fs.readdirSync(projDir)) {
            if (f.endsWith('.jsonl')) allSessionKeys.add(f.replace('.jsonl', ''));
          }
        } catch {}
      }
    }
    for (const entry of codexIndex.values()) {
      allSessionKeys.add(`codex:${entry.id}`);
    }
    for (const entry of geminiIndex.values()) {
      allSessionKeys.add(`gemini:${entry.id}`);
    }
    for (const entry of piIndex.values()) {
      allSessionKeys.add(`pi:${entry.id}`);
    }
    let pruned = false;
    for (const key of Object.keys(summaryCache)) {
      if (!allSessionKeys.has(key)) { delete summaryCache[key]; pruned = true; }
    }
    if (pruned) scheduleSaveSummary();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unified sessions endpoint: /api/sessions?project=<realPath>
// Also keep legacy /api/projects/:id/sessions for backward compat
app.get('/api/sessions', (req, res) => {
  try {
    const projectPath = req.query.project;
    if (!projectPath) return res.status(400).json({ error: 'Missing project param' });
    const resolved = path.resolve(projectPath);
    serveSessions(res, resolved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recent sessions across all projects (must be before :id route)
app.get('/api/recent-sessions', (req, res) => {
  try {
    scanCodexSessions();
    scanPiSessions();
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const allSessions = [];

    // Claude sessions
    let dirs;
    try { dirs = fs.readdirSync(PROJECTS_DIR).filter(d => { try { return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; } }); }
    catch { dirs = []; }

    const canon = p => { try { return fs.realpathSync(p); } catch { return p; } };

    for (const encoded of dirs) {
      const decoded = decodeProjectPath(encoded);
      const canonical = canon(decoded);
      const projDir = path.join(PROJECTS_DIR, encoded);
      try {
        const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const filePath = path.join(projDir, f);
          try {
            const stat = fs.statSync(filePath);
            const id = f.replace('.jsonl', '');
            const info = getSessionInfo(filePath);
            if (!info.firstUserMessage) continue;
            allSessions.push({
              id, agent: 'claude', date: stat.mtime.toISOString(), mtime: stat.mtimeMs,
              preview: info.firstUserMessage, jsonlPath: filePath,
              summary: getSummaryText(id),
              projectPath: canonical, projectName: getProjectName(canonical),
            });
          } catch {}
        }
      } catch {}
    }

    // Codex sessions
    for (const entry of codexIndex.values()) {
      const key = summaryCacheKey('codex', entry.id);
      if (!entry.preview) continue;
      const canonical = canon(entry.cwd);
      allSessions.push({
        id: entry.id, agent: 'codex', date: entry.date, mtime: entry.mtime,
        preview: entry.preview,
        summary: getSummaryText(key),
        projectPath: canonical, projectName: getProjectName(canonical),
      });
    }

    // Gemini sessions
    for (const entry of geminiIndex.values()) {
      const key = summaryCacheKey('gemini', entry.id);
      if (!entry.preview) continue;
      const canonical = canon(entry.cwd);
      allSessions.push({
        id: entry.id, agent: 'gemini', date: entry.date, mtime: entry.mtime,
        preview: entry.preview,
        summary: getSummaryText(key),
        projectPath: canonical, projectName: getProjectName(canonical),
      });
    }

    // Pi sessions
    for (const entry of piIndex.values()) {
      const key = summaryCacheKey('pi', entry.id);
      if (!entry.preview) continue;
      const canonical = canon(entry.cwd);
      allSessions.push({
        id: entry.id, agent: 'pi', date: entry.date, mtime: entry.mtime,
        preview: entry.preview,
        summary: getSummaryText(key),
        projectPath: canonical, projectName: getProjectName(canonical),
      });
    }

    allSessions.sort((a, b) => b.mtime - a.mtime);
    const sessions = allSessions.slice(0, limit);
    res.json(sessions);

    generateMissingSummaries(sessions).catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force-regenerate summaries for a session or all sessions in a project
app.post('/api/regenerate-summaries', async (req, res) => {
  const { sessionId, projectId } = req.query;
  let cleared = 0;
  if (sessionId) {
    // Clear one specific session
    if (summaryCache[sessionId]) { delete summaryCache[sessionId]; cleared++; }
    const codexKey = `codex:${sessionId}`;
    if (summaryCache[codexKey]) { delete summaryCache[codexKey]; cleared++; }
    const geminiKey = `gemini:${sessionId}`;
    if (summaryCache[geminiKey]) { delete summaryCache[geminiKey]; cleared++; }
    const piKey = `pi:${sessionId}`;
    if (summaryCache[piKey]) { delete summaryCache[piKey]; cleared++; }
  } else if (projectId) {
    // Clear all sessions for a project
    const projectDir = path.join(PROJECTS_DIR, projectId);
    if (path.resolve(projectDir).startsWith(PROJECTS_DIR + path.sep)) {
      try {
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const id = f.replace('.jsonl', '');
          if (summaryCache[id]) { delete summaryCache[id]; cleared++; }
        }
      } catch {}
    }
  } else {
    // Clear all summaries
    cleared = Object.keys(summaryCache).length;
    summaryCache = {};
  }
  await flushSaveSummary();
  res.json({ cleared, message: 'Summaries will regenerate on next load' });
});

app.get('/api/projects/:id/sessions', (req, res) => {
  try {
    const projectDir = path.join(PROJECTS_DIR, req.params.id);
    if (!path.resolve(projectDir).startsWith(PROJECTS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }
    const decoded = decodeProjectPath(req.params.id);
    serveSessions(res, decoded);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function serveSessions(res, projectPath) {
  const MAX_SESSIONS = 30;
  const allSessions = [];

  // Canonicalize so a query for one alias (e.g. ~/Documents/herd) also picks
  // up sessions recorded under the real path (~/Documents/Personal/herd).
  let canonQuery = projectPath;
  try { canonQuery = fs.realpathSync(projectPath); } catch {}
  const canonOf = p => { try { return fs.realpathSync(p); } catch { return p; } };

  // Claude sessions — match every encoded dir whose decoded path resolves to
  // the same canonical directory as the query.
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR);
    for (const encoded of dirs) {
      let decoded;
      try { decoded = decodeProjectPath(encoded); } catch { continue; }
      if (decoded !== projectPath && canonOf(decoded) !== canonQuery) continue;
      const projectDir = path.join(PROJECTS_DIR, encoded);
      try {
        const files = fs.readdirSync(projectDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const filePath = path.join(projectDir, f);
            const stat = fs.statSync(filePath);
            return { file: f, path: filePath, mtime: stat.mtimeMs, date: stat.mtime.toISOString() };
          });
        for (const f of files) {
          const info = getSessionInfo(f.path);
          const id = f.file.replace('.jsonl', '');
          allSessions.push({
            id, agent: 'claude', date: f.date, mtime: f.mtime,
            preview: info.firstUserMessage, jsonlPath: f.path,
            summary: getSummaryText(id),
          });
        }
      } catch {}
    }
  } catch {}

  // Codex sessions
  for (const entry of codexIndex.values()) {
    if (entry.cwd !== projectPath && canonOf(entry.cwd) !== canonQuery) continue;
    const key = summaryCacheKey('codex', entry.id);
    allSessions.push({
      id: entry.id, agent: 'codex', date: entry.date, mtime: entry.mtime,
      preview: entry.preview,
      summary: getSummaryText(key),
    });
  }

  // Gemini sessions
  for (const entry of geminiIndex.values()) {
    if (entry.cwd !== projectPath && canonOf(entry.cwd) !== canonQuery) continue;
    const key = summaryCacheKey('gemini', entry.id);
    allSessions.push({
      id: entry.id, agent: 'gemini', date: entry.date, mtime: entry.mtime,
      preview: entry.preview,
      summary: getSummaryText(key),
    });
  }

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

  // Sort by recency, filter, truncate
  allSessions.sort((a, b) => b.mtime - a.mtime);
  const totalCount = allSessions.length;
  const sessions = allSessions.filter(s => s.preview).slice(0, MAX_SESSIONS);

  res.json({ sessions, total: totalCount, truncated: totalCount > MAX_SESSIONS });

  // Background: generate missing summaries
  generateMissingSummaries(sessions).catch(() => {});
}

// C1b: POST (state-changing: invokes osascript to pop a native dialog).
// The generic middleware above origin-checks all non-GET requests.
app.post('/api/pick-folder', (req, res) => {
  execFile('osascript', ['-e', 'POSIX path of (choose folder)'], { timeout: 60000 }, (err, stdout) => {
    if (err) {
      // User cancelled the dialog
      return res.json({ cancelled: true });
    }
    const dirPath = stdout.trim();
    if (!dirPath) return res.json({ cancelled: true });
    const resolved = path.resolve(dirPath);
    res.json({ path: resolved, name: getProjectName(resolved) });
  });
});

// C1b: POST + origin-checked. Opens a project directory in Finder via `open`.
// Path is resolved and must be an existing directory; execFile (no shell) avoids
// any injection risk from the path argument.
app.post('/api/open-in-finder', express.json(), (req, res) => {
  const dirPath = req.body && typeof req.body.path === 'string' ? req.body.path : '';
  if (!dirPath) return res.status(400).json({ error: 'path required' });
  const resolved = path.resolve(dirPath);
  let stat;
  try { stat = fs.statSync(resolved); } catch { return res.status(404).json({ error: 'not found' }); }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'not a directory' });
  execFile('open', [resolved], { timeout: 5000 }, err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

// --- WebSocket terminal (using `script` as PTY wrapper) ---

const terminals = new Map();

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const projectPath = params.get('project');
  const resume = params.get('resume');  // session ID to resume
  const agent = params.get('agent') || 'claude';
  const cols = parseInt(params.get('cols')) || 120;
  const rows = parseInt(params.get('rows')) || 30;

  // Validate agent
  if (agent !== 'claude' && agent !== 'codex' && agent !== 'gemini' && agent !== 'pi') {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid agent' }));
    ws.close();
    return;
  }
  if (agent === 'codex' && !codexBin) {
    ws.send(JSON.stringify({ type: 'error', message: 'Codex is not installed' }));
    ws.close();
    return;
  }
  if (agent === 'gemini' && !geminiBin) {
    ws.send(JSON.stringify({ type: 'error', message: 'Gemini is not installed' }));
    ws.close();
    return;
  }
  if (agent === 'pi' && !piBin) {
    ws.send(JSON.stringify({ type: 'error', message: 'Pi is not installed' }));
    ws.close();
    return;
  }

  // B6: Validate resume parameter format
  if (resume && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resume)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID format' }));
    ws.close();
    return;
  }

  // B8: Validate project path and capture encoded directory name
  const resolvedProject = projectPath && path.resolve(projectPath);
  const encodedDir = resolvedProject ? findEncodedDir(resolvedProject) : null;

  // For Claude resume, we need the encoded dir to find the session file
  if (resume && agent === 'claude' && !encodedDir) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
    ws.close();
    return;
  }

  // For new sessions, the directory must exist on disk (but doesn't need to be in ~/.claude/projects yet)
  const projectDirExists = resolvedProject && fs.existsSync(resolvedProject);
  if (!resume && !projectDirExists) {
    ws.send(JSON.stringify({ type: 'error', message: 'Project directory does not exist' }));
    ws.close();
    return;
  }

  // Dedup: if an existing terminal is still registered for this (agent, sessionId),
  // its old WebSocket is likely a ghost (sleep/wake, crash) that we haven't reaped
  // yet. Kill it before spawning a replacement, otherwise both run in parallel.
  if (resume) {
    for (const [oldId, oldTerm] of terminals) {
      if (oldTerm.sessionId === resume && oldTerm.agent === agent) {
        // SIGHUP, not SIGTERM: interactive zsh ignores SIGTERM but honors SIGHUP
        // (terminal-hangup), which also propagates to the foreground process group
        // (claude/codex/gemini) via the tty.
        try { oldTerm.proc.kill('SIGHUP'); } catch {}
        try { oldTerm.ws.terminate(); } catch {}
        terminals.delete(oldId);
      }
    }
  }

  // Spawn an interactive shell in a real PTY via node-pty.
  // The agent is launched as a command inside the shell so that when it exits,
  // the user drops back to a live shell prompt in the same tab.
  const shell = process.env.SHELL || '/bin/zsh';
  let sessionId = resume || null;

  let proc;
  try {
    proc = pty.spawn(shell, ['-li'], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: projectDirExists ? projectPath : os.homedir(),
      env: {
        ...agentEnv(agent),
        TERM: 'xterm-256color',
      },
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: `Failed to spawn: ${err.message}` }));
    ws.close();
    return;
  }

  const termId = crypto.randomUUID();
  terminals.set(termId, { proc, ws, sessionId, agent });

  ws.send(JSON.stringify({ type: 'ready', termId, sessionId }));

  // Launch agent inside the shell. `node-pty` already applied cols/rows via
  // TIOCSWINSZ at spawn and `proc.resize()` handles later client resizes, so
  // `stty` isn't needed for sizing. We do cap width at 96 cols for readability
  // on wide terminals (narrow ones keep their actual width — no forced wrap).
  const MAX_COLS = 96;
  const effectiveCols = Math.min(cols || 80, MAX_COLS);
  const setSize = effectiveCols < (cols || 80)
    ? `stty cols ${effectiveCols} 2>/dev/null; clear; `
    : 'clear; ';

  let launchCmd;
  if (agent === 'codex') {
    if (resume) {
      launchCmd = `${setSize}${codexBin} resume -C ${JSON.stringify(resolvedProject)} ${resume}\n`;
    } else {
      launchCmd = `${setSize}${codexBin} -C ${JSON.stringify(resolvedProject)}\n`;
    }
  } else if (agent === 'gemini') {
    if (resume) {
      launchCmd = `${setSize}${geminiBin} --sandbox --resume ${resume}\n`;
    } else {
      launchCmd = `${setSize}${geminiBin} --sandbox\n`;
    }
  } else if (agent === 'pi') {
    if (resume) {
      launchCmd = `${setSize}${piBin} --session ${resume}\n`;
    } else {
      launchCmd = `${setSize}${piBin}\n`;
    }
  } else {
    const sandboxFlag = `--settings '{"sandbox":{"enabled":true}}'`;
    if (resume) {
      launchCmd = `${setSize}${claudeBin} ${sandboxFlag} --resume ${resume}\n`;
    } else {
      launchCmd = `${setSize}${claudeBin} ${sandboxFlag}\n`;
    }
  }
  proc.write(launchCmd);

  // --- Auto-naming ---
  let outputBuffer = '';
  let charsSinceLastRename = 0;
  let renameCount = 0;   // successful meaningful renames (caps at MAX_RENAMES)
  let hasAttempted = false;  // whether we've called haiku at least once
  const MAX_RENAMES = 5;
  const INITIAL_DELAY = 90_000;      // 1.5 minutes (wait for actual task content)
  const RENAME_INTERVAL = 5 * 60_000; // 5 minutes
  const MAX_RENAME_AGE = 30 * 60_000; // 30 minutes
  const MIN_NEW_CHARS = 1000;
  const sessionStart = Date.now();
  let renameTimer = null;
  let sessionEnded = false;

  // R2: Consistent ANSI stripping (matches client)
  function stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[\x00-\x1f]/g, '');
  }

  // Clean terminal output for naming: strip TUI chrome, banners, prompts
  function cleanForNaming(raw) {
    let s = stripAnsi(raw);
    // Remove Claude Code startup banner lines
    s = s.replace(/Claude Code v[\d.]+/g, '');
    s = s.replace(/Opus \d+\.\d+.*?context\).*?(?:Claude Max|high effort|low effort|medium effort)/g, '');
    s = s.replace(/~\/[^\s]*/g, '');  // ~/Documents/herd etc.
    // Remove shell prompts like (base) user@host dir %
    s = s.replace(/\(base\)\s*\S+@\S+\s+\S+\s*%/g, '');
    // Remove box-drawing and TUI decoration characters
    s = s.replace(/[─│┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╠╣╦╩╬▀▄█▌▐░▒▓■●◆◇○◎★☆►◄▲▼⊞⊟]/g, '');
    // Remove common status bar content
    s = s.replace(/\? for shortcuts/g, '');
    s = s.replace(/ctrl\+[a-z] to \w+/gi, '');
    s = s.replace(/Image in clipboard/g, '');
    s = s.replace(/\/effort/g, '');
    s = s.replace(/Running\.\.\./g, '');
    s = s.replace(/In \S+\.js/g, '');
    // Remove file paths
    s = s.replace(/\/Users\/\S+/g, '');
    // Remove repeated dots/underscores (TUI padding)
    s = s.replace(/[_.]{3,}/g, ' ');
    // Collapse whitespace
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  // Detect session ID for new sessions by finding the newest JSONL in the project dir
  function detectSessionId() {
    if (sessionId) return sessionId;

    if (agent === 'codex') {
      // Scan today's Codex rollout dir for recently-created files
      try {
        const now = new Date();
        const dayDir = path.join(CODEX_SESSIONS_DIR,
          String(now.getFullYear()),
          String(now.getMonth() + 1).padStart(2, '0'),
          String(now.getDate()).padStart(2, '0'));
        const files = readdirSafe(dayDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const fp = path.join(dayDir, f);
            return { name: codexFileSessionId(f), mtime: fs.statSync(fp).mtimeMs, path: fp };
          })
          .filter(f => f.name && f.mtime >= sessionStart - 5000)
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          sessionId = files[0].name;
          const entry = terminals.get(termId);
          if (entry) entry.sessionId = sessionId;
          try { ws.send(JSON.stringify({ type: 'ready', termId, sessionId })); } catch {}
        }
      } catch {}
    } else if (agent === 'gemini') {
      try {
        scanGeminiSessions();
        const session = Array.from(geminiIndex.values())
          .filter(s => s.cwd === resolvedProject && s.mtime >= sessionStart - 5000)
          .sort((a, b) => b.mtime - a.mtime)[0];
        if (session) {
          sessionId = session.id;
          const entry = terminals.get(termId);
          if (entry) entry.sessionId = sessionId;
          try { ws.send(JSON.stringify({ type: 'ready', termId, sessionId })); } catch {}
        }
      } catch {}
    } else if (agent === 'pi') {
      try {
        scanPiSessions();
        const piDirs = readdirSafe(PI_SESSIONS_DIR);
        for (const dirName of piDirs) {
          let decoded;
          try { decoded = decodePiProjectPath(dirName); } catch { continue; }
          if (decoded !== resolvedProject) continue;
          const projDir = path.join(PI_SESSIONS_DIR, dirName);
          const files = readdirSafe(projDir)
            .filter(f => f.endsWith('.jsonl'))
            .map(f => {
              const filePath = path.join(projDir, f);
              try {
                const stat = fs.statSync(filePath);
                return { name: f, path: filePath, mtime: stat.mtimeMs };
              } catch { return null; }
            })
            .filter(f => f && f.mtime >= sessionStart - 5000)
            .sort((a, b) => b.mtime - a.mtime);
          if (files.length > 0) {
            // Read first line to get session ID
            try {
              const headerLine = fs.readFileSync(files[0].path, 'utf8').split('\n')[0];
              const header = JSON.parse(headerLine);
              if (header.type === 'session' && header.id) {
                sessionId = header.id;
                const entry = terminals.get(termId);
                if (entry) entry.sessionId = sessionId;
                try { ws.send(JSON.stringify({ type: 'ready', termId, sessionId })); } catch {}
              }
            } catch {}
          }
          break; // Found the matching project dir
        }
      } catch {}
    } else {
      if (!encodedDir) return null;
      try {
        const projDir = path.join(PROJECTS_DIR, encodedDir);
        const files = fs.readdirSync(projDir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ name: f.replace('.jsonl', ''), mtime: fs.statSync(path.join(projDir, f)).mtimeMs }))
          .filter(f => f.mtime >= sessionStart - 5000)
          .sort((a, b) => b.mtime - a.mtime);
        if (files.length > 0) {
          sessionId = files[0].name;
          const entry = terminals.get(termId);
          if (entry) entry.sessionId = sessionId;
          try { ws.send(JSON.stringify({ type: 'ready', termId, sessionId })); } catch {}
        }
      } catch {}
    }
    return sessionId;
  }

  // Build naming input from JSONL user messages when available
  function getJsonlNamingText() {
    const sid = detectSessionId();
    if (!sid) return null;

    if (agent === 'gemini') {
      let logsFile = null;
      for (const entry of geminiIndex.values()) {
        if (entry.id === sid) { logsFile = entry.logsFile; break; }
      }
      if (!logsFile) return null;
      try {
        const logs = JSON.parse(fs.readFileSync(logsFile, 'utf8'));
        const msgs = logs.filter(e => e.sessionId === sid && e.type === 'user' && e.message && !e.message.startsWith('/'))
                         .map(e => e.message.slice(0, 300).replace(/\n/g, ' ').trim());
        if (!msgs.length) return null;
        let text = '';
        for (const m of msgs) {
          if (text.length + m.length > 1500) break;
          text += (text ? ' | ' : '') + m;
        }
        return text;
      } catch {
        return null;
      }
    }

    let jsonlPath = null;
    if (agent === 'codex') {
      // Find Codex session file from index
      for (const [fp, entry] of codexIndex.entries()) {
        if (entry.id === sid) { jsonlPath = fp; break; }
      }
    } else if (agent === 'pi') {
      // Find Pi session file from index
      for (const [fp, entry] of piIndex.entries()) {
        if (entry.id === sid) { jsonlPath = fp; break; }
      }
    } else if (encodedDir) {
      jsonlPath = path.join(PROJECTS_DIR, encodedDir, `${sid}.jsonl`);
    }
    if (!jsonlPath) return null;
    const msgs = agent === 'pi' ? getPiUserMessages(jsonlPath) : getUserMessages(jsonlPath);
    if (!msgs.length) return null;
    // Include all user messages, truncated to ~1500 chars total
    let text = '';
    for (const m of msgs) {
      if (text.length + m.length > 1500) break;
      text += (text ? ' | ' : '') + m;
    }
    return text;
  }

  async function generateTitle() {
    if (sessionEnded || renameCount >= MAX_RENAMES) return;
    if (Date.now() - sessionStart > MAX_RENAME_AGE) return;

    // Always schedule the next attempt up front so early returns below
    // don't leave the timer dead.
    scheduleNextRename();

    // Prefer JSONL user messages over noisy terminal output
    const jsonlText = getJsonlNamingText();
    let namingInput, title;
    if (jsonlText && jsonlText.length >= 10) {
      if (hasAttempted && charsSinceLastRename < MIN_NEW_CHARS) return;
      hasAttempted = true;
      charsSinceLastRename = 0;
      namingInput = jsonlText;
      title = await generateSummary(namingInput);
    } else {
      const clean = cleanForNaming(outputBuffer).slice(-800);
      if (clean.length < 30) return;
      if (hasAttempted && charsSinceLastRename < MIN_NEW_CHARS) return;
      hasAttempted = true;
      charsSinceLastRename = 0;
      namingInput = clean;
      title = await generateLiveTitle(namingInput);
    }
    if (!title) return;

    // Haiku is instructed to reply "new session" when the task isn't clear
    // yet — don't consume a rename slot or notify the client for that.
    const normalized = title.replace(/["'.]/g, '').trim().toLowerCase();
    if (!normalized || normalized === 'new session') return;

    renameCount++;
    try { ws.send(JSON.stringify({ type: 'title', title })); } catch {}
    // Persist live title to summary cache
    const sid = detectSessionId();
    if (sid) {
      setSummary(summaryCacheKey(agent, sid), title);
      scheduleSaveSummary();
      broadcastSummaryUpdate(sid, agent, title);
    }
  }

  function scheduleNextRename() {
    if (renameTimer) clearTimeout(renameTimer);
    if (sessionEnded || renameCount >= MAX_RENAMES) return;
    if (Date.now() - sessionStart > MAX_RENAME_AGE) return;
    renameTimer = setTimeout(generateTitle, RENAME_INTERVAL);
  }

  // For resumed sessions, use cached summary immediately
  if (resume) {
    renameCount = MAX_RENAMES; // don't auto-rename resumed sessions
    const cacheKey = summaryCacheKey(agent, resume);
    if (agent === 'codex') {
      // Look up Codex session preview from rollout index
      let preview = null;
      for (const entry of codexIndex.values()) {
        if (entry.id === resume) { preview = entry.preview; break; }
      }
      const title = getSummaryText(cacheKey) || (preview && preview.slice(0, 60));
      if (title) ws.send(JSON.stringify({ type: 'title', title }));
    } else if (agent === 'gemini') {
      let preview = null;
      for (const entry of geminiIndex.values()) {
        if (entry.id === resume) { preview = entry.preview; break; }
      }
      const title = getSummaryText(cacheKey) || (preview && preview.slice(0, 60));
      if (title) ws.send(JSON.stringify({ type: 'title', title }));
    } else if (agent === 'pi') {
      let preview = null;
      for (const entry of piIndex.values()) {
        if (entry.id === resume) { preview = entry.preview; break; }
      }
      const title = getSummaryText(cacheKey) || (preview && preview.slice(0, 60));
      if (title) ws.send(JSON.stringify({ type: 'title', title }));
    } else if (encodedDir) {
      const jsonlDir = path.join(PROJECTS_DIR, encodedDir);
      const info = getSessionInfo(path.join(jsonlDir, `${resume}.jsonl`));
      const title = getSummaryText(cacheKey) || (info.firstUserMessage && info.firstUserMessage.slice(0, 60));
      if (title) ws.send(JSON.stringify({ type: 'title', title }));
    }
  } else {
    // First rename after 1 minute
    renameTimer = setTimeout(generateTitle, INITIAL_DELAY);
  }

  // PTY output → WebSocket + buffer for auto-naming
  // Coalesce rapid output chunks into fewer, larger WebSocket frames.
  // node-pty emits already-decoded utf8 strings and handles multi-byte
  // boundaries internally, so no StringDecoder is needed here.
  let wsSendBuf = '';
  let wsSendTimer = null;
  // H7: Backpressure. A stalled browser tab can let ws.bufferedAmount grow
  // without bound, OOMing the server and taking every other terminal down.
  // Pause the PTY when the queue exceeds HIGH_WATER; resume under LOW_WATER.
  const HIGH_WATER = 1 << 20;  // 1 MB queued to client
  const LOW_WATER  = 1 << 17;  // 128 KB
  let ptyPaused = false;
  const maybeResume = () => {
    if (ptyPaused && ws.bufferedAmount < LOW_WATER) {
      try { proc.resume(); } catch {}
      ptyPaused = false;
    }
  };
  const flushWsBuf = () => {
    wsSendTimer = null;
    if (wsSendBuf) {
      const chunk = wsSendBuf;
      wsSendBuf = '';
      try { ws.send(JSON.stringify({ type: 'output', data: chunk })); } catch {}
    }
    maybeResume();
  };

  proc.onData(str => {
    outputBuffer += str;
    if (outputBuffer.length > 2048) outputBuffer = outputBuffer.slice(-2048);
    charsSinceLastRename += str.length;
    wsSendBuf += str;
    if (!ptyPaused && ws.bufferedAmount > HIGH_WATER) {
      try { proc.pause(); } catch {}
      ptyPaused = true;
    }
    if (!wsSendTimer) wsSendTimer = setTimeout(flushWsBuf, 8);
  });

  proc.onExit(({ exitCode }) => {
    sessionEnded = true;
    if (renameTimer) clearTimeout(renameTimer);
    if (wsSendTimer) { clearTimeout(wsSendTimer); flushWsBuf(); } else if (wsSendBuf) { flushWsBuf(); }
    try { ws.send(JSON.stringify({ type: 'exit', code: exitCode || 0 })); } catch {}
    terminals.delete(termId);
  });

  // WebSocket → stdin + resize
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        try { proc.write(msg.data); } catch {}
      } else if (msg.type === 'resize' && msg.cols && msg.rows) {
        try { proc.resize(msg.cols, msg.rows); } catch {}
      }
    } catch {}
  });

  ws.on('close', () => {
    sessionEnded = true;
    if (renameTimer) clearTimeout(renameTimer);
    // SIGHUP, not SIGTERM: interactive zsh ignores SIGTERM.
    try { proc.kill('SIGHUP'); } catch {}
    terminals.delete(termId);
  });
});

// P7: Graceful shutdown
function cleanup() {
  // H5: flush any pending summary writes before the event loop exits
  flushSaveSummarySync();
  for (const [, term] of terminals) {
    try { term.proc.kill('SIGHUP'); } catch {}
  }
  wss.close();
  server.close(() => process.exit());
  setTimeout(() => process.exit(1), 3000);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// S1: Bind to localhost only — no auth, so don't expose on all interfaces
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`\n  Herd → http://${HOST}:${PORT}\n`);
});
