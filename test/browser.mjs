// Browser interaction helper for Claude Code
// Usage: node test/browser.mjs <command> [args...]
//
// Commands:
//   screenshot [selector]     - take a screenshot (optionally of a specific element)
//   click <selector>          - click an element
//   type <selector> <text>    - type text into an element
//   eval <js>                 - evaluate JS in the page
//   text [selector]           - get text content of the page or element
//   html [selector]           - get HTML of element
//   list <selector>           - list all matching elements with their text
//   wait <selector>           - wait for element to appear
//   hover <selector>          - hover over an element

import { chromium } from 'playwright';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = join(__dirname, 'screenshots');
const STATE_FILE = join(__dirname, '.browser-state.json');
const URL = process.env.HUB_URL || 'http://localhost:3456';

if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });

// Parse commands - supports chaining with "then" keyword
// e.g.: node test/browser.mjs click ".project-item >> nth=0" then screenshot
const rawArgs = process.argv.slice(2);

if (rawArgs.length === 0) {
  console.log('Usage: node test/browser.mjs <command> [args...] [then <command> [args...]] ...');
  console.log('Commands: screenshot, click, type, eval, text, html, list, wait, hover');
  console.log('Chain commands with "then": click ".btn" then screenshot');
  process.exit(1);
}

// Split args by "then" keyword into separate commands
function parseCommands(rawArgs) {
  const commands = [];
  let current = [];
  for (const arg of rawArgs) {
    if (arg === 'then') {
      if (current.length) commands.push(current);
      current = [];
    } else {
      current.push(arg);
    }
  }
  if (current.length) commands.push(current);
  return commands;
}

const commandChain = parseCommands(rawArgs);

async function executeCommand(page, command, args) {
  switch (command) {
    case 'screenshot': {
      const path = join(SCREENSHOT_DIR, `hub-${Date.now()}.png`);
      if (args[0]) {
        await page.locator(args[0]).screenshot({ path });
      } else {
        await page.screenshot({ path });
      }
      console.log(path);
      break;
    }

    case 'click': {
      if (!args[0]) { console.error('Usage: click <selector>'); return; }
      await page.locator(args[0]).click();
      await page.waitForTimeout(500);
      console.log(`Clicked ${args[0]}`);
      break;
    }

    case 'type': {
      if (args.length < 2) { console.error('Usage: type <selector> <text>'); return; }
      const selector = args[0];
      const text = args.slice(1).join(' ');
      await page.locator(selector).fill(text);
      console.log(`Typed "${text}" into ${selector}`);
      break;
    }

    case 'eval': {
      const js = args.join(' ');
      const result = await page.evaluate(js);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'text': {
      if (args[0]) {
        const text = await page.locator(args[0]).allInnerTexts();
        console.log(text.join('\n'));
      } else {
        const text = await page.locator('body').innerText();
        console.log(text);
      }
      break;
    }

    case 'html': {
      if (args[0]) {
        const html = await page.locator(args[0]).innerHTML();
        console.log(html);
      } else {
        const html = await page.content();
        console.log(html);
      }
      break;
    }

    case 'list': {
      if (!args[0]) { console.error('Usage: list <selector>'); return; }
      const elements = await page.locator(args[0]).all();
      for (let i = 0; i < elements.length; i++) {
        const text = (await elements[i].innerText()).trim().substring(0, 100);
        const tag = await elements[i].evaluate(el => el.tagName.toLowerCase());
        const cls = await elements[i].evaluate(el => el.className);
        console.log(`[${i}] <${tag} class="${cls}"> ${text}`);
      }
      console.log(`\nTotal: ${elements.length} elements`);
      break;
    }

    case 'wait': {
      if (!args[0]) { console.error('Usage: wait <selector>'); return; }
      const timeout = args[1] ? parseInt(args[1]) : 10000;
      await page.locator(args[0]).waitFor({ timeout });
      console.log(`Element ${args[0]} found`);
      break;
    }

    case 'sleep': {
      const ms = parseInt(args[0]) || 1000;
      await page.waitForTimeout(ms);
      console.log(`Slept ${ms}ms`);
      break;
    }

    case 'hover': {
      if (!args[0]) { console.error('Usage: hover <selector>'); return; }
      await page.locator(args[0]).hover();
      console.log(`Hovered ${args[0]}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
  }
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome'
  });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  try {
    for (const cmd of commandChain) {
      const [command, ...args] = cmd;
      await executeCommand(page, command, args);
    }
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error(err.message);
  process.exit(1);
});
