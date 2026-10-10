import type { DB, UserRow } from '../db.js';
import { USERNAME, type PublicUser } from '../../shared/api.js';
import { cutText } from '../../shared/text.js';

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
  return JSON.stringify(typeof name === 'string' ? cutText(name, USERNAME.max) : '');
}

/**
 * The local account a typed name belongs to. Names match whatever their case ("Sam" is "sam");
 * an install from before that rule may hold both spellings, and there the exact one wins.
 */
export function findLocalUser(db: DB, username: string): UserRow | undefined {
  return db
    .prepare(`SELECT * FROM users WHERE kind = 'local' AND username = ? COLLATE NOCASE ORDER BY username = ? DESC, id LIMIT 1`)
    .get(username, username) as UserRow | undefined;
}

/** Whether a local account exists; none yet means the first visit is setup. */
export function hasLocalUser(db: DB): boolean {
  return (db.prepare(`SELECT EXISTS(SELECT 1 FROM users WHERE kind = 'local') AS found`).get() as { found: number }).found === 1;
}

/**
 * A new local account, or undefined when the name is taken. The check is part of the insert, so
 * two creates for one name can't both pass it, and it ignores case as sign-in does: "Sam" can't
 * be added beside "sam".
 */
export function insertLocalUser(
  db: DB,
  username: string,
  passwordHash: string,
  { isAdmin, mustChangePassword }: { isAdmin: boolean; mustChangePassword: boolean },
): UserRow | undefined {
  return db
    .prepare(
      `INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at, must_change_password)
       SELECT 'local', @username, @passwordHash, @username, @isAdmin, @now, @mustChangePassword
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = @username COLLATE NOCASE)
       RETURNING *`,
    )
    .get({ username, passwordHash, isAdmin: Number(isAdmin), mustChangePassword: Number(mustChangePassword), now: Date.now() }) as UserRow | undefined;
}
