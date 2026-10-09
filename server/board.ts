/**
 * Tasks as the board sees them, and what changes them beyond a priorities save's own writes. A
 * task (`items`) belongs to its user and is named by its uid; a day's list names it through an
 * entry (`priorities.item_id`) and a session through `sessions.item_id`. Only the board puts a task
 * in Later or Next (`lane`), and done is never stored: a task is done when its latest entry is
 * ticked (`listDone`). Here are the lanes and their order, the one lane rule a save follows
 * (`nextFromLater`), the clean-up of tasks nothing names (`collectItems`), the full delete
 * (`deleteItem`), and the board the API answers with, its categories and recurring priorities
 * included.
 */
import type { DB } from './db.js';
import type { CategoryRow, ItemRow } from './routes/shared.js';
import { cutoffKey } from '../shared/dates.js';
import { activeMs } from '../shared/timer.js';
import { LIMITS, LOOKBACK_DAYS, type Board, type BoardCard, type Category, type OpenLane, type Recurring } from '../shared/api.js';

/** A list of ids or uids as one bound parameter, read in SQL as `IN (SELECT value FROM json_each(?))`. */
export function inList(values: readonly (number | string)[]): string {
  return JSON.stringify(values);
}

/** Each of the user's tasks' latest entry: the date of the latest day whose list holds it, and its tick there. One bound parameter, the user. */
export const LATEST = `SELECT item_id, date, done FROM (
    SELECT p.item_id, d.date, p.done, ROW_NUMBER() OVER (PARTITION BY p.item_id ORDER BY d.date DESC) AS n
    FROM priorities p JOIN days d ON d.id = p.day_id WHERE d.user_id = ?
  ) WHERE n = 1`;

/** The uids of a lane's tasks in their order. */
function laneOrder(db: DB, userId: number, lane: OpenLane): string[] {
  const rows = db.prepare(`SELECT uid FROM items WHERE user_id = ? AND lane = ? ORDER BY position, id`).all(userId, lane) as { uid: string }[];
  return rows.map((c) => c.uid);
}

/** Numbers the given tasks 1..n in this order. */
function writeOrder(db: DB, userId: number, uids: string[]): void {
  const set = db.prepare(`UPDATE items SET position = ? WHERE user_id = ? AND uid = ?`);
  uids.forEach((uid, i) => set.run(i + 1, userId, uid));
}

/** Numbers a lane's tasks 1..n: `first`, tasks of that lane, at the top in this order, then the rest as they were. */
export function renumber(db: DB, userId: number, lane: OpenLane, first: readonly string[] = []): void {
  writeOrder(db, userId, [...first, ...laneOrder(db, userId, lane).filter((uid) => !first.includes(uid))]);
}

/** Tasks in Later and Next that aren't done, which `BOARD_LIMITS.openCards` caps. */
export function openCount(db: DB, userId: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i LEFT JOIN (${LATEST}) l ON l.item_id = i.id WHERE i.user_id = ? AND i.lane IS NOT NULL AND COALESCE(l.done, 0) = 0`,
      )
      .get(userId, userId) as { n: number }
  ).n;
}

/**
 * The task goes to `lane`, before `before` there, or at the end when that names no task of the
 * lane (null, another lane's, itself). The lane it left is renumbered.
 */
export function placeItem(db: DB, userId: number, item: ItemRow, lane: OpenLane, before: string | null): void {
  db.prepare(`UPDATE items SET lane = ? WHERE id = ?`).run(lane, item.id);
  const order = laneOrder(db, userId, lane).filter((uid) => uid !== item.uid);
  const at = before == null ? -1 : order.indexOf(before);
  order.splice(at === -1 ? order.length : at, 0, item.uid);
  writeOrder(db, userId, order);
  if (item.lane != null && item.lane !== lane) renumber(db, userId, item.lane);
}

/**
 * The lane rule a priorities save follows, for the tasks it added open to `date`'s list: a task in
 * Later whose latest list that is (no entry on a later date) goes to the top of Next, in the order
 * given, so a task pulled from Later onto today and left open is lined up in Next. A task in Next
 * keeps its place, and one with no lane stays without.
 */
export function nextFromLater(db: DB, userId: number, date: string, items: readonly ItemRow[]): void {
  const later = db.prepare(`SELECT 1 FROM priorities p JOIN days d ON d.id = p.day_id WHERE p.item_id = ? AND d.date > ? LIMIT 1`);
  const moved = items.filter((i) => i.lane === 'later' && later.get(i.id, date) === undefined).map((i) => i.uid);
  if (moved.length === 0) return;
  const move = db.prepare(`UPDATE items SET lane = 'next' WHERE user_id = ? AND uid = ?`);
  for (const uid of moved) move.run(userId, uid);
  renumber(db, userId, 'later');
  renumber(db, userId, 'next', moved);
}

/**
 * Deletes the user's tasks (those in `only` when given) that nothing names: no entry, no session,
 * and a one-off in no lane that isn't archived. A task in a lane is the board's, and a recurring
 * priority in use a setting, so neither goes. A tombstone is skipped: it stays until the prune, so
 * a late save naming its uid can't make the task again. An archived task (a removed recurring
 * priority) goes only with `archivedBefore`, the prune's cutoff, once `legacy_done_at` (a card's
 * done time, kept by the one-item migration), else `archived_at`, is before that instant: until
 * then a stale offer that adds it finds it still archived, and can't make a one-off under its uid.
 * Returns how many went.
 */
export function collectItems(db: DB, userId: number, only?: readonly number[], archivedBefore?: number): number {
  const archived = archivedBefore === undefined ? '' : 'OR (archived_at IS NOT NULL AND COALESCE(legacy_done_at, archived_at) < @archivedBefore)';
  return db
    .prepare(
      `DELETE FROM items WHERE user_id = @userId ${only ? 'AND id IN (SELECT value FROM json_each(@only))' : ''}
         AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM priorities p WHERE p.item_id = items.id)
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.item_id = items.id)
         AND ((archived_at IS NULL AND weekdays IS NULL AND lane IS NULL) ${archived})`,
    )
    .run({ userId, only: only && inList(only), archivedBefore }).changes;
}

/**
 * Deletes a one-off task everywhere, in the caller's transaction: every session on it stays on
 * its day as unplanned time under the task's name and category (a running one runs on), every
 * day's entry of it goes, and the task stays as a tombstone, in no lane, until the prune, so a save
 * from a device that still has it can't bring it back. The tombstone keeps only the uid, which it
 * also takes as its title, so the deleted name doesn't stay in the file. The lane it was in closes up.
 */
export function deleteItem(db: DB, userId: number, item: ItemRow, now: number): void {
  db.prepare(`UPDATE sessions SET label = ?, category_uid = ?, item_id = NULL WHERE user_id = ? AND item_id = ?`).run(
    item.title.slice(0, LIMITS.sessionLabel),
    item.category_uid,
    userId,
    item.id,
  );
  db.prepare(`DELETE FROM priorities WHERE item_id = ?`).run(item.id);
  db.prepare(`UPDATE items SET deleted_at = ?, lane = NULL, position = 0, title = uid, category_uid = NULL WHERE id = ?`).run(now, item.id);
  if (item.lane != null) renumber(db, userId, item.lane);
}

/** What `listed`, `earlier` and `logged` are worked out from: the dates of the days whose lists hold a task, and the focus logged on it. */
export interface ItemCounts {
  dates: string[];
  /** Seconds of its completed sessions, every day. */
  logged: number;
  /** The same seconds by the date of the day each session is on. */
  loggedOn: Map<string, number>;
}

/** Each task's counts, by its id: one query for the entries and one for the sessions, however many tasks. */
export function itemCounts(db: DB, ids: readonly number[]): Map<number, ItemCounts> {
  const counts = new Map(ids.map((id): [number, ItemCounts] => [id, { dates: [], logged: 0, loggedOn: new Map() }]));
  const list = inList([...counts.keys()]);
  const entries = db
    .prepare(`SELECT p.item_id, d.date FROM priorities p JOIN days d ON d.id = p.day_id WHERE p.item_id IN (SELECT value FROM json_each(?))`)
    .all(list) as { item_id: number; date: string }[];
  for (const e of entries) counts.get(e.item_id)!.dates.push(e.date);
  const sessions = db
    .prepare(
      `SELECT s.item_id, s.started_at, s.ended_at, s.paused_seconds, d.date FROM sessions s JOIN days d ON d.id = s.day_id
       WHERE s.status = 'completed' AND s.item_id IS NOT NULL AND s.item_id IN (SELECT value FROM json_each(?))`,
    )
    .all(list) as { item_id: number; started_at: number; ended_at: number; paused_seconds: number; date: string }[];
  for (const s of sessions) {
    const c = counts.get(s.item_id)!;
    // Rounded per session, as each session's durationSeconds is, so the total is what the log adds up to.
    const seconds = Math.round(activeMs({ startedAt: s.started_at, pausedSeconds: s.paused_seconds, pausedAt: null }, s.ended_at) / 1000);
    c.logged += seconds;
    c.loggedOn.set(s.date, (c.loggedOn.get(s.date) ?? 0) + seconds);
  }
  return counts;
}

/** The user's categories in the order they were made, removed ones included: past time keeps its name. */
export function categoryRows(db: DB, userId: number): CategoryRow[] {
  return db.prepare(`SELECT * FROM categories WHERE user_id = ? ORDER BY id`).all(userId) as CategoryRow[];
}

function categoriesJson(db: DB, userId: number): Category[] {
  return categoryRows(db, userId).map((c) => ({ uid: c.uid, name: c.name, color: c.color, archived: c.archived_at != null }));
}

/** ISO weekdays (Monday 1 to Sunday 7) as a recurring priority stores them: bit 0 for Monday. */
export function weekdayMask(weekdays: readonly number[]): number {
  return weekdays.reduce((mask, day) => mask | (1 << (day - 1)), 0);
}

/** The ISO weekdays in a recurring priority's mask, ascending. */
function weekdaysOf(mask: number): number[] {
  return [1, 2, 3, 4, 5, 6, 7].filter((day) => mask & (1 << (day - 1)));
}

/** The user's recurring priorities not removed, in the order they were made, the order the offer lists them in. */
function recurringJson(db: DB, userId: number): Recurring[] {
  const rows = db
    .prepare(`SELECT * FROM items WHERE user_id = ? AND weekdays IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL ORDER BY id`)
    .all(userId) as (ItemRow & { weekdays: number })[];
  return rows.map((r) => ({ uid: r.uid, title: r.title, categoryUid: r.category_uid, weekdays: weekdaysOf(r.weekdays) }));
}

/** How far back the board sends the tasks a list holds: `LOOKBACK_DAYS`, and a day of slack for the client's zone. */
export const LIST_WINDOW_DAYS = LOOKBACK_DAYS + 1;
/** How far ahead it sends a planned task, so lists saved on far-off dates can't grow every answer. */
export const PLANNED_WINDOW_DAYS = 60;

/**
 * The user's board: the one-off tasks in Later and Next that aren't done, in order, then every
 * other one whose latest entry is from `LIST_WINDOW_DAYS` before the server's UTC today to
 * `PLANNED_WINDOW_DAYS` after it, so a task planned weeks ahead is in it, and so is every task the
 * client can show as done this week or left open; the categories and the recurring priorities.
 * Archived and deleted tasks are left out. `listDate` and `listDone` are read from the lists on
 * every call, so neither can drift from them.
 */
export function boardJson(db: DB, userId: number, now: number = Date.now()): Board {
  const from = cutoffKey(now, LIST_WINDOW_DAYS);
  const to = cutoffKey(now, -PLANNED_WINDOW_DAYS);
  const rows = db
    .prepare(
      `SELECT i.*, l.date AS list_date, l.done AS list_done FROM items i LEFT JOIN (${LATEST}) l ON l.item_id = i.id
       WHERE i.user_id = ? AND i.weekdays IS NULL AND i.archived_at IS NULL AND i.deleted_at IS NULL
         AND ((i.lane IS NOT NULL AND COALESCE(l.done, 0) = 0) OR l.date BETWEEN ? AND ?)
       ORDER BY CASE i.lane WHEN 'later' THEN 0 WHEN 'next' THEN 1 ELSE 2 END, i.position, l.date DESC, i.id`,
    )
    .all(userId, userId, from, to) as (ItemRow & { list_date: string | null; list_done: number | null })[];
  const counts = itemCounts(
    db,
    rows.map((r) => r.id),
  );
  const cards = rows.map((r): BoardCard => {
    const { dates, logged } = counts.get(r.id)!;
    return {
      uid: r.uid,
      title: r.title,
      categoryUid: r.category_uid,
      lane: r.lane,
      position: r.position,
      createdAt: r.created_at,
      listDate: r.list_date,
      listDone: r.list_done === 1,
      listed: dates.length,
      logged,
    };
  });
  return { cards, categories: categoriesJson(db, userId), recurring: recurringJson(db, userId) };
}
