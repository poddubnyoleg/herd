require('dotenv').config({ path: require('path').join(require('os').homedir(), 'Documents/sweatcoin/sweat-researcher/.env') });
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.PORT || 3456;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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

function encodeProjectPath(p) {
  return p.replace(/\//g, '-');
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
          if (text && text.length > 3 && !text.startsWith('You are a')) {
            firstUserMessage = text.slice(0, 150).replace(/\n/g, ' ').trim();
            break;
          }
        }
      } catch {}
    }

    return { firstUserMessage, timestamp, slug };
  } catch {
    return { firstUserMessage: null, timestamp: null };
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !text) return null;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: `Name this chat session in 2-4 words. Lowercase, no punctuation. Reply with ONLY the words.\n\n"${text.slice(0, 300)}"` }],
      }),
    });
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

// Background: generate summaries for sessions missing them
async function generateMissingSummaries(sessions) {
  const uncached = sessions.filter(s => !summaryCache[s.id] && s.preview);
  if (!uncached.length) return;

  // Process in parallel batches of 5
  for (let i = 0; i < uncached.length; i += 5) {
    const batch = uncached.slice(i, i + 5);
    await Promise.all(batch.map(async s => {
      const summary = await generateSummary(s.preview);
      if (summary) summaryCache[s.id] = summary;
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
      for (const f of jsonls.slice(-5)) {
        try {
          const mt = fs.statSync(path.join(projDir, f)).mtimeMs;
          if (mt > latestMtime) latestMtime = mt;
        } catch {}
      }

      return { id: encoded, path: decoded, name: getProjectName(decoded), exists, sessionCount: jsonls.length, latestMtime };
    })
    .filter(p => p.exists && p.sessionCount > 0)
    .sort((a, b) => b.latestMtime - a.latestMtime);

    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id/sessions', (req, res) => {
  try {
    const projectDir = path.join(PROJECTS_DIR, req.params.id);
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath = path.join(projectDir, f);
        const stat = fs.statSync(filePath);
        return { file: f, path: filePath, mtime: stat.mtimeMs, date: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 30);

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

    res.json(sessions);

    // Background: generate missing summaries
    generateMissingSummaries(sessions).catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- WebSocket terminal (using `script` as PTY wrapper) ---

const terminals = new Map();

// Detect user's shell
const userShell = process.env.SHELL || '/bin/zsh';

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const projectPath = params.get('project');
  const resume = params.get('resume');  // session ID to resume claude
  const cols = parseInt(params.get('cols')) || 120;
  const rows = parseInt(params.get('rows')) || 30;

  if (!projectPath) {
    ws.send(JSON.stringify({ type: 'error', message: 'No project path' }));
    ws.close();
    return;
  }

  // Determine what to spawn:
  // - resume=<id> → claude --resume <id>  (direct)
  // - otherwise   → interactive shell (user runs claude themselves)
  let scriptArgs;
  let sessionId = null;

  if (resume) {
    sessionId = resume;
    scriptArgs = ['-q', '/dev/null', claudeBin, '--resume', resume];
  } else {
    // Interactive shell — cd to project, ready for anything
    scriptArgs = ['-q', '/dev/null', userShell, '-i'];
  }

  let proc;
  try {
    proc = spawn('script', scriptArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectPath,
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

  // --- Auto-naming ---
  let outputBuffer = '';
  let titleGenerated = false;
  let titleTimer = null;

  function stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
  }

  async function generateTitle() {
    if (titleGenerated) return;
    titleGenerated = true;
    const clean = stripAnsi(outputBuffer).replace(/\s+/g, ' ').trim().slice(-800);
    if (clean.length < 20) return;
    const title = await generateSummary(clean);
    if (title) {
      try { ws.send(JSON.stringify({ type: 'title', title })); } catch {}
    }
  }

  // For resumed sessions, use cached summary immediately
  if (resume) {
    titleGenerated = true;
    const encodedProject = encodeProjectPath(projectPath);
    const jsonlDir = path.join(PROJECTS_DIR, encodedProject);
    const info = getSessionInfo(path.join(jsonlDir, `${resume}.jsonl`));
    const title = summaryCache[resume] || (info.firstUserMessage && info.firstUserMessage.slice(0, 60));
    if (title) {
      ws.send(JSON.stringify({ type: 'title', title }));
    }
  }

  // stdout → WebSocket + buffer for auto-naming
  proc.stdout.on('data', data => {
    const str = data.toString();
    try { ws.send(JSON.stringify({ type: 'output', data: str })); } catch {}

    // Buffer output for auto-naming (debounced)
    if (!titleGenerated) {
      outputBuffer += str;
      if (titleTimer) clearTimeout(titleTimer);
      // Generate title after 3s of quiet, or when buffer is large enough
      if (outputBuffer.length > 2000) {
        generateTitle();
      } else {
        titleTimer = setTimeout(generateTitle, 3000);
      }
    }
  });

  proc.stderr.on('data', data => {
    try { ws.send(JSON.stringify({ type: 'output', data: data.toString() })); } catch {}
  });

  proc.on('exit', (code) => {
    try { ws.send(JSON.stringify({ type: 'exit', code: code || 0 })); } catch {}
    terminals.delete(termId);
  });

  // WebSocket → stdin
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input') proc.stdin.write(msg.data);
    } catch {}
  });

  ws.on('close', () => {
    if (titleTimer) clearTimeout(titleTimer);
    try { proc.kill('SIGTERM'); } catch {}
    terminals.delete(termId);
  });
});

// Cleanup
process.on('SIGINT', () => {
  for (const [, term] of terminals) {
    try { term.proc.kill('SIGTERM'); } catch {}
  }
  process.exit();
});

server.listen(PORT, () => {
  console.log(`\n  Claude Hub → http://localhost:${PORT}\n`);
});
