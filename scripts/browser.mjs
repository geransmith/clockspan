/**
 * The headless Chromium that scripts/screenshots.mjs and scripts/icons.mjs drive over the
 * DevTools protocol. The browser is CHROME_BIN, else an installed Chrome / Chromium / Edge /
 * Brave, else a Chrome for Testing build fetched once into node_modules/.cache. (Vivaldi is
 * left out on purpose: its headless mode starts but never lets DevTools drive a tab.)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BROWSER_CACHE = path.join(ROOT, 'node_modules', '.cache', 'clockspan-browser');

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

export function findBrowser() {
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
  console.log('[browser] no Chromium found; fetching Chrome for Testing into node_modules/.cache (one time, ~150 MB)');
  // Pinned: `npx --yes` runs whatever it downloads, so the package version is fixed here.
  const r = spawnSync('npx', ['--yes', '@puppeteer/browsers@3.2.2', 'install', 'chrome@stable', '--path', BROWSER_CACHE], {
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

export function launchBrowser(bin, profileDir) {
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

export class Cdp {
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

/**
 * Finds, starts and connects to a headless Chromium in a throwaway profile. `close()` stops it
 * and deletes the profile; calling it again waits for the same shutdown.
 */
export async function openBrowser(log) {
  const bin = findBrowser();
  log(`browser: ${bin}`);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockspan-browser-'));
  let child;
  let cdp;
  // Chromium's helper processes still write to the profile while it quits, so the profile goes
  // only once the browser has exited: asked to over DevTools, killed if it takes over 5 s.
  const shutDown = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      if (cdp) cdp.send('Browser.close').catch(() => {});
      else child.kill('SIGKILL');
      const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(kill);
    }
    cdp?.close();
    fs.rmSync(profileDir, { recursive: true, force: true });
  };
  let closing;
  const close = () => (closing ??= shutDown());
  try {
    let wsUrl;
    ({ child, wsUrl } = await launchBrowser(bin, profileDir));
    cdp = await Cdp.connect(wsUrl);
    return { cdp, close };
  } catch (err) {
    await close();
    throw err;
  }
}
