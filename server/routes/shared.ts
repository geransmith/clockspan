import type { RequestHandler } from 'express';
import type { DB } from '../db.js';
import { isValidDateKey } from '../../shared/dates.js';
import type { Session, SessionStatus } from '../../shared/api.js';
import { activeMs } from '../../shared/timer.js';

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
}

export function findDay(db: DB, userId: number, date: string): DayRow | undefined {
  return db.prepare(`SELECT id, overtime_approved, retro_note, retro_at FROM days WHERE user_id = ? AND date = ?`).get(userId, date) as DayRow | undefined;
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
