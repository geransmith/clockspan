/**
 * The headless Chromium that scripts/screenshots.mjs and scripts/icons.mjs drive over the
 * DevTools protocol. The browser is CHROME_BIN, else an installed Chrome / Chromium / Edge /
 * Brave, else a Chrome for Testing build fetched once into node_modules/.cache. (Vivaldi is
 * left out on purpose: its headless mode starts but never lets DevTools drive a tab.)
 */
import { spawn } from 'node:child_process';
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

async function findBrowser() {
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
  return cacheBrowser();
}

/**
 * No browser on this machine: the Chrome for Testing build a previous run fetched into
 * node_modules/.cache, else one fetched now.
 */
async function cacheBrowser() {
  try {
    // A devDependency, so package-lock.json pins it and what it pulls in, and Dependabot bumps it.
    // Imported here because only a machine with no browser of its own needs it.
    const { Browser, BrowserTag, detectBrowserPlatform, getInstalledBrowsers, install, resolveBuildId } = await import('@puppeteer/browsers');
    const cached = (await getInstalledBrowsers({ cacheDir: BROWSER_CACHE })).map((b) => b.executablePath).find(isExecutable);
    if (cached) return cached;
    console.log('[browser] no Chromium found; fetching Chrome for Testing into node_modules/.cache (one time, ~150 MB)');
    const platform = detectBrowserPlatform();
    const buildId = await resolveBuildId(Browser.CHROME, platform, BrowserTag.STABLE);
    return (await install({ browser: Browser.CHROME, buildId, platform, cacheDir: BROWSER_CACHE, downloadProgressCallback: 'default' })).executablePath;
  } catch (err) {
    throw new Error(`Could not fetch a browser (${err.message}). Install Chrome, or point CHROME_BIN at any Chromium.`);
  }
}

/**
 * Starts the browser; `ready` is its DevTools URL. The caller holds `child` from the start, so
 * it can stop a browser that never gets that far.
 */
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
  const ready = new Promise((resolve, reject) => {
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) resolve(m[1]);
    });
    child.on('exit', (code) => reject(new Error(`Browser exited (${code}) before DevTools was ready:\n${err}`)));
    setTimeout(() => reject(new Error(`Browser did not start within 30 s:\n${err}`)), 30_000).unref();
  });
  return { child, ready };
}

// ----- DevTools protocol -----

const closedError = (method) => new Error(`${method}: the browser closed the DevTools connection`);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    // A browser that dies answers nothing, so its pending commands fail here instead of
    // waiting forever.
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(closedError(p.method));
      this.pending.clear();
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`Could not connect to ${url}`));
    });
    return new Cdp(ws);
  }

  /** Settles the command a reply answers. Events carry no id; nothing here waits on one. */
  onMessage(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }

  send(method, params = {}, sessionId) {
    // WebSocket.send drops a frame on a closed socket without a word, so no reply would come.
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(closedError(method));
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
  const bin = await findBrowser();
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
    const launched = launchBrowser(bin, profileDir);
    child = launched.child;
    cdp = await Cdp.connect(await launched.ready);
    return { cdp, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Opens a blank tab and returns a `send` for DevTools commands to it. */
export async function openTab(cdp) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  // For a browser that keeps the socket open but never answers a tab, as Vivaldi's headless
  // mode does.
  const silent = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('The browser opened a tab but never answered DevTools. Try another Chromium via CHROME_BIN.')), 15_000).unref(),
  );
  await Promise.race([send('Page.enable'), silent]);
  return send;
}
