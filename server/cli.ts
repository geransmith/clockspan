import { randomBytes } from 'node:crypto';
import { loadConfig } from './config.js';
import { findLocalUser, openDatabase } from './db.js';
import { hashPassword, parsePassword } from './auth/password.js';

// Usage: node dist/server/cli.js reset-password <username> [new-password]
// Without a password argument, a random one is generated and printed; it is temporary, and
// the user chooses their own at the next sign-in.
const [cmd, username, passwordArg] = process.argv.slice(2);

if (cmd !== 'reset-password' || !username) {
  console.error('Usage: reset-password <username> [new-password]');
  process.exit(2);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[config] ${(err as Error).message}`);
  process.exit(1);
}
const db = openDatabase(config.dbPath);
const user = findLocalUser(db, username);
if (!user) {
  console.error(`No local user named "${username}".`);
  process.exit(1);
}

const password = passwordArg ?? randomBytes(12).toString('base64url');
const checked = parsePassword(password);
if ('error' in checked) {
  console.error(checked.error);
  process.exit(1);
}

db.prepare(`UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?`).run(await hashPassword(checked.password), passwordArg ? 0 : 1, user.id);
db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(user.id);
console.log(
  passwordArg ? `Password updated for ${username}.` : `Temporary password for ${username}: ${password}\nThey choose their own the next time they sign in.`,
);
db.close();
