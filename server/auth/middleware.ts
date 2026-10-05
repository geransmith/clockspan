import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Config } from '../config.js';
import { ensureDefaultUser, type DB, type UserRow } from '../db.js';
import { refuse } from '../refuse.js';
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
  if (!req.user) return refuse(res, 401, 'Not signed in.');
  next();
}

/**
 * After requireAuth: a user on a temporary password (an admin set it, or the CLI generated it)
 * gets nothing but the password change until they choose their own. The client shows that
 * page first, so only a stale tab or a script meets the 403.
 */
export function requireOwnPassword(req: Request, res: Response, next: NextFunction): void {
  if (currentUser(req).must_change_password) return refuse(res, 403, 'Choose a new password first.');
  next();
}

/** requireAuth, then an admin, then one on their own password. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (!currentUser(req).is_admin) return refuse(res, 403, 'Only an admin can do that.');
    requireOwnPassword(req, res, next);
  });
}

/** Narrow helper so route handlers don't repeat the non-null check. */
export function currentUser(req: Request): UserRow {
  if (!req.user) throw new Error('currentUser called without requireAuth');
  return req.user;
}
