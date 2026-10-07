import { Router, type Response } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse } from '../refuse.js';
import { isWholeNumber } from '../validate.js';
import type { Break, Punch, Session, SessionStatus } from '../../shared/api.js';
import { activeMs, MIN_BREAK_MS } from '../../shared/timer.js';

export interface DayRow {
  id: number;
  date: string;
  overtime_approved: number;
  retro_note: string;
  retro_at: number | null;
  work_minutes: number | null;
}

/** The `days` columns a `Day` is built from. `findDay` and `daysInRange` (`routes/days.ts`) both read these, so a new per-day column is added here once, and on `DayRow`. */
export const DAY_COLUMNS = 'id, date, overtime_approved, retro_note, retro_at, work_minutes';

export function findDay(db: DB, userId: number, date: string): DayRow | undefined {
  return db.prepare(`SELECT ${DAY_COLUMNS} FROM days WHERE user_id = ? AND date = ?`).get(userId, date) as DayRow | undefined;
}

/** Ids the client or the server mints (a priority's, and those of the cards, categories and recurring priorities it links to): 12 hex chars (`newUid`); only the shape is checked, loosely. */
export const UID_RE = /^[a-z0-9]{8,32}$/i;

export function ensureDay(db: DB, userId: number, date: string): number {
  const existing = findDay(db, userId, date);
  if (existing) return existing.id;
  const info = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, ?, ?)`).run(userId, date, Date.now());
  return Number(info.lastInsertRowid);
}

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

export interface PriorityRow {
  id: number;
  day_id: number;
  position: number;
  text: string;
  done: number;
  uid: string | null;
  added_at: number | null;
  card_uid: string | null;
  recurring_uid: string | null;
  category_uid: string | null;
}

interface SessionRowFields {
  id: number;
  day_id: number;
  user_id: number;
  label: string;
  planned_seconds: number;
  started_at: number;
  priority_uid: string | null;
  paused_seconds: number;
  paused_at: number | null;
}

export type SessionRow = SessionRowFields & ({ status: 'running'; ended_at: null } | { status: Exclude<SessionStatus, 'running'>; ended_at: number });

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
 * The router for `table`'s `/:id` routes, and where the ownership check lives. It runs as the
 * router's `id` param handler, so every route on this router with an `:id` in its path gets it,
 * one added later included, without listing a guard. It answers 404 for anyone else's row, or
 * none (an id that is not plain digits finds none), and hands the caller's own on to the
 * handler, which reads it with `owned(res)` instead of repeating the lookup.
 */
export function ownedRouter<T extends OwnedTable>(db: DB, table: T): { router: Router; owned: (res: Response) => Dated<OwnedRows[T]> } {
  const router = Router();
  router.param('id', (req, res, next, id: string) => {
    // Number() also reads '0x1', '1e0', '+1' and ' 1' (from %201) as 1.
    const row = /^\d+$/.test(id) ? getOwned(db, table, currentUser(req).id, Number(id)) : undefined;
    if (!row) return refuse(res, 404, NOT_FOUND[table]);
    res.locals.owned = row;
    next();
  });
  return { router, owned: (res) => res.locals.owned as Dated<OwnedRows[T]> };
}

/** The user's running session, if any: there is at most one (a unique partial index). */
export function runningSession(db: DB, userId: number): Dated<SessionRow> | undefined {
  return db.prepare(`SELECT s.*, d.date FROM sessions s JOIN days d ON d.id = s.day_id WHERE s.user_id = ? AND s.status = 'running' LIMIT 1`).get(userId) as
    Dated<SessionRow> | undefined;
}

export function breakRowToJson(b: Dated<BreakRow>): Break {
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

export function sessionRowToJson(s: Dated<SessionRow>): Session {
  const fields = {
    id: s.id,
    date: s.date,
    label: s.label,
    plannedSeconds: s.planned_seconds,
    startedAt: s.started_at,
    pausedSeconds: s.paused_seconds,
    pausedAt: s.paused_at,
    priorityUid: s.priority_uid,
  };
  if (s.status === 'running') return { ...fields, status: 'running', endedAt: null, durationSeconds: null };
  return { ...fields, status: s.status, endedAt: s.ended_at, durationSeconds: Math.round(activeMs(fields, s.ended_at) / 1000) };
}
