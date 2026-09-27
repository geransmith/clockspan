import { isIPv6 } from 'node:net';
import { Router } from 'express';
import { findLocalUser, type DB, type UserRow } from '../db.js';
import type { Config } from '../config.js';
import { DUMMY_HASH, hashPassword, parseCredentials, parsePassword, verifyPassword } from './password.js';
import { createSession, destroySession, revokeOtherSessions } from './session.js';
import { currentUser, requireAdmin, requireAuth } from './middleware.js';
import type { AuthInfo, OkResponse, PublicUser, UserResponse, UsersResponse } from '../../shared/api.js';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;
// Expired entries are swept once the map grows past this, so a spray of addresses can't
// make it grow without bound.
const SWEEP_ABOVE = 1000;

/** Simple per-IP login limiter. In-memory is fine for a single-process self-hosted app. */
export class LoginLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  check(ip: string): { ok: boolean; retryAfterSec: number } {
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt <= Date.now()) return { ok: true, retryAfterSec: 0 };
    if (entry.count >= MAX_ATTEMPTS) {
      return { ok: false, retryAfterSec: Math.ceil((entry.resetAt - Date.now()) / 1000) };
    }
    return { ok: true, retryAfterSec: 0 };
  }

  fail(ip: string): void {
    const now = Date.now();
    if (this.attempts.size >= SWEEP_ABOVE) {
      for (const [k, v] of this.attempts) if (v.resetAt <= now) this.attempts.delete(k);
    }
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt <= now) this.attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    else entry.count += 1;
  }

  reset(ip: string): void {
    this.attempts.delete(ip);
  }
}

/**
 * What the login limiter counts an address under. An IPv6 client is usually handed a whole
 * /64, so keyed by the full address it could take a fresh five attempts from each of 2^64
 * addresses; the /64 is the client. An IPv4 address a dual-stack socket reports as
 * `::ffff:a.b.c.d` is that IPv4 address.
 */
export function limiterKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail] = ip.split('%')[0]!.split('::');
  // A dotted IPv4 tail fills the last two groups.
  const groups = (s: string) => (s ? s.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])) : []);
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const full = [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return `${full
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * A name as it goes into a log line: quoted and cut short, so whatever was typed into the
 * login form (a newline, say) cannot forge a line of its own. Every auth event is logged once
 * because, with the port on the internet, the log is how a password-guessing run or a locked
 * out household member gets noticed.
 */
export function logName(name: unknown): string {
  return JSON.stringify(typeof name === 'string' ? name.slice(0, 40) : '');
}

export function publicUser(u: UserRow): PublicUser {
  return { id: u.id, name: u.display_name, username: u.username, isAdmin: Boolean(u.is_admin), kind: u.kind };
}

function userCount(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE kind = 'local'`).get() as { n: number }).n;
}

export function localAuthRouter(db: DB, config: Config): Router {
  const r = Router();
  const limiter = new LoginLimiter();

  r.get('/me', (req, res) => {
    res.json({
      mode: 'local',
      setupRequired: userCount(db) === 0,
      user: req.user ? publicUser(req.user) : null,
      cookieSecure: config.cookieSecure,
    } satisfies AuthInfo);
  });

  r.post('/setup', async (req, res) => {
    if (userCount(db) > 0) {
      res.status(403).json({ error: 'Setup has already been completed.' });
      return;
    }
    const creds = parseCredentials(req.body);
    if ('error' in creds) {
      res.status(400).json({ error: creds.error });
      return;
    }
    const hash = await hashPassword(creds.password);
    // Re-check after the await: two first visitors racing each other must not both become
    // admin. The check and the insert below run without yielding, so this one is decisive.
    if (userCount(db) > 0) {
      res.status(403).json({ error: 'Setup has already been completed.' });
      return;
    }
    const info = db
      .prepare(
        `INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at)
         VALUES ('local', ?, ?, ?, 1, ?)`,
      )
      .run(creds.username, hash, creds.username, Date.now());
    createSession(db, config, res, Number(info.lastInsertRowid));
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid) as UserRow;
    console.log(`[auth] setup: admin ${logName(user.username)} created from ${req.ip}`);
    res.status(201).json({ user: publicUser(user) } satisfies UserResponse);
  });

  r.post('/login', async (req, res) => {
    // Only undefined once the socket is gone, when no answer can be sent anyway.
    const ip = String(req.ip);
    const key = limiterKey(ip);
    const gate = limiter.check(key);
    if (!gate.ok) {
      console.warn(`[auth] login blocked from ${ip}: too many attempts`);
      res.setHeader('Retry-After', String(gate.retryAfterSec));
      res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfterSec / 60)} min.` });
      return;
    }
    // Counted now, before the hash: the check above and this line run without yielding, so
    // each of a burst of requests sees the ones before it. Counted after the await, a burst
    // would all pass the gate while the first was still hashing. A correct password clears it.
    limiter.fail(key);
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const user = typeof username === 'string' ? findLocalUser(db, username.trim()) : undefined;
    // Always run the hash, against a dummy when the name is unknown, so timing can't tell
    // a wrong username from a wrong password.
    const ok = typeof password === 'string' && (await verifyPassword(password, user?.password_hash ?? DUMMY_HASH));
    if (!ok || !user) {
      console.warn(`[auth] login failed for ${logName(username)} from ${ip}`);
      res.status(401).json({ error: 'Incorrect username or password.' });
      return;
    }
    limiter.reset(key);
    createSession(db, config, res, user.id);
    console.log(`[auth] ${logName(user.username)} signed in from ${ip}`);
    res.json({ user: publicUser(user) } satisfies UserResponse);
  });

  r.post('/logout', (req, res) => {
    destroySession(db, config, req, res);
    res.json({ ok: true } satisfies OkResponse);
  });

  // The current-password check is a login in disguise: a stolen cookie must not be able to
  // guess it at scrypt speed. Same limiter, keyed by the account rather than the address.
  r.post('/password', requireAuth, async (req, res) => {
    const user = currentUser(req);
    const key = `user:${user.id}`;
    const gate = limiter.check(key);
    if (!gate.ok) {
      console.warn(`[auth] password change blocked for ${logName(user.username)}: too many attempts`);
      res.setHeader('Retry-After', String(gate.retryAfterSec));
      res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfterSec / 60)} min.` });
      return;
    }
    // Counted before the hash, like a login.
    limiter.fail(key);
    const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    if (!user.password_hash || typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, user.password_hash))) {
      console.warn(`[auth] password change refused for ${logName(user.username)}: current password wrong`);
      res.status(400).json({ error: 'Current password is incorrect.' });
      return;
    }
    limiter.reset(key);
    const next = parsePassword(newPassword);
    if ('error' in next) {
      res.status(400).json({ error: next.error });
      return;
    }
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(await hashPassword(next.password), user.id);
    // A changed password is usually "someone else may have the old one": drop every other session.
    revokeOtherSessions(db, req, user.id);
    console.log(`[auth] password changed for ${logName(user.username)}; other sessions signed out`);
    res.json({ ok: true } satisfies OkResponse);
  });

  // Admin user management. Deleting a user cascades all of their data.
  r.get('/users', requireAdmin, (_req, res) => {
    const rows = db.prepare(`SELECT * FROM users WHERE kind = 'local' ORDER BY created_at`).all() as UserRow[];
    res.json({ users: rows.map(publicUser) } satisfies UsersResponse);
  });

  r.post('/users', requireAdmin, async (req, res) => {
    const creds = parseCredentials(req.body);
    if ('error' in creds) {
      res.status(400).json({ error: creds.error });
      return;
    }
    const name = creds.username;
    const hash = await hashPassword(creds.password);
    // The uniqueness check is part of the insert: a pre-check before the hash could be
    // overtaken by a second create for the same name while this one was hashing. It ignores
    // case, as sign-in does, so "Sam" can't be added beside "sam".
    const info = db
      .prepare(
        `INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at)
         SELECT 'local', @name, @hash, @name, 0, @now
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = @name COLLATE NOCASE)`,
      )
      .run({ name, hash, now: Date.now() });
    if (info.changes === 0) {
      res.status(409).json({ error: 'That username is already taken.' });
      return;
    }
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid) as UserRow;
    console.log(`[auth] user ${logName(name)} created by ${logName(currentUser(req).username)}`);
    res.status(201).json({ user: publicUser(user) } satisfies UserResponse);
  });

  r.delete('/users/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const me = currentUser(req);
    if (id === me.id) {
      res.status(400).json({ error: 'You cannot delete your own account.' });
      return;
    }
    const info = db.prepare(`DELETE FROM users WHERE id = ? AND kind = 'local'`).run(id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    console.log(`[auth] user #${id} and their data deleted by ${logName(me.username)}`);
    res.json({ ok: true } satisfies OkResponse);
  });

  return r;
}
