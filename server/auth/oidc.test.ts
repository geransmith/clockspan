import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestApp, type TestApp } from '../dev/harness.js';
import { SESSION_COOKIE } from './session.js';
import { escapeHtml, upsertOidcUser } from './oidc.js';

/**
 * The harness points discovery at a port nothing listens on, so these cover everything that
 * does not need a live provider: the mode answer, the two error pages, the flow cookie, and
 * the user upsert. The code grant itself is exercised against a real provider only.
 */
describe('AUTH_MODE=oidc', () => {
  let app: TestApp;
  beforeEach(async () => {
    // Discovery retries in the background and logs each failure; keep the run quiet.
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
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({ n: 0 });
  });

  it('answers 503 on /auth/login while the provider is unreachable', async () => {
    const r = await raw('/auth/login');
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/^Identity provider is unreachable: /);
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it('refuses a callback without the flow cookie', async () => {
    const r = await raw('/auth/callback?code=abc&state=xyz');
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('<a href="/auth/login">Try again</a>');
  });

  it('clears the flow cookie and shows an escaped error when the callback cannot complete', async () => {
    const r = await raw('/auth/callback?code=abc&state=xyz', 'fs_oidc=not-json');
    expect(r.status).toBe(400);
    const body = await r.text();
    expect(body).toMatch(/^Sign-in failed: /);
    expect(body).toContain('<a href="/auth/login">Try again</a>');
    // The one-time cookie is dropped whatever went wrong, and no session was created.
    const cleared = r.headers.getSetCookie().find((c) => c.startsWith('fs_oidc='));
    expect(cleared).toMatch(/Max-Age=0/i);
    expect(cleared).toMatch(/Path=\/auth/i);
    expect(r.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM auth_sessions`).get()).toEqual({ n: 0 });
  });

  it('logs out locally even when the provider cannot be asked for an end-session URL', async () => {
    const r = await app.api.post('/api/auth/logout');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, redirect: null });
    expect(app.api.cookies()).not.toHaveProperty(SESSION_COOKIE);
  });

  it('makes the first provider user the admin, later ones members, and follows a renamed user', () => {
    const first = upsertOidcUser(app.db, 'issuer|1', 'Ada');
    const second = upsertOidcUser(app.db, 'issuer|2', 'Bob');
    expect(first).toMatchObject({ kind: 'oidc', oidc_sub: 'issuer|1', display_name: 'Ada', is_admin: 1 });
    expect(second).toMatchObject({ kind: 'oidc', oidc_sub: 'issuer|2', display_name: 'Bob', is_admin: 0 });
    // Same subject again: same row, new name, admin flag untouched.
    const renamed = upsertOidcUser(app.db, 'issuer|1', 'Ada L.');
    expect(renamed.id).toBe(first.id);
    expect(renamed.display_name).toBe('Ada L.');
    expect(renamed.is_admin).toBe(1);
    expect(app.db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(first.id)).toEqual({ display_name: 'Ada L.' });
    // The same name again is a plain read.
    expect(upsertOidcUser(app.db, 'issuer|1', 'Ada L.')).toMatchObject({ id: first.id, display_name: 'Ada L.' });
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE kind = 'oidc'`).get()).toEqual({ n: 2 });
    // A name is a label: a provider that sends a paragraph gets the first 100 characters.
    expect(upsertOidcUser(app.db, 'issuer|3', 'n'.repeat(500)).display_name).toBe('n'.repeat(100));
  });
});

describe('escapeHtml', () => {
  it('neutralises every character that could open a tag or an attribute', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'q'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
    expect(escapeHtml('plain text')).toBe('plain text');
  });
});
