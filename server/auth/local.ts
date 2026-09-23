import { Router } from 'express';
import type { DB, UserRow } from '../db.js';
import type { Config } from '../config.js';
import { DUMMY_HASH, hashPassword, validatePassword, validateUsername, verifyPassword } from './password.js';
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
    const { username, password } = req.body ?? {};
    const err = validateUsername(username) ?? validatePassword(password);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    const hash = await hashPassword(password);
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
      .run(username.trim(), hash, username.trim(), Date.now());
    createSession(db, config, res, Number(info.lastInsertRowid));
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid) as UserRow;
    console.log(`[auth] setup: admin ${logName(user.username)} created from ${req.ip}`);
    res.status(201).json({ user: publicUser(user) } satisfies UserResponse);
  });

  r.post('/login', async (req, res) => {
    // Only undefined once the socket is gone, when no answer can be sent anyway.
    const ip = String(req.ip);
    const gate = limiter.check(ip);
    if (!gate.ok) {
      console.warn(`[auth] login blocked from ${ip}: too many attempts`);
      res.setHeader('Retry-After', String(gate.retryAfterSec));
      res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfterSec / 60)} min.` });
      return;
    }
    // Counted now, before the hash: the check above and this line run without yielding, so
    // each of a burst of requests sees the ones before it. Counted after the await, a burst
    // would all pass the gate while the first was still hashing. A correct password clears it.
    limiter.fail(ip);
    const { username, password } = req.body ?? {};
    const user =
      typeof username === 'string'
        ? (db.prepare(`SELECT * FROM users WHERE kind = 'local' AND username = ?`).get(username.trim()) as UserRow | undefined)
        : undefined;
    // Always run the hash, against a dummy when the name is unknown, so timing can't tell
    // a wrong username from a wrong password.
    const ok = typeof password === 'string' && (await verifyPassword(password, user?.password_hash ?? DUMMY_HASH));
    if (!ok || !user) {
      console.warn(`[auth] login failed for ${logName(username)} from ${ip}`);
      res.status(401).json({ error: 'Incorrect username or password.' });
      return;
    }
    limiter.reset(ip);
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
    const { currentPassword, newPassword } = req.body ?? {};
    if (!user.password_hash || typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, user.password_hash))) {
      console.warn(`[auth] password change refused for ${logName(user.username)}: current password wrong`);
      res.status(400).json({ error: 'Current password is incorrect.' });
      return;
    }
    limiter.reset(key);
    const err = validatePassword(newPassword);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(await hashPassword(newPassword), user.id);
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
    const { username, password } = req.body ?? {};
    const err = validateUsername(username) ?? validatePassword(password);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    const name = username.trim();
    const hash = await hashPassword(password);
    // The uniqueness check is the insert itself: a pre-check before the hash could be overtaken
    // by a second create for the same name while this one was hashing.
    const info = db
      .prepare(
        `INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at)
         VALUES ('local', ?, ?, ?, 0, ?) ON CONFLICT(username) DO NOTHING`,
      )
      .run(name, hash, name, Date.now());
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
