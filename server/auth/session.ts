import { createHash, randomBytes } from 'node:crypto';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { Request, Response } from 'express';
import type { DB, UserRow } from '../db.js';
import type { Config } from '../config.js';

export const SESSION_COOKIE = 'fs_session';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db: DB, config: Config, res: Response, userId: number): void {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    `INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, hashToken(token), now, now + config.sessionTtlMs, now);
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    }),
  );
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  return parseCookie(header)[SESSION_COOKIE] ?? null;
}

/** Returns the user for a valid session and slides its expiry; null otherwise. */
export function resolveSession(db: DB, config: Config, req: Request): UserRow | null {
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
  // Slide expiry at most once an hour to keep writes cheap.
  if (now - row.last_seen_at > 3_600_000) {
    db.prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`).run(
      now,
      now + config.sessionTtlMs,
      row.session_id,
    );
  }
  const { session_id: _s, expires_at: _e, last_seen_at: _l, ...user } = row;
  return user;
}

export function destroySession(db: DB, config: Config, req: Request, res: Response): void {
  const token = readSessionToken(req);
  if (token) db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(hashToken(token));
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: 0,
    }),
  );
}

export function purgeExpiredSessions(db: DB): void {
  db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`).run(Date.now());
}
