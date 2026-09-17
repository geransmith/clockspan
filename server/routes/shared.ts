import type { DB } from '../db.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateKey(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
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

/** Client-minted priority ids (12 hex chars); the server only checks the shape. */
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
  status: 'running' | 'completed' | 'cancelled';
  priority_uid: string | null;
}

export function sessionRowToJson(s: SessionRow & { date: string }) {
  return {
    id: s.id,
    date: s.date,
    label: s.label,
    notes: s.notes,
    plannedSeconds: s.planned_seconds,
    startedAt: s.started_at,
    endedAt: s.ended_at,
    status: s.status,
    durationSeconds: s.ended_at != null ? Math.round((s.ended_at - s.started_at) / 1000) : null,
    priorityUid: s.priority_uid,
  };
}
