#!/usr/bin/env node
/**
 * Regenerates docs/screenshots/*.png for the README. One command, nothing to set up:
 *
 *   npm run screenshots
 *
 * It reuses a running `npm run dev` (BASE_URL, default http://localhost:5173) or starts one,
 * seeds the dev DB (`--running --quarter`, with the clock pinned to 10:30 so every run looks
 * the same) and turns the sticker chart on for the history shot, drives a local Chromium over
 * the DevTools protocol, and stops whatever it started. scripts/browser.mjs picks the browser
 * (CHROME_BIN, an installed one, or a Chrome for Testing build it fetches once). The dev
 * server has to be in AUTH_MODE=none (the default): the script does not sign in.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const BASE = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
/** Local time of day the sheet is shown at: clocked in at 08:30, lunch due 13:30, 15 min left on the timer. */
const CLOCK = '10:30';

const PHONE = { width: 375, height: 812, deviceScaleFactor: 2, mobile: true };
/** Taller than a phone so the sheet shots reach the priorities card and the review shows both lists. */
const PHONE_TALL = { ...PHONE, height: 1000 };
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[screenshots] ${msg}`);

// ----- dates -----

const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function lastWeekday() {
  const d = new Date();
  do d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  return todayKey(d);
}
function clockMs() {
  const [h, m] = CLOCK.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// ----- dev server -----

async function healthy() {
  try {
    return (await fetch(`${BASE}/api/health`)).ok;
  } catch {
    return false;
  }
}

async function waitFor(check, what, timeoutMs = 60_000, every = 400) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(every);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Starts `npm run dev` in its own process group so the whole tree can be stopped at the end. */
async function startDevServer() {
  log(`no server at ${BASE}; starting npm run dev`);
  const child = spawn('npm', ['run', 'dev'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const tail = [];
  const keep = (chunk) => {
    tail.push(...String(chunk).split('\n'));
    tail.splice(0, Math.max(0, tail.length - 40));
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  try {
    await waitFor(healthy, `${BASE}/api/health`);
  } catch (err) {
    stopGroup(child);
    throw new Error(`${err.message}\n${tail.join('\n')}`, { cause: err });
  }
  return child;
}

function stopGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

function seed() {
  log(`seeding (--running --quarter --now ${CLOCK})`);
  const r = spawnSync('npm', ['run', 'seed', '--', '--running', '--quarter', '--now', CLOCK], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('npm run seed failed');
}

/** The sticker chart is off by default; the history shot shows it on. No other shot reads it. */
async function enableStickers() {
  const res = await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stickers: true }) });
  if (!res.ok) throw new Error(`PUT /api/settings failed (${res.status})`);
}

// ----- page -----

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  static async open(cdp) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    const silent = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('The browser opened a tab but never answered DevTools. Try another Chromium via CHROME_BIN.')), 15_000).unref(),
    );
    await Promise.race([page.send('Page.enable'), silent]);
    await page.send('Runtime.enable');
    // The sheet reads the clock through Date, so shifting Date shifts the whole app: the
    // timer bar, the tiles and "today" all agree with the seed's --now.
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const Real = Date;
        const shift = ${clockMs()} - Real.now();
        class Shifted extends Real {
          constructor(...args) { super(...(args.length ? args : [Real.now() + shift])); }
          static now() { return Real.now() + shift; }
        }
        window.Date = Shifted;
      })();`,
    });
    return page;
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async setDevice(device, scheme) {
    await this.send('Emulation.setDeviceMetricsOverride', device);
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  }

  async goto(url, readySelector) {
    await this.send('Page.navigate', { url });
    await this.waitForSelector(readySelector, 30_000);
    // Data has arrived; give the layout a beat (fonts, transitions) before capturing.
    await sleep(500);
  }

  waitForSelector(selector, timeoutMs = 10_000) {
    return waitFor(() => this.eval(`!!document.querySelector(${JSON.stringify(selector)})`), selector, timeoutMs, 100);
  }

  /** Clicks the first `selector`, or the one whose text is `text`. */
  async click(selector, text) {
    await this.waitForSelector(selector);
    const found = await this.eval(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = ${text === undefined ? 'els[0]' : `els.find((e) => e.textContent.trim() === ${JSON.stringify(text)})`};
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!found) throw new Error(`Nothing to click for ${selector}${text ? ` "${text}"` : ''}`);
    await sleep(350);
  }

  /** Page-relative box of an element, for a clipped capture. */
  async boxOf(selector, pad = 0) {
    const box = await this.eval(`(() => {
      const b = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
      return b ? { x: b.x + window.scrollX, y: b.y + window.scrollY, width: b.width, height: b.height } : null;
    })()`);
    if (!box) throw new Error(`No element for ${selector}`);
    return { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad, scale: 1 };
  }

  async capture(file, { fullPage = false, clip } = {}) {
    const params = { format: 'png', captureBeyondViewport: fullPage || Boolean(clip) };
    if (clip) params.clip = clip;
    else if (fullPage) {
      const { width, height } = await this.eval('({ width: document.documentElement.clientWidth, height: document.documentElement.scrollHeight })');
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
}

// ----- the shots -----

const READY_SHEET = '.app--has-bar .card';
const READY_HISTORY = '.history-view .card';
const openSettings = (tab) => async (page) => {
  await page.click('button[title="Settings"]');
  await page.click(`#tab-${tab}`);
};

const SHOTS = [
  { name: 'sheet-phone-light', url: '/', device: PHONE_TALL, scheme: 'light', ready: READY_SHEET },
  { name: 'sheet-phone-dark', url: '/', device: PHONE_TALL, scheme: 'dark', ready: READY_SHEET },
  { name: 'sheet-desktop', url: '/', device: DESKTOP, scheme: 'dark', ready: READY_SHEET, fullPage: true },
  { name: 'retro', url: `/?date=${lastWeekday()}`, device: PHONE, scheme: 'light', ready: '#card-retro .card', clip: '#card-retro' },
  // The route's date picks the day, so the panel is filled before the first paint settles.
  { name: 'history', url: `/?view=history&date=${lastWeekday()}`, device: PHONE, scheme: 'light', ready: '.calendar-detail .tile', fullPage: true },
  {
    name: 'review',
    url: '/?view=history',
    device: PHONE_TALL,
    scheme: 'light',
    ready: READY_HISTORY,
    steps: async (page) => {
      await page.click('.segmented [role="tab"]', 'Review');
      await page.click('.review [role="tab"]', 'Month');
      await page.waitForSelector('.review');
      await sleep(600);
    },
  },
  { name: 'settings-alarms', url: '/', device: PHONE, scheme: 'light', ready: READY_SHEET, steps: openSettings('alarms') },
  { name: 'settings-data', url: '/', device: PHONE, scheme: 'light', ready: READY_SHEET, steps: openSettings('data') },
];

async function main() {
  const cleanups = [];
  const cleanup = () => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch {
        /* best effort */
      }
    }
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  try {
    if (!(await healthy())) {
      const dev = await startDevServer();
      cleanups.push(() => stopGroup(dev));
    } else {
      log(`using the server at ${BASE}`);
    }
    seed();
    await enableStickers();

    const browser = await openBrowser(log);
    cleanups.push(browser.close);
    const { cdp } = browser;

    fs.mkdirSync(OUT, { recursive: true });
    for (const shot of SHOTS) {
      const page = await Page.open(cdp);
      await page.setDevice(shot.device, shot.scheme);
      await page.goto(`${BASE}${shot.url}`, shot.ready);
      if (shot.steps) await shot.steps(page);
      const file = path.join(OUT, `${shot.name}.png`);
      await page.capture(file, { fullPage: shot.fullPage, clip: shot.clip ? await page.boxOf(shot.clip, 8) : undefined });
      await page.send('Page.close');
      log(`wrote ${path.relative(ROOT, file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
    }
    await browser.close();
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(`[screenshots] ${err.message}`);
  process.exit(1);
});
