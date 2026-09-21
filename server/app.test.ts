import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
