import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { startTestApp, type TestApp } from './dev/harness.js';

describe('response headers', () => {
  let app: TestApp;
  afterEach(() => app.close());

  it('sets the security headers on every response', async () => {
    app = await startTestApp();
    const res = await app.api.get('/api/health');
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('x-powered-by')).toBeNull();
    // Plain http: no HSTS, so a LAN install never pins itself to a scheme it doesn't serve.
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('adds HSTS once the deployment is https', async () => {
    app = await startTestApp({ env: { APP_URL: 'https://focus.example.com' } });
    const res = await app.api.get('/api/health');
    expect(res.headers.get('strict-transport-security')).toMatch(/^max-age=\d+$/);
  });

  it('answers unknown API paths as JSON, not the SPA shell', async () => {
    app = await startTestApp();
    const res = await app.api.get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found.' });
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

  it('refuses a body over the limit with a 413, not a crash', async () => {
    const res = await send(JSON.stringify({ pad: 'x'.repeat(300_000) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/too large/i) });
    // The app is still up and the row untouched.
    expect((await app.api.get('/api/settings')).status).toBe(200);
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM settings`).get()).toEqual({ n: 0 });
  });

  it('answers an unexpected failure with a fixed 500 message and logs the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    app.db.close(); // every query now throws inside the handler
    const res = await app.api.get('/api/settings');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error.' });
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]![0])).toMatch(/not open/);
    logged.mockRestore();
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
  afterEach(() => app.close());

  const USER = { username: 'geran', password: 'correct horse' };
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
});

describe('static client', () => {
  let app: TestApp;
  let dir: string;
  beforeEach(() => {
    // A stand-in for dist/client: the shell, a fingerprinted asset and an icon.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockspan-client-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.mkdirSync(path.join(dir, 'icons'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>');
    fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'icons', 'icon.svg'), '<svg/>');
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the shell for every non-API path, uncached, and the fingerprinted assets for a year', async () => {
    app = await startTestApp({ clientDir: dir });
    for (const p of ['/', '/history', '/some/deep/path?date=2026-09-01']) {
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
    // The API is still the API.
    expect((await app.api.get('/api/nope')).status).toBe(404);
  });

  it('serves nothing outside /api when there is no build', async () => {
    app = await startTestApp({ clientDir: path.join(dir, 'missing') });
    expect((await fetch(app.url + '/')).status).toBe(404);
    expect((await app.api.get('/api/health')).body).toEqual({ ok: true });
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
