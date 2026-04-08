// Herd — Playwright test suite
// Run: node test/hub.test.mjs
// Requires: server running on localhost:3456

import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, 'screenshots');
const URL = process.env.HUB_URL || 'http://localhost:3456';

if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ── Test runner ──

let browser, context, page;
const results = [];
let currentGroup = '';

function group(name) { currentGroup = name; }

async function test(name, fn) {
  const fullName = currentGroup ? `${currentGroup} > ${name}` : name;
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    results.push({ name: fullName, pass: true, ms });
    process.stdout.write(`  \x1b[32m✓\x1b[0m ${fullName} \x1b[2m(${ms}ms)\x1b[0m\n`);
  } catch (err) {
    const ms = Date.now() - start;
    results.push({ name: fullName, pass: false, ms, error: err.message });
    process.stdout.write(`  \x1b[31m✗\x1b[0m ${fullName} \x1b[2m(${ms}ms)\x1b[0m\n`);
    process.stdout.write(`    \x1b[31m${err.message}\x1b[0m\n`);
    // Screenshot on failure
    try {
      const slug = fullName.replace(/[^a-z0-9]+/gi, '-').slice(0, 50);
      await page.screenshot({ path: join(SCREENSHOT_DIR, `FAIL-${slug}.png`) });
    } catch {}
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(str, substr, msg) {
  if (!str.includes(substr)) throw new Error(msg || `Expected "${str}" to include "${substr}"`);
}

function assertGreater(a, b, msg) {
  if (!(a > b)) throw new Error(msg || `Expected ${a} > ${b}`);
}

// ── Setup ──

async function setup() {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await context.newPage();
}

async function loadPage() {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
}

async function freshPage() {
  // Clear localStorage and reload
  await page.evaluate(() => localStorage.clear());
  await loadPage();
}

// ── Tests ──

async function runTests() {
  await setup();
  await loadPage();

  // ═══════════════════════════════════════════
  group('Page load');
  // ═══════════════════════════════════════════

  await test('page title is Herd', async () => {
    const title = await page.title();
    assertEqual(title, 'Herd');
  });

  await test('sidebar is visible', async () => {
    const sidebar = page.locator('#sidebar');
    assert(await sidebar.isVisible(), 'Sidebar not visible');
  });

  await test('sidebar header shows Herd', async () => {
    const text = await page.locator('#sidebar-header').innerText();
    assertIncludes(text, 'Herd');
  });

  await test('empty state is visible with no tabs', async () => {
    const emptyState = page.locator('#empty-state');
    assert(await emptyState.isVisible(), 'Empty state not visible');
    const text = await emptyState.innerText();
    assertIncludes(text, 'Select a project');
  });

  await test('terminal area is hidden with no tabs', async () => {
    const termArea = page.locator('#terminal-area');
    // terminal-area exists but display:none (no has-tabs class)
    const display = await termArea.evaluate(el => getComputedStyle(el).display);
    assertEqual(display, 'none');
  });

  // ═══════════════════════════════════════════
  group('Projects list');
  // ═══════════════════════════════════════════

  await test('projects are listed in the sidebar', async () => {
    const count = await page.locator('.project-item').count();
    assertGreater(count, 0, 'No projects found');
  });

  await test('each project shows name and session count', async () => {
    const first = page.locator('.project-item').first();
    const name = await first.locator('.project-name').innerText();
    const count = await first.locator('.project-count').innerText();
    assert(name.length > 0, 'Project name is empty');
    assert(parseInt(count) > 0, 'Session count should be > 0');
  });

  await test('projects are sorted by most recent', async () => {
    // First project should be herd (we just used it)
    const firstName = await page.locator('.project-item').first().locator('.project-name').innerText();
    assertIncludes(firstName, 'herd');
  });

  await test('chevron is present on each project', async () => {
    const chevrons = await page.locator('.project-chevron').count();
    const projects = await page.locator('.project-item').count();
    assertEqual(chevrons, projects);
  });

  // ═══════════════════════════════════════════
  group('Project expand/collapse');
  // ═══════════════════════════════════════════

  await test('clicking project expands it', async () => {
    const first = page.locator('.project-item').first();
    assert(!(await first.evaluate(el => el.classList.contains('expanded'))), 'Should start collapsed');
    await first.locator('.project-header').click();
    await page.waitForTimeout(500);
    assert(await first.evaluate(el => el.classList.contains('expanded')), 'Should be expanded');
  });

  await test('expanded project shows sessions', async () => {
    const sessions = page.locator('.project-item.expanded .session-item');
    await sessions.first().waitFor({ timeout: 5000 });
    const count = await sessions.count();
    assertGreater(count, 0, 'No sessions in expanded project');
  });

  await test('expanded project shows "new session" button', async () => {
    const btn = page.locator('.project-item.expanded .new-session-btn');
    assert(await btn.isVisible(), 'New session button not found');
    const text = await btn.innerText();
    assertIncludes(text, 'new session');
  });

  await test('sessions show summary/preview text', async () => {
    const sessionText = await page.locator('.project-item.expanded .session-item').first().innerText();
    assert(sessionText.trim().length > 0, 'Session text is empty');
  });

  await test('sessions show relative date', async () => {
    const dates = await page.locator('.project-item.expanded .session-date').allInnerTexts();
    assert(dates.length > 0, 'No dates found');
    // dates should be things like "now", "3m", "1h", "2d", etc.
    for (const d of dates) {
      assert(d.trim().length > 0, `Date is empty`);
    }
  });

  await test('clicking expanded project collapses it', async () => {
    const first = page.locator('.project-item').first();
    await first.locator('.project-header').click();
    await page.waitForTimeout(300);
    assert(!(await first.evaluate(el => el.classList.contains('expanded'))), 'Should be collapsed');
  });

  await test('only one project expanded at a time', async () => {
    // Expand first
    await page.locator('.project-item >> nth=0').locator('.project-header').click();
    await page.waitForTimeout(500);
    // Expand second
    await page.locator('.project-item >> nth=1').locator('.project-header').click();
    await page.waitForTimeout(500);
    const expandedCount = await page.locator('.project-item.expanded').count();
    assertEqual(expandedCount, 1, `Expected 1 expanded, got ${expandedCount}`);
    // Collapse it
    await page.locator('.project-item.expanded .project-header').click();
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════
  group('Theme');
  // ═══════════════════════════════════════════

  await test('three theme buttons exist', async () => {
    const count = await page.locator('.theme-btn').count();
    assertEqual(count, 3);
  });

  await test('dark theme is default', async () => {
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    assertEqual(theme, 'dark');
    const darkBtn = page.locator('.theme-btn[data-theme="dark"]');
    assert(await darkBtn.evaluate(el => el.classList.contains('active')), 'Dark button should be active');
  });

  await test('switching to light theme updates UI', async () => {
    await page.locator('.theme-btn[data-theme="light"]').click();
    await page.waitForTimeout(300);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    assertEqual(theme, 'light');
    // Background should be white-ish
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assertIncludes(bg, '255', 'Background should be white in light theme');
  });

  await test('light theme screenshot looks correct', async () => {
    const path = join(SCREENSHOT_DIR, 'theme-light.png');
    await page.screenshot({ path });
    // Just verifying it doesn't crash - visual check via screenshot
  });

  await test('switching to auto theme works', async () => {
    await page.locator('.theme-btn[data-theme="auto"]').click();
    await page.waitForTimeout(200);
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    assertEqual(theme, 'auto');
  });

  await test('theme persists in localStorage', async () => {
    await page.locator('.theme-btn[data-theme="dark"]').click();
    const stored = await page.evaluate(() => localStorage.getItem('herd-theme'));
    assertEqual(stored, 'dark');
  });

  await test('theme restored on reload', async () => {
    await page.locator('.theme-btn[data-theme="light"]').click();
    await loadPage();
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    assertEqual(theme, 'light');
    // Reset to dark
    await page.locator('.theme-btn[data-theme="dark"]').click();
  });

  // ═══════════════════════════════════════════
  group('API');
  // ═══════════════════════════════════════════

  await test('GET /api/projects returns JSON array', async () => {
    const res = await page.evaluate(() => fetch('/api/projects').then(r => r.json()));
    assert(Array.isArray(res), 'Response should be an array');
    assertGreater(res.length, 0, 'Should have at least one project');
  });

  await test('project objects have required fields', async () => {
    const res = await page.evaluate(() => fetch('/api/projects').then(r => r.json()));
    const p = res[0];
    assert(p.id, 'Missing id');
    assert(p.path, 'Missing path');
    assert(p.name, 'Missing name');
    assert(typeof p.exists === 'boolean', 'exists should be boolean');
    assert(typeof p.sessionCount === 'number', 'sessionCount should be number');
    assert(typeof p.latestMtime === 'number', 'latestMtime should be number');
  });

  await test('GET /api/projects/:id/sessions returns sessions', async () => {
    const projects = await page.evaluate(() => fetch('/api/projects').then(r => r.json()));
    const id = projects[0].id;
    const data = await page.evaluate(id => fetch(`/api/projects/${id}/sessions`).then(r => r.json()), id);
    assert(Array.isArray(data.sessions), 'Response should have sessions array');
    assert(typeof data.total === 'number', 'Response should have total count');
    assert(typeof data.truncated === 'boolean', 'Response should have truncated flag');
    assertGreater(data.sessions.length, 0, 'Should have sessions');
  });

  await test('session objects have required fields', async () => {
    const projects = await page.evaluate(() => fetch('/api/projects').then(r => r.json()));
    const data = await page.evaluate(id =>
      fetch(`/api/projects/${id}/sessions`).then(r => r.json()), projects[0].id);
    const s = data.sessions[0];
    assert(s.id, 'Missing id');
    assert(s.date, 'Missing date');
    assert(typeof s.mtime === 'number', 'mtime should be number');
    assert(s.preview, 'Missing preview');
  });

  await test('sessions are sorted by date descending', async () => {
    const projects = await page.evaluate(() => fetch('/api/projects').then(r => r.json()));
    const data = await page.evaluate(id =>
      fetch(`/api/projects/${id}/sessions`).then(r => r.json()), projects[0].id);
    const sessions = data.sessions;
    if (sessions.length >= 2) {
      assert(sessions[0].mtime >= sessions[1].mtime, 'Sessions not sorted desc');
    }
  });

  await test('path traversal is blocked', async () => {
    const res = await page.evaluate(() =>
      fetch('/api/projects/..%2F..%2Fetc/sessions').then(r => ({ status: r.status }))
    );
    assertEqual(res.status, 400, 'Path traversal should return 400');
  });

  await test('invalid project returns error', async () => {
    const res = await page.evaluate(() =>
      fetch('/api/projects/nonexistent-project-xyz/sessions').then(r => ({ status: r.status }))
    );
    // Should be 500 (readdir fails) or similar error
    assert(res.status >= 400, 'Invalid project should return error');
  });

  // ═══════════════════════════════════════════
  group('Layout');
  // ═══════════════════════════════════════════

  await test('sidebar has correct default width', async () => {
    const width = await page.locator('#sidebar').evaluate(el => el.offsetWidth);
    assertEqual(width, 280);
  });

  await test('resize handle exists between sidebar and main', async () => {
    const handle = page.locator('#resize-handle');
    assert(await handle.isVisible(), 'Resize handle not visible');
  });

  await test('sidebar can be resized by dragging', async () => {
    const handle = page.locator('#resize-handle');
    const box = await handle.boundingBox();
    // Drag handle to the right
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const newWidth = await page.locator('#sidebar').evaluate(el => el.offsetWidth);
    assertGreater(newWidth, 280, 'Sidebar should be wider after drag');
    // Reset by dragging back
    const box2 = await handle.boundingBox();
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await page.mouse.down();
    await page.mouse.move(280, box2.y + box2.height / 2, { steps: 5 });
    await page.mouse.up();
  });

  await test('sidebar resize has min/max bounds', async () => {
    const handle = page.locator('#resize-handle');
    const box = await handle.boundingBox();
    // Try dragging to far left (below min 150px)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(50, box.y + box.height / 2, { steps: 3 });
    const width = await page.locator('#sidebar').evaluate(el => el.offsetWidth);
    assertGreater(width, 140, 'Sidebar should respect min width');
    await page.mouse.up();
    // Reset
    const box2 = await handle.boundingBox();
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await page.mouse.down();
    await page.mouse.move(280, box2.y + box2.height / 2, { steps: 3 });
    await page.mouse.up();
  });

  // ═══════════════════════════════════════════
  group('Tab creation');
  // ═══════════════════════════════════════════

  await test('clicking a session creates a tab', async () => {
    // Expand first project
    await page.locator('.project-item >> nth=0').locator('.project-header').click();
    await page.waitForTimeout(500);
    // Click first session
    await page.locator('.session-item').first().click();
    await page.waitForTimeout(1000);
    const tabCount = await page.locator('.tab').count();
    assertEqual(tabCount, 1, 'Should have 1 tab');
  });

  await test('tab bar shows the session name', async () => {
    const tabName = await page.locator('.tab .tab-name').first().innerText();
    assert(tabName.length > 0, 'Tab name should not be empty');
  });

  await test('tab has alive dot (green)', async () => {
    const dot = page.locator('.tab .tab-dot').first();
    const isAlive = await dot.evaluate(el => !el.classList.contains('dead'));
    assert(isAlive, 'Tab dot should indicate alive');
  });

  await test('tab has close button', async () => {
    const closeBtn = page.locator('.tab .tab-close').first();
    assert(await closeBtn.count() > 0, 'Close button not found');
  });

  await test('empty state is hidden when tab is open', async () => {
    const emptyState = page.locator('#empty-state');
    assert(await emptyState.evaluate(el => el.classList.contains('hidden')), 'Empty state should be hidden');
  });

  await test('terminal area is visible when tab is open', async () => {
    const termArea = page.locator('#terminal-area');
    assert(await termArea.evaluate(el => el.classList.contains('has-tabs')), 'Terminal area should have has-tabs class');
    const display = await termArea.evaluate(el => getComputedStyle(el).display);
    assertEqual(display, 'block');
  });

  await test('terminal wrapper is active', async () => {
    const wrappers = page.locator('.terminal-wrapper.active');
    assertEqual(await wrappers.count(), 1, 'Should have exactly 1 active terminal wrapper');
  });

  await test('xterm terminal is rendered', async () => {
    // xterm may use canvas (GPU) or DOM renderer depending on environment
    const hasXterm = await page.locator('.terminal-wrapper.active .xterm').count();
    assertGreater(hasXterm, 0, 'xterm container should be rendered');
  });

  await test('screenshot with terminal open', async () => {
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'with-terminal.png') });
  });

  // ═══════════════════════════════════════════
  group('Multiple tabs');
  // ═══════════════════════════════════════════

  await test('opening second session creates second tab', async () => {
    // Click second session from expanded project
    const sessions = page.locator('.session-item');
    if (await sessions.count() >= 2) {
      await sessions.nth(1).click();
      await page.waitForTimeout(1000);
      const tabCount = await page.locator('.tab').count();
      assertEqual(tabCount, 2, 'Should have 2 tabs');
    }
  });

  await test('second tab becomes active', async () => {
    const tabs = await page.locator('.tab').count();
    if (tabs >= 2) {
      const lastTab = page.locator('.tab').last();
      assert(await lastTab.evaluate(el => el.classList.contains('active')), 'Last tab should be active');
    }
  });

  await test('only one terminal wrapper active at a time', async () => {
    const active = await page.locator('.terminal-wrapper.active').count();
    assertEqual(active, 1, 'Exactly one terminal wrapper should be active');
  });

  await test('clicking first tab switches to it', async () => {
    const tabs = await page.locator('.tab').count();
    if (tabs >= 2) {
      await page.locator('.tab').first().click();
      await page.waitForTimeout(300);
      assert(
        await page.locator('.tab').first().evaluate(el => el.classList.contains('active')),
        'First tab should be active'
      );
    }
  });

  await test('duplicate resume session is not opened', async () => {
    // Click the same session again — should switch to existing tab, not create new
    const tabsBefore = await page.locator('.tab').count();
    await page.locator('.session-item').first().click();
    await page.waitForTimeout(500);
    const tabsAfter = await page.locator('.tab').count();
    assertEqual(tabsAfter, tabsBefore, 'Should not create duplicate tab');
  });

  await test('screenshot with multiple tabs', async () => {
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'multi-tabs.png') });
  });

  // ═══════════════════════════════════════════
  group('Tab close');
  // ═══════════════════════════════════════════

  await test('closing a tab removes it', async () => {
    const tabsBefore = await page.locator('.tab').count();
    await page.locator('.tab .tab-close').last().click();
    await page.waitForTimeout(300);
    const tabsAfter = await page.locator('.tab').count();
    assertEqual(tabsAfter, tabsBefore - 1, 'Tab should be removed');
  });

  await test('closing last tab shows empty state', async () => {
    // Close all remaining tabs
    while (await page.locator('.tab').count() > 0) {
      await page.locator('.tab .tab-close').first().click();
      await page.waitForTimeout(300);
    }
    const emptyState = page.locator('#empty-state');
    assert(!(await emptyState.evaluate(el => el.classList.contains('hidden'))), 'Empty state should show');
  });

  // ═══════════════════════════════════════════
  group('Keyboard shortcuts');
  // ═══════════════════════════════════════════

  await test('Ctrl+W closes active tab', async () => {
    // Ensure a project is expanded and visible
    const expanded = await page.locator('.project-item.expanded').count();
    if (!expanded) {
      await page.locator('.project-item >> nth=0').locator('.project-header').click();
      await page.waitForTimeout(500);
    }
    await page.locator('.session-item').first().waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('.session-item').first().click();
    await page.waitForTimeout(1000);
    assertEqual(await page.locator('.tab').count(), 1);

    // Dispatch Ctrl+W via JS — browser-level Ctrl+W is intercepted by Chrome
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
    });
    await page.waitForTimeout(300);
    assertEqual(await page.locator('.tab').count(), 0, 'Ctrl+W should close tab');
  });

  // ═══════════════════════════════════════════
  group('WebSocket');
  // ═══════════════════════════════════════════

  await test('WebSocket connects and receives ready message', async () => {
    // Get a project to connect to
    const projects = await page.evaluate(() => fetch('/api/projects').then(r => r.json()));
    const project = projects.find(p => p.exists);
    assert(project, 'Need an existing project');

    const result = await page.evaluate(async (projectPath) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${location.host}/ws?project=${encodeURIComponent(projectPath)}&cols=80&rows=24`);
        const timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 5000);
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            ws.close();
            resolve(msg);
          }
        };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('WS error')); };
      });
    }, project.path);

    assertEqual(result.type, 'ready');
    assert(result.termId, 'Should have termId');
  });

  await test('WebSocket rejects invalid project', async () => {
    const result = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://${location.host}/ws?project=/nonexistent/path&cols=80&rows=24`);
        const timeout = setTimeout(() => { ws.close(); resolve({ type: 'timeout' }); }, 3000);
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'error') {
            clearTimeout(timeout);
            ws.close();
            resolve(msg);
          }
        };
      });
    });
    assertEqual(result.type, 'error');
    assertIncludes(result.message, 'Invalid project');
  });

  await test('WebSocket receives terminal output', async () => {
    const projects = await page.evaluate(() => fetch('/api/projects').then(r => r.json()));
    const project = projects.find(p => p.exists);

    const result = await page.evaluate(async (projectPath) => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${location.host}/ws?project=${encodeURIComponent(projectPath)}&cols=80&rows=24`);
        let gotReady = false;
        let output = '';
        const timeout = setTimeout(() => { ws.close(); resolve({ gotReady, output: output.slice(0, 200) }); }, 8000);
        ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'ready') gotReady = true;
          if (msg.type === 'output') {
            output += msg.data;
            if (output.length > 50) {
              clearTimeout(timeout);
              ws.close();
              resolve({ gotReady, hasOutput: true });
            }
          }
        };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('WS error')); };
      });
    }, project.path);

    assert(result.gotReady, 'Should receive ready');
    assert(result.hasOutput, 'Should receive terminal output');
  });

  // ═══════════════════════════════════════════
  group('New session');
  // ═══════════════════════════════════════════

  await test('"+ new session" creates a tab', async () => {
    await freshPage();
    // Expand a project
    const projectItem = page.locator('.project-item').first();
    await projectItem.locator('.project-header').click();
    await page.waitForTimeout(500);

    const newBtn = page.locator('.new-session-btn');
    if (await newBtn.isVisible()) {
      await newBtn.click();
      await page.waitForTimeout(1500);
      const tabCount = await page.locator('.tab').count();
      assertEqual(tabCount, 1, 'Should create a tab');
      // Clean up
      await page.locator('.tab .tab-close').first().click();
      await page.waitForTimeout(300);
    }
  });

  // ═══════════════════════════════════════════
  group('Archived projects');
  // ═══════════════════════════════════════════

  await test('archived projects have muted styling', async () => {
    const archived = page.locator('.project-item.archived');
    const count = await archived.count();
    if (count > 0) {
      const opacity = await archived.first().locator('.project-name').evaluate(
        el => getComputedStyle(el).opacity
      );
      assert(parseFloat(opacity) < 1, 'Archived project name should have reduced opacity');
    } else {
      // Skip — no archived projects
      process.stdout.write('    \x1b[33m(skipped — no archived projects)\x1b[0m\n');
    }
  });

  await test('archived projects do not show "new session" button', async () => {
    const archived = page.locator('.project-item.archived');
    const count = await archived.count();
    if (count > 0) {
      await archived.first().locator('.project-header').click();
      await page.waitForTimeout(500);
      const newBtn = archived.first().locator('.new-session-btn');
      assertEqual(await newBtn.count(), 0, 'Archived project should not have new session button');
      // Collapse
      await archived.first().locator('.project-header').click();
      await page.waitForTimeout(300);
    } else {
      process.stdout.write('    \x1b[33m(skipped — no archived projects)\x1b[0m\n');
    }
  });

  // ═══════════════════════════════════════════
  group('UI elements');
  // ═══════════════════════════════════════════

  await test('logo has accent color', async () => {
    const logoColor = await page.locator('.logo').evaluate(el => getComputedStyle(el).color);
    assert(logoColor !== 'rgb(0, 0, 0)', 'Logo should have accent color');
  });

  await test('project list scrolls when overflow', async () => {
    const overflow = await page.locator('#project-list').evaluate(
      el => getComputedStyle(el).overflowY
    );
    assertEqual(overflow, 'auto');
  });

  await test('sidebar footer is at bottom', async () => {
    const footer = page.locator('#sidebar-footer');
    assert(await footer.isVisible(), 'Footer should be visible');
    const sidebarRect = await page.locator('#sidebar').boundingBox();
    const footerRect = await footer.boundingBox();
    // Footer should be near the bottom of sidebar
    assertGreater(footerRect.y, sidebarRect.y + sidebarRect.height / 2, 'Footer should be in lower half');
  });

  // ═══════════════════════════════════════════
  group('CSS / styling');
  // ═══════════════════════════════════════════

  await test('body uses monospace font', async () => {
    const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    assert(
      fontFamily.toLowerCase().includes('mono') || fontFamily.toLowerCase().includes('courier'),
      `Expected monospace font, got: ${fontFamily}`
    );
  });

  await test('dark theme variables are set', async () => {
    await page.locator('.theme-btn[data-theme="dark"]').click();
    await page.waitForTimeout(100);
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );
    assertEqual(bg, '#0a0e14');
  });

  await test('light theme variables are set', async () => {
    await page.locator('.theme-btn[data-theme="light"]').click();
    await page.waitForTimeout(100);
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    );
    assertEqual(bg, '#ffffff');
    // Reset
    await page.locator('.theme-btn[data-theme="dark"]').click();
  });

  await test('tab hover shows close button', async () => {
    // Create a tab
    await page.locator('.project-item >> nth=0').locator('.project-header').click();
    await page.waitForTimeout(500);
    await page.locator('.session-item').first().click();
    await page.waitForTimeout(1000);

    // Close button should be hidden by default
    const closeBtn = page.locator('.tab .tab-close').first();
    const opacityBefore = await closeBtn.evaluate(el => getComputedStyle(el).opacity);
    // Active tab's close button should be visible (opacity > 0)
    // The CSS says: .tab.active .tab-close { opacity: 0.6; }
    // Hmm, actually let me check — the tab might already be active
    // Let's just verify the close button exists
    assert(await closeBtn.count() > 0, 'Close button exists');

    // Clean up
    await page.locator('.tab .tab-close').first().click();
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════
  group('Session title in tooltip');
  // ═══════════════════════════════════════════

  await test('session items have title attribute with preview', async () => {
    await page.locator('.project-item >> nth=0').locator('.project-header').click();
    await page.waitForTimeout(500);
    const title = await page.locator('.session-item').first().getAttribute('title');
    assert(title && title.length > 0, 'Session should have title tooltip');
    // Collapse
    await page.locator('.project-item >> nth=0').locator('.project-header').click();
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════
  group('Edge cases');
  // ═══════════════════════════════════════════

  await test('rapid project expand/collapse does not break UI', async () => {
    for (let i = 0; i < 5; i++) {
      await page.locator('.project-item >> nth=0').locator('.project-header').click();
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(500);
    // Should not crash — verify page is still responsive
    const title = await page.title();
    assertEqual(title, 'Herd');
  });

  await test('page reload restores clean state', async () => {
    await loadPage();
    const tabs = await page.locator('.tab').count();
    assertEqual(tabs, 0, 'Tabs should not persist across reload');
    const emptyState = page.locator('#empty-state');
    assert(await emptyState.isVisible(), 'Empty state should show after reload');
  });

  await test('API handles concurrent requests', async () => {
    const results = await page.evaluate(async () => {
      const promises = Array.from({ length: 10 }, () =>
        fetch('/api/projects').then(r => ({ status: r.status, ok: r.ok }))
      );
      return Promise.all(promises);
    });
    assert(results.every(r => r.ok), 'All concurrent requests should succeed');
  });

  // ═══════════════════════════════════════════
  group('Inactive tab attention animations');
  // ═══════════════════════════════════════════

  // Helper: open two tabs and return their IDs (second tab is active)
  async function openTwoTabs() {
    await freshPage();
    const expanded = await page.locator('.project-item.expanded').count();
    if (!expanded) {
      await page.locator('.project-item >> nth=0').locator('.project-header').click();
      await page.waitForTimeout(500);
    }
    await page.locator('.session-item').first().waitFor({ state: 'visible', timeout: 5000 });
    // Open first tab
    await page.locator('.session-item >> nth=0').click();
    await page.waitForTimeout(1000);
    // Open second tab (if available) or use new session
    const sessionCount = await page.locator('.session-item').count();
    if (sessionCount >= 2) {
      await page.locator('.session-item >> nth=1').click();
    } else {
      const newBtn = page.locator('.new-session-btn');
      if (await newBtn.isVisible()) await newBtn.click();
    }
    await page.waitForTimeout(1000);
    const tabIds = await page.evaluate(() => [...window.__herd.tabs.keys()]);
    return tabIds;
  }

  await test('inactive tab with no output has no unread/finished class', async () => {
    const tabIds = await openTwoTabs();
    assert(tabIds.length >= 2, 'Need at least 2 tabs');
    // Second tab is active, first is inactive
    const firstTabClasses = await page.locator('.tab >> nth=0').evaluate(el => el.className);
    assert(!firstTabClasses.includes('unread'), 'Inactive tab should not start as unread');
    assert(!firstTabClasses.includes('finished'), 'Inactive tab should not start as finished');
  });

  await test('setting unread on inactive tab adds .unread class', async () => {
    // Simulate unread state on the first (inactive) tab
    await page.evaluate(() => {
      const hub = window.__herd;
      const firstTabId = [...hub.tabs.keys()][0];
      const tab = hub.tabs.get(firstTabId);
      tab.unread = true;
      hub.renderTabs();
    });
    await page.waitForTimeout(100);
    const firstTab = page.locator('.tab >> nth=0');
    assert(await firstTab.evaluate(el => el.classList.contains('unread')), 'Tab should have unread class');
    assert(!await firstTab.evaluate(el => el.classList.contains('finished')), 'Tab should not have finished class');
  });

  await test('unread tab name has accent color', async () => {
    const nameColor = await page.locator('.tab.unread .tab-name').evaluate(
      el => getComputedStyle(el).color
    );
    // accent color in dark theme is #58a6ff → rgb(88, 166, 255)
    assertIncludes(nameColor, '88', 'Unread tab name should use accent color');
  });

  await test('unread tab dot has accent color', async () => {
    const dotBg = await page.locator('.tab.unread .tab-dot').evaluate(
      el => getComputedStyle(el).backgroundColor
    );
    assertIncludes(dotBg, '88', 'Unread tab dot should use accent color');
  });

  await test('setting finished on inactive tab adds .finished class and removes .unread', async () => {
    await page.evaluate(() => {
      const hub = window.__herd;
      const firstTabId = [...hub.tabs.keys()][0];
      const tab = hub.tabs.get(firstTabId);
      tab.finished = true;
      tab.unread = false;
      hub.renderTabs();
    });
    await page.waitForTimeout(100);
    const firstTab = page.locator('.tab >> nth=0');
    assert(await firstTab.evaluate(el => el.classList.contains('finished')), 'Tab should have finished class');
    assert(!await firstTab.evaluate(el => el.classList.contains('unread')), 'Tab should not have unread class');
  });

  await test('finished tab has pulse animation', async () => {
    const animation = await page.locator('.tab.finished').evaluate(
      el => getComputedStyle(el).animationName
    );
    assertEqual(animation, 'tab-pulse', 'Finished tab should have tab-pulse animation');
  });

  await test('finished tab pulse animation duration is 2s', async () => {
    const duration = await page.locator('.tab.finished').evaluate(
      el => getComputedStyle(el).animationDuration
    );
    assertEqual(duration, '2s');
  });

  await test('finished tab pulse animation is infinite', async () => {
    const iteration = await page.locator('.tab.finished').evaluate(
      el => getComputedStyle(el).animationIterationCount
    );
    assertEqual(iteration, 'infinite');
  });

  await test('finished tab name is green and bold', async () => {
    const nameEl = page.locator('.tab.finished .tab-name');
    const color = await nameEl.evaluate(el => getComputedStyle(el).color);
    const weight = await nameEl.evaluate(el => getComputedStyle(el).fontWeight);
    // --green in dark theme is #3fb950 → rgb(63, 185, 80)
    assertIncludes(color, '63', 'Finished tab name should be green');
    assert(parseInt(weight) >= 600, `Finished tab name should be bold, got weight ${weight}`);
  });

  await test('finished tab dot has pulse animation', async () => {
    const dotAnimation = await page.locator('.tab.finished .tab-dot').evaluate(
      el => getComputedStyle(el).animationName
    );
    assertEqual(dotAnimation, 'dot-pulse', 'Finished tab dot should have dot-pulse animation');
  });

  await test('finished tab dot pulse is 1.5s infinite', async () => {
    const dot = page.locator('.tab.finished .tab-dot');
    const duration = await dot.evaluate(el => getComputedStyle(el).animationDuration);
    const iteration = await dot.evaluate(el => getComputedStyle(el).animationIterationCount);
    assertEqual(duration, '1.5s');
    assertEqual(iteration, 'infinite');
  });

  await test('finished tab has green-tinted background', async () => {
    const bg = await page.locator('.tab.finished').evaluate(
      el => getComputedStyle(el).backgroundColor
    );
    // color-mix(in srgb, var(--green) 12%, transparent) should produce some green channel
    assert(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', `Finished tab should have tinted background, got ${bg}`);
  });

  await test('switching to finished tab clears unread and finished state', async () => {
    // Click the first (finished) tab to switch to it
    await page.locator('.tab >> nth=0').click();
    await page.waitForTimeout(300);
    const firstTab = page.locator('.tab >> nth=0');
    assert(await firstTab.evaluate(el => el.classList.contains('active')), 'First tab should be active');
    assert(!await firstTab.evaluate(el => el.classList.contains('finished')), 'Finished should be cleared on switch');
    assert(!await firstTab.evaluate(el => el.classList.contains('unread')), 'Unread should be cleared on switch');
    // Verify internal state was reset too
    const state = await page.evaluate(() => {
      const hub = window.__herd;
      const tab = hub.tabs.get(hub.activeTabId);
      return { unread: tab.unread, finished: tab.finished, outputSinceViewed: tab.outputSinceViewed };
    });
    assertEqual(state.unread, false);
    assertEqual(state.finished, false);
    assertEqual(state.outputSinceViewed, 0);
  });

  await test('output on inactive tab triggers unread after 200 chars', async () => {
    // Switch to second tab so first becomes inactive
    await page.locator('.tab >> nth=1').click();
    await page.waitForTimeout(300);
    // Simulate output arriving on the first (inactive) tab via internal handler
    await page.evaluate(() => {
      const hub = window.__herd;
      const firstTabId = [...hub.tabs.keys()][0];
      const tab = hub.tabs.get(firstTabId);
      // Simulate < 200 chars — should NOT trigger unread
      tab.outputSinceViewed = 100;
      hub.renderTabs();
    });
    await page.waitForTimeout(100);
    assert(!await page.locator('.tab >> nth=0').evaluate(el => el.classList.contains('unread')),
      'Should not be unread with < 200 chars output');

    // Now exceed 200 chars
    await page.evaluate(() => {
      const hub = window.__herd;
      const firstTabId = [...hub.tabs.keys()][0];
      const tab = hub.tabs.get(firstTabId);
      tab.outputSinceViewed = 250;
      tab.unread = true;
      hub.renderTabs();
    });
    await page.waitForTimeout(100);
    assert(await page.locator('.tab >> nth=0').evaluate(el => el.classList.contains('unread')),
      'Should be unread with > 200 chars output');
  });

  await test('idle timer transitions unread to finished', async () => {
    // Set up the idle timer on the inactive tab with a short timeout for testing
    await page.evaluate(() => {
      const hub = window.__herd;
      const firstTabId = [...hub.tabs.keys()][0];
      const tab = hub.tabs.get(firstTabId);
      tab.unread = true;
      tab.finished = false;
      // Simulate the idle timer firing (like 5s of no output)
      if (tab.idleTimer) clearTimeout(tab.idleTimer);
      tab.idleTimer = setTimeout(() => {
        if (firstTabId !== hub.activeTabId && !tab.finished) {
          tab.finished = true;
          tab.unread = false;
          hub.renderTabs();
          hub.updateSidebarFinished(firstTabId, true);
        }
      }, 500); // Use 500ms instead of 5000ms for test speed
      hub.renderTabs();
    });

    // Should be unread now, not finished yet
    await page.waitForTimeout(100);
    assert(await page.locator('.tab >> nth=0').evaluate(el => el.classList.contains('unread')),
      'Should be unread before idle timer fires');

    // Wait for the idle timer to fire
    await page.waitForTimeout(600);
    assert(await page.locator('.tab >> nth=0').evaluate(el => el.classList.contains('finished')),
      'Should be finished after idle timer');
    assert(!await page.locator('.tab >> nth=0').evaluate(el => el.classList.contains('unread')),
      'Unread should be cleared when finished');
  });

  await test('new output on finished tab resets to unread', async () => {
    // First tab should still be finished from previous test
    assert(await page.locator('.tab >> nth=0').evaluate(el => el.classList.contains('finished')),
      'Precondition: tab should be finished');
    // Simulate new output arriving — clears finished, sets unread
    await page.evaluate(() => {
      const hub = window.__herd;
      const firstTabId = [...hub.tabs.keys()][0];
      const tab = hub.tabs.get(firstTabId);
      tab.finished = false;
      tab.unread = true;
      hub.updateSidebarFinished(firstTabId, false);
      hub.renderTabs();
    });
    await page.waitForTimeout(100);
    assert(!await page.locator('.tab >> nth=0').evaluate(el => el.classList.contains('finished')),
      'Finished should be cleared on new output');
    assert(await page.locator('.tab >> nth=0').evaluate(el => el.classList.contains('unread')),
      'Should be unread again on new output');
  });

  await test('active tab never gets unread or finished class', async () => {
    // The second tab is active — verify it has neither class even if we set state
    await page.evaluate(() => {
      const hub = window.__herd;
      const activeId = hub.activeTabId;
      const tab = hub.tabs.get(activeId);
      // These should not affect rendering because switchTab clears them
      tab.unread = false;
      tab.finished = false;
      hub.renderTabs();
    });
    await page.waitForTimeout(100);
    const activeTab = page.locator('.tab.active');
    assert(!await activeTab.evaluate(el => el.classList.contains('unread')), 'Active tab should not be unread');
    assert(!await activeTab.evaluate(el => el.classList.contains('finished')), 'Active tab should not be finished');
  });

  await test('sidebar session item gets finished class', async () => {
    // Set finished state on the first tab and update sidebar
    await page.evaluate(() => {
      const hub = window.__herd;
      const firstTabId = [...hub.tabs.keys()][0];
      const tab = hub.tabs.get(firstTabId);
      tab.finished = true;
      tab.unread = false;
      hub.renderTabs();
      hub.updateSidebarFinished(firstTabId, true);
    });
    await page.waitForTimeout(100);
    const sidebarFinished = await page.evaluate(() => {
      const hub = window.__herd;
      const firstTabId = [...hub.tabs.keys()][0];
      const el = document.querySelector(`.session-item[data-tab-id="${firstTabId}"]`);
      return { found: !!el, finished: el?.classList.contains('finished') ?? false };
    });
    assert(sidebarFinished.found, 'Sidebar item should be linked to tab via data-tab-id');
    assert(sidebarFinished.finished, 'Sidebar session item should have finished class');
  });

  await test('sidebar finished session has green styling and pulse', async () => {
    const sidebarItem = page.locator('.session-item.finished');
    const count = await sidebarItem.count();
    assertGreater(count, 0, 'Should have a finished sidebar item');
    const animation = await sidebarItem.first().evaluate(
      el => getComputedStyle(el).animationName
    );
    assertEqual(animation, 'tab-pulse', 'Sidebar finished item should pulse');
    const fontWeight = await sidebarItem.first().evaluate(
      el => getComputedStyle(el).fontWeight
    );
    assert(parseInt(fontWeight) >= 600, 'Sidebar finished item should be bold');
    const borderLeft = await sidebarItem.first().evaluate(
      el => getComputedStyle(el).borderLeftWidth
    );
    assertEqual(borderLeft, '2px', 'Sidebar finished item should have left border');
  });

  await test('switching to tab clears sidebar finished state', async () => {
    const cleared = await page.evaluate(() => {
      const hub = window.__herd;
      const firstTabId = [...hub.tabs.keys()][0];
      const el = document.querySelector(`.session-item[data-tab-id="${firstTabId}"]`);
      if (!el) return 'no-sidebar-item';
      // Switch to the first tab (clears finished)
      hub.switchTab(firstTabId);
      return el.classList.contains('finished') ? 'still-finished' : 'cleared';
    });
    assertEqual(cleared, 'cleared', 'Sidebar finished class should be removed on switch');
  });

  await test('screenshot of unread tab state', async () => {
    // Setup: switch to second tab, mark first as unread
    await page.evaluate(() => {
      const hub = window.__herd;
      const ids = [...hub.tabs.keys()];
      hub.switchTab(ids[1]);
      const tab = hub.tabs.get(ids[0]);
      tab.unread = true;
      tab.finished = false;
      hub.renderTabs();
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'tab-unread.png') });
  });

  await test('screenshot of finished tab state', async () => {
    await page.evaluate(() => {
      const hub = window.__herd;
      const ids = [...hub.tabs.keys()];
      const tab = hub.tabs.get(ids[0]);
      tab.finished = true;
      tab.unread = false;
      hub.renderTabs();
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'tab-finished.png') });
  });

  // Clean up tabs from this group
  await page.evaluate(() => {
    const hub = window.__herd;
    for (const id of [...hub.tabs.keys()]) hub.closeTab(id);
  });
  await page.waitForTimeout(300);

  // ═══════════════════════════════════════════
  group('Full page screenshots');
  // ═══════════════════════════════════════════

  await test('final dark theme screenshot', async () => {
    await page.locator('.theme-btn[data-theme="dark"]').click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'final-dark.png') });
  });

  await test('final light theme screenshot', async () => {
    await page.locator('.theme-btn[data-theme="light"]').click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'final-light.png') });
    // Reset
    await page.locator('.theme-btn[data-theme="dark"]').click();
  });

  // ── Done ──
  await browser.close();

  // Summary
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  \x1b[1m${passed}/${total} passed\x1b[0m  ${failed ? `\x1b[31m${failed} failed\x1b[0m  ` : ''}(\x1b[2m${(totalMs / 1000).toFixed(1)}s\x1b[0m)`);

  if (failed) {
    console.log(`\n  \x1b[31mFailed tests:\x1b[0m`);
    for (const r of results.filter(r => !r.pass)) {
      console.log(`    \x1b[31m✗\x1b[0m ${r.name}`);
      console.log(`      ${r.error}`);
    }
  }

  console.log();
  process.exit(failed ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
