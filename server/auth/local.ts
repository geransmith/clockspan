import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { findLocalUser, findUserById, type DB, type UserRow } from '../db.js';
import type { Config } from '../config.js';
import { refuse } from '../refuse.js';
import { reclaimSpace } from '../retention.js';
import { DUMMY_HASH, hashPassword, parseCredentials, parsePassword, verifyPassword } from './password.js';
import { createSession, destroySession, revokeSessions } from './session.js';
import { currentUser, requireAdmin, requireAuth } from './middleware.js';
import { accountKey, LoginLimiter, limiterKey, MAX_ACCOUNT_FAILURES, refuseTooMany, warnUntrustedProxy } from './limiter.js';
import { logName, publicUser } from './users.js';
import type { LogoutResponse, OkResponse, UserResponse, UsersResponse } from '../../shared/api.js';

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

/** Local accounts; none yet means the first visit is setup. */
export function userCount(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE kind = 'local'`).get() as { n: number }).n;
}

/**
 * `setupCode` is only fixed by tests; a server makes a new one each start. Until the first
 * account exists it is printed in the log, and setup asks for it: a stranger who reaches a
 * fresh install before its owner has no way to read the log, so can't make themselves admin.
 */
export function localAuthRouter(db: DB, config: Config, setupCode: string = newSetupCode()): Router {
  const r = Router();
  const addresses = new LoginLimiter();
  const accounts = new LoginLimiter(MAX_ACCOUNT_FAILURES);
  const passwordChecks = new LoginLimiter();
  r.use(warnUntrustedProxy(config));
  if (userCount(db) === 0) console.log(`[auth] No account yet. The setup page asks for this code: ${setupCode}`);

  r.post('/setup', async (req, res) => {
    if (userCount(db) > 0) return refuse(res, 403, 'Setup has already been completed.');
    // Wrong codes count against the address like failed sign-ins do.
    const key = limiterKey(String(req.ip));
    const gate = addresses.check(key);
    if (!gate.ok) return refuseTooMany(res, gate.retryAfterSec);
    if (!setupCodeMatches(setupCode, (req.body as { setupCode?: unknown }).setupCode)) {
      addresses.fail(key);
      console.warn(`[auth] setup refused from ${req.ip}: wrong setup code`);
      return refuse(res, 403, "That setup code doesn't match the one in the server log.");
    }
    const creds = parseCredentials(req.body);
    if ('error' in creds) return refuse(res, 400, creds.error);
    const hash = await hashPassword(creds.password);
    // Re-check after the await: two first visitors racing each other must not both become
    // admin. The check and the insert below run without yielding, so this one is decisive.
    if (userCount(db) > 0) return refuse(res, 403, 'Setup has already been completed.');
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
    const { username, password } = req.body as { username?: unknown; password?: unknown };
    const account = accountKey(username);
    const gate = addresses.check(key);
    const accountGate = accounts.check(account);
    if (!gate.ok || !accountGate.ok) {
      const retryAfterSec = Math.max(gate.retryAfterSec, accountGate.retryAfterSec);
      console.warn(
        gate.ok
          ? `[auth] login blocked for ${logName(username)} from ${ip}: too many failures on this account`
          : `[auth] login blocked from ${ip}: too many attempts`,
      );
      return refuseTooMany(res, retryAfterSec);
    }
    // Counted now, before the hash: the checks above and these lines run without yielding, so
    // each of a burst of requests sees the ones before it. Counted after the await, a burst
    // would all pass the gate while the first was still hashing. A correct password takes its
    // own count back.
    addresses.fail(key);
    accounts.fail(account);
    const user = typeof username === 'string' ? findLocalUser(db, username.trim()) : undefined;
    // Always run the hash, against a dummy when the name is unknown, so timing can't tell
    // a wrong username from a wrong password.
    const ok = typeof password === 'string' && (await verifyPassword(password, user?.password_hash ?? DUMMY_HASH));
    if (!ok || !user) {
      console.warn(`[auth] login failed for ${logName(username)} from ${ip}`);
      return refuse(res, 401, 'Incorrect username or password.');
    }
    addresses.succeed(key);
    accounts.succeed(account);
    createSession(db, config, res, user.id);
    console.log(`[auth] ${logName(user.username)} signed in from ${ip}`);
    res.json({ user: publicUser(user) } satisfies UserResponse);
  });

  r.post('/logout', (req, res) => {
    destroySession(db, config, req, res);
    res.json({ ok: true } satisfies LogoutResponse);
  });

  // The current-password check is a login in disguise: a stolen cookie must not guess it at
  // scrypt speed. It has a limiter of its own, keyed by the user, so the lock holds across every
  // session and address of that user.
  r.post('/password', requireAuth, async (req, res) => {
    const user = currentUser(req);
    const key = String(user.id);
    const gate = passwordChecks.check(key);
    if (!gate.ok) {
      console.warn(`[auth] password change blocked for ${logName(user.username)}: too many attempts`);
      return refuseTooMany(res, gate.retryAfterSec);
    }
    // Counted before the hash, like a login.
    passwordChecks.fail(key);
    const { currentPassword, newPassword } = req.body as { currentPassword?: unknown; newPassword?: unknown };
    if (!user.password_hash || typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, user.password_hash))) {
      console.warn(`[auth] password change refused for ${logName(user.username)}: current password wrong`);
      return refuse(res, 400, 'Current password is incorrect.');
    }
    passwordChecks.succeed(key);
    const next = parsePassword(newPassword);
    if ('error' in next) return refuse(res, 400, next.error);
    if (user.must_change_password && next.password === currentPassword) return refuse(res, 400, 'Choose a password other than the temporary one.');
    db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`).run(await hashPassword(next.password), user.id);
    // A changed password is usually "someone else may have the old one", and what leaked may be
    // this session's own cookie: end every session, this one included, and give this browser a
    // new one.
    revokeSessions(db, user.id);
    createSession(db, config, res, user.id);
    console.log(`[auth] password changed for ${logName(user.username)}; every session signed out, this one renewed`);
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
    if ('error' in creds) return refuse(res, 400, creds.error);
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
    if (info.changes === 0) return refuse(res, 409, 'That username is already taken.');
    const user = findUserById(db, info.lastInsertRowid)!;
    console.log(`[auth] user ${logName(name)} created by ${logName(currentUser(req).username)}`);
    res.status(201).json({ user: publicUser(user) } satisfies UserResponse);
  });

  r.delete('/users/:id', requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    const me = currentUser(req);
    if (id === me.id) return refuse(res, 400, 'You cannot delete your own account.');
    const info = db.prepare(`DELETE FROM users WHERE id = ? AND kind = 'local'`).run(id);
    if (info.changes === 0) return refuse(res, 404, 'User not found.');
    // A deleted user's text must not stay readable in the file's free pages.
    reclaimSpace(db);
    console.log(`[auth] user #${id} and their data deleted by ${logName(me.username)}`);
    res.json({ ok: true } satisfies OkResponse);
  });

  return r;
}
