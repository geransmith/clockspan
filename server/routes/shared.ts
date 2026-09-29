import type { RequestHandler } from 'express';
import type { DB } from '../db.js';
import { isValidDateKey } from '../../shared/dates.js';
import type { Break, Session, SessionStatus } from '../../shared/api.js';
import { activeMs, MIN_BREAK_MS } from '../../shared/timer.js';

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

export function breakRowToJson(b: BreakRow & { date: string }): Break {
  return { id: b.id, date: b.date, plannedSeconds: b.planned_seconds, startedAt: b.started_at, endedAt: b.ended_at };
}

/**
 * Ends the user's running break, if any, at `now`: a new break or a focus session starting
 * means the last break is over, so no two overlap in the log. One that ran under a minute
 * is deleted instead.
 */
export function endRunningBreak(db: DB, userId: number, now: number): void {
  db.prepare(`DELETE FROM breaks WHERE user_id = ? AND ended_at > ? AND started_at > ?`).run(userId, now, now - MIN_BREAK_MS);
  db.prepare(`UPDATE breaks SET ended_at = ? WHERE user_id = ? AND ended_at > ?`).run(now, userId, now);
}

export function sessionRowToJson(s: SessionRow & { date: string }): Session {
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
