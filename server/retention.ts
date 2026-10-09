import type { Config } from './config.js';
import type { DB } from './db.js';
import type { PruneInfo } from '../shared/api.js';
import type { Settings } from '../shared/settings.js';
import { loadSettings } from './settings.js';
import { collectItems, inList, renumber } from './board.js';
import { DAY_MS } from '../shared/dates.js';

/**
 * Old days are deleted two ways: the user's "Delete old days now" button and an automatic
 * prune (per-user setting, plus an optional server-wide ceiling from RETENTION_DAYS), which
 * `startBackgroundJobs` in app.ts runs through `runRetention` on a timer. Both go through
 * `pruneDays` so the rules are in one place. Deleting a `days` row cascades to its punches,
 * entries, old per-day rows, sessions and breaks. The same prune takes the tasks done before the
 * cutoff, the deleted tasks' tombstones from before it, and any task nothing names (an archived
 * one once its `legacy_done_at`, a card's done time kept by the one-item migration, else its
 * `archived_at`, is before it: the prune is the only thing that deletes an archived task).
 * Settings, logins, categories, recurring priorities in use and open tasks in a lane are never
 * touched.
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

/** What one prune deleted: days, and tasks, tombstones included. */
export interface Pruned {
  days: number;
  items: number;
}

/** A one-off task, or an archived one: a recurring priority in use is a setting, however long ago it was last done. */
const NOT_A_SETTING = `(weekdays IS NULL OR archived_at IS NOT NULL)`;

/**
 * Deletes the user's days before `before` (YYYY-MM-DD, exclusive), and the tasks they leave done
 * and named by nothing: those whose latest entry was ticked before it, whatever their lane. Then
 * the tombstones of tasks deleted before it (UTC midnight, like `cutoffKey`), which no open page
 * still sends after a retention window of 30 days or more, and any task nothing names
 * (`collectItems`, which skips the newer tombstones, and archived tasks archived or done since the
 * cutoff). A done task kept for its sessions leaves its lane, and a lane that lost a task closes up.
 */
export function pruneDays(db: DB, userId: number, before: string): Pruned {
  return db.transaction((): Pruned => {
    // Read before the days go: once they have, nothing says these were done.
    const done = (
      db
        .prepare(
          `SELECT i.id FROM items i JOIN priorities p ON p.item_id = i.id JOIN days d ON d.id = p.day_id
           WHERE i.user_id = ? AND ${NOT_A_SETTING} AND p.done = 1 AND d.date < ?
             AND d.date = (SELECT MAX(d2.date) FROM priorities p2 JOIN days d2 ON d2.id = p2.day_id WHERE p2.item_id = i.id)`,
        )
        .all(userId, before) as { id: number }[]
    ).map((i) => i.id);
    const days = db.prepare(`DELETE FROM days WHERE user_id = ? AND date < ? AND ${NO_RUNNING_TIMER}`).run(userId, before).changes;
    // A day kept for its running timer still names its tasks, and a session may name one from a later day.
    const finished = db
      .prepare(
        `DELETE FROM items WHERE user_id = ? AND id IN (SELECT value FROM json_each(?)) AND ${NOT_A_SETTING}
           AND NOT EXISTS (SELECT 1 FROM priorities p WHERE p.item_id = items.id)
           AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.item_id = items.id)`,
      )
      .run(userId, inList(done)).changes;
    // One kept for a session on a later day loses its lane: with its ticked day gone, nothing says
    // it was done, and it would show as open there again.
    const unlaned = db
      .prepare(`UPDATE items SET lane = NULL, position = 0 WHERE user_id = ? AND id IN (SELECT value FROM json_each(?)) AND lane IS NOT NULL`)
      .run(userId, inList(done)).changes;
    const cutoff = Date.parse(`${before}T00:00:00Z`);
    const tombstones = db.prepare(`DELETE FROM items WHERE user_id = ? AND deleted_at < ?`).run(userId, cutoff).changes;
    const items = finished + tombstones + collectItems(db, userId, undefined, cutoff);
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
  const deleted: Pruned = { days: 0, items: 0 };
  for (const { id } of users) {
    const keep = effectiveKeepDays(loadSettings(db, id), config);
    if (keep == null) continue;
    const pruned = pruneDays(db, id, cutoffKey(now, keep));
    deleted.days += pruned.days;
    deleted.items += pruned.items;
  }
  const { days, items } = deleted;
  if (days > 0 || items > 0) reclaimSpace(db);
  if (days > 0) console.log(`[retention] deleted ${days} day${days === 1 ? '' : 's'}`);
  if (items > 0) console.log(`[retention] deleted ${items} task${items === 1 ? '' : 's'}`);
  return days;
}
