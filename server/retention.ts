import type { Config } from './config.js';
import type { DB } from './db.js';
import type { PruneInfo } from '../shared/api.js';
import type { Settings } from '../shared/settings.js';
import { loadSettings } from './settings.js';
import { DAY_MS } from '../shared/dates.js';

/**
 * Old days are deleted two ways: the user's "Delete old days now" button and an automatic
 * prune (per-user setting, plus an optional server-wide ceiling from RETENTION_DAYS), which
 * `startBackgroundJobs` in app.ts runs through `runRetention` on a timer. Both go through
 * `pruneDays` so the rules are in one place. Deleting a `days` row cascades to its punches,
 * priorities, sessions and breaks; settings and logins are never touched.
 */

/**
 * Days whose key sorts before this one are older than `keepDays`. The server normally never
 * decides what "today" is (see AGENTS.md); this is the one place it computes a date, in UTC,
 * because the cutoff is at least 30 days back and no user zone is known. A day of slop on a
 * month-old boundary changes nothing.
 */
export function cutoffKey(now: number, keepDays: number): string {
  return new Date(now - keepDays * DAY_MS).toISOString().slice(0, 10);
}

type PruneCounts = Pick<PruneInfo, 'matching' | 'total' | 'oldest'>;

// A day with a running timer is kept whatever its date: the timer bar would otherwise point at
// a session whose day no longer exists. The preview's count and the delete share this test.
const NO_RUNNING_TIMER = `NOT EXISTS (SELECT 1 FROM sessions s WHERE s.day_id = days.id AND s.status = 'running')`;

/**
 * The counts behind `GET /days/prune`: `matching` is the days `pruneDays(before)` would delete,
 * and the route adds the cutoff and the server cap.
 */
export function countDays(db: DB, userId: number, before: string): PruneCounts {
  return db
    .prepare(
      `SELECT COUNT(*) AS total, MIN(date) AS oldest,
              COUNT(*) FILTER (WHERE date < ? AND ${NO_RUNNING_TIMER}) AS matching
       FROM days WHERE user_id = ?`,
    )
    .get(before, userId) as PruneCounts;
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
