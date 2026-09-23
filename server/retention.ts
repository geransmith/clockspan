import type { Config } from './config.js';
import type { DB } from './db.js';
import type { Settings } from '../shared/settings.js';
import { loadSettings } from './routes/settings.js';

/**
 * Old days are deleted two ways: the user's "Delete old days now" button and an automatic
 * prune (per-user setting, plus an optional server-wide ceiling from RETENTION_DAYS). Both
 * go through `pruneDays` so the rules are in one place. Deleting a `days` row cascades to
 * its punches, priorities and sessions; settings and logins are never touched.
 */

const DAY_MS = 86_400_000;
const RUN_AFTER_BOOT_MS = 30_000;
const RUN_EVERY_MS = 6 * 3_600_000;

/**
 * Days whose key sorts before this one are older than `keepDays`. The server normally never
 * decides what "today" is (see AGENTS.md); this is the one place it computes a date, in UTC,
 * because the cutoff is at least 30 days back and no user zone is known. A day of slop on a
 * month-old boundary changes nothing.
 */
export function cutoffKey(now: number, keepDays: number): string {
  return new Date(now - keepDays * DAY_MS).toISOString().slice(0, 10);
}

/** The counts behind `GET /days/prune`; the route adds the cutoff and the server cap. */
export interface PruneCounts {
  /** Days that `pruneDays(before)` would delete. */
  matching: number;
  total: number;
  oldest: string | null;
}

// A day with a running timer is kept whatever its date: the timer bar would otherwise point at
// a session whose day no longer exists. The preview's count and the delete share this test.
const NO_RUNNING_TIMER = `NOT EXISTS (SELECT 1 FROM sessions s WHERE s.day_id = days.id AND s.status = 'running')`;

export function countDays(db: DB, userId: number, before: string): PruneCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, MIN(date) AS oldest,
              SUM(CASE WHEN date < ? AND ${NO_RUNNING_TIMER} THEN 1 ELSE 0 END) AS matching
       FROM days WHERE user_id = ?`,
    )
    .get(before, userId) as { total: number; oldest: string | null; matching: number | null };
  return { matching: row.matching ?? 0, total: row.total, oldest: row.oldest };
}

/** Deletes the user's days before `before` (YYYY-MM-DD, exclusive) and returns how many. */
export function pruneDays(db: DB, userId: number, before: string): number {
  return db.prepare(`DELETE FROM days WHERE user_id = ? AND date < ? AND ${NO_RUNNING_TIMER}`).run(userId, before).changes;
}

/**
 * SQLite reuses freed pages but never shrinks the file on its own. VACUUM rewrites the
 * database compactly; in WAL mode that lands in the -wal file until a checkpoint, so one is
 * forced so `focus.db` itself gets smaller. Not valid inside a transaction.
 */
export function reclaimSpace(db: DB): void {
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/** How many days this user keeps: their own setting when on, capped by the server, or null for "everything". */
export function effectiveKeepDays(settings: Settings, config: Config): number | null {
  const own = settings.retention.enabled ? settings.retention.days : null;
  const cap = config.retentionDays;
  if (own == null) return cap;
  if (cap == null) return own;
  return Math.min(own, cap);
}

/** One pass over every user. Returns the number of days deleted. */
export function runRetention(db: DB, config: Config, now: number = Date.now()): number {
  const users = db.prepare(`SELECT id FROM users`).all() as { id: number }[];
  let deleted = 0;
  for (const { id } of users) {
    const keep = effectiveKeepDays(loadSettings(db, id), config);
    if (keep == null) continue;
    deleted += pruneDays(db, id, cutoffKey(now, keep));
  }
  if (deleted > 0) {
    reclaimSpace(db);
    console.log(`[retention] deleted ${deleted} day${deleted === 1 ? '' : 's'}`);
  }
  return deleted;
}

/** Shortly after boot, then every few hours. Both timers are unref'd so they never hold the process open. */
export function scheduleRetention(db: DB, config: Config): void {
  const run = () => {
    try {
      runRetention(db, config);
    } catch (err) {
      console.error('[retention]', err);
    }
  };
  setTimeout(run, RUN_AFTER_BOOT_MS).unref();
  setInterval(run, RUN_EVERY_MS).unref();
}
