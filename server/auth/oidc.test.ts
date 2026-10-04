import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestApp, type TestApp } from '../dev/harness.js';
import { SESSION_COOKIE } from './session.js';
import { upsertOidcUser } from './oidc.js';

/**
 * The harness points discovery at a port nothing listens on, so these cover everything that
 * does not need a live provider: the mode answer, the two error pages, the flow cookie, and
 * the user upsert. The code grant, with the token exchange and userinfo faked, is in
 * `oidc-flow.test.ts`.
 */
describe('AUTH_MODE=oidc', () => {
  let app: TestApp;
  beforeEach(async () => {
    // The routes log why a sign-in failed; two tests read it.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    app = await startTestApp({ authMode: 'oidc' });
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  const raw = (path: string, cookie?: string) => fetch(app.url + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });

  it('reports the mode with no user and keeps the data routes closed', async () => {
    expect((await app.api.get('/api/auth/me')).body).toEqual({ mode: 'oidc', setupRequired: false, user: null, cookieSecure: false });
    expect((await app.api.get('/api/settings')).status).toBe(401);
    expect((await app.api.get('/api/days')).status).toBe(401);
    // The password routes are not mounted: they sit behind the auth gate like any unknown path.
    expect((await app.api.post('/api/auth/login', { username: 'x', password: 'y' })).status).toBe(401);
    expect((await app.api.post('/api/auth/setup', { username: 'x', password: 'y' })).status).toBe(401);
    expect(app.count('users')).toBe(0);
  });

  it('answers 503 on /auth/login while the provider is unreachable, with the cause in the log only', async () => {
    const r = await raw('/auth/login');
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('Identity provider is unreachable. <a href="/auth/login">Try again</a>.');
    expect(r.headers.getSetCookie()).toEqual([]);
    // A refused connection: the issuer is https, so openid-client really tried the port.
    expect(console.error).toHaveBeenCalledWith('[oidc] sign-in refused, provider unreachable: fetch failed: connect ECONNREFUSED 127.0.0.1:2');
  });

  it('refuses a callback without the flow cookie', async () => {
    const r = await raw('/auth/callback?code=abc&state=xyz');
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('<a href="/auth/login">Try again</a>');
  });

  it('clears the flow cookie and shows fixed text when the callback cannot complete', async () => {
    const r = await raw('/auth/callback?code=abc&state=xyz', 'fs_oidc=not-json');
    expect(r.status).toBe(400);
    // What went wrong (here a JSON parse error) is logged, not shown.
    expect(await r.text()).toBe('Sign-in failed. <a href="/auth/login">Try again</a>.');
    expect(console.error).toHaveBeenCalledWith('[oidc] callback failed:', expect.any(SyntaxError));
    // The one-time cookie is dropped whatever went wrong, and no session was created.
    const cleared = r.headers.getSetCookie().find((c) => c.startsWith('fs_oidc='));
    expect(cleared).toMatch(/Max-Age=0/i);
    expect(cleared).toMatch(/Path=\/auth/i);
    expect(r.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    expect(app.count('auth_sessions')).toBe(0);
  });

  it('creates provider users, none of them admin, and follows a renamed user', () => {
    const first = upsertOidcUser(app.db, 'issuer', '1', 'Ada');
    const second = upsertOidcUser(app.db, 'issuer', '2', 'Bob');
    expect(first).toMatchObject({ kind: 'oidc', oidc_sub: 'issuer|1', display_name: 'Ada', is_admin: 0 });
    expect(second).toMatchObject({ kind: 'oidc', oidc_sub: 'issuer|2', display_name: 'Bob', is_admin: 0 });
    // Same subject again: same row, new name.
    const renamed = upsertOidcUser(app.db, 'issuer', '1', 'Ada L.');
    expect(renamed.id).toBe(first.id);
    expect(renamed.display_name).toBe('Ada L.');
    expect(app.db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(first.id)).toEqual({ display_name: 'Ada L.' });
    // The same name again is a plain read.
    expect(upsertOidcUser(app.db, 'issuer', '1', 'Ada L.')).toMatchObject({ id: first.id, display_name: 'Ada L.' });
    expect(app.count('users', `kind = 'oidc'`)).toBe(2);
    // A name is a label: a provider that sends a paragraph gets the first 100 characters.
    expect(upsertOidcUser(app.db, 'issuer', '3', 'n'.repeat(500)).display_name).toBe('n'.repeat(100));
  });
});
