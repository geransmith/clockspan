import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse } from '../refuse.js';
import { boardJson, deleteItem, openCount, placeItem, weekdayMask } from '../board.js';
import { isOneOf, isWholeNumber } from '../validate.js';
import { BAD_CATEGORY, getOwnedByUid, parseUidField, uidRouter, UID_NOT_FOUND, UID_RE, type ItemRow } from './shared.js';
import { taskNote, taskTitle } from '../../shared/text.js';
import { BOARD_LIMITS, OPEN_LANES, type Board } from '../../shared/api.js';

const NOT_FOUND = UID_NOT_FOUND.items;
const NO_TITLE = 'A task needs a title.';
const BAD_LANE = 'lane must be later or next.';
const NO_PLACE = 'A task needs a lane or weekdays.';
const ROUTINE_LANE = 'A recurring priority stays off the board.';
const ONE_OFF_WEEKDAYS = 'Only a recurring priority has weekdays.';
const BAD_WEEKDAYS = 'weekdays must be one or more days from 1 to 7.';
const BAD_WEEKDAY = 'weekday must be a day from 1 to 7 with on true or false.';
const LAST_WEEKDAY = 'A recurring priority keeps at least one weekday.';
const WEEKDAYS_LIST = 'Send one day as weekday: { day, on }.';
const BAD_BEFORE = 'before must be a task id or null.';
const BAD_NOTE = 'note must be a string.';
const FULL = `The board holds at most ${BOARD_LIMITS.openCards} tasks in Later and Next.`;
const RECURRING_FULL = `The board keeps at most ${BOARD_LIMITS.recurring} recurring priorities.`;

/** A task's name as `taskTitle` stores it; null for anything but text, or blank text. */
function parseTitle(raw: unknown): string | null {
  return typeof raw === 'string' ? taskTitle(raw) || null : null;
}

/** A recurring priority's weekdays as the table's mask: one or more distinct ISO weekdays (1..7) in any order; null for anything else. */
function parseWeekdays(raw: unknown): number | null {
  if (!Array.isArray(raw)) return null;
  const sent: unknown[] = raw;
  const days = sent.filter((day): day is number => isWholeNumber(day, { min: 1, max: 7 }));
  if (days.length === 0 || days.length !== sent.length || new Set(days).size !== days.length) return null;
  return weekdayMask(days);
}

/** One weekday set or cleared on a recurring priority: an ISO weekday (1..7) and whether it is on; null for anything else. */
function parseWeekday(raw: unknown): { day: number; on: boolean } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { day, on } = raw as { day?: unknown; on?: unknown };
  return isWholeNumber(day, { min: 1, max: 7 }) && typeof on === 'boolean' ? { day, on } : null;
}

/** Recurring priorities not removed, which `BOARD_LIMITS.recurring` caps. */
function routineCount(db: DB, userId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND weekdays IS NOT NULL AND archived_at IS NULL`).get(userId) as { n: number }).n;
}

/**
 * The tasks' own routes under `/items`, for the board and Settings: a task typed on a day's sheet
 * is made by the priorities save that first names it instead. Every `/:uid` route works on the
 * caller's own task or answers 404 (`uidRouter`), a deleted task's tombstone included. An archived
 * task is a 404 to PATCH, and to DELETE when it is a recurring priority; an archived one-off can
 * still be deleted everywhere. A write sets the fields it was sent, and the last write wins, but a
 * weekday is set or cleared on its own, so two devices' toggles both land. Every write answers the
 * whole board.
 */
export function itemsRouter(db: DB): Router {
  const { router: r, owned } = uidRouter(db, 'items');

  // A task made on the board, in `lane` before `before` there (a capture, or a new task for a done
  // one), or a recurring priority made in Settings, with `weekdays`. A uid that exists answers the
  // board as it is (a retry), but an archived or deleted task's stays taken: a 404.
  r.post('/', (req, res) => {
    const userId = currentUser(req).id;
    const body = req.body as { uid?: unknown; title?: unknown; categoryUid?: unknown; lane?: unknown; before?: unknown; weekdays?: unknown };
    if (typeof body.uid !== 'string' || !UID_RE.test(body.uid)) return refuse(res, 400, 'uid must be a task id.');
    const title = parseTitle(body.title);
    if (title === null) return refuse(res, 400, NO_TITLE);
    const category = parseUidField(body.categoryUid, BAD_CATEGORY);
    if ('error' in category) return refuse(res, 400, category.error);
    if (body.lane !== undefined && body.weekdays !== undefined) return refuse(res, 400, ROUTINE_LANE);
    if (body.lane === undefined && body.weekdays === undefined) return refuse(res, 400, NO_PLACE);
    const lane = body.lane;
    if (lane !== undefined && !isOneOf(OPEN_LANES, lane)) return refuse(res, 400, BAD_LANE);
    const weekdays = body.weekdays === undefined ? null : parseWeekdays(body.weekdays);
    if (body.weekdays !== undefined && weekdays === null) return refuse(res, 400, BAD_WEEKDAYS);
    const place = parseUidField(body.before, BAD_BEFORE);
    if ('error' in place) return refuse(res, 400, place.error);
    const uid = body.uid.toLowerCase();
    const outcome = db.transaction((): 'kept' | 'created' | { status: number; error: string } => {
      const existing = getOwnedByUid(db, 'items', userId, uid);
      if (existing) return existing.archived_at == null && existing.deleted_at == null ? 'kept' : { status: 404, error: NOT_FOUND };
      if (lane && openCount(db, userId) >= BOARD_LIMITS.openCards) return { status: 400, error: FULL };
      if (weekdays !== null && routineCount(db, userId) >= BOARD_LIMITS.recurring) return { status: 400, error: RECURRING_FULL };
      const item = db
        .prepare(`INSERT INTO items (user_id, uid, title, category_uid, weekdays, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
        .get(userId, uid, title, category.uid ?? null, weekdays, Date.now()) as ItemRow;
      if (lane) placeItem(db, userId, item, lane, place.uid ?? null);
      return 'created';
    })();
    if (typeof outcome === 'object') return refuse(res, outcome.status, outcome.error);
    res.status(outcome === 'created' ? 201 : 200).json(boardJson(db, userId) satisfies Board);
  });

  // A new name, category, note or place, or one weekday set or cleared (`weekday: { day, on }`); a
  // field left out keeps its value. `before` alone reorders the task's lane. A lane given to a task
  // that had none is checked against the cap: a done task in a lane isn't counted, so it takes no
  // room.
  r.patch('/:uid', (req, res) => {
    const item = owned(res);
    if (item.archived_at != null) return refuse(res, 404, NOT_FOUND);
    const body = req.body as {
      title?: unknown;
      categoryUid?: unknown;
      note?: unknown;
      lane?: unknown;
      before?: unknown;
      weekday?: unknown;
      weekdays?: unknown;
    };
    // A tab from before the upgrade sends the whole list; refused, so its change shows as not saved.
    if (body.weekdays !== undefined) return refuse(res, 400, WEEKDAYS_LIST);
    const title = body.title === undefined ? item.title : parseTitle(body.title);
    if (title === null) return refuse(res, 400, NO_TITLE);
    const category = parseUidField(body.categoryUid, BAD_CATEGORY);
    if ('error' in category) return refuse(res, 400, category.error);
    if (body.note !== undefined && typeof body.note !== 'string') return refuse(res, 400, BAD_NOTE);
    const note = body.note === undefined ? item.note : taskNote(body.note);
    const lane = body.lane;
    if (lane !== undefined && !isOneOf(OPEN_LANES, lane)) return refuse(res, 400, BAD_LANE);
    if (item.weekdays != null && lane !== undefined) return refuse(res, 400, ROUTINE_LANE);
    let weekdays = item.weekdays;
    if (body.weekday !== undefined) {
      if (weekdays == null) return refuse(res, 400, ONE_OFF_WEEKDAYS);
      const change = parseWeekday(body.weekday);
      if (change === null) return refuse(res, 400, BAD_WEEKDAY);
      // Only the day pressed changes, so another device's change to the other days stands.
      const bit = weekdayMask([change.day]);
      weekdays = change.on ? weekdays | bit : weekdays & ~bit;
      if (weekdays === 0) return refuse(res, 400, LAST_WEEKDAY);
    }
    const place = parseUidField(body.before, BAD_BEFORE);
    if ('error' in place) return refuse(res, 400, place.error);
    const to = lane ?? item.lane;
    const moves = to != null && (to !== item.lane || place.uid !== undefined);
    const categoryUid = category.uid === undefined ? item.category_uid : category.uid;
    const outcome = db.transaction((): 'full' | 'saved' => {
      const gains = lane !== undefined && item.lane == null;
      if (gains && openCount(db, item.user_id) >= BOARD_LIMITS.openCards) return 'full';
      db.prepare(`UPDATE items SET title = ?, category_uid = ?, note = ?, weekdays = ? WHERE id = ?`).run(title, categoryUid, note, weekdays, item.id);
      if (moves) placeItem(db, item.user_id, item, to, place.uid ?? null);
      return 'saved';
    })();
    if (outcome === 'full') return refuse(res, 400, FULL);
    res.json(boardJson(db, item.user_id) satisfies Board);
  });

  // A one-off task, archived or not, is deleted everywhere (`deleteItem`). A recurring priority is
  // Settings' Remove: it stops repeating and the days it was on keep it, so it is archived, and
  // goes at the prune once nothing names it (`collectItems`). Until then a device still offering
  // it adds the archived routine, never a one-off under its uid.
  r.delete('/:uid', (_req, res) => {
    const item = owned(res);
    if (item.weekdays != null && item.archived_at != null) return refuse(res, 404, NOT_FOUND);
    if (item.weekdays == null) db.transaction(() => deleteItem(db, item.user_id, item, Date.now()))();
    else db.prepare(`UPDATE items SET archived_at = ? WHERE id = ?`).run(Date.now(), item.id);
    res.json(boardJson(db, item.user_id) satisfies Board);
  });

  return r;
}
