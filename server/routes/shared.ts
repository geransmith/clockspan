import type { RequestHandler, Response } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { isValidDateKey } from '../../shared/dates.js';
import type { Break, Punch, Session, SessionStatus } from '../../shared/api.js';
import { activeMs, BREAK_SECONDS } from '../../shared/timer.js';

/** Guards a `/:date` route: 400 unless the param is a real `YYYY-MM-DD`. Works under `mergeParams` too. */
export const requireDate: RequestHandler = (req, res, next) => {
  if (!isValidDateKey(req.params.date)) {
    res.status(400).json({ error: 'Invalid date.' });
    return;
  }
  next();
};

/** The `:date` param after `requireDate`; typed so handlers don't repeat the cast. */
export function dateParam(req: { params: Record<string, string | string[] | undefined> }): string {
  return req.params.date as string;
}

export interface DayRow {
  id: number;
  overtime_approved: number;
  retro_note: string;
  retro_at: number | null;
  work_minutes: number | null;
}

/** The `days` columns a `Day` is built from. `findDay` and `/days/range` both read these, so a new per-day column is added here once. */
export const DAY_COLUMNS = 'id, overtime_approved, retro_note, retro_at, work_minutes';

export function findDay(db: DB, userId: number, date: string): DayRow | undefined {
  return db.prepare(`SELECT ${DAY_COLUMNS} FROM days WHERE user_id = ? AND date = ?`).get(userId, date) as DayRow | undefined;
}

/** Priority ids: the client mints 12 hex chars (`newUid`); the server only checks the shape, loosely. */
export const UID_RE = /^[a-z0-9]{8,32}$/i;

export function ensureDay(db: DB, userId: number, date: string): number {
  const existing = findDay(db, userId, date);
  if (existing) return existing.id;
  const info = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, ?, ?)`).run(userId, date, Date.now());
  return Number(info.lastInsertRowid);
}

/** A whole number of seconds within `bounds` for a `plannedSeconds` field, or the message to send back. */
export function parsePlannedSeconds(raw: unknown, bounds: { min: number; max: number }): { seconds: number } | { error: string } {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= bounds.min && raw <= bounds.max) return { seconds: raw };
  return { error: `plannedSeconds must be between ${bounds.min} and ${bounds.max}.` };
}

export interface PunchRow {
  id: number;
  day_id: number;
  position: number;
  kind: Punch['kind'];
  at: number | null;
}

export interface PriorityRow {
  id: number;
  day_id: number;
  position: number;
  text: string;
  done: number;
  uid: string | null;
  added_at: number | null;
}

export interface SessionRow {
  id: number;
  day_id: number;
  user_id: number;
  label: string;
  notes: string;
  planned_seconds: number;
  started_at: number;
  ended_at: number | null;
  status: SessionStatus;
  priority_uid: string | null;
  paused_seconds: number;
  paused_at: number | null;
}

export interface BreakRow {
  id: number;
  day_id: number;
  user_id: number;
  planned_seconds: number;
  started_at: number;
  ended_at: number;
}

/** A session or break row with its day's date, which every answer about it carries. */
export type Dated<Row> = Row & { date: string };

/** The tables a `/:id` route works on: each row belongs to one user and one day. */
interface OwnedRows {
  sessions: SessionRow;
  breaks: BreakRow;
}
type OwnedTable = keyof OwnedRows;
const NOT_FOUND: Record<OwnedTable, string> = { sessions: 'Session not found.', breaks: 'Break not found.' };

/** The user's own row of `table` with its date; undefined for anyone else's, or none. */
export function getOwned<T extends OwnedTable>(db: DB, table: T, userId: number, id: number): Dated<OwnedRows[T]> | undefined {
  return db.prepare(`SELECT x.*, d.date FROM ${table} x JOIN days d ON d.id = x.day_id WHERE x.id = ? AND x.user_id = ?`).get(id, userId) as
    Dated<OwnedRows[T]> | undefined;
}

/**
 * For the `/:id` routes of `table`: `load` is the guard each of them takes, which is where the
 * ownership check lives. It answers 404 for anyone else's row, or none, and hands the caller's
 * own on to the handler, which reads it with `owned(res)` instead of repeating the lookup.
 */
export function ownedRows<T extends OwnedTable>(db: DB, table: T): { load: RequestHandler; owned: (res: Response) => Dated<OwnedRows[T]> } {
  return {
    load: (req, res, next) => {
      const row = getOwned(db, table, currentUser(req).id, Number(req.params.id));
      if (!row) {
        res.status(404).json({ error: NOT_FOUND[table] });
        return;
      }
      res.locals.owned = row;
      next();
    },
    owned: (res) => res.locals.owned as Dated<OwnedRows[T]>,
  };
}

/** The user's running session, if any: there is at most one (a unique partial index). */
export function runningSession(db: DB, userId: number): Dated<SessionRow> | undefined {
  return db.prepare(`SELECT s.*, d.date FROM sessions s JOIN days d ON d.id = s.day_id WHERE s.user_id = ? AND s.status = 'running' LIMIT 1`).get(userId) as
    Dated<SessionRow> | undefined;
}

export function breakRowToJson(b: Dated<BreakRow>): Break {
  return { id: b.id, date: b.date, plannedSeconds: b.planned_seconds, startedAt: b.started_at, endedAt: b.ended_at };
}

/** A break that ends at `now` after running less than this is dropped rather than logged. */
export const MIN_BREAK_MS = BREAK_SECONDS.min * 1000;

/**
 * Ends the user's running break, if any, at `now`: a new break or a focus session starting
 * means the last break is over, so no two overlap in the log. One that ran under a minute
 * is deleted instead.
 */
export function endRunningBreak(db: DB, userId: number, now: number): void {
  db.prepare(`DELETE FROM breaks WHERE user_id = ? AND ended_at > ? AND started_at > ?`).run(userId, now, now - MIN_BREAK_MS);
  db.prepare(`UPDATE breaks SET ended_at = ? WHERE user_id = ? AND ended_at > ?`).run(now, userId, now);
}

export function sessionRowToJson(s: Dated<SessionRow>): Session {
  const timing = { startedAt: s.started_at, pausedSeconds: s.paused_seconds, pausedAt: s.paused_at };
  return {
    id: s.id,
    date: s.date,
    label: s.label,
    notes: s.notes,
    plannedSeconds: s.planned_seconds,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    status: s.status,
    pausedSeconds: s.paused_seconds,
    pausedAt: s.paused_at,
    durationSeconds: s.ended_at != null ? Math.round(activeMs(timing, s.ended_at) / 1000) : null,
    priorityUid: s.priority_uid,
  };
}
