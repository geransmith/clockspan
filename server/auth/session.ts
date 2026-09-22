import { createHash, randomBytes } from 'node:crypto';
import { parseCookie, stringifySetCookie, type SetCookie } from 'cookie';
import type { Request, Response } from 'express';
import type { DB, UserRow } from '../db.js';
import type { Config } from '../config.js';

export const SESSION_COOKIE = 'fs_session';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The attributes every cookie this app sets shares; `secure` follows the deployment. */
export type CookieOptions = Omit<SetCookie, 'name' | 'value'>;

export function cookieOptions(config: Config, path = '/'): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path };
}

/** The session cookie with a full TTL ahead of it; sent at login and again whenever the expiry slides. */
function sessionCookie(config: Config, token: string): string {
  return stringifySetCookie({ name: SESSION_COOKIE, value: token, ...cookieOptions(config), maxAge: Math.floor(config.sessionTtlMs / 1000) });
}

/** Stores a new session for the user and returns its token; only the hash is kept. Login and the dev seed's `--sessions` both come here. */
export function insertSession(db: DB, config: Config, userId: number): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    `INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, hashToken(token), now, now + config.sessionTtlMs, now);
  return token;
}

export function createSession(db: DB, config: Config, res: Response, userId: number): void {
  res.setHeader('Set-Cookie', sessionCookie(config, insertSession(db, config, userId)));
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  return parseCookie(header)[SESSION_COOKIE] ?? null;
}

/** Returns the user for a valid session and slides its expiry; null otherwise. */
export function resolveSession(db: DB, config: Config, req: Request, res: Response): UserRow | null {
  const token = readSessionToken(req);
  if (!token) return null;
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.*
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as (UserRow & { session_id: number; expires_at: number; last_seen_at: number }) | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    db.prepare(`DELETE FROM auth_sessions WHERE id = ?`).run(row.session_id);
    return null;
  }
  // Slide expiry at most once an hour to keep writes cheap. The cookie's Max-Age was set at
  // login, so the browser is handed it again with a fresh one: the row sliding on its own
  // would still have the browser drop the cookie a TTL after login.
  if (now - row.last_seen_at > 3_600_000) {
    db.prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`).run(now, now + config.sessionTtlMs, row.session_id);
    res.setHeader('Set-Cookie', sessionCookie(config, token));
  }
  const { session_id: _s, expires_at: _e, last_seen_at: _l, ...user } = row;
  return user;
}

export function destroySession(db: DB, config: Config, req: Request, res: Response): void {
  const token = readSessionToken(req);
  if (token) db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(hashToken(token));
  res.setHeader('Set-Cookie', stringifySetCookie({ name: SESSION_COOKIE, value: '', ...cookieOptions(config), maxAge: 0 }));
}

/** Signs the user out everywhere except the request's own session (after a password change). */
export function revokeOtherSessions(db: DB, req: Request, userId: number): void {
  const token = readSessionToken(req);
  db.prepare(`DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?`).run(userId, token ? hashToken(token) : '');
}

export function purgeExpiredSessions(db: DB): void {
  db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(Date.now());
}
