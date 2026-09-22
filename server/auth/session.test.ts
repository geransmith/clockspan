import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../dev/harness.js';
import { purgeExpiredSessions, revokeOtherSessions, SESSION_COOKIE } from './session.js';
import type { Request } from 'express';

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
    // A cookie header with no session cookie in it is the same as none.
    expect((await fetch(`${app.url}/api/settings`, { headers: { cookie: 'theme=dark' } })).status).toBe(401);
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

  it('slides the expiry once an hour, not on every request, and hands the browser the cookie again', async () => {
    const issued = setCookie(await app.api.post('/api/auth/setup', USER));
    const first = only();
    // Within the hour: nothing written, nothing re-sent.
    const quiet = await app.api.get('/api/settings');
    expect(only()).toEqual(first);
    expect(setCookie(quiet)).toBe('');
    // An hour old: both timestamps move forward by the full TTL from now, and the same token
    // goes back out with a full Max-Age so the browser's copy slides too.
    const before = Date.now();
    app.db
      .prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`)
      .run(first.last_seen_at - 2 * HOUR, first.expires_at - 2 * HOUR, first.id);
    const slidRes = await app.api.get('/api/settings');
    expect(slidRes.status).toBe(200);
    const slid = only();
    expect(slid.last_seen_at).toBeGreaterThanOrEqual(before);
    expect(slid.expires_at).toBe(slid.last_seen_at + app.config.sessionTtlMs);
    expect(setCookie(slidRes)).toBe(issued);
    expect(issued).toMatch(new RegExp(`; Max-Age=${Math.floor(app.config.sessionTtlMs / 1000)}(;|$)`, 'i'));
  });

  it('never slides on a static file, whose answer is publicly cacheable', async () => {
    // A stand-in for dist/client: the shell and one fingerprinted asset.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clockspan-client-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>');
    fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    await app.close();
    app = await startTestApp({ authMode: 'local', clientDir: dir });
    try {
      const issued = setCookie(await app.api.post('/api/auth/setup', USER));
      const first = only();
      app.db
        .prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`)
        .run(first.last_seen_at - 2 * HOUR, first.expires_at - 2 * HOUR, first.id);
      // An hour-old session and a cookie on the request: the asset and the shell still answer
      // without a Set-Cookie, and the row is untouched.
      for (const p of ['/assets/index-abc123.js', '/']) {
        const r = await app.api.get(p);
        expect(r.status).toBe(200);
        expect(r.headers.getSetCookie()).toEqual([]);
      }
      expect(only().last_seen_at).toBe(first.last_seen_at - 2 * HOUR);
      // The next API call slides as usual.
      expect(setCookie(await app.api.get('/api/settings'))).toBe(issued);
      expect(only().last_seen_at).toBeGreaterThan(first.last_seen_at);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('revokeOtherSessions without a cookie of its own signs the user out everywhere', async () => {
    await app.api.post('/api/auth/setup', USER);
    await app.client().post('/api/auth/login', USER);
    expect(rows()).toHaveLength(2);
    const userId = (app.db.prepare(`SELECT user_id FROM auth_sessions LIMIT 1`).get() as { user_id: number }).user_id;
    revokeOtherSessions(app.db, { headers: {} } as Request, userId);
    expect(rows()).toHaveLength(0);
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
