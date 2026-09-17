import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../dev/harness.js';
import { purgeExpiredSessions, SESSION_COOKIE } from './session.js';

const USER = { username: 'geran', password: 'correct horse' };
const HOUR = 3_600_000;

type SessionRow = { id: number; expires_at: number; last_seen_at: number };

describe('cookie sessions', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp({ authMode: 'local' });
  });
  afterEach(() => app.close());

  const rows = () => app.db.prepare(`SELECT id, expires_at, last_seen_at FROM auth_sessions ORDER BY id`).all() as SessionRow[];
  const only = () => {
    const all = rows();
    expect(all).toHaveLength(1);
    return all[0]!;
  };
  const setCookie = (r: { headers: Headers }) => r.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';

  it('sets a cookie the browser keeps to itself and only sends over https when the app is https', async () => {
    const plain = setCookie(await app.api.post('/api/auth/setup', USER));
    expect(plain).toMatch(/; HttpOnly/i);
    expect(plain).toMatch(/; SameSite=Lax/i);
    expect(plain).toMatch(/; Path=\//i);
    expect(plain).toMatch(/; Max-Age=\d+/i);
    expect(plain).not.toMatch(/; Secure/i);

    await app.close();
    app = await startTestApp({ authMode: 'local', env: { APP_URL: 'https://focus.example.com' } });
    expect(setCookie(await app.api.post('/api/auth/setup', USER))).toMatch(/; Secure/i);
  });

  it('answers 401 for a cookie that matches nothing, without touching the table', async () => {
    await app.api.post('/api/auth/setup', USER);
    const stranger = app.client();
    const r = await fetch(`${app.url}/api/settings`, { headers: { cookie: `${SESSION_COOKIE}=${'x'.repeat(43)}` } });
    expect(r.status).toBe(401);
    expect((await stranger.get('/api/settings')).status).toBe(401);
    expect(rows()).toHaveLength(1);
  });

  it('expires: the row goes on the first request after expires_at and the client is signed out', async () => {
    await app.api.post('/api/auth/setup', USER);
    const s = only();
    expect(s.expires_at - s.last_seen_at).toBe(app.config.sessionTtlMs);
    app.db.prepare(`UPDATE auth_sessions SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, s.id);
    expect((await app.api.get('/api/settings')).status).toBe(401);
    expect(rows()).toHaveLength(0);
    expect((await app.api.get('/api/auth/me')).body.user).toBeNull();
  });

  it('slides the expiry once an hour, not on every request', async () => {
    await app.api.post('/api/auth/setup', USER);
    const first = only();
    // Within the hour: nothing written.
    await app.api.get('/api/settings');
    expect(only()).toEqual(first);
    // An hour old: both timestamps move forward by the full TTL from now.
    const before = Date.now();
    app.db.prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`).run(first.last_seen_at - 2 * HOUR, first.expires_at - 2 * HOUR, first.id);
    expect((await app.api.get('/api/settings')).status).toBe(200);
    const slid = only();
    expect(slid.last_seen_at).toBeGreaterThanOrEqual(before);
    expect(slid.expires_at).toBe(slid.last_seen_at + app.config.sessionTtlMs);
  });

  it('logout drops only the calling session', async () => {
    await app.api.post('/api/auth/setup', USER);
    const phone = app.client();
    expect((await phone.post('/api/auth/login', USER)).status).toBe(200);
    expect(rows()).toHaveLength(2);
    expect((await phone.post('/api/auth/logout')).body).toEqual({ ok: true });
    expect(rows()).toHaveLength(1);
    expect((await app.api.get('/api/settings')).status).toBe(200);
    expect((await phone.get('/api/settings')).status).toBe(401);
  });

  it('purgeExpiredSessions removes exactly the expired rows', async () => {
    await app.api.post('/api/auth/setup', USER);
    const phone = app.client();
    await phone.post('/api/auth/login', USER);
    const [mine, theirs] = rows();
    app.db.prepare(`UPDATE auth_sessions SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, theirs!.id);
    purgeExpiredSessions(app.db);
    expect(rows().map((r) => r.id)).toEqual([mine!.id]);
    expect((await app.api.get('/api/settings')).status).toBe(200);
  });
});
