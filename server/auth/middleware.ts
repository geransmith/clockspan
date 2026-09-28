import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { DB, UserRow } from '../db.js';
import type { Config } from '../config.js';
import { ensureDefaultUser } from '../db.js';
import { resolveSession } from './session.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRow;
  }
}

/** Attaches req.user when a valid session exists (or always, in AUTH_MODE=none). */
export function resolveUser(db: DB, config: Config): RequestHandler {
  if (config.authMode === 'none') {
    const user = ensureDefaultUser(db);
    return (req, _res, next) => {
      req.user = user;
      next();
    };
  }
  return (req, res, next) => {
    const user = resolveSession(db, config, req, res);
    if (user) req.user = user;
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  next();
}

/**
 * After requireAuth: a user on a temporary password (an admin set it, or the CLI generated it)
 * gets nothing but the password change until they choose their own. The client shows that
 * page first, so only a stale tab or a script meets the 403.
 */
export function requireOwnPassword(req: Request, res: Response, next: NextFunction): void {
  if (currentUser(req).must_change_password) {
    res.status(403).json({ error: 'password change required' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!req.user.is_admin) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  requireOwnPassword(req, res, next);
}

/** Narrow helper so route handlers don't repeat the non-null check. */
export function currentUser(req: Request): UserRow {
  if (!req.user) throw new Error('currentUser called without requireAuth');
  return req.user;
}
