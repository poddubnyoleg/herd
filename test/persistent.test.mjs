// Herd — sessions that outlive their viewer (docs/proposal-persistent-sessions.md)
// Run: npm run test:persistent
//
// Self-contained: boots its own server from a temp copy of server.js, with a
// temp HOME and a stub `claude` (test/fixtures/fake-claude.sh) that drops into
// a plain shell. It never touches the Herd on :3456, its summaries.json, or
// real agent sessions. Needs node-pty to spawn and localhost sockets, so it
// cannot run under a sandbox that blocks either.

import { chromium } from 'playwright';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Same load-time workaround as server.js: xterm 5.3.0 misdetects Node 21+ as a
// browser because of the global navigator.
const { Terminal: Headless } = (() => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (nav) delete globalThis.navigator;
  try { return require('xterm-headless'); } finally { if (nav) Object.defineProperty(globalThis, 'navigator', nav); }
})();

// ── Runner ──

const results = [];
let beforeEach = async () => {};
async function test(name, fn) {
  const start = Date.now();
  try {
    await beforeEach();
    await fn();
    results.push({ name, pass: true });
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${name} \x1b[2m(${Date.now() - start}ms)\x1b[0m\n`);
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${name} \x1b[2m(${Date.now() - start}ms)\x1b[0m\n    \x1b[31m${err.message}\x1b[0m\n`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 10000, interval = 100, msg = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${msg}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── Isolated server ──

async function startServer(env = {}) {
  // Plain alphanumeric root: Claude's dash-encoded project dirs decode back
  // to it unambiguously, so session-id detection works for the stub.
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/herdpersist'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zshrc'), '');
  fs.copyFileSync(path.join(REPO, 'test', 'fixtures', 'fake-claude.sh'), path.join(home, '.local', 'bin', 'claude'));
  fs.chmodSync(path.join(home, '.local', 'bin', 'claude'), 0o755);
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  // A copy, not a symlink: server.js keeps summaries.json next to itself.
  fs.copyFileSync(path.join(REPO, 'server.js'), path.join(app, 'server.js'));
  fs.symlinkSync(path.join(REPO, 'public'), path.join(app, 'public'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(app, 'node_modules'));
  const proj = path.join(root, 'proj');
  const projUnnamed = path.join(root, 'proj-unnamed');
  fs.mkdirSync(proj);
  fs.mkdirSync(projUnnamed);
  fs.writeFileSync(path.join(proj, 'lines.txt'), Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');

  const port = 3500 + Math.floor(Math.random() * 400);
  const proc = spawn(process.execPath, [path.join(app, 'server.js')], {
    cwd: root,
    env: { ...process.env, HOME: home, PORT: String(port), SHELL: '/bin/zsh', LESS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(url)).ok, { msg: `server on ${port}\n${log}` });
  const exited = new Promise(r => proc.on('exit', r));
  return {
    url, root, proj, projUnnamed, log: () => log,
    live: async () => (await fetch(`${url}/api/live`)).json(),
    async killAll() {
      for (const t of await this.live()) await fetch(`${url}/api/live/${t.termId}`, { method: 'DELETE' });
      await waitFor(async () => (await this.live()).length === 0, { msg: 'no live terminals' });
    },
    async stop() {
      proc.kill('SIGTERM');
      await exited;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// A raw viewer, for protocol-level cases a page cannot produce deterministically.
function openWs(srv, params) {
  const u = new URL(srv.url.replace('http', 'ws') + '/ws');
  const all = { project: srv.proj, agent: 'claude', cols: 100, rows: 30, client: crypto.randomUUID(), ...params };
  for (const [k, v] of Object.entries(all)) if (v != null) u.searchParams.set(k, String(v));
  const ws = new WebSocket(u);
  ws.msgs = [];
  ws.stream = ''; // snapshot + output, in arrival order
  ws.on('message', d => {
    const m = JSON.parse(d);
    ws.msgs.push(m);
    if (m.type === 'snapshot') ws.stream += '\x1bc' + m.data;
    if (m.type === 'output') ws.stream += m.data;
  });
  ws.closed = new Promise(r => ws.on('close', code => r(code)));
  ws.input = s => ws.send(JSON.stringify({ type: 'input', data: s }));
  return new Promise((resolve, reject) => { ws.on('open', () => resolve(ws)); ws.on('error', reject); });
}

// Render a viewer's stream the way the browser would and return its lines.
function render(stream, cols = 100, rows = 30) {
  const t = new Headless({ cols, rows, scrollback: 1000, allowProposedApi: true });
  return new Promise(resolve => t.write(stream, () => {
    const b = t.buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
    t.dispose();
    resolve(lines);
  }));
}

// ── Page helpers ──

const tabs = page => page.evaluate(() => [...window.__herd.tabs.values()].map(t => ({
  id: t.id, termId: t.termId, sessionId: t.sessionId, alive: t.alive, finished: t.finished,
  unread: t.unread, holdsSlot: t._holdsSlot, busy: t._busy, yielded: t._yielded,
  wsState: t.ws ? t.ws.readyState : -1, active: t.id === window.__herd.activeTabId,
})));
const bufText = (page, id) => page.evaluate(id => {
  const b = window.__herd.tabs.get(id).terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
  return lines.join('\n');
}, id);
const typeIn = (page, id, s) => page.evaluate(([id, s]) =>
  window.__herd.tabs.get(id).ws.send(JSON.stringify({ type: 'input', data: s })), [id, s]);
async function openTab(page, project, opts = {}) {
  const id = await page.evaluate(([p, o]) => window.__herd.createTab(p, 'test', o.resume || null, 'claude', o), [project, opts]);
  await waitFor(async () => (await tabs(page)).find(t => t.id === id && t.holdsSlot && t.termId),
    { msg: 'tab connected' });
  await waitFor(async () => (await bufText(page, id)).includes('$ '), { msg: 'shell prompt' });
  return id;
}
// storage: set the saved tab state before the app loads (null clears it)
async function loadPage(context, srv, { storage } = {}) {
  const page = await context.newPage();
  if (storage !== undefined) {
    await page.goto(`${srv.url}/__blank`); // same origin, no app
    await page.evaluate(s => s ? localStorage.setItem('herd-tabs', JSON.stringify(s)) : localStorage.clear(), storage);
  }
  await page.goto(srv.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__herd);
  return page;
}

// ── Tests ──

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const srv = await startServer();
  try {
    let context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    let page = await loadPage(context, srv);

    let tabId, pid, sessionId;

    await test('1. Reload keeps the process and its screen', async () => {
      tabId = await openTab(page, srv.proj);
      await typeIn(page, tabId, 'echo before-$((40+2))\r');
      await waitFor(async () => (await bufText(page, tabId)).includes('before-42'), { msg: 'echo output' });
      // Session detection (the stub writes a transcript) persists the tab by sessionId too
      await waitFor(async () => (await tabs(page))[0].sessionId, { msg: 'session id detected' });
      const [t] = await srv.live();
      pid = t.pid;
      sessionId = t.sessionId;
      await page.reload({ waitUntil: 'load' });
      await waitFor(async () => (await tabs(page)).find(t => t.holdsSlot), { msg: 'reattached after reload' });
      const [after] = await tabs(page);
      tabId = after.id;
      const live = await srv.live();
      assert(live.length === 1 && live[0].pid === pid, `expected the same PID ${pid}, got ${JSON.stringify(live)}`);
      await waitFor(async () => (await bufText(page, tabId)).includes('before-42'), { msg: 'pre-reload screen restored' });
      // The restored terminal is live: input reaches the same shell
      await typeIn(page, tabId, 'echo after-$((40+3))\r');
      await waitFor(async () => (await bufText(page, tabId)).includes('after-43'), { msg: 'input after reattach' });
    });

    await test('2. Socket drop keeps the process', async () => {
      await page.evaluate(id => window.__herd.tabs.get(id).ws.close(), tabId);
      await waitFor(async () => {
        const [t] = await tabs(page);
        return t.holdsSlot && t.wsState === 1 && t.alive;
      }, { msg: 'reconnected' });
      const live = await srv.live();
      assert(live.length === 1 && live[0].pid === pid && live[0].attached, `same PID, attached: ${JSON.stringify(live)}`);
      const text = await bufText(page, tabId);
      assert(text.includes('after-43'), 'screen restored after drop');
      assert(!text.includes('[disconnected]'), 'snapshot replaced the local [disconnected] marker');
    });

    let page2, context2;
    await test('4. Second window, explicit: the first shows "opened elsewhere" and stays put', async () => {
      context2 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      page2 = await loadPage(context2, srv);
      const id2 = await openTab(page2, srv.proj, { resume: sessionId });
      assert((await bufText(page2, id2)).includes('after-43'), 'second window sees the session screen');
      await waitFor(async () => (await tabs(page))[0].yielded, { msg: 'first window displaced' });
      const overlay = await page.locator('.terminal-takeover').textContent();
      assert(/Opened in another window/.test(overlay), `overlay: ${overlay}`);
      await sleep(2500); // longer than the first reconnect backoff
      const [t1] = await tabs(page);
      assert(!t1.alive && t1.wsState === 3, `first window must not reconnect: ${JSON.stringify(t1)}`);
      const live = await srv.live();
      assert(live.length === 1 && live[0].pid === pid && live[0].attached, 'same PID, held by the second window');
    });

    await test('5. Second window, automatic: a reconnect gets busy and does not take it back', async () => {
      // Simulate the first window's automatic reconnect (steal=0)
      await page.evaluate(id => window.__herd.connectWebSocket(window.__herd.tabs.get(id)), tabId);
      await waitFor(async () => (await tabs(page))[0].busy, { msg: 'busy reply' });
      const overlay = await page.locator('.terminal-takeover').textContent();
      assert(/Open in another window/.test(overlay), `overlay: ${overlay}`);
      const [t2] = await tabs(page2);
      assert(t2.holdsSlot && t2.wsState === 1, 'second window still holds the terminal');
      // Once the second window leaves (page close = detach, not kill), the
      // first one's quiet retries attach by themselves.
      await page2.close();
      await context2.close();
      await waitFor(async () => (await tabs(page))[0].holdsSlot, { timeout: 15000, msg: 'first window attaches by itself' });
      assert(await page.locator('.terminal-takeover').count() === 0, 'overlay removed');
      const live = await srv.live();
      assert(live.length === 1 && live[0].pid === pid, 'same PID throughout');
    });

    await test('6. A replaced socket is inert: its input and kill code are ignored', async () => {
      // Free the page's slot without killing (reload detaches), then drive raw sockets.
      await page.goto('about:blank');
      const t0 = Date.now();
      const a = await openWs(srv, { attach: (await srv.live())[0].termId, resume: sessionId });
      await waitFor(() => a.msgs.some(m => m.type === 'snapshot'), { interval: 10, msg: 'a attached' });
      // An idle attach cuts at once; only a stalled sequence waits (≤1s fallback)
      assert(Date.now() - t0 < 500, `idle attach took ${Date.now() - t0}ms`);
      // On `detached`, fire input and a 4001 kill from the replaced socket —
      // they reach the server after the takeover.
      a.on('message', d => {
        if (JSON.parse(d).type !== 'detached') return;
        a.input('echo SHOULD-NOT-RUN\r');
        a.close(4001);
      });
      const b = await openWs(srv, { resume: sessionId, steal: 1 });
      await a.closed;
      await sleep(500);
      b.input('echo b-$((1+1))\r');
      await waitFor(() => b.stream.includes('b-2'), { msg: 'b is live' });
      const lines = await render(b.stream);
      assert(!lines.some(l => l.includes('SHOULD-NOT-RUN')), 'input from the replaced socket must not run');
      const live = await srv.live();
      assert(live.length === 1 && live[0].pid === pid && live[0].attached, `not killed: ${JSON.stringify(live)}`);
      b.close();
      await b.closed;
    });

    await test('3. ✕ kills the process', async () => {
      await page.close();
      page = await loadPage(context, srv); // restores the tab (steal=0; nobody else holds it)
      await waitFor(async () => (await tabs(page)).find(t => t.holdsSlot), { msg: 'restored' });
      await page.locator('.tab .tab-close').first().click();
      await waitFor(() => !pidAlive(pid), { msg: `PID ${pid} gone` });
      await waitFor(async () => (await srv.live()).length === 0, { msg: '/api/live empty' });
    });

    // From here on, every test starts with no terminals running.
    beforeEach = () => srv.killAll();

    await test('7. Attach mid-sequence: the cut moves to a parser boundary, no fragments', async () => {
      const cases = [
        { cmd: `printf 'AAA\\033[38;5;2'; sleep 0.6; printf '40mBBB\\033[0m\\n'\r`, stalled: 'AAA\x1b[38;5;2',
          done: lines => lines.some(l => /^AAA.*BBB/.test(l)),
          clean: lines => lines.includes('AAABBB') && !lines.some(l => l.startsWith('AAA40m')) },
        { cmd: `printf 'X\\033]1337;File=inline=1:QUFBQQ'; sleep 0.6; printf 'QkJCQg==\\007Y\\n'\r`, stalled: 'X\x1b]1337;File=inline=1:QUFBQQ',
          done: lines => lines.some(l => /^X.*Y$/.test(l)),
          clean: lines => lines.includes('XY') && !lines.some(l => l.startsWith('XQkJC')) },
      ];
      for (const c of cases) {
        const a = await openWs(srv, {});
        await waitFor(() => a.stream.includes('$ '), { msg: 'prompt' });
        a.input(c.cmd);
        await waitFor(() => a.stream.endsWith(c.stalled), { msg: 'stream stalled mid-sequence' });
        // Take over while the parser is inside the sequence
        const b = await openWs(srv, { attach: a.msgs.find(m => m.type === 'ready').termId, steal: 1 });
        await waitFor(() => b.msgs.some(m => m.type === 'snapshot'), { msg: 'snapshot' });
        const lines = await waitFor(async () => { const l = await render(b.stream); return c.done(l) && l; }, { msg: 'command finished' });
        assert(c.clean(lines), `fragment or missing text:\n${lines.filter(Boolean).join('\n')}`);
        b.close(4001);
        await Promise.all([a.closed, b.closed]);
      }
      await srv.killAll();
    });

    await test('Saved cursor (ESC 7) survives a reattach', async () => {
      const a = await openWs(srv, {});
      await waitFor(() => a.stream.includes('$ '), { msg: 'prompt' });
      a.input(`printf '\\e[5;10H\\e7\\e[20;1H'; sleep 0.8; printf '\\e8X\\n'\r`);
      await waitFor(() => a.stream.endsWith('\x1b[20;1H'), { msg: 'cursor saved' });
      const b = await openWs(srv, { attach: a.msgs.find(m => m.type === 'ready').termId, steal: 1 });
      // Done when X lands: at the saved spot, or (bug) at the home position
      const lines = await waitFor(async () => {
        const l = await render(b.stream);
        return (l.some(x => /^ *X$/.test(x)) || l[0].startsWith('X')) && l;
      }, { msg: 'restored cursor used' });
      assert(lines[4] === ' '.repeat(9) + 'X', `X at row 5 col 10, got ${JSON.stringify(lines.slice(0, 6))}`);
      b.close(4001);
      await Promise.all([a.closed, b.closed]);
    });

    await test('Kill elsewhere: a busy tab retrying gets session-gone, not a --resume respawn', async () => {
      const a = await openWs(srv, {});
      const ready = await waitFor(() => a.msgs.find(m => m.type === 'ready' && m.sessionId), { msg: 'detected' });
      const b = await openWs(srv, { resume: ready.sessionId });
      const busy = await waitFor(() => b.msgs.find(m => m.type === 'busy'), { msg: 'busy' });
      assert(busy.termId === ready.termId, 'busy names the terminal');
      await b.closed;
      // A tab whose socket is down (another client id) may not kill it...
      let res = await fetch(`${srv.url}/api/live/${ready.termId}?client=${crypto.randomUUID()}`, { method: 'DELETE' });
      assert(res.status === 409, `ownership check: ${res.status}`);
      // ...the holder's ✕ can
      a.close(4001);
      await a.closed;
      await waitFor(async () => (await srv.live()).length === 0, { msg: 'killed' });
      const retry = await openWs(srv, { attach: busy.termId, resume: ready.sessionId });
      const err = await waitFor(() => retry.msgs.find(m => m.type === 'error'), { msg: 'reply' });
      assert(err.code === 'session-gone', `got ${JSON.stringify(retry.msgs)}`);
      await sleep(300);
      assert((await srv.live()).length === 0, 'no respawn');
      // Without the termId (a fresh open of the session) it resumes as before
      const fresh = await openWs(srv, { resume: ready.sessionId });
      await waitFor(() => fresh.msgs.some(m => m.type === 'ready'), { msg: 'resumed' });
      fresh.close(4001);
      await fresh.closed;
    });

    await test('8. Alt screen: less survives a reload, arrow keys still scroll it', async () => {
      page = await loadPage(context, srv);
      const id = await openTab(page, srv.proj);
      await typeIn(page, id, 'less lines.txt\r');
      const screen = id => page.evaluate(id => {
        const term = window.__herd.tabs.get(id).terminal;
        const b = term.buffer.active;
        return { type: b.type, top: b.getLine(b.viewportY).translateToString(true), deckm: term.modes.applicationCursorKeysMode };
      }, id);
      await waitFor(async () => (await screen(id)).top === 'line 1', { msg: 'less open' });
      await page.reload({ waitUntil: 'load' });
      await waitFor(async () => (await tabs(page)).find(t => t.holdsSlot), { msg: 'reattached' });
      const [t] = await tabs(page);
      const restored = await waitFor(async () => { const s = await screen(t.id); return s.type === 'alternate' && s; },
        { msg: 'alt screen restored' });
      assert(restored.type === 'alternate', `alt buffer restored: ${JSON.stringify(restored)}`);
      assert(restored.deckm, 'DECCKM (application cursor keys) restored');
      assert(restored.top === 'line 1', `screen restored: ${JSON.stringify(restored)}`);
      await page.evaluate(id => window.__herd.tabs.get(id).terminal.focus(), t.id);
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
      await waitFor(async () => (await page.evaluate(id => {
        const b = window.__herd.tabs.get(id).terminal.buffer.active;
        return b.getLine(b.viewportY).translateToString(true);
      }, t.id)) === 'line 4', { msg: 'pager scrolled by arrow keys' });
      await page.keyboard.press('q');
      await page.locator('.tab .tab-close').first().click();
      await waitFor(async () => (await srv.live()).length === 0, { msg: 'killed' });
    });

    await test('9. Finished while away: a background tab that grew comes back green; an idle one does not', async () => {
      page = await loadPage(context, srv);
      const grows = await openTab(page, srv.proj);
      const idle = await openTab(page, srv.proj);
      const active = await openTab(page, srv.proj);
      assert((await tabs(page)).find(t => t.id === active).active, 'third tab active');
      await typeIn(page, grows, 'sleep 1; seq 1 60\r');
      await page.close(); // detach everything
      await sleep(4000);  // the output lands while nobody watches, then it goes quiet
      page = await loadPage(context, srv);
      await waitFor(async () => (await tabs(page)).filter(t => t.holdsSlot).length === 3, { msg: 'all reattached' });
      await sleep(500);
      const ts = await tabs(page);
      const [g, i] = [ts[0], ts[1]];
      assert(g.finished, `grown background tab is green: ${JSON.stringify(g)}`);
      assert(!i.finished && !i.unread, `idle background tab is not: ${JSON.stringify(i)}`);
      const log = await page.evaluate(() => window.__herd.dumpLog());
      assert(/"event":"attached".*"grewWhileDetached":true/.test(log), 'dumpLog records the attach flags');
      await srv.killAll();
      await page.close();
    });

    await test('session-gone: a restored new session whose terminal died is marked dead and dropped', async () => {
      page = await loadPage(context, srv, { storage: {
        tabs: [{ termId: crypto.randomUUID(), sessionId: null, projectPath: srv.projUnnamed, name: 'gone', agent: 'claude' }],
      } });
      await waitFor(async () => (await page.evaluate(() => {
        const [t] = window.__herd.tabs.values();
        const b = t.terminal.buffer.active;
        let s = '';
        for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true);
        return s;
      })).includes('Session ended'), { msg: 'Session ended shown' });
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('herd-tabs')));
      assert(saved.tabs.length === 0, `dropped from saved state: ${JSON.stringify(saved)}`);
      assert((await srv.live()).length === 0, 'nothing spawned');
      await page.evaluate(() => localStorage.clear());
      await page.close();
    });

    await test('Sidebar: running mark, and an unnamed terminal attachable by termId', async () => {
      const named = await openWs(srv, {});
      await waitFor(() => named.msgs.some(m => m.type === 'ready' && m.sessionId), { msg: 'detected' });
      named.close();
      // List proj-unnamed in the sidebar via an old transcript; the stub never
      // writes one for terminals launched there, so theirs stay unnamed.
      const enc = srv.projUnnamed.replace(/[^a-zA-Z0-9]/g, '-');
      const dir = path.join(srv.root, 'home', '.claude', 'projects', enc);
      fs.mkdirSync(dir, { recursive: true });
      const oldId = crypto.randomUUID();
      fs.writeFileSync(path.join(dir, `${oldId}.jsonl`), JSON.stringify({
        type: 'user', sessionId: oldId, cwd: srv.projUnnamed, timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'an older session' },
      }) + '\n');
      const a = await openWs(srv, { project: srv.projUnnamed });
      await waitFor(() => a.stream.includes('$ '), { msg: 'prompt' });
      a.input('echo unnamed-$((2*21))\r');
      await waitFor(() => a.stream.includes('unnamed-42'), { msg: 'output' });
      a.close();
      await a.closed;

      page = await loadPage(context, srv, { storage: null });
      const live = await srv.live();
      const namedT = live.find(t => t.sessionId);
      await waitFor(async () => page.locator(`.recent-session-item.running[data-sid="${namedT.sessionId}"]`).count(),
        { msg: 'running mark on the named session' });
      await page.locator(`.project-item[data-path="${srv.projUnnamed}"] .project-header`).click();
      const row = page.locator('.session-item.live-unnamed');
      await waitFor(async () => row.count(), { msg: 'running (unnamed) row' });
      await row.first().click();
      await waitFor(async () => (await tabs(page)).find(t => t.holdsSlot), { msg: 'attached by termId' });
      const [t] = await tabs(page);
      assert(t.termId === live.find(l => !l.sessionId).termId, 'attached to the unnamed terminal');
      await waitFor(async () => (await bufText(page, t.id)).includes('unnamed-42'), { msg: 'its screen restored' });
      await srv.killAll();
      await page.evaluate(() => localStorage.clear());
      await page.close();
    });

    await context.close();
  } finally {
    await browser.close();
    await srv.stop();
  }

  // Reaper: its own server, with the TTLs in seconds.
  beforeEach = async () => {};
  const reap = await startServer({
    HERD_DETACHED_TTL_HOURS: String(2 / 3600),   // 2s
    HERD_DETACHED_IDLE_MINUTES: String(2 / 60),  // 2s
    HERD_DETACHED_MAX_HOURS: String(12 / 3600),  // 12s
  });
  try {
    await test('10. Reaper: an idle detached terminal goes; a growing one lasts until the hard cap', async () => {
      const idle = await openWs(reap, {});
      const busy = await openWs(reap, {});
      await waitFor(() => idle.stream.includes('$ ') && busy.stream.includes('$ '), { msg: 'prompts' });
      busy.input('while true; do echo tick; sleep 0.3; done\r');
      await sleep(500);
      const pids = Object.fromEntries((await reap.live()).map(t => [t.termId, t.pid]));
      const idleId = idle.msgs.find(m => m.type === 'ready').termId;
      const busyId = busy.msgs.find(m => m.type === 'ready').termId;
      idle.close();
      busy.close();
      await waitFor(() => !pidAlive(pids[idleId]), { timeout: 8000, msg: 'idle terminal reaped' });
      assert(pidAlive(pids[busyId]), 'growing terminal survives the TTL');
      await waitFor(() => !pidAlive(pids[busyId]), { timeout: 15000, msg: 'growing terminal reaped at the hard cap' });
    });
  } finally {
    await reap.stop();
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
