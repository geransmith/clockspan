import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, startBackgroundJobs } from './app.js';
import { loadConfig } from './config.js';
import { ensureDefaultUser, openDatabase } from './db.js';
import { countRows, SETUP_CODE, startTestApp, tempClientBuild, writeClientBuild, type TestApp } from './dev/harness.js';
import { Discovery } from './auth/oidc.js';

describe('response headers', () => {
  let app: TestApp;
  afterEach(() => app.close());

  it('sets the security headers on every response', async () => {
    app = await startTestApp();
    const res = await app.api.get('/api/health');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    // Nothing the app serves is a `data:` URL, so no directive allows one.
    expect(csp.split('; ')).toEqual(["default-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('x-powered-by')).toBeNull();
    // Plain http: no HSTS, so a LAN install never pins itself to a scheme it doesn't serve.
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('marks every API answer no-store, and only those', async () => {
    app = await startTestApp();
    expect((await app.api.get('/api/health')).headers.get('cache-control')).toBe('no-store');
    expect((await app.api.get('/api/settings')).headers.get('cache-control')).toBe('no-store');
    expect((await app.api.get('/api/nope')).headers.get('cache-control')).toBe('no-store');
    // Express mounts /api case-insensitively, so this reaches the settings router.
    const upper = await app.api.get('/API/settings');
    expect(upper.status).toBe(200);
    expect(upper.headers.get('cache-control')).toBe('no-store');
    expect((await app.api.get('/api')).headers.get('cache-control')).toBe('no-store');
    // Outside /api nothing is set here; the static block in app.ts decides.
    expect((await fetch(`${app.url}/`)).headers.get('cache-control')).toBeNull();
    expect((await fetch(`${app.url}/apiary`)).headers.get('cache-control')).toBeNull();
  });

  it('adds HSTS once the deployment is https', async () => {
    app = await startTestApp({ env: { APP_URL: 'https://focus.example.com' } });
    const res = await app.api.get('/api/health');
    expect(res.headers.get('strict-transport-security')).toMatch(/^max-age=\d+$/);
  });
});

describe('cross-site writes', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp();
  });
  afterEach(() => app.close());

  // A browser sets Sec-Fetch-Site itself; fetch here can send any value, which is the point.
  const send = (method: string, path: string, site?: string, body = '{}') =>
    fetch(`${app.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(site ? { 'sec-fetch-site': site } : {}) },
      body: method === 'GET' ? undefined : body,
    });

  it('refuses a write that another site sent, so a page cannot cancel a running timer', async () => {
    const started = await app.api.post('/api/days/2026-09-22/sessions', { plannedSeconds: 1500, label: 'focus' });
    // What a page elsewhere can send with no preflight: a POST with a text/plain body.
    const forged = await fetch(`${app.url}/api/sessions/${started.body.session.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' },
      body: '',
    });
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({ error: 'Cross-site request refused.' });
    expect((await app.api.get('/api/sessions/running')).body.session.status).toBe('running');
  });

  it('refuses same-site writes too: a sibling app on the domain is same-site for the cookie', async () => {
    expect((await send('PUT', '/api/settings', 'same-site')).status).toBe(403);
    expect((await send('DELETE', '/api/settings', 'cross-site')).status).toBe(403);
  });

  it("lets the app's own writes through, and clients that send no Sec-Fetch-Site", async () => {
    expect((await send('PUT', '/api/settings', 'same-origin')).status).toBe(200);
    expect((await send('PUT', '/api/settings', 'none')).status).toBe(200);
    expect((await send('PUT', '/api/settings')).status).toBe(200);
  });

  // Safari before 16.4 sends no Sec-Fetch-Site, but it does send Origin on a POST.
  it('falls back to Origin when a browser sends no Sec-Fetch-Site', async () => {
    const write = (origin: string) => fetch(`${app.url}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', origin }, body: '{}' });
    expect((await write('https://evil.example')).status).toBe(403);
    expect((await write('null')).status).toBe(403);
    expect((await write(app.url)).status).toBe(200);
    // A proxy that rewrites Host: the public origin is APP_URL's.
    await app.close();
    app = await startTestApp({ env: { APP_URL: 'https://focus.example.com' } });
    expect((await write('https://focus.example.com')).status).toBe(200);
    expect((await write('https://other.example.com')).status).toBe(403);
  });

  it('leaves reads alone, whoever sent them', async () => {
    expect((await send('GET', '/api/settings', 'cross-site')).status).toBe(200);
  });
});

describe('host names under AUTH_MODE=none', () => {
  let app: TestApp;
  afterEach(async () => {
    await app.close();
  });

  // fetch drops a Host header it is handed, so these go through node:http, which sends it as given.
  const as = (host: string, path = '/api/settings', method = 'GET') =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = http.request(`${app.url}${path}`, { method, headers: { host, 'content-type': 'application/json' } }, (res) => {
        let text = '';
        res
          .setEncoding('utf8')
          .on('data', (chunk: string) => (text += chunk))
          .on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) as unknown }));
      });
      req.on('error', reject).end(method === 'GET' ? undefined : '{"workMinutes": 300}');
    });

  it('refuses a name it does not know, reads included, and says what to set', async () => {
    app = await startTestApp({ seed: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A rebinding page: its own name, pointed at this server, so the browser calls it same-origin.
    const read = await as('rebind.example:8080', `/api/days/${app.seeded!.today}`);
    expect(read).toEqual({ status: 403, body: { error: 'This server does not answer to rebind.example. Add it to ALLOWED_HOSTS.' } });
    expect((await as('rebind.example:8080', '/api/settings', 'PUT')).status).toBe(403);
    expect((await as('rebind.example', '/api/auth/me')).status).toBe(403);
    expect(app.count('settings')).toBe(0);
    // One line per name, however many requests it sends.
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[host\] API request for "rebind\.example" refused/);
  });

  it('answers the names no outside page can use', async () => {
    app = await startTestApp();
    const names = ['127.0.0.1:8080', '192.168.1.10', '[::1]:8080', '[FE80::1]', 'tower:8080', 'TOWER.', 'localhost:5173', 'app.localhost'];
    for (const host of [...names, 'tower.local', 'nas.home.arpa', 'box.internal']) expect([host, (await as(host)).status]).toEqual([host, 200]);
    // Only the whole label counts.
    for (const host of ['evil.notlocal', 'local.evil.example', 'internal.evil.example']) expect([host, (await as(host)).status]).toEqual([host, 403]);
  });

  it("answers APP_URL's host and ALLOWED_HOSTS, where a leading dot takes the whole domain", async () => {
    app = await startTestApp({ env: { APP_URL: 'https://focus.example.com', ALLOWED_HOSTS: 'nas.example.net,.lan' } });
    for (const host of ['focus.example.com', 'FOCUS.example.com:443', 'nas.example.net', 'lan', 'tower.lan', 'a.b.lan:8080']) {
      expect([host, (await as(host)).status]).toEqual([host, 200]);
    }
    for (const host of ['example.com', 'www.focus.example.com', 'focus.example.com.evil.example', 'example.net', 'tower.flan']) {
      expect([host, (await as(host)).status]).toEqual([host, 403]);
    }
  });

  it('refuses a Host header no browser would send, without logging it', async () => {
    app = await startTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const host of ['tower/x', '[1:2]', '.', '-tower'])
      expect([host, await as(host)]).toEqual([host, { status: 403, body: { error: 'Invalid Host header.' } }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets a request with no Host header through: a browser always sends one', async () => {
    app = await startTestApp();
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(new URL(app.url).port), '127.0.0.1', () => socket.end('GET /api/settings HTTP/1.0\r\n\r\n'));
      let text = '';
      socket
        .setEncoding('utf8')
        .on('data', (chunk: string) => (text += chunk))
        .on('end', () => resolve(text))
        .on('error', reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 200 /);
  });

  it('logs the first few refused names once each, so made-up names cannot flood the log', async () => {
    app = await startTestApp();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 12; i++) expect((await as(`n${i}.evil.example`)).status).toBe(403);
    expect((await as('n0.evil.example')).status).toBe(403);
    expect(warn).toHaveBeenCalledTimes(10);
  });

  it('leaves the health check alone, and every sign-in mode', async () => {
    app = await startTestApp();
    expect(await as('rebind.example', '/api/health')).toEqual({ status: 200, body: { ok: true } });
    await app.close();
    // The session cookie belongs to the real name, so a rebound one gets nothing anyway.
    app = await startTestApp({ authMode: 'local' });
    expect((await as('rebind.example', '/api/auth/me')).status).toBe(200);
    expect((await as('rebind.example', '/api/settings')).status).toBe(401);
  });
});

describe('bad request bodies', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp();
  });
  afterEach(() => app.close());

  const send = (body: string, type = 'application/json') => fetch(`${app.url}/api/settings`, { method: 'PUT', headers: { 'content-type': type }, body });

  it('turns malformed JSON into a 400 with a JSON error and no stack trace', async () => {
    const res = await send('{"workMinutes": ');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe('string');
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).not.toMatch(/\n\s+at /);
  });

  it("shows a 4xx's message when the error carries no expose flag", async () => {
    // The router's bad-param 400 has no `expose`, which is why the handler hides only `expose: false`.
    expect(await app.api.get('/api/days/%E0')).toMatchObject({ status: 400, body: { error: "Failed to decode param '%E0'" } });
  });

  it('refuses a body over the limit with a 413, not a crash', async () => {
    const res = await send(JSON.stringify({ pad: 'x'.repeat(300_000) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/too large/i) });
    // The app is still up and the row untouched.
    expect((await app.api.get('/api/settings')).status).toBe(200);
    expect(app.count('settings')).toBe(0);
  });

  it('answers an unexpected failure with a fixed 500 message and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    app.db.close(); // every query now throws inside the handler
    const res = await app.api.get('/api/settings');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error.' });
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]![0])).toMatch(/not open/);
  });

  it('ignores a body that is not JSON instead of parsing it', async () => {
    // A form post never reaches a route as a parsed body, which is part of what keeps
    // cross-site requests harmless; here it just means "no patch".
    const res = await send('workMinutes=1', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { workMinutes: number }).workMinutes).not.toBe(1);
  });
});

describe('TRUST_PROXY', () => {
  let app: TestApp;
  afterEach(async () => {
    await app.close();
  });

  const USER = { username: 'geran', password: 'correct horse', setupCode: SETUP_CODE };
  const loginFrom = (forwardedFor: string) =>
    fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      body: JSON.stringify({ username: USER.username, password: 'wrong' }),
    });
  const exhaust = async () => {
    for (let i = 0; i < 5; i++) expect((await loginFrom('203.0.113.1')).status).toBe(401);
  };

  it('keys the login limiter on the forwarded address only when told to trust the proxy', async () => {
    app = await startTestApp({ authMode: 'local' });
    await app.api.post('/api/auth/setup', USER);
    await exhaust();
    // Not trusted: every request is the loopback, so a new forwarded address changes nothing.
    expect((await loginFrom('203.0.113.2')).status).toBe(429);
    await app.close();

    app = await startTestApp({ authMode: 'local', env: { TRUST_PROXY: '1' } });
    await app.api.post('/api/auth/setup', USER);
    await exhaust();
    expect((await loginFrom('203.0.113.1')).status).toBe(429);
    expect((await loginFrom('203.0.113.2')).status).toBe(401);
  });

  it('says once in the log when a proxy forwards sign-ins that TRUST_PROXY does not trust', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const me = (headers: Record<string, string> = {}) => fetch(`${app.url}/api/auth/me`, { headers });
    app = await startTestApp({ authMode: 'local' });
    await me();
    expect(warn).not.toHaveBeenCalled();
    await me({ 'x-forwarded-for': '203.0.113.1' });
    await me({ 'x-forwarded-for': '203.0.113.2' });
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /^\[proxy\] A request came in with X-Forwarded-For but TRUST_PROXY is not set\. If a reverse proxy sent it, every sign-in counts as coming from the proxy \(127\.0\.0\.1\), so 5 failed sign-ins from anyone block new sign-ins for everyone for up to 15 minutes: /,
    );
    await app.close();

    warn.mockClear();
    app = await startTestApp({ authMode: 'local', env: { TRUST_PROXY: '1' } });
    await me({ 'x-forwarded-for': '203.0.113.1' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('static client', () => {
  let app: TestApp;
  let dir: string;
  beforeEach(() => {
    dir = tempClientBuild();
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the shell for every non-API path, uncached, and the fingerprinted assets for a year', async () => {
    app = await startTestApp({ clientDir: dir });
    for (const p of ['/', '/index.html', '/history', '/some/deep/path?date=2026-09-01']) {
      const r = await fetch(app.url + p);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/text\/html/);
      expect(r.headers.get('cache-control')).toBe('no-cache');
      expect(await r.text()).toContain('shell');
    }
    const asset = await fetch(`${app.url}/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    // Everything else keeps the short default so an updated icon or manifest shows up.
    const icon = await fetch(`${app.url}/icons/icon.svg`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('cache-control')).toBe('public, max-age=3600');
    // The API is still the API: JSON, never the shell.
    expect(await app.api.get('/api/nope')).toMatchObject({ status: 404, body: { error: 'Not found.' } });
  });

  it('answers a missing file under /assets with a 404, never the shell', async () => {
    app = await startTestApp({ clientDir: dir });
    // A page from before an upgrade asking for the old build's chunk.
    const missing = await fetch(`${app.url}/assets/History-missing.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toMatch(/application\/json/);
    expect(await missing.json()).toEqual({ error: 'Not found.' });
    // The miss still goes through security.ts, and nothing caches it for a year.
    expect(missing.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff');
    expect(missing.headers.get('cache-control')).toBeNull();
    for (const p of ['/assets/nested/index-old.css', '/assets/', '/assets']) expect((await fetch(app.url + p)).status).toBe(404);

    const asset = await fetch(`${app.url}/assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    // Only the /assets segment: a path that merely starts with the word is a client route.
    for (const p of ['/some/route', '/assets-old']) {
      const r = await fetch(app.url + p);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('shell');
    }
  });

  it('serves the build from a folder with a dot-named directory in its path', async () => {
    // An install under ~/.local/share, or a checkout under .claude/worktrees: send ignores
    // dotfiles, and only the path inside the build is the app's to judge.
    const hidden = path.join(dir, '.local', 'share', 'clockspan');
    writeClientBuild(hidden);
    fs.writeFileSync(path.join(hidden, '.secret'), 'not for the browser');
    app = await startTestApp({ clientDir: hidden });
    for (const p of ['/', '/history', '/some/deep/path?date=2026-09-01']) {
      const r = await fetch(app.url + p);
      expect(r.status, p).toBe(200);
      expect(await r.text()).toContain('shell');
    }
    expect((await fetch(`${app.url}/assets/index-abc123.js`)).status).toBe(200);
    expect((await fetch(`${app.url}/icons/icon.svg`)).status).toBe(200);
    // A dotfile inside the build is still never served: the path falls through to the shell.
    expect(await (await fetch(`${app.url}/.secret`)).text()).toContain('shell');
  });

  it('caches by the path inside the build, whatever the folders above it are called', async () => {
    // An install under a folder named assets: only the build's own /assets is fingerprinted.
    const nested = path.join(dir, 'assets', 'clockspan');
    writeClientBuild(nested);
    app = await startTestApp({ clientDir: nested });
    expect((await fetch(`${app.url}/assets/index-abc123.js`)).headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    for (const p of ['/sw.js', '/manifest.webmanifest', '/icons/icon.svg']) {
      const r = await fetch(app.url + p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('cache-control'), p).toBe('public, max-age=3600');
    }
  });

  it('serves nothing outside /api when there is no build', async () => {
    app = await startTestApp({ clientDir: path.join(dir, 'missing') });
    expect((await fetch(app.url + '/')).status).toBe(404);
    expect((await app.api.get('/api/health')).body).toEqual({ ok: true });
  });

  it('answers a shell removed under a running server with fixed text, and logs the cause', async () => {
    app = await startTestApp({ clientDir: dir });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    // What a rebuild emptying dist/client does after the boot-time check has passed.
    fs.rmSync(path.join(dir, 'index.html'));
    const res = await fetch(`${app.url}/history`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'Request failed.' });
    expect(text).not.toContain(dir);
    expect(logged).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOENT' }));
  });
});

describe('createApp', () => {
  it('defaults to the client directory beside the server: dist/client once built, the source tree here', async () => {
    const db = openDatabase(':memory:');
    const server = createApp(db, loadConfig({ AUTH_MODE: 'none', PORT: '0' })).listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('<div id="root">');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});

describe('startBackgroundJobs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('purges expired logins every six hours and schedules the old-day prune; building an app starts neither', () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 16, 12) });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = openDatabase(':memory:');
    const config = loadConfig({ AUTH_MODE: 'none', RETENTION_DAYS: '30' });
    const user = ensureDefaultUser(db);
    const now = Date.now();
    db.prepare(`INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, 'old', ?, ?, ?)`).run(
      user.id,
      0,
      now + 60_000,
      0,
    );
    db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2025-01-01', 0)`).run(user.id);
    const count = (table: string) => countRows(db, table);

    createApp(db, config);
    vi.advanceTimersByTime(7 * 3_600_000);
    expect([count('auth_sessions'), count('days')]).toEqual([1, 1]);

    startBackgroundJobs(db, config);
    vi.advanceTimersByTime(29_999);
    expect(count('days')).toBe(1);
    vi.advanceTimersByTime(1);
    expect(count('days')).toBe(0);
    expect(log).toHaveBeenCalledWith('[retention] deleted 1 day');
    // The login expired a minute after it was stored; the next six-hourly purge takes it.
    expect(count('auth_sessions')).toBe(1);
    vi.advanceTimersByTime(6 * 3_600_000);
    expect(count('auth_sessions')).toBe(0);
    db.close();
  });

  it('warms the OIDC lookup createApp was given, which building the app leaves alone', () => {
    vi.useFakeTimers();
    const db = openDatabase(':memory:');
    const config = loadConfig({
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'https://127.0.0.1:2/',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      APP_URL: 'http://localhost',
    });
    const discovery = new Discovery('https://127.0.0.1:2/', 'c', 's');
    const get = vi.spyOn(discovery, 'get');
    const warm = vi.spyOn(discovery, 'warm').mockResolvedValue();
    createApp(db, config, { discovery });
    expect(get).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    startBackgroundJobs(db, config, discovery);
    expect(warm).toHaveBeenCalledOnce();
    db.close();
  });

  it('logs a job that fails instead of ending the process', () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openDatabase(':memory:');
    startBackgroundJobs(db, loadConfig({ AUTH_MODE: 'none' }));
    // Stands in for a database that is busy or full when the prune and the purge run.
    db.close();
    expect(() => vi.advanceTimersByTime(6 * 3_600_000)).not.toThrow();
    expect(error).toHaveBeenCalledWith('[sessions]', expect.any(Error));
    expect(error).toHaveBeenCalledWith('[retention]', expect.any(Error));
  });
});
