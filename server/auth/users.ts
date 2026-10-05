import type { UserRow } from '../db.js';
import { USERNAME, type PublicUser } from '../../shared/api.js';

/** A user as the client sees it (`/auth/me`, the admin's user list); every auth mode answers with this. */
export function publicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    name: u.display_name,
    username: u.username,
    isAdmin: Boolean(u.is_admin),
    mustChangePassword: Boolean(u.must_change_password),
  };
}

/**
 * A name as it goes into a log line: quoted and cut short, so whatever was typed into the
 * login form (a newline, say) cannot forge a line of its own. Every auth event is logged once
 * because, with the port on the internet, the log is how a password-guessing run or a locked
 * out household member gets noticed.
 */
export function logName(name: unknown): string {
  return JSON.stringify(typeof name === 'string' ? name.slice(0, USERNAME.max) : '');
}
