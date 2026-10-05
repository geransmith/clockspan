import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { resetPassword } from './auth/reset.js';

// Usage: node dist/server/cli.js reset-password <username> [new-password] (see auth/reset.ts)
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
const result = await resetPassword(db, username, passwordArg);
if ('error' in result) {
  console.error(result.error);
  process.exit(1);
}

console.log(
  result.temporary
    ? `Temporary password for ${username}: ${result.password}\nThey choose their own the next time they sign in.`
    : `Password updated for ${username}.`,
);
db.close();
