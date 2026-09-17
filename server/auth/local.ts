import { Router } from 'express';
import type Database from 'better-sqlite3';
import type { DB, UserRow } from '../db.js';
import type { Config } from '../config.js';
import { DUMMY_HASH, hashPassword, validatePassword, validateUsername, verifyPassword } from './password.js';
import { createSession, destroySession, revokeOtherSessions } from './session.js';
import { currentUser, requireAdmin, requireAuth } from './middleware.js';
import type { AuthInfo, PublicUser } from '../../shared/api.js';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;
// Expired entries are swept once the map grows past this, so a spray of addresses can't
// make it grow without bound.
const SWEEP_ABOVE = 1000;

/** Simple per-IP login limiter. In-memory is fine for a single-process self-hosted app. */
class LoginLimiter {
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
    const info: AuthInfo = {
      mode: 'local',
      setupRequired: userCount(db) === 0,
      user: req.user ? publicUser(req.user) : null,
    };
    res.json(info);
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
    res.status(201).json({ user: publicUser(user) });
  });

  r.post('/login', async (req, res) => {
    const ip = req.ip ?? 'unknown';
    const gate = limiter.check(ip);
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfterSec));
      res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfterSec / 60)} min.` });
      return;
    }
    const { username, password } = req.body ?? {};
    const user =
      typeof username === 'string'
        ? (db.prepare(`SELECT * FROM users WHERE kind = 'local' AND username = ?`).get(username.trim()) as
            | UserRow
            | undefined)
        : undefined;
    // Always run the hash, against a dummy when the name is unknown, so timing can't tell
    // a wrong username from a wrong password.
    const ok = typeof password === 'string' && (await verifyPassword(password, user?.password_hash ?? DUMMY_HASH));
    if (!ok || !user) {
      limiter.fail(ip);
      res.status(401).json({ error: 'Incorrect username or password.' });
      return;
    }
    limiter.reset(ip);
    createSession(db, config, res, user.id);
    res.json({ user: publicUser(user) });
  });

  r.post('/logout', (req, res) => {
    destroySession(db, config, req, res);
    res.json({ ok: true });
  });

  // The current-password check is a login in disguise: a stolen cookie must not be able to
  // guess it at scrypt speed. Same limiter, keyed by the account rather than the address.
  r.post('/password', requireAuth, async (req, res) => {
    const user = currentUser(req);
    const key = `user:${user.id}`;
    const gate = limiter.check(key);
    if (!gate.ok) {
      res.setHeader('Retry-After', String(gate.retryAfterSec));
      res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfterSec / 60)} min.` });
      return;
    }
    const { currentPassword, newPassword } = req.body ?? {};
    if (!user.password_hash || typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, user.password_hash))) {
      limiter.fail(key);
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
    res.json({ ok: true });
  });

  // Admin user management. Deleting a user cascades all of their data.
  r.get('/users', requireAdmin, (_req, res) => {
    const rows = db.prepare(`SELECT * FROM users WHERE kind = 'local' ORDER BY created_at`).all() as UserRow[];
    res.json({ users: rows.map(publicUser) });
  });

  r.post('/users', requireAdmin, async (req, res) => {
    const { username, password } = req.body ?? {};
    const err = validateUsername(username) ?? validatePassword(password);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    const name = username.trim();
    if (db.prepare(`SELECT 1 FROM users WHERE username = ?`).get(name)) {
      res.status(409).json({ error: 'That username is already taken.' });
      return;
    }
    const hash = await hashPassword(password);
    let info: Database.RunResult;
    try {
      info = db
        .prepare(
          `INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at)
           VALUES ('local', ?, ?, ?, 0, ?)`,
        )
        .run(name, hash, name, Date.now());
    } catch (err) {
      // The check above ran before the hash; a second create for the same name can land in between.
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        res.status(409).json({ error: 'That username is already taken.' });
        return;
      }
      throw err;
    }
    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid) as UserRow;
    res.status(201).json({ user: publicUser(user) });
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
    res.json({ ok: true });
  });

  return r;
}
