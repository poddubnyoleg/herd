const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 3456;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// B4: Only upgrade WebSocket on /ws path
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') {
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

function getSessionInfo(jsonlPath) {
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    let content;
    try {
      const buffer = Buffer.alloc(16384);
      const bytesRead = fs.readSync(fd, buffer, 0, 16384, 0);
      content = buffer.toString('utf8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
    const lines = content.split('\n').filter(l => l.trim());

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

function saveSummaryCache() {
  try { fs.writeFileSync(SUMMARY_CACHE_PATH, JSON.stringify(summaryCache, null, 2)); } catch {}
}

async function generateSummary(text) {
  if (!claudeBin || !text) return null;

  const prompt = `Name this chat session in 2-4 words. Lowercase, no punctuation. Reply with ONLY the words.\n\n"${text.slice(0, 1000)}"`;
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

async function generateMissingSummaries(sessions) {
  const uncached = sessions.filter(s => !summaryCache[s.id] && !summarizing.has(s.id) && s.preview);
  if (!uncached.length) return;

  uncached.forEach(s => summarizing.add(s.id));

  // Process in parallel batches of 5
  for (let i = 0; i < uncached.length; i += 5) {
    const batch = uncached.slice(i, i + 5);
    await Promise.all(batch.map(async s => {
      try {
        const summary = await generateSummary(s.preview);
        if (summary) summaryCache[s.id] = summary;
      } finally {
        summarizing.delete(s.id);
      }
    }));
  }
  saveSummaryCache();
}

// --- API ---

app.get('/api/projects', (req, res) => {
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
      try { return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(); }
      catch { return false; }
    });

    const projects = dirs.map(encoded => {
      const decoded = decodeProjectPath(encoded);
      const exists = fs.existsSync(decoded);
      const projDir = path.join(PROJECTS_DIR, encoded);
      const jsonls = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));

      let latestMtime = 0;
      for (const f of jsonls) {
        try {
          const mt = fs.statSync(path.join(projDir, f)).mtimeMs;
          if (mt > latestMtime) latestMtime = mt;
        } catch {}
      }

      return { id: encoded, path: decoded, name: getProjectName(decoded), exists, sessionCount: jsonls.length, latestMtime };
    })
    .filter(p => p.sessionCount > 0)
    .sort((a, b) => b.latestMtime - a.latestMtime);

    res.json(projects);

    // B5: Lazily prune stale summaries
    const allSessionIds = new Set();
    for (const p of projects) {
      try {
        const projDir = path.join(PROJECTS_DIR, p.id);
        for (const f of fs.readdirSync(projDir)) {
          if (f.endsWith('.jsonl')) allSessionIds.add(f.replace('.jsonl', ''));
        }
      } catch {}
    }
    let pruned = false;
    for (const id of Object.keys(summaryCache)) {
      if (!allSessionIds.has(id)) { delete summaryCache[id]; pruned = true; }
    }
    if (pruned) saveSummaryCache();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id/sessions', (req, res) => {
  try {
    const projectDir = path.join(PROJECTS_DIR, req.params.id);
    // Prevent path traversal — resolved path must stay inside PROJECTS_DIR
    if (!path.resolve(projectDir).startsWith(PROJECTS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }
    const MAX_SESSIONS = 30;
    const allFiles = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath = path.join(projectDir, f);
        const stat = fs.statSync(filePath);
        return { file: f, path: filePath, mtime: stat.mtimeMs, date: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime - a.mtime);
    const totalCount = allFiles.length;
    const files = allFiles.slice(0, MAX_SESSIONS);

    const sessions = files.map(f => {
      const info = getSessionInfo(f.path);
      return {
        id: f.file.replace('.jsonl', ''),
        date: f.date,
        mtime: f.mtime,
        preview: info.firstUserMessage,
        summary: summaryCache[f.file.replace('.jsonl', '')] || null,
      };
    }).filter(s => s.preview);

    // B7: Include truncation info
    res.json({ sessions, total: totalCount, truncated: totalCount > MAX_SESSIONS });

    // Background: generate missing summaries
    generateMissingSummaries(sessions).catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- WebSocket terminal (using `script` as PTY wrapper) ---

const terminals = new Map();

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const projectPath = params.get('project');
  const resume = params.get('resume');  // session ID to resume claude
  const cols = parseInt(params.get('cols')) || 120;
  const rows = parseInt(params.get('rows')) || 30;

  // B6: Validate resume parameter format
  if (resume && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resume)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID format' }));
    ws.close();
    return;
  }

  // B8: Validate project path and capture encoded directory name
  const resolvedProject = projectPath && path.resolve(projectPath);
  const encodedDir = resolvedProject ? findEncodedDir(resolvedProject) : null;
  if (!encodedDir) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
    ws.close();
    return;
  }
  // For new shells the directory must still exist; resume works from anywhere
  const projectDirExists = fs.existsSync(resolvedProject);
  if (!resume && !projectDirExists) {
    ws.send(JSON.stringify({ type: 'error', message: 'Project directory no longer exists' }));
    ws.close();
    return;
  }

  // Spawn an interactive shell wrapped in `script` for PTY.
  // Claude is launched as a command inside the shell so that when it exits,
  // the user drops back to a live shell prompt in the same tab.
  const shell = process.env.SHELL || '/bin/zsh';
  let sessionId = resume || null;
  const scriptArgs = ['-q', '/dev/null', shell, '-li'];

  let proc;
  try {
    proc = spawn('script', scriptArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectDirExists ? projectPath : os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLUMNS: String(cols),
        LINES: String(rows),
      },
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: `Failed to spawn: ${err.message}` }));
    ws.close();
    return;
  }

  const termId = crypto.randomUUID();
  terminals.set(termId, { proc, ws, sessionId });

  ws.send(JSON.stringify({ type: 'ready', termId, sessionId }));

  // Launch claude inside the shell — when it exits the shell stays alive
  const claudeCmd = resume
    ? `${claudeBin} --resume ${resume}\n`
    : `${claudeBin}\n`;
  proc.stdin.write(claudeCmd);

  // --- Auto-naming ---
  let outputBuffer = '';
  let charsSinceLastRename = 0;
  let renameCount = 0;
  const MAX_RENAMES = 5;
  const INITIAL_DELAY = 60_000;      // 1 minute
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

  async function generateTitle() {
    if (sessionEnded || renameCount >= MAX_RENAMES) return;
    if (Date.now() - sessionStart > MAX_RENAME_AGE) return;
    const clean = stripAnsi(outputBuffer).replace(/\s+/g, ' ').trim().slice(-800);
    if (clean.length < 20) return;
    if (renameCount > 0 && charsSinceLastRename < MIN_NEW_CHARS) return;
    renameCount++;
    charsSinceLastRename = 0;
    const title = await generateSummary(clean);
    if (title) {
      try { ws.send(JSON.stringify({ type: 'title', title })); } catch {}
    }
    scheduleNextRename();
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
    const jsonlDir = path.join(PROJECTS_DIR, encodedDir);
    const info = getSessionInfo(path.join(jsonlDir, `${resume}.jsonl`));
    const title = summaryCache[resume] || (info.firstUserMessage && info.firstUserMessage.slice(0, 60));
    if (title) {
      ws.send(JSON.stringify({ type: 'title', title }));
    }
  } else {
    // First rename after 1 minute
    renameTimer = setTimeout(generateTitle, INITIAL_DELAY);
  }

  // stdout → WebSocket + buffer for auto-naming
  proc.stdout.on('data', data => {
    const str = data.toString();
    try { ws.send(JSON.stringify({ type: 'output', data: str })); } catch {}
    outputBuffer += str;
    if (outputBuffer.length > 2048) outputBuffer = outputBuffer.slice(-2048);
    charsSinceLastRename += str.length;
  });

  proc.stderr.on('data', data => {
    try { ws.send(JSON.stringify({ type: 'output', data: data.toString() })); } catch {}
  });

  proc.on('exit', (code) => {
    sessionEnded = true;
    if (renameTimer) clearTimeout(renameTimer);
    try { ws.send(JSON.stringify({ type: 'exit', code: code || 0 })); } catch {}
    terminals.delete(termId);
  });

  // WebSocket → stdin + resize
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') {
        try { proc.stdin.write(msg.data); } catch {}
      } else if (msg.type === 'resize' && msg.cols && msg.rows) {
        // Note: script-based PTY has limited resize support since we
        // can't ioctl the PTY fd directly. SIGWINCH signals child apps
        // to re-check dimensions, but the underlying PTY size is fixed
        // at initial cols/rows. Full resize requires node-pty.
        try { proc.kill('SIGWINCH'); } catch {}
      }
    } catch {}
  });

  ws.on('close', () => {
    sessionEnded = true;
    if (renameTimer) clearTimeout(renameTimer);
    try { proc.kill('SIGTERM'); } catch {}
    terminals.delete(termId);
  });
});

// P7: Graceful shutdown
function cleanup() {
  for (const [, term] of terminals) {
    try { term.proc.kill('SIGTERM'); } catch {}
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
