import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETUP_CODE, startTestApp, type Client, type TestApp } from '../dev/harness.js';
import { SESSION_COOKIE } from './session.js';
import { MAX_ACCOUNT_FAILURES } from './limiter.js';
import { newSetupCode, setupCodeMatches } from './local.js';
import { hashPassword } from './password.js';
import { currentUser } from './middleware.js';
import type { Request } from 'express';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db.js';

const ADMIN = { username: 'geran', password: 'correct horse' };
const FIRST_RUN = { ...ADMIN, setupCode: SETUP_CODE };

describe('AUTH_MODE=local', () => {
  let app: TestApp;
  // Every auth event writes a log line; keep them out of the test output.
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app = await startTestApp({ authMode: 'local' });
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  const setup = (client: Client = app.api) => client.post('/api/auth/setup', FIRST_RUN);
  // A sign-in the proxy says came from `ip`; the app must be started with TRUST_PROXY.
  const loginFrom = (ip: string, username = ADMIN.username, password = 'wrong') =>
    fetch(`${app.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ username, password }),
    });

  it('asks for setup until the first user exists, then signs that user in', async () => {
    expect((await app.api.get('/api/auth/me')).body).toEqual({ mode: 'local', setupRequired: true, user: null, cookieSecure: false });
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

  it('tells the sign-in page when the cookie is Secure, so it can warn a plain-http visitor', async () => {
    await app.close();
    app = await startTestApp({ authMode: 'local', env: { APP_URL: 'https://focus.example.com' } });
    expect((await app.api.get('/api/auth/me')).body.cookieSecure).toBe(true);
  });

  it('takes setup only with the code from the server log, whatever its case or dashes', async () => {
    const wrong = await app.api.post('/api/auth/setup', { ...ADMIN, setupCode: 'AAAA-BBBB-CCCC' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toMatch(/server log/);
    expect((await app.api.post('/api/auth/setup', ADMIN)).status).toBe(403);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/setup refused .*wrong setup code/));
    expect((await app.api.get('/api/auth/me')).body.setupRequired).toBe(true);
    const typed = ` ${SETUP_CODE.toLowerCase().replaceAll('-', ' ')} `;
    expect((await app.api.post('/api/auth/setup', { ...ADMIN, setupCode: typed })).status).toBe(201);
  });

  it('counts wrong setup codes against the address like failed sign-ins', async () => {
    for (let i = 0; i < 5; i++) expect((await app.api.post('/api/auth/setup', { ...ADMIN, setupCode: 'nope' })).status).toBe(403);
    const locked = await setup();
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('prints a fresh code in the log until the first account exists, and not after', async () => {
    log.mockClear();
    const db = openDatabase(':memory:');
    const config = loadConfig({ AUTH_MODE: 'local' });
    createApp(db, config);
    const line = (log.mock.calls as unknown[][]).map(([m]) => String(m)).find((m) => m.includes('setup page asks for this code'));
    const code = /([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})$/.exec(line ?? '')?.[1];
    expect(code).toBeDefined();
    expect(code).not.toBe(SETUP_CODE);
    db.prepare(`INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at) VALUES ('local', 'x', 'h', 'x', 1, 0)`).run();
    log.mockClear();
    createApp(db, config);
    expect(log.mock.calls.flat().join('\n')).not.toContain('setup page asks for this code');
    db.close();
  });

  it('lets only one of two racing first visitors become admin', async () => {
    const [a, b] = await Promise.all([
      setup(app.client()),
      app.client().post('/api/auth/setup', { username: 'second', password: 'also long enough', setupCode: SETUP_CODE }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 403]);
    expect((await app.api.get('/api/auth/me')).body.setupRequired).toBe(false);
  });

  it('validates the setup form', async () => {
    expect((await app.api.post('/api/auth/setup', { ...FIRST_RUN, username: 'a' })).status).toBe(400);
    expect((await app.api.post('/api/auth/setup', { ...FIRST_RUN, username: 'ok name' })).status).toBe(400);
    expect((await app.api.post('/api/auth/setup', { ...FIRST_RUN, username: 'fine', password: 'short' })).status).toBe(400);
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

    // The success took back only its own attempt: the two failures before it still count, so
    // three more from the same address lock the next attempt, even with the right password.
    const d = app.client();
    for (let i = 0; i < 3; i++) expect((await d.post('/api/auth/login', { username: 'geran', password: 'wrong' })).status).toBe(401);
    const locked = await d.post('/api/auth/login', { username: 'geran', password: ADMIN.password });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);

    // The log says who signed in and which attempts failed, with the name quoted so a typed
    // newline cannot forge a line, and never the password.
    expect(log).toHaveBeenCalledWith('[auth] "geran" signed in from 127.0.0.1');
    expect(warn).toHaveBeenCalledWith('[auth] login failed for "nobody" from 127.0.0.1');
    expect(warn).toHaveBeenCalledWith('[auth] login blocked from 127.0.0.1: too many attempts');
    const lines = [...log.mock.calls, ...warn.mock.calls].map((c) => String(c[0]));
    expect(lines.some((l) => l.includes(ADMIN.password) || l.includes('wrong'))).toBe(false);
  });

  it('keeps counting guesses when the same address signs in to another account between them', async () => {
    await setup();
    await app.api.post('/api/auth/users', { username: 'sam', password: 'sam password' });
    const c = app.client();
    const guess = () => c.post('/api/auth/login', { username: 'geran', password: 'a guess' });
    for (let i = 0; i < 4; i++) expect((await guess()).status).toBe(401);
    expect((await c.post('/api/auth/login', { username: 'sam', password: 'sam password' })).status).toBe(200);
    expect((await guess()).status).toBe(401);
    expect((await guess()).status).toBe(429);
  });

  it('counts attempts sent at once, so a burst cannot get past the limit while the first is hashing', async () => {
    await setup();
    const c = app.client();
    const burst = await Promise.all(Array.from({ length: 10 }, () => c.post('/api/auth/login', { username: 'geran', password: 'wrong' })));
    expect(burst.map((r) => r.status).sort((x, y) => x - y)).toEqual([...Array<number>(5).fill(401), ...Array<number>(5).fill(429)]);
  });

  it('counts an IPv6 client by its /64, so rotating through its own addresses gets no fresh attempts', async () => {
    await app.close();
    app = await startTestApp({ authMode: 'local', env: { TRUST_PROXY: '1' } });
    await setup();
    const from = (ip: string) => loginFrom(ip).then((r) => r.status);
    for (let i = 1; i <= 5; i++) expect(await from(`2001:db8:1:2::${i}`)).toBe(401);
    expect(await from('2001:db8:1:2:ffff::1')).toBe(429);
    // The next /64 over, and an IPv4 client, are someone else.
    expect(await from('2001:db8:1:3::1')).toBe(401);
    expect(await from('203.0.113.9')).toBe(401);
  });

  it('caps failures per account across addresses, whatever the case or spacing of the name', { timeout: 30_000 }, async () => {
    await app.close();
    app = await startTestApp({ authMode: 'local', env: { TRUST_PROXY: '1' } });
    await setup();
    // Five guesses from each of ten addresses: no address reaches its own limit.
    const guesses = Array.from({ length: MAX_ACCOUNT_FAILURES }, (_, i) => loginFrom(`203.0.113.${Math.floor(i / 5)}`, i % 2 ? 'GERAN' : ' geran '));
    expect(new Set((await Promise.all(guesses)).map((r) => r.status))).toEqual(new Set([401]));
    // Now the account is locked, from a fresh address and with the right password too.
    const locked = await loginFrom('198.51.100.1', 'geran', ADMIN.password);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith('[auth] login blocked for "geran" from 198.51.100.1: too many failures on this account');
    // Another name from the same address is still only a wrong password.
    expect((await loginFrom('198.51.100.1', 'nobody')).status).toBe(401);
  });

  it('cuts a long or odd username short in the log', async () => {
    await setup();
    const c = app.client();
    expect((await c.post('/api/auth/login', { username: `a\n${'b'.repeat(60)}`, password: 'x' })).status).toBe(401);
    expect(warn).toHaveBeenCalledWith(`[auth] login failed for ${JSON.stringify(`a\n${'b'.repeat(38)}`)} from 127.0.0.1`);
    expect((await c.post('/api/auth/login', { username: 42, password: 'x' })).status).toBe(401);
    expect(warn).toHaveBeenCalledWith('[auth] login failed for "" from 127.0.0.1');
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

  it('rate-limits current-password guesses per account, from any of its sessions', async () => {
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

  it('counts current-password guesses sent at once the same way', async () => {
    await setup();
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => app.api.post('/api/auth/password', { currentPassword: `guess ${i}`, newPassword: 'new password' })),
    );
    expect(burst.map((r) => r.status).sort((x, y) => x - y)).toEqual([...Array<number>(5).fill(400), ...Array<number>(5).fill(429)]);
  });

  it('answers 409, not 500, when the same username is added twice at once', async () => {
    await setup();
    const [a, b] = await Promise.all([
      app.api.post('/api/auth/users', { username: 'twin', password: 'twin password' }),
      app.api.post('/api/auth/users', { username: 'twin', password: 'twin password' }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);
    expect(app.count('users', `username = 'twin'`)).toBe(1);
  });

  it('matches usernames whatever their case, at sign-in and when adding a user', async () => {
    await setup();
    const phone = app.client();
    expect((await phone.post('/api/auth/login', { username: ' Geran ', password: ADMIN.password })).body.user).toMatchObject({ username: 'geran' });

    expect((await app.api.post('/api/auth/users', { username: 'Sam', password: 'sam password' })).status).toBe(201);
    for (const username of ['sam', 'SAM', 'Sam']) {
      expect((await app.api.post('/api/auth/users', { username, password: 'other password' })).body).toEqual({ error: 'That username is already taken.' });
    }
    expect((await phone.post('/api/auth/login', { username: 'sam', password: 'sam password' })).body.user).toMatchObject({ username: 'Sam' });
  });

  it('keeps both spellings working where an older install already has them, the exact one first', async () => {
    await setup();
    await app.api.post('/api/auth/users', { username: 'Twin', password: 'upper password' });
    app.db
      .prepare(`INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at) VALUES ('local', 'twin', ?, 'twin', 0, ?)`)
      .run(await hashPassword('lower password'), Date.now());
    const c = app.client();
    expect((await c.post('/api/auth/login', { username: 'twin', password: 'lower password' })).body.user).toMatchObject({ username: 'twin' });
    expect((await c.post('/api/auth/login', { username: 'Twin', password: 'upper password' })).body.user).toMatchObject({ username: 'Twin' });
    // Neither is exact: the older account.
    expect((await c.post('/api/auth/login', { username: 'TWIN', password: 'upper password' })).body.user).toMatchObject({ username: 'Twin' });
  });

  it('signs every session out when the password changes and gives this one a new cookie', async () => {
    await setup();
    const phone = app.client();
    expect((await phone.post('/api/auth/login', { username: 'geran', password: ADMIN.password })).status).toBe(200);
    expect((await phone.get('/api/settings')).status).toBe(200);
    const before = app.api.cookies()[SESSION_COOKIE];

    expect((await app.api.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'new password' })).status).toBe(200);
    expect(app.api.cookies()[SESSION_COOKIE]).not.toBe(before);
    expect((await fetch(`${app.url}/api/settings`, { headers: { cookie: `${SESSION_COOKIE}=${before}` } })).status).toBe(401);
    expect((await app.api.get('/api/settings')).status).toBe(200);
    expect((await phone.get('/api/settings')).status).toBe(401);
    expect(app.count('auth_sessions')).toBe(1);
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
    const adminId = (await setup()).body.user.id;
    const created = await app.api.post('/api/auth/users', { username: 'sam', password: 'sam password' });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ username: 'sam', isAdmin: false });
    expect((await app.api.post('/api/auth/users', { username: 'sam', password: 'sam password' })).status).toBe(409);
    expect((await app.api.post('/api/auth/users', { username: 'x', password: 'sam password' })).status).toBe(400);
    expect((await app.api.get('/api/auth/users')).body.users.map((u: { username: string }) => u.username)).toEqual(['geran', 'sam']);

    const sam = app.client();
    await sam.post('/api/auth/login', { username: 'sam', password: 'sam password' });
    await sam.post('/api/auth/password', { currentPassword: 'sam password', newPassword: 'sam chose this' });
    const refused = await sam.get('/api/auth/users');
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'Only an admin can do that.' });
    expect((await sam.post('/api/auth/users', { username: 'eve', password: 'eve password' })).status).toBe(403);
    expect(await sam.del(`/api/auth/users/${adminId}`)).toMatchObject({ status: 403, body: { error: 'Only an admin can do that.' } });
    expect(app.count('users', 'id = ?', adminId)).toBe(1);
    await sam.put('/api/days/2026-09-01/punches', { punches: [{ at: Date.UTC(2026, 8, 1, 8) }, { at: null }, { at: null }, { at: null }] });
    expect((await sam.put('/api/days/2026-09-01/retro', { note: 'note only sam wrote' })).status).toBe(200);
    expect(app.count('days')).toBe(1);

    expect((await app.api.del(`/api/auth/users/${created.body.user.id}`)).body).toEqual({ ok: true });
    expect((await app.api.del(`/api/auth/users/${created.body.user.id}`)).status).toBe(404);
    expect(app.count('days')).toBe(0);
    // Compacted: the deleted text is not left behind in a free page.
    expect(app.db.serialize().includes('note only sam wrote')).toBe(false);
    expect((await sam.get('/api/settings')).status).toBe(401);

    expect((await app.api.del(`/api/auth/users/${adminId}`)).status).toBe(400);
    // Only local accounts: the user AUTH_MODE=none left behind is not one.
    const leftover = app.db.prepare(`INSERT INTO users (kind, display_name, is_admin, created_at) VALUES ('default', 'You', 1, 0)`).run().lastInsertRowid;
    expect((await app.api.del(`/api/auth/users/${leftover}`)).status).toBe(404);
    expect(app.count('users', `kind = 'default'`)).toBe(1);
  });

  it('has a user an admin added choose their own password before anything else', async () => {
    await setup();
    expect((await app.api.get('/api/auth/me')).body.user.mustChangePassword).toBe(false);
    await app.api.post('/api/auth/users', { username: 'sam', password: 'temporary pw' });
    const listed = (await app.api.get('/api/auth/users')).body.users.map((u: { username: string; mustChangePassword: boolean }) => [
      u.username,
      u.mustChangePassword,
    ]);
    expect(listed).toEqual([
      ['geran', false],
      ['sam', true],
    ]);

    const sam = app.client();
    expect((await sam.post('/api/auth/login', { username: 'sam', password: 'temporary pw' })).body.user.mustChangePassword).toBe(true);
    // Only the password change is open: data routes, reads and writes, answer 403.
    const blocked = await sam.get('/api/settings');
    expect(blocked.status).toBe(403);
    expect(blocked.body).toEqual({ error: 'Choose a new password first.' });
    expect((await sam.put('/api/days/2026-09-01/punches', { punches: [] })).status).toBe(403);
    // Keeping the temporary password is not choosing one.
    expect((await sam.post('/api/auth/password', { currentPassword: 'temporary pw', newPassword: 'temporary pw' })).status).toBe(400);
    expect((await sam.post('/api/auth/password', { currentPassword: 'temporary pw', newPassword: 'sam chose this' })).body).toEqual({ ok: true });
    expect((await sam.get('/api/auth/me')).body.user.mustChangePassword).toBe(false);
    expect((await sam.get('/api/settings')).status).toBe(200);
  });

  it('keeps an admin on a temporary password out of user management as well', async () => {
    await setup();
    // The flag a reset without a password sets (`resetPassword`), without the new password and the sign-out that come with it.
    app.db.prepare(`UPDATE users SET must_change_password = 1`).run();
    expect((await app.api.get('/api/auth/users')).status).toBe(403);
    expect((await app.api.del('/api/auth/users/999')).status).toBe(403);
    expect((await app.api.get('/api/days/2026-09-01')).status).toBe(403);
    // Choosing their own opens everything again.
    expect((await app.api.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'a new one' })).body).toEqual({ ok: true });
    expect((await app.api.get('/api/auth/users')).status).toBe(200);
  });

  it('answers the same errors when a request carries no body at all', async () => {
    const bare = (path: string, cookie?: string) => fetch(app.url + path, { method: 'POST', headers: cookie ? { cookie } : {} });
    // No body is no setup code.
    expect((await bare('/api/auth/setup')).status).toBe(403);
    await setup();
    expect((await bare('/api/auth/login')).status).toBe(401);
    expect((await app.api.post('/api/auth/login', { username: 42, password: ADMIN.password })).status).toBe(401);
    const cookie = `${SESSION_COOKIE}=${app.api.cookies()[SESSION_COOKIE]}`;
    expect((await bare('/api/auth/password', cookie)).status).toBe(400);
    expect((await bare('/api/auth/users', cookie)).status).toBe(400);
  });

  it('answers 401 as JSON for unauthenticated data routes', async () => {
    // Unknown /api paths sit behind the same gate, so they are 401 too, not 404.
    for (const path of ['/api/days', '/api/days/2026-09-01', '/api/sessions/running', '/api/nope']) {
      const r = await app.api.get(path);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'Not signed in.' });
    }
    // The auth routes that need a user are not behind the data gate; they answer 401 themselves, before any 403.
    for (const send of [
      () => app.api.get('/api/auth/users'),
      () => app.api.post('/api/auth/users', { username: 'eve', password: 'eve password' }),
      () => app.api.del('/api/auth/users/1'),
      () => app.api.post('/api/auth/password', { currentPassword: 'x', newPassword: 'long enough' }),
    ]) {
      expect(await send()).toMatchObject({ status: 401, body: { error: 'Not signed in.' } });
    }
  });
});

describe('currentUser', () => {
  it('refuses to be used on a request that never went through requireAuth', () => {
    expect(() => currentUser({} as Request)).toThrow(/requireAuth/);
  });
});

describe('setup codes', () => {
  it('are twelve unambiguous characters in threes of four, new each time', () => {
    const codes = new Set(Array.from({ length: 50 }, newSetupCode));
    expect(codes.size).toBe(50);
    for (const c of codes) expect(c).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });

  it('match whatever the case, spacing or dashes, and never a non-string', () => {
    expect(setupCodeMatches('ABCD-EFGH-JKMN', 'abcd efgh jkmn')).toBe(true);
    expect(setupCodeMatches('ABCD-EFGH-JKMN', 'ABCDEFGHJKMN')).toBe(true);
    expect(setupCodeMatches('ABCD-EFGH-JKMN', 'ABCD-EFGH-JKMP')).toBe(false);
    expect(setupCodeMatches('ABCD-EFGH-JKMN', 42)).toBe(false);
  });
});

describe('AUTH_MODE=none', () => {
  it('is always the default user', async () => {
    const app = await startTestApp();
    try {
      const r = await app.api.get('/api/auth/me');
      expect(r.body).toMatchObject({ mode: 'none', setupRequired: false, user: { kind: 'default', isAdmin: true }, cookieSecure: false });
      expect((await app.api.get('/api/health')).body).toEqual({ ok: true });
      expect((await app.api.post('/api/auth/login', {})).status).toBe(404);
      expect((await app.api.get('/api/nope')).body).toEqual({ error: 'Not found.' });
    } finally {
      await app.close();
    }
  });
});
