import { createHash, randomBytes } from 'node:crypto';
import { parseCookie, stringifySetCookie } from 'cookie';
import type { Request, Response } from 'express';
import type { DB, UserRow } from '../db.js';
import type { Config } from '../config.js';
import { HOUR_MS } from '../../shared/dates.js';

export const SESSION_COOKIE = 'fs_session';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Builds every cookie this app sets: HttpOnly and SameSite=Lax, with `Secure` following the deployment. A Max-Age of 0 clears one. */
export function cookieHeader(config: Config, name: string, value: string, maxAgeSec: number, path = '/'): string {
  return stringifySetCookie({ name, value, httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path, maxAge: maxAgeSec });
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  return header ? parseCookie(header)[name] : undefined;
}

/** The session cookie with a full TTL ahead of it; sent at login and again whenever the expiry slides. */
function sessionCookie(config: Config, token: string): string {
  return cookieHeader(config, SESSION_COOKIE, token, Math.floor(config.sessionTtlMs / 1000));
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

/**
 * Returns the user for a valid session and slides its expiry; null otherwise. A valid session
 * is one whose user belongs to the running AUTH_MODE: one made before a mode switch never
 * resolves (a local account's cookie can't get past an OIDC provider's access policy, nor an
 * OIDC sign-in into a local install), and its row expires and `purgeExpiredSessions` removes it.
 */
export function resolveSession(db: DB, config: Config, req: Request, res: Response): UserRow | null {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.*
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND u.kind = ?`,
    )
    .get(hashToken(token), config.authMode) as (UserRow & { session_id: number; expires_at: number; last_seen_at: number }) | undefined;
  if (!row) return null;
  if (row.expires_at <= now) {
    db.prepare(`DELETE FROM auth_sessions WHERE id = ?`).run(row.session_id);
    return null;
  }
  // Slide expiry at most once an hour to keep writes cheap. The cookie's Max-Age was set at
  // login, so the browser is handed it again with a fresh one: the row sliding on its own
  // would still have the browser drop the cookie a TTL after login.
  if (now - row.last_seen_at > HOUR_MS) {
    db.prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`).run(now, now + config.sessionTtlMs, row.session_id);
    res.setHeader('Set-Cookie', sessionCookie(config, token));
  }
  const { session_id: _s, expires_at: _e, last_seen_at: _l, ...user } = row;
  return user;
}

export function destroySession(db: DB, config: Config, req: Request, res: Response): void {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(hashToken(token));
  res.setHeader('Set-Cookie', cookieHeader(config, SESSION_COOKIE, '', 0));
}

/** Ends every session of the user: a password change (which then issues a new one) and the reset-password command. */
export function revokeSessions(db: DB, userId: number): void {
  db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(userId);
}

export function purgeExpiredSessions(db: DB): void {
  db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(Date.now());
}
