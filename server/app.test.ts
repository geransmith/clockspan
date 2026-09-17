import { afterEach, describe, expect, it } from 'vitest';
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
