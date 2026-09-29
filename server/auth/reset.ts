import { randomBytes } from 'node:crypto';
import { findLocalUser, type DB } from '../db.js';
import { hashPassword, parsePassword } from './password.js';

/** What the CLI prints: the message for a refusal, or the password that is now set. */
export type ResetResult = { error: string } | { password: string; temporary: boolean };

/**
 * `reset-password <username> [new-password]` (cli.ts only reads the arguments and prints the
 * answer). Without a password a random one is made; it is temporary, so the user chooses their
 * own at the next sign-in. Either way every session of theirs ends, so no device stays signed
 * in on the old password.
 */
export async function resetPassword(db: DB, username: string, given?: string): Promise<ResetResult> {
  const user = findLocalUser(db, username);
  if (!user) return { error: `No local user named "${username}".` };
  const checked = parsePassword(given ?? randomBytes(12).toString('base64url'));
  if ('error' in checked) return checked;
  const temporary = given === undefined;
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?`).run(await hashPassword(checked.password), temporary ? 1 : 0, user.id);
  db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(user.id);
  return { password: checked.password, temporary };
}
