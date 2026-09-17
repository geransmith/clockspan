#!/usr/bin/env node
/**
 * Regenerates docs/screenshots/*.png for the README. One command, nothing to set up:
 *
 *   npm run screenshots
 *
 * It reuses a running `npm run dev` (BASE_URL, default http://localhost:5173) or starts one,
 * seeds the dev DB (`--running --quarter`, with the clock pinned to 10:30 so every run looks
 * the same), drives a local Chromium over the DevTools protocol, and stops whatever it
 * started. The browser is CHROME_BIN, else an installed Chrome / Chromium / Edge / Brave,
 * else a Chrome for Testing build fetched once into node_modules/.cache. (Vivaldi is left
 * out on purpose: its headless mode starts but never lets DevTools drive a tab.) The dev
 * server has to be in AUTH_MODE=none (the default): the script does not sign in.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const BASE = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
const BROWSER_CACHE = path.join(ROOT, 'node_modules', '.cache', 'clockspan-browser');
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

// ----- browser -----

const MAC_APPS = [
  ['Google Chrome.app', 'Google Chrome'],
  ['Chromium.app', 'Chromium'],
  ['Microsoft Edge.app', 'Microsoft Edge'],
  ['Brave Browser.app', 'Brave Browser'],
].flatMap(([app, exe]) => ['/Applications', path.join(os.homedir(), 'Applications')].map((dir) => path.join(dir, app, 'Contents', 'MacOS', exe)));
const WIN_APPS = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe'].flatMap((rel) =>
  [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean).map((dir) => path.join(dir, rel)),
);
const PATH_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'microsoft-edge', 'brave-browser'];

function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findBrowser() {
  if (process.env.CHROME_BIN) {
    if (isExecutable(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
    throw new Error(`CHROME_BIN is not an executable: ${process.env.CHROME_BIN}`);
  }
  for (const p of [...MAC_APPS, ...WIN_APPS]) if (isExecutable(p)) return p;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of PATH_NAMES) {
      const p = path.join(dir, name);
      if (isExecutable(p)) return p;
    }
  }
  return cachedBrowser() ?? fetchBrowser();
}

const CACHED_EXE_NAMES = new Set(['Google Chrome for Testing', 'chrome', 'chrome.exe']);

/** A Chrome for Testing build a previous run fetched, if any. */
function cachedBrowser() {
  const walk = (dir, depth) => {
    if (depth > 8 || !fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isFile() && CACHED_EXE_NAMES.has(entry.name) && isExecutable(p)) return p;
      if (entry.isDirectory()) {
        const found = walk(p, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(BROWSER_CACHE, 0);
}

/** No browser on this machine: fetch Chrome for Testing once into node_modules/.cache. */
function fetchBrowser() {
  log('no Chromium found; fetching Chrome for Testing into node_modules/.cache (one time, ~150 MB)');
  const r = spawnSync('npx', ['--yes', '@puppeteer/browsers', 'install', 'chrome@stable', '--path', BROWSER_CACHE], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // The last line is "chrome@<version> <executable path>".
  const line = (r.stdout ?? '').trim().split('\n').at(-1) ?? '';
  const exe = line.slice(line.indexOf(' ') + 1).trim();
  if (r.status !== 0 || !isExecutable(exe)) {
    throw new Error(`Could not fetch a browser (${line || 'no output'}). Install Chrome, or point CHROME_BIN at any Chromium.`);
  }
  return exe;
}

function launchBrowser(bin, profileDir) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--disable-gpu',
    'about:blank',
  ];
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) resolve({ child, wsUrl: m[1] });
    });
    child.on('exit', (code) => reject(new Error(`Browser exited (${code}) before DevTools was ready:\n${err}`)));
    setTimeout(() => reject(new Error(`Browser did not start within 30 s:\n${err}`)), 30_000).unref();
  });
}

// ----- DevTools protocol -----

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`Could not connect to ${url}`));
    });
    return new Cdp(ws);
  }

  onMessage(msg) {
    if (msg.id) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else {
      for (const l of this.listeners) l(msg);
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
  }

  close() {
    this.ws.close();
  }
}

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  static async open(cdp) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    const silent = new Promise((_, reject) => setTimeout(() => reject(new Error('The browser opened a tab but never answered DevTools. Try another Chromium via CHROME_BIN.')), 15_000).unref());
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

    const bin = findBrowser();
    log(`browser: ${bin}`);
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockspan-shots-'));
    cleanups.push(() => fs.rmSync(profileDir, { recursive: true, force: true }));
    const { child: browser, wsUrl } = await launchBrowser(bin, profileDir);
    cleanups.push(() => browser.kill('SIGKILL'));
    const cdp = await Cdp.connect(wsUrl);
    cleanups.push(() => cdp.close());

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
    // Chromium exits on its own once told to; SIGKILL above is the fallback.
    await cdp.send('Browser.close').catch(() => {});
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(`[screenshots] ${err.message}`);
  process.exit(1);
});
