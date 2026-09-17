import { loadConfig } from '../config.js';
import { ensureDefaultUser, openDatabase } from '../db.js';
import { DEFAULT_HISTORY_DAYS, LOCAL_USERS, ensureLocalUsers, localDateKey, seedDatabase, startOfQuarter, weekdaysSince, type SeedManifest } from './seed.js';

// Usage: npm run seed [-- --fresh] [--running] [--days N | --quarter] [--today YYYY-MM-DD]
// Fills the dev DB (DATA_DIR, default ./data) with sample days for the default user, or for
// the `admin` and `sam` local users when AUTH_MODE=local. Safe to run while `npm run dev`
// is up; reload the page afterwards.

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed with NODE_ENV=production. This is dev data.');
  process.exit(2);
}

const opts: { fresh: boolean; running: boolean; quarter: boolean; days?: string; today?: string } = { fresh: false, running: false, quarter: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const [name, inline] = args[i]!.split('=', 2) as [string, string | undefined];
  const next = () => inline ?? args[++i];
  if (name === '--fresh') opts.fresh = true;
  else if (name === '--running') opts.running = true;
  else if (name === '--quarter') opts.quarter = true;
  else if (name === '--days') opts.days = next();
  else if (name === '--today') opts.today = next();
  else {
    console.error(`Unknown option ${name}. Options: --fresh --running --days N --quarter --today YYYY-MM-DD`);
    process.exit(2);
  }
}

const now = Date.now();
const today = opts.today ?? localDateKey(now);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error(`--today must be YYYY-MM-DD (got "${today}").`);
  process.exit(2);
}
if (opts.quarter && opts.days !== undefined) {
  console.error('Pass --days or --quarter, not both.');
  process.exit(2);
}
const daysRaw = opts.days;
// --quarter covers the previous calendar quarter too, so Review → Quarter has a step back.
const days = opts.quarter ? weekdaysSince(startOfQuarter(today, 1), today) : daysRaw === undefined ? DEFAULT_HISTORY_DAYS : Number(daysRaw);
if (!Number.isInteger(days) || days < 0 || days > 400) {
  console.error(`--days must be a whole number from 0 to 400 (got "${daysRaw}").`);
  process.exit(2);
}
const { fresh, running } = opts;

const config = loadConfig();
const db = openDatabase(config.dbPath);

const seeded: { name: string; manifest: SeedManifest }[] = [];
if (config.authMode === 'local') {
  const { admin, member } = ensureLocalUsers(db);
  seeded.push({ name: admin.username!, manifest: seedDatabase(db, { userId: admin.id, today, now, days, running, fresh }) });
  // Fewer days and no timer, so the two accounts are easy to tell apart.
  seeded.push({ name: member.username!, manifest: seedDatabase(db, { userId: member.id, today, now, days: Math.min(days, 3), fresh }) });
} else {
  const user = ensureDefaultUser(db);
  seeded.push({ name: 'default user', manifest: seedDatabase(db, { userId: user.id, today, now, days, running, fresh }) });
}
db.close();

console.log(`Seeded ${config.dbPath} (AUTH_MODE=${config.authMode})`);
for (const { name, manifest } of seeded) {
  const past = manifest.days.slice(0, -1);
  const first = past[0]?.date;
  const last = past[past.length - 1]?.date;
  const span = past.length === 0 ? 'no history' : `${past.length} past weekday${past.length === 1 ? '' : 's'} (${first} to ${last})`;
  const timer = manifest.days.at(-1)!.sessions.some((s) => s.status === 'running') ? ', timer running' : '';
  console.log(`  ${name}: ${span}, today ${manifest.today} clocked in${timer}`);
}
if (config.authMode === 'local') {
  console.log(`  Log in as ${LOCAL_USERS.admin} (admin) or ${LOCAL_USERS.member}, password "${LOCAL_USERS.password}".`);
}
if (fresh) console.log('  Settings and logins were reset.');
