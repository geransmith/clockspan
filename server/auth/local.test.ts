import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type Client, type TestApp } from '../dev/harness.js';
import { SESSION_COOKIE } from './session.js';

const ADMIN = { username: 'geran', password: 'correct horse' };

describe('AUTH_MODE=local', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp({ authMode: 'local' });
  });
  afterEach(() => app.close());

  const setup = (client: Client = app.api) => client.post('/api/auth/setup', ADMIN);

  it('asks for setup until the first user exists, then signs that user in', async () => {
    expect((await app.api.get('/api/auth/me')).body).toEqual({ mode: 'local', setupRequired: true, user: null });
    expect((await app.api.get('/api/settings')).status).toBe(401);

    const r = await setup();
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ username: 'geran', isAdmin: true, kind: 'local' });
    expect(app.api.cookies()).toHaveProperty(SESSION_COOKIE);
    expect((await app.api.get('/api/auth/me')).body).toMatchObject({ setupRequired: false, user: { username: 'geran' } });
    expect((await app.api.get('/api/settings')).status).toBe(200);

    // Setup is one-shot.
    expect((await setup(app.client())).status).toBe(403);
  });

  it('lets only one of two racing first visitors become admin', async () => {
    const [a, b] = await Promise.all([setup(app.client()), app.client().post('/api/auth/setup', { username: 'second', password: 'also long enough' })]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    expect((await app.api.get('/api/auth/me')).body.setupRequired).toBe(false);
  });

  it('validates the setup form', async () => {
    expect((await app.api.post('/api/auth/setup', { username: 'a', password: ADMIN.password })).status).toBe(400);
    expect((await app.api.post('/api/auth/setup', { username: 'ok name', password: ADMIN.password })).status).toBe(400);
    expect((await app.api.post('/api/auth/setup', { username: 'fine', password: 'short' })).status).toBe(400);
    expect((await app.api.get('/api/auth/me')).body.setupRequired).toBe(true);
  });

  it('logs in, logs out, and rate-limits bad attempts', async () => {
    await setup();
    const c = app.client();
    expect((await c.post('/api/auth/login', { username: 'geran', password: 'wrong' })).status).toBe(401);
    expect((await c.post('/api/auth/login', { username: 'nobody', password: ADMIN.password })).status).toBe(401);
    const ok = await c.post('/api/auth/login', { username: ' geran ', password: ADMIN.password });
    expect(ok.status).toBe(200);
    expect((await c.get('/api/settings')).status).toBe(200);

    expect((await c.post('/api/auth/logout')).body).toEqual({ ok: true });
    expect(c.cookies()).not.toHaveProperty(SESSION_COOKIE);
    expect((await c.get('/api/settings')).status).toBe(401);

    // A success cleared the counter; five failures from one address then lock the sixth
    // attempt, even with the right password.
    const d = app.client();
    for (let i = 0; i < 5; i++) expect((await d.post('/api/auth/login', { username: 'geran', password: 'wrong' })).status).toBe(401);
    const locked = await d.post('/api/auth/login', { username: 'geran', password: ADMIN.password });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('changes the password only with the current one', async () => {
    await setup();
    expect((await app.api.post('/api/auth/password', { currentPassword: 'nope', newPassword: 'new password' })).status).toBe(400);
    expect((await app.api.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'short' })).status).toBe(400);
    expect((await app.api.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'new password' })).body).toEqual({ ok: true });
    const c = app.client();
    expect((await c.post('/api/auth/login', { username: 'geran', password: ADMIN.password })).status).toBe(401);
    expect((await c.post('/api/auth/login', { username: 'geran', password: 'new password' })).status).toBe(200);
  });

  it('rate-limits current-password guesses per account, whatever the address', async () => {
    await setup();
    for (let i = 0; i < 5; i++) {
      expect((await app.api.post('/api/auth/password', { currentPassword: `guess ${i}`, newPassword: 'new password' })).status).toBe(400);
    }
    const locked = await app.api.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'new password' });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    // Still the old password: nothing was changed while locked.
    expect((await app.client().post('/api/auth/login', { username: 'geran', password: ADMIN.password })).status).toBe(200);
    // The lock is on the account, not the caller: another session of the same user is locked too.
    const other = app.client();
    await other.post('/api/auth/login', { username: 'geran', password: ADMIN.password });
    expect((await other.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'new password' })).status).toBe(429);
    // A login failure and a password-change failure count in separate buckets (address vs account).
    expect((await app.client().post('/api/auth/login', { username: 'geran', password: 'wrong' })).status).toBe(401);
  });

  it('answers 409, not 500, when two admins add the same username at once', async () => {
    await setup();
    const [a, b] = await Promise.all([
      app.api.post('/api/auth/users', { username: 'twin', password: 'twin password' }),
      app.api.post('/api/auth/users', { username: 'twin', password: 'twin password' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE username = 'twin'`).get()).toEqual({ n: 1 });
  });

  it('signs the other sessions out when the password changes, and keeps this one', async () => {
    await setup();
    const phone = app.client();
    expect((await phone.post('/api/auth/login', { username: 'geran', password: ADMIN.password })).status).toBe(200);
    expect((await phone.get('/api/settings')).status).toBe(200);

    expect((await app.api.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'new password' })).status).toBe(200);
    expect((await app.api.get('/api/settings')).status).toBe(200);
    expect((await phone.get('/api/settings')).status).toBe(401);
  });

  it('answers an unknown username exactly like a wrong password', async () => {
    await setup();
    const c = app.client();
    const unknown = await c.post('/api/auth/login', { username: 'nobody', password: ADMIN.password });
    const wrong = await c.post('/api/auth/login', { username: 'geran', password: 'wrong' });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('lets an admin manage users, and deleting one drops their data', async () => {
    await setup();
    const created = await app.api.post('/api/auth/users', { username: 'sam', password: 'sam password' });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ username: 'sam', isAdmin: false });
    expect((await app.api.post('/api/auth/users', { username: 'sam', password: 'sam password' })).status).toBe(409);
    expect((await app.api.post('/api/auth/users', { username: 'x', password: 'sam password' })).status).toBe(400);
    expect((await app.api.get('/api/auth/users')).body.users.map((u: { username: string }) => u.username)).toEqual(['geran', 'sam']);

    const sam = app.client();
    await sam.post('/api/auth/login', { username: 'sam', password: 'sam password' });
    expect((await sam.get('/api/auth/users')).status).toBe(403);
    expect((await sam.post('/api/auth/users', { username: 'eve', password: 'eve password' })).status).toBe(403);
    await sam.put('/api/days/2026-09-01/punches', { punches: [{ at: Date.UTC(2026, 8, 1, 8) }, { at: null }, { at: null }, { at: null }] });
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM days`).get()).toEqual({ n: 1 });

    expect((await app.api.del(`/api/auth/users/${created.body.user.id}`)).body).toEqual({ ok: true });
    expect((await app.api.del(`/api/auth/users/${created.body.user.id}`)).status).toBe(404);
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM days`).get()).toEqual({ n: 0 });
    expect((await sam.get('/api/settings')).status).toBe(401);

    const me = (await app.api.get('/api/auth/me')).body.user.id;
    expect((await app.api.del(`/api/auth/users/${me}`)).status).toBe(400);
  });

  it('answers 401 as JSON for unauthenticated data routes', async () => {
    // Unknown /api paths sit behind the same gate, so they are 401 too, not 404.
    for (const path of ['/api/days', '/api/days/2026-09-01', '/api/sessions/running', '/api/nope']) {
      const r = await app.api.get(path);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'unauthenticated' });
    }
  });
});

describe('AUTH_MODE=none', () => {
  it('is always the default user', async () => {
    const app = await startTestApp();
    try {
      const r = await app.api.get('/api/auth/me');
      expect(r.body).toMatchObject({ mode: 'none', setupRequired: false, user: { kind: 'default', isAdmin: true } });
      expect((await app.api.get('/api/health')).body).toEqual({ ok: true });
      expect((await app.api.post('/api/auth/login', {})).status).toBe(404);
      expect((await app.api.get('/api/nope')).body).toEqual({ error: 'Not found.' });
    } finally {
      await app.close();
    }
  });
});
