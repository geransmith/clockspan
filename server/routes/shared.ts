import { Router, type Request, type Response } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse } from '../refuse.js';
import { isWholeNumber, parseId } from '../validate.js';
import type { Break, CategoryColor, OpenLane, Punch, Session, SessionStatus } from '../../shared/api.js';
import { activeMs, MIN_BREAK_MS } from '../../shared/timer.js';

export interface DayRow {
  id: number;
  date: string;
  overtime_approved: number;
  retro_note: string;
  retro_at: number | null;
  work_minutes: number | null;
}

/** The `days` columns a `Day` is built from. `findDay` below and `daysInRange` (`routes/days.ts`) both read these, so a new per-day column is added here once, and on `DayRow`. */
export const DAY_COLUMNS = 'id, date, overtime_approved, retro_note, retro_at, work_minutes';

export function findDay(db: DB, userId: number, date: string): DayRow | undefined {
  return db.prepare(`SELECT ${DAY_COLUMNS} FROM days WHERE user_id = ? AND date = ?`).get(userId, date) as DayRow | undefined;
}

/** Ids the client or the server mints (a task's, a category's): 12 hex chars (`newUid`); only the shape is checked, loosely. */
export const UID_RE = /^[a-z0-9]{8,32}$/i;

export function ensureDay(db: DB, userId: number, date: string): number {
  const existing = findDay(db, userId, date);
  if (existing) return existing.id;
  const info = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, ?, ?)`).run(userId, date, Date.now());
  return Number(info.lastInsertRowid);
}

/**
 * An optional uid field (a `categoryUid`, a lane's `before`): undefined = not mentioned, null =
 * none, or a uid, lowercased; anything else gets `message`. Only the shape is checked: a category
 * is a soft link, and one made on this device may reach the server after the task or session that
 * names it.
 */
export function parseUidField(raw: unknown, message: string): { uid: string | null | undefined } | { error: string } {
  if (raw == null) return { uid: raw };
  if (typeof raw === 'string' && UID_RE.test(raw)) return { uid: raw.toLowerCase() };
  return { error: message };
}

/** What a bad `categoryUid` is refused with. */
export const BAD_CATEGORY = "categoryUid must be a category's id or null.";

/** A whole number of seconds within `bounds` for a `plannedSeconds` field, or the message to send back. */
export function parsePlannedSeconds(raw: unknown, bounds: { min: number; max: number }): { seconds: number } | { error: string } {
  if (isWholeNumber(raw, bounds)) return { seconds: raw };
  return { error: `plannedSeconds must be a whole number from ${bounds.min} to ${bounds.max}.` };
}

export interface PunchRow {
  id: number;
  day_id: number;
  position: number;
  kind: Punch['kind'];
  at: number | null;
}

/**
 * A task as stored: a one-off, or a recurring priority (`weekdays` set, never in a lane). One a
 * full delete took stays as a tombstone (`deleted_at` set) until the prune, so its uid stays taken.
 */
export interface ItemRow {
  id: number;
  user_id: number;
  uid: string;
  title: string;
  category_uid: string | null;
  /** '' with none. */
  note: string;
  /** A mask: bit 0 for Monday to bit 6 for Sunday, at least one set; null on a one-off. */
  weekdays: number | null;
  lane: OpenLane | null;
  /** 1..n within its lane, 0 with none. */
  position: number;
  created_at: number;
  archived_at: number | null;
  deleted_at: number | null;
}

/** A session as `SESSIONS` reads it: its own columns, its day's date, and its task's uid, name and the category it counts under. */
interface SessionRowFields {
  id: number;
  day_id: number;
  user_id: number;
  date: string;
  label: string;
  planned_seconds: number;
  started_at: number;
  paused_seconds: number;
  paused_at: number | null;
  /** The task; null for an unplanned session. */
  item_id: number | null;
  /** The category picked in the log, or kept from a task it lost; read only while it has no task. */
  category_uid: string | null;
  item_uid: string | null;
  item_title: string | null;
  /** Its task's category with one, else its own: what it counts under. */
  category: string | null;
}

export type SessionRow = SessionRowFields & ({ status: 'running'; ended_at: null } | { status: Exclude<SessionStatus, 'running'>; ended_at: number });

/** A break as `BREAKS` reads it: its own columns and its day's date, which every answer about it carries. */
export interface BreakRow {
  id: number;
  day_id: number;
  user_id: number;
  date: string;
  planned_seconds: number;
  started_at: number;
  ended_at: number;
}

/** A category as stored; one removed in Settings has `archived_at` set and is never deleted. */
export interface CategoryRow {
  id: number;
  user_id: number;
  uid: string;
  name: string;
  /** Checked by the routes (`CATEGORY_COLORS`); the table has no CHECK. */
  color: CategoryColor;
  archived_at: number | null;
}

/**
 * Sessions as every reader takes them (`x`): with their day's date, and through their task its
 * uid, current name and category, so a session is named and counted by its task's current name and category.
 */
export const SESSIONS = `SELECT x.*, d.date, i.uid AS item_uid, i.title AS item_title,
    CASE WHEN x.item_id IS NOT NULL THEN i.category_uid ELSE x.category_uid END AS category
  FROM sessions x JOIN days d ON d.id = x.day_id LEFT JOIN items i ON i.id = x.item_id`;

/** Breaks as every reader takes them (`x`), with their day's date. */
export const BREAKS = 'SELECT x.*, d.date FROM breaks x JOIN days d ON d.id = x.day_id';

/** The tables a `/:id` route works on: each row belongs to one user and one day. */
interface OwnedRows {
  sessions: SessionRow;
  breaks: BreakRow;
}
type OwnedTable = keyof OwnedRows;
const NOT_FOUND: Record<OwnedTable, string> = { sessions: 'Session not found.', breaks: 'Break not found.' };
/** How each table's rows are read (as `x`), with their date. */
const OWNED_SELECT: Record<OwnedTable, string> = { sessions: SESSIONS, breaks: BREAKS };

/** The user's own row of `table` with its date; undefined for anyone else's, or none. */
export function getOwned<T extends OwnedTable>(db: DB, table: T, userId: number, id: number): OwnedRows[T] | undefined {
  return db.prepare(`${OWNED_SELECT[table]} WHERE x.id = ? AND x.user_id = ?`).get(id, userId) as OwnedRows[T] | undefined;
}

/**
 * A router whose `param` handler is the ownership check: `find` looks up the caller's own row
 * for the param's value, and anything it doesn't find answers 404 with `notFound`. The row goes
 * on to the handler, which reads it with `owned(res)` instead of repeating the lookup.
 */
function guardedRouter<Row>(
  param: string,
  find: (req: Request, value: string) => Row | undefined,
  notFound: string,
): { router: Router; owned: (res: Response) => Row } {
  const router = Router();
  router.param(param, (req, res, next, value: string) => {
    const row = find(req, value);
    if (row === undefined) return refuse(res, 404, notFound);
    res.locals.owned = row;
    next();
  });
  return { router, owned: (res) => res.locals.owned as Row };
}

/**
 * The router for `table`'s `/:id` routes, and where the ownership check lives. It runs as the
 * router's `id` param handler, so every route on this router with an `:id` in its path gets it,
 * one added later included, without listing a guard. It answers 404 for anyone else's row, or
 * none (an id that is not plain digits finds none), and hands the caller's own on to the
 * handler, which reads it with `owned(res)` instead of repeating the lookup.
 */
export function ownedRouter<T extends OwnedTable>(db: DB, table: T): { router: Router; owned: (res: Response) => OwnedRows[T] } {
  return guardedRouter(
    'id',
    (req, raw) => {
      const id = parseId(raw);
      return id === undefined ? undefined : getOwned(db, table, currentUser(req).id, id);
    },
    NOT_FOUND[table],
  );
}

/** The tables a `/:uid` route works on: each row belongs to one user, and to no day, and is named by its uid. */
interface UidRows {
  categories: CategoryRow;
  items: ItemRow;
}
type UidTable = keyof UidRows;
export const UID_NOT_FOUND: Record<UidTable, string> = { categories: 'Category not found.', items: 'Task not found.' };
/** The rows a table keeps that its routes treat as none: a deleted task stays as a tombstone until the prune. */
const UID_GONE: { [T in UidTable]: (row: UidRows[T]) => boolean } = { categories: () => false, items: (row) => row.deleted_at != null };

/** The user's own row of `table` with this uid (lowercase), a tombstone included; undefined for anyone else's, or none. */
export function getOwnedByUid<T extends UidTable>(db: DB, table: T, userId: number, uid: string): UidRows[T] | undefined {
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND uid = ?`).get(userId, uid) as UidRows[T] | undefined;
}

/**
 * `ownedRouter` for a table whose rows hang off the user rather than a day: the router for
 * `table`'s `/:uid` routes, where the ownership check lives as the router's `uid` param handler,
 * so every route on it with a `:uid` in its path gets it, one added later included. It answers
 * 404 for anyone else's row, or none (a uid of the wrong shape finds none, and a deleted task's
 * tombstone counts as none), and hands the caller's own on to the handler, which reads it with
 * `owned(res)`.
 */
export function uidRouter<T extends UidTable>(db: DB, table: T): { router: Router; owned: (res: Response) => UidRows[T] } {
  return guardedRouter(
    'uid',
    (req, uid) => {
      const row = UID_RE.test(uid) ? getOwnedByUid(db, table, currentUser(req).id, uid.toLowerCase()) : undefined;
      return row && !UID_GONE[table](row) ? row : undefined;
    },
    UID_NOT_FOUND[table],
  );
}

/** The user's running session, if any: there is at most one (a unique partial index). */
export function runningSession(db: DB, userId: number): SessionRow | undefined {
  return db.prepare(`${SESSIONS} WHERE x.user_id = ? AND x.status = 'running' LIMIT 1`).get(userId) as SessionRow | undefined;
}

export function breakRowToJson(b: BreakRow): Break {
  return { id: b.id, date: b.date, plannedSeconds: b.planned_seconds, startedAt: b.started_at, endedAt: b.ended_at };
}

/**
 * Ends the user's running break, if any, at `now`: a new break, a focus session starting or End
 * break (`POST /breaks/:id/end`) means the break is over, so no two overlap in the log. A break
 * start always ends the one before, so there is at most one. One that ran under `MIN_BREAK_MS`
 * is deleted instead.
 */
export function endRunningBreak(db: DB, userId: number, now: number): void {
  db.prepare(`DELETE FROM breaks WHERE user_id = ? AND ended_at > ? AND started_at > ?`).run(userId, now, now - MIN_BREAK_MS);
  db.prepare(`UPDATE breaks SET ended_at = ? WHERE user_id = ? AND ended_at > ?`).run(now, userId, now);
}

export function sessionRowToJson(s: SessionRow): Session {
  const fields = {
    id: s.id,
    date: s.date,
    label: s.label,
    plannedSeconds: s.planned_seconds,
    startedAt: s.started_at,
    pausedSeconds: s.paused_seconds,
    pausedAt: s.paused_at,
    priorityUid: s.item_uid,
    title: s.item_title,
    categoryUid: s.category,
  };
  if (s.status === 'running') return { ...fields, status: 'running', endedAt: null, durationSeconds: null };
  return { ...fields, status: s.status, endedAt: s.ended_at, durationSeconds: Math.round(activeMs(fields, s.ended_at) / 1000) };
}
