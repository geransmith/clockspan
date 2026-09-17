import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { hashPassword, validatePassword } from './auth/password.js';

// Usage: node dist/server/cli.js reset-password <username> [new-password]
// Without a password argument, a random one is generated and printed.
const [cmd, username, passwordArg] = process.argv.slice(2);

if (cmd !== 'reset-password' || !username) {
  console.error('Usage: reset-password <username> [new-password]');
  process.exit(2);
}

const config = loadConfig();
const db = openDatabase(config.dbPath);
const user = db.prepare(`SELECT id FROM users WHERE kind = 'local' AND username = ?`).get(username) as { id: number } | undefined;
if (!user) {
  console.error(`No local user named "${username}".`);
  process.exit(1);
}

const password = passwordArg ?? Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
const err = validatePassword(password);
if (err) {
  console.error(err);
  process.exit(1);
}

db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hashPassword(password), user.id);
db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(user.id);
console.log(passwordArg ? `Password updated for ${username}.` : `New password for ${username}: ${password}`);
db.close();
