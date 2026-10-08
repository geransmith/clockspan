import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse } from '../refuse.js';
import { boardJson, collectItems, deleteItem, isDone, openCount, placeItem, weekdayMask } from '../board.js';
import { isWholeNumber } from '../validate.js';
import { getOwnedByUid, parseCategoryUid, uidRouter, UID_RE, type ItemRow } from './shared.js';
import { hasText } from '../../shared/priorities.js';
import { BOARD_LIMITS, LIMITS, type Board, type OpenLane } from '../../shared/api.js';

const NOT_FOUND = 'Task not found.';
const NO_TITLE = 'A task needs a title.';
const BAD_LANE = 'lane must be later or next.';
const NO_PLACE = 'A task needs a lane or weekdays.';
const ROUTINE_LANE = 'A recurring priority stays off the board.';
const ONE_OFF_WEEKDAYS = 'Only a recurring priority has weekdays.';
const BAD_WEEKDAYS = 'weekdays must be one or more days from 1 to 7.';
const FULL = `The board holds at most ${BOARD_LIMITS.openCards} tasks in Later and Next.`;
const RECURRING_FULL = `The board keeps at most ${BOARD_LIMITS.recurring} recurring priorities.`;

/** A task's name: trimmed and cut to a priority's length; null for anything but text, or blank text. */
function parseTitle(raw: unknown): string | null {
  return typeof raw === 'string' && hasText({ text: raw }) ? raw.trim().slice(0, LIMITS.priorityText) : null;
}

/** The lanes the board puts a task in; Done is a ticked entry, and In progress today's list. */
function isOpenLane(raw: unknown): raw is OpenLane {
  return raw === 'later' || raw === 'next';
}

/** Where a task goes in its lane: before this task (lowercased), or at the end for null; undefined = not mentioned. */
function parseBefore(raw: unknown): { before: string | null | undefined } | { error: string } {
  if (raw == null) return { before: raw };
  if (typeof raw === 'string' && UID_RE.test(raw)) return { before: raw.toLowerCase() };
  return { error: 'before must be a task id or null.' };
}

/** A recurring priority's weekdays as the table's mask: one or more distinct ISO weekdays (1..7) in any order; null for anything else. */
function parseWeekdays(raw: unknown): number | null {
  if (!Array.isArray(raw)) return null;
  const sent: unknown[] = raw;
  const days = sent.filter((day): day is number => isWholeNumber(day, { min: 1, max: 7 }));
  if (days.length === 0 || days.length !== sent.length || new Set(days).size !== days.length) return null;
  return weekdayMask(days);
}

/** Recurring priorities not removed, which `BOARD_LIMITS.recurring` caps. */
function routineCount(db: DB, userId: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND weekdays IS NOT NULL AND archived_at IS NULL`).get(userId) as { n: number }).n;
}

/**
 * The tasks' own routes under `/items`, for the board and Settings: a task typed on a day's sheet
 * is made by the priorities save that first names it instead. Every `/:uid` route works on the
 * caller's own task or answers 404 (`uidRouter`), a deleted task's tombstone included. An archived
 * task is a 404 here too, so no lane or edit lands on it. A write sets the fields it was sent, and
 * the last write wins. Every write answers the whole board.
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
    const category = parseCategoryUid(body.categoryUid);
    if ('error' in category) return refuse(res, 400, category.error);
    if (body.lane !== undefined && body.weekdays !== undefined) return refuse(res, 400, ROUTINE_LANE);
    if (body.lane === undefined && body.weekdays === undefined) return refuse(res, 400, NO_PLACE);
    const lane = body.lane;
    if (lane !== undefined && !isOpenLane(lane)) return refuse(res, 400, BAD_LANE);
    const weekdays = body.weekdays === undefined ? null : parseWeekdays(body.weekdays);
    if (body.weekdays !== undefined && weekdays === null) return refuse(res, 400, BAD_WEEKDAYS);
    const place = parseBefore(body.before);
    if ('error' in place) return refuse(res, 400, place.error);
    const uid = body.uid.toLowerCase();
    const outcome = db.transaction((): 'kept' | 'created' | { status: number; error: string } => {
      const existing = getOwnedByUid(db, 'items', userId, uid);
      if (existing) return existing.archived_at == null && existing.deleted_at == null ? 'kept' : { status: 404, error: NOT_FOUND };
      if (lane && openCount(db, userId) >= BOARD_LIMITS.openCards) return { status: 400, error: FULL };
      if (weekdays !== null && routineCount(db, userId) >= BOARD_LIMITS.recurring) return { status: 400, error: RECURRING_FULL };
      const item = db
        .prepare(`INSERT INTO items (user_id, uid, title, category_uid, weekdays, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
        .get(userId, uid, title, category.categoryUid ?? null, weekdays, Date.now()) as ItemRow;
      if (lane) placeItem(db, userId, item, lane, place.before ?? null);
      return 'created';
    })();
    if (typeof outcome === 'object') return refuse(res, outcome.status, outcome.error);
    res.status(outcome === 'created' ? 201 : 200).json(boardJson(db, userId) satisfies Board);
  });

  // A new name, category, place or weekdays; a field left out keeps its value. `before` alone
  // reorders the task's lane. A lane given to a task that had none, or to a done one, is checked
  // against the cap.
  r.patch('/:uid', (req, res) => {
    const item = owned(res);
    if (item.archived_at != null) return refuse(res, 404, NOT_FOUND);
    const body = req.body as { title?: unknown; categoryUid?: unknown; lane?: unknown; before?: unknown; weekdays?: unknown };
    const title = body.title === undefined ? item.title : parseTitle(body.title);
    if (title === null) return refuse(res, 400, NO_TITLE);
    const category = parseCategoryUid(body.categoryUid);
    if ('error' in category) return refuse(res, 400, category.error);
    const lane = body.lane;
    if (lane !== undefined && !isOpenLane(lane)) return refuse(res, 400, BAD_LANE);
    const routine = item.weekdays != null;
    if (routine && lane !== undefined) return refuse(res, 400, ROUTINE_LANE);
    if (!routine && body.weekdays !== undefined) return refuse(res, 400, ONE_OFF_WEEKDAYS);
    const weekdays = body.weekdays === undefined ? item.weekdays : parseWeekdays(body.weekdays);
    if (weekdays === null && routine) return refuse(res, 400, BAD_WEEKDAYS);
    const place = parseBefore(body.before);
    if ('error' in place) return refuse(res, 400, place.error);
    const to = lane ?? item.lane;
    const moves = to != null && (to !== item.lane || place.before !== undefined);
    const categoryUid = category.categoryUid === undefined ? item.category_uid : category.categoryUid;
    const outcome = db.transaction((): 'full' | 'saved' => {
      const gains = lane !== undefined && (item.lane == null || isDone(db, item.id));
      if (gains && openCount(db, item.user_id) >= BOARD_LIMITS.openCards) return 'full';
      db.prepare(`UPDATE items SET title = ?, category_uid = ?, weekdays = ? WHERE id = ?`).run(title, categoryUid, weekdays, item.id);
      if (moves) placeItem(db, item.user_id, item, to, place.before ?? null);
      return 'saved';
    })();
    if (outcome === 'full') return refuse(res, 400, FULL);
    res.json(boardJson(db, item.user_id) satisfies Board);
  });

  // A one-off task, archived or not, is deleted everywhere (`deleteItem`). A recurring priority is
  // Settings' Remove: it stops repeating and the days it was on keep it, so it is archived and
  // deleted only when nothing names it.
  r.delete('/:uid', (_req, res) => {
    const item = owned(res);
    if (item.weekdays != null && item.archived_at != null) return refuse(res, 404, NOT_FOUND);
    db.transaction(() => {
      if (item.weekdays == null) {
        deleteItem(db, item.user_id, item, Date.now());
        return;
      }
      db.prepare(`UPDATE items SET archived_at = ? WHERE id = ?`).run(Date.now(), item.id);
      collectItems(db, item.user_id, [item.id]);
    })();
    res.json(boardJson(db, item.user_id) satisfies Board);
  });

  return r;
}
