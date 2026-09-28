import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { findLocalUser, findUserById, type DB, type UserRow } from '../db.js';
import type { Config } from '../config.js';
import { DUMMY_HASH, hashPassword, parseCredentials, parsePassword, verifyPassword } from './password.js';
import { createSession, destroySession, revokeOtherSessions } from './session.js';
import { currentUser, requireAdmin, requireAuth } from './middleware.js';
import { accountKey, LoginLimiter, limiterKey, MAX_ACCOUNT_FAILURES, refuseTooMany, warnUntrustedProxy } from './limiter.js';
import { logName, publicUser } from './users.js';
import type { AuthInfo, OkResponse, UserResponse, UsersResponse } from '../../shared/api.js';

/** Letters and digits that can't be read as one another: no 0/O, no 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A first-run setup code: twelve characters in threes of four, about 59 bits. */
export function newSetupCode(): string {
  const chars = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

/** A typed code against the real one, whatever its case, spacing or dashes, in constant time. */
export function setupCodeMatches(expected: string, typed: unknown): boolean {
  const norm = (s: string) =>
    createHash('sha256')
      .update(s.toUpperCase().replace(/[^A-Z0-9]/g, ''))
      .digest();
  return typeof typed === 'string' && timingSafeEqual(norm(expected), norm(typed));
}

function userCount(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE kind = 'local'`).get() as { n: number }).n;
}

/**
 * `setupCode` is only fixed by tests; a server makes a new one each start. Until the first
 * account exists it is printed in the log, and setup asks for it: a stranger who reaches a
 * fresh install before its owner has no way to read the log, so can't make themselves admin.
 */
export function localAuthRouter(db: DB, config: Config, setupCode: string = newSetupCode()): Router {
  const r = Router();
  const limiter = new LoginLimiter();
  const accounts = new LoginLimiter(MAX_ACCOUNT_FAILURES);
  r.use(warnUntrustedProxy(config));
  if (userCount(db) === 0) console.log(`[auth] No account yet. The setup page asks for this code: ${setupCode}`);

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
    // Wrong codes count against the address like failed sign-ins do.
    const key = limiterKey(String(req.ip));
    const gate = limiter.check(key);
    if (!gate.ok) {
      refuseTooMany(res, gate.retryAfterSec);
      return;
    }
    if (!setupCodeMatches(setupCode, (req.body as { setupCode?: unknown } | undefined)?.setupCode)) {
      limiter.fail(key);
      console.warn(`[auth] setup refused from ${req.ip}: wrong setup code`);
      res.status(403).json({ error: "That setup code doesn't match the one in the server log." });
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
    const user = findUserById(db, info.lastInsertRowid)!;
    console.log(`[auth] setup: admin ${logName(user.username)} created from ${req.ip}`);
    res.status(201).json({ user: publicUser(user) } satisfies UserResponse);
  });

  r.post('/login', async (req, res) => {
    // Only undefined once the socket is gone, when no answer can be sent anyway.
    const ip = String(req.ip);
    const key = limiterKey(ip);
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const account = accountKey(username);
    const gate = limiter.check(key);
    const accountGate = accounts.check(account);
    if (!gate.ok || !accountGate.ok) {
      const retryAfterSec = Math.max(gate.retryAfterSec, accountGate.retryAfterSec);
      console.warn(
        gate.ok
          ? `[auth] login blocked for ${logName(username)} from ${ip}: too many failures on this account`
          : `[auth] login blocked from ${ip}: too many attempts`,
      );
      refuseTooMany(res, retryAfterSec);
      return;
    }
    // Counted now, before the hash: the checks above and these lines run without yielding, so
    // each of a burst of requests sees the ones before it. Counted after the await, a burst
    // would all pass the gate while the first was still hashing. A correct password takes its
    // own count back.
    limiter.fail(key);
    accounts.fail(account);
    const user = typeof username === 'string' ? findLocalUser(db, username.trim()) : undefined;
    // Always run the hash, against a dummy when the name is unknown, so timing can't tell
    // a wrong username from a wrong password.
    const ok = typeof password === 'string' && (await verifyPassword(password, user?.password_hash ?? DUMMY_HASH));
    if (!ok || !user) {
      console.warn(`[auth] login failed for ${logName(username)} from ${ip}`);
      res.status(401).json({ error: 'Incorrect username or password.' });
      return;
    }
    limiter.succeed(key);
    accounts.succeed(account);
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
      refuseTooMany(res, gate.retryAfterSec);
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
    limiter.succeed(key);
    const next = parsePassword(newPassword);
    if ('error' in next) {
      res.status(400).json({ error: next.error });
      return;
    }
    if (user.must_change_password && next.password === currentPassword) {
      res.status(400).json({ error: 'Choose a password other than the temporary one.' });
      return;
    }
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`).run(await hashPassword(next.password), user.id);
    // A changed password is usually "someone else may have the old one": drop every other session.
    revokeOtherSessions(db, req, user.id);
    console.log(`[auth] password changed for ${logName(user.username)}; other sessions signed out`);
    res.json({ ok: true } satisfies OkResponse);
  });

  // Admin user management. Deleting a user cascades all of their data. A user an admin adds
  // signs in with the password the admin typed and has to choose their own before anything else.
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
        `INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at, must_change_password)
         SELECT 'local', @name, @hash, @name, 0, @now, 1
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = @name COLLATE NOCASE)`,
      )
      .run({ name, hash, now: Date.now() });
    if (info.changes === 0) {
      res.status(409).json({ error: 'That username is already taken.' });
      return;
    }
    const user = findUserById(db, info.lastInsertRowid)!;
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
