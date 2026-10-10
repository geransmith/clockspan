import type { Config } from './config.js';
import { bumpRevision, type DB } from './db.js';
import type { PruneInfo } from '../shared/api.js';
import { RETENTION_LIMITS, type Settings } from '../shared/settings.js';
import { loadSettings } from './settings.js';
import { collectItems, inList, LATEST, renumber } from './board.js';
import { cutoffKey, DAY_MS } from '../shared/dates.js';

/**
 * Old days are deleted two ways: the user's "Delete old days now" button and an automatic
 * prune (per-user setting, plus an optional server-wide ceiling from RETENTION_DAYS), which
 * `startBackgroundJobs` in app.ts runs through `runRetention` on a timer. Both go through
 * `pruneDays` so the rules are in one place. Deleting a `days` row cascades to its punches,
 * entries, old per-day rows, sessions and breaks. The same prune takes the tasks done before the
 * cutoff, the deleted tasks' tombstones from before it (30 days old at least), and any task
 * nothing names (an archived one once its `legacy_done_at`, a card's done time kept by the
 * one-item migration, else its `archived_at`, is before it: the prune is the only thing that
 * deletes an archived task).
 * Settings, logins, categories, recurring priorities in use and open tasks in a lane are never
 * touched.
 */

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

/** What one prune deleted: days, and tasks, tombstones included. */
export interface Pruned {
  days: number;
  items: number;
}

/**
 * Deletes the user's days before `before` (YYYY-MM-DD, exclusive), and the tasks they leave done
 * and named by nothing: those whose latest entry was ticked before it, whatever their lane. Then
 * the tombstones of tasks deleted before it (UTC midnight, like `cutoffKey`) and at least
 * `RETENTION_LIMITS.min` days before `now`, whatever the cutoff, so a page that still holds a
 * deleted task can't make it again, and any task nothing names (`collectItems`, which skips the
 * newer tombstones, and archived tasks archived or done since the cutoff). A done task kept for
 * its sessions leaves its lane, and a lane that lost a task closes up.
 */
export function pruneDays(db: DB, userId: number, before: string, now: number = Date.now()): Pruned {
  return db.transaction((): Pruned => {
    // Read before the days go: once they have, nothing says these were done.
    const done = (db.prepare(`SELECT item_id AS id FROM (${LATEST}) WHERE done = 1 AND date < ?`).all(userId, before) as { id: number }[]).map((i) => i.id);
    const days = db.prepare(`DELETE FROM days WHERE user_id = ? AND date < ? AND ${NO_RUNNING_TIMER}`).run(userId, before).changes;
    // With its ticked day gone, nothing says a done task was done, and in a lane it would show as
    // open again. Out of its lane, `collectItems` takes it unless a kept day or a session names it.
    const unlaned = db
      .prepare(`UPDATE items SET lane = NULL, position = 0 WHERE user_id = ? AND id IN (SELECT value FROM json_each(?)) AND lane IS NOT NULL`)
      .run(userId, inList(done)).changes;
    const cutoff = Date.parse(`${before}T00:00:00Z`);
    const tombstoneCutoff = Math.min(cutoff, now - RETENTION_LIMITS.min * DAY_MS);
    const tombstones = db.prepare(`DELETE FROM items WHERE user_id = ? AND deleted_at < ?`).run(userId, tombstoneCutoff).changes;
    const items = tombstones + collectItems(db, userId, undefined, cutoff);
    if (items > 0 || unlaned > 0) {
      renumber(db, userId, 'later');
      renumber(db, userId, 'next');
    }
    return { days, items };
  })();
}

/**
 * SQLite reuses freed pages but never shrinks the file on its own. VACUUM rewrites the
 * database compactly; in WAL mode that lands in the -wal file until a checkpoint, so one is
 * forced so `focus.db` itself gets smaller. Not valid inside a transaction.
 */
export function reclaimSpace(db: DB): void {
  // Best effort: the prune or delete before it is committed, so its answer stands, and the next one compacts again.
  try {
    db.exec('VACUUM');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.error('[db] compaction failed', err);
  }
}

/** How many days this user keeps: their own setting when on, capped by the server, or null for "everything". */
export function effectiveKeepDays(settings: Settings, config: Config): number | null {
  const own = settings.retention.enabled ? settings.retention.days : null;
  const cap = config.retentionDays;
  if (own == null) return cap;
  if (cap == null) return own;
  return Math.min(own, cap);
}

/** One pass over every user, moving on the revision of each user it deleted something for. Returns the number of days deleted. */
export function runRetention(db: DB, config: Config, now: number = Date.now()): number {
  const users = db.prepare(`SELECT id FROM users`).all() as { id: number }[];
  const deleted: Pruned = { days: 0, items: 0 };
  for (const { id } of users) {
    const keep = effectiveKeepDays(loadSettings(db, id), config);
    if (keep == null) continue;
    const pruned = pruneDays(db, id, cutoffKey(now, keep), now);
    // Here and not in pruneDays: POST /days/prune is a write the middleware has numbered already.
    if (pruned.days > 0 || pruned.items > 0) bumpRevision(db, id);
    deleted.days += pruned.days;
    deleted.items += pruned.items;
  }
  const { days, items } = deleted;
  if (days > 0 || items > 0) reclaimSpace(db);
  if (days > 0) console.log(`[retention] deleted ${days} day${days === 1 ? '' : 's'}`);
  if (items > 0) console.log(`[retention] deleted ${items} task${items === 1 ? '' : 's'}`);
  return days;
}
