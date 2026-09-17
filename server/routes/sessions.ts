import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { ensureDay, isValidDateKey, sessionRowToJson, UID_RE, type SessionRow } from './shared.js';

const MIN_PLANNED = 60;
const MAX_PLANNED = 8 * 3600;

/**
 * A session's priority link: undefined = not mentioned, null = unplanned, a uid that must
 * exist on that day. Returns an error message for anything else.
 */
function parsePriorityUid(db: DB, dayId: number, raw: unknown): { uid: string | null | undefined; error?: string } {
  if (raw === undefined) return { uid: undefined };
  if (raw === null) return { uid: null };
  if (typeof raw !== 'string' || !UID_RE.test(raw)) return { uid: undefined, error: 'priorityUid must be a priority id or null.' };
  const uid = raw.toLowerCase();
  const hit = db.prepare(`SELECT 1 FROM priorities WHERE day_id = ? AND uid = ?`).get(dayId, uid);
  return hit ? { uid } : { uid: undefined, error: 'That priority is not on this day.' };
}

function getOwned(db: DB, userId: number, id: number): (SessionRow & { date: string }) | undefined {
  return db
    .prepare(`SELECT s.*, d.date FROM sessions s JOIN days d ON d.id = s.day_id WHERE s.id = ? AND s.user_id = ?`)
    .get(id, userId) as (SessionRow & { date: string }) | undefined;
}

function running(db: DB, userId: number): (SessionRow & { date: string }) | undefined {
  return db
    .prepare(`SELECT s.*, d.date FROM sessions s JOIN days d ON d.id = s.day_id WHERE s.user_id = ? AND s.status = 'running' LIMIT 1`)
    .get(userId) as (SessionRow & { date: string }) | undefined;
}

/** Mounted at /api/days/:date/sessions (start) — separate router so params flow cleanly. */
export function sessionStartRouter(db: DB): Router {
  const r = Router({ mergeParams: true });

  r.post('/', (req, res) => {
    const user = currentUser(req);
    const date = (req.params as { date: string }).date;
    if (!isValidDateKey(date)) {
      res.status(400).json({ error: 'Invalid date.' });
      return;
    }
    const { label, plannedSeconds, priorityUid } = (req.body ?? {}) as { label?: unknown; plannedSeconds?: unknown; priorityUid?: unknown };
    if (!(typeof plannedSeconds === 'number' && Number.isInteger(plannedSeconds) && plannedSeconds >= MIN_PLANNED && plannedSeconds <= MAX_PLANNED)) {
      res.status(400).json({ error: `plannedSeconds must be between ${MIN_PLANNED} and ${MAX_PLANNED}.` });
      return;
    }
    const existing = running(db, user.id);
    if (existing) {
      res.status(409).json({ error: 'A timer is already running.', session: sessionRowToJson(existing) });
      return;
    }
    const result = db.transaction((): { id: number } | { error: string } => {
      const dayId = ensureDay(db, user.id, date);
      const link = parsePriorityUid(db, dayId, priorityUid);
      if (link.error) return { error: link.error };
      const info = db
        .prepare(
          `INSERT INTO sessions (day_id, user_id, label, notes, planned_seconds, started_at, ended_at, status, priority_uid)
           VALUES (?, ?, ?, '', ?, ?, NULL, 'running', ?)`,
        )
        .run(dayId, user.id, typeof label === 'string' ? label.slice(0, 200) : '', plannedSeconds, Date.now(), link.uid ?? null);
      return { id: Number(info.lastInsertRowid) };
    })();
    if ('error' in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json({ session: sessionRowToJson(getOwned(db, user.id, result.id)!) });
  });

  return r;
}

export function sessionsRouter(db: DB): Router {
  const r = Router();

  r.get('/running', (req, res) => {
    const s = running(db, currentUser(req).id);
    res.json({ session: s ? sessionRowToJson(s) : null });
  });

  r.patch('/:id', (req, res) => {
    const user = currentUser(req);
    const s = getOwned(db, user.id, Number(req.params.id));
    if (!s) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    const { plannedSeconds, label, notes, priorityUid } = (req.body ?? {}) as Record<string, unknown>;
    const next = {
      planned: s.planned_seconds,
      label: s.label,
      notes: s.notes,
      priorityUid: s.priority_uid,
    };
    const link = parsePriorityUid(db, s.day_id, priorityUid);
    if (link.error) {
      res.status(400).json({ error: link.error });
      return;
    }
    if (link.uid !== undefined) next.priorityUid = link.uid;
    if (plannedSeconds !== undefined) {
      if (!(typeof plannedSeconds === 'number' && Number.isInteger(plannedSeconds) && plannedSeconds >= MIN_PLANNED && plannedSeconds <= MAX_PLANNED)) {
        res.status(400).json({ error: `plannedSeconds must be between ${MIN_PLANNED} and ${MAX_PLANNED}.` });
        return;
      }
      if (s.status !== 'running') {
        res.status(409).json({ error: 'Only a running timer can be adjusted.' });
        return;
      }
      next.planned = plannedSeconds;
    }
    if (label !== undefined) next.label = typeof label === 'string' ? label.slice(0, 200) : s.label;
    if (notes !== undefined) next.notes = typeof notes === 'string' ? notes.slice(0, 2000) : s.notes;
    db.prepare(`UPDATE sessions SET planned_seconds = ?, label = ?, notes = ?, priority_uid = ? WHERE id = ?`).run(next.planned, next.label, next.notes, next.priorityUid, s.id);
    res.json({ session: sessionRowToJson(getOwned(db, user.id, s.id)!) });
  });

  // Ends now, but never later than the planned end: a timer that expired while the
  // tab was closed is recorded with its planned duration.
  r.post('/:id/finish', (req, res) => {
    const user = currentUser(req);
    const s = getOwned(db, user.id, Number(req.params.id));
    if (!s) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    if (s.status === 'running') {
      const endedAt = Math.min(Date.now(), s.started_at + s.planned_seconds * 1000);
      db.prepare(`UPDATE sessions SET ended_at = ?, status = 'completed' WHERE id = ?`).run(endedAt, s.id);
    }
    res.json({ session: sessionRowToJson(getOwned(db, user.id, s.id)!) });
  });

  r.post('/:id/cancel', (req, res) => {
    const user = currentUser(req);
    const s = getOwned(db, user.id, Number(req.params.id));
    if (!s) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    if (s.status === 'running') {
      db.prepare(`UPDATE sessions SET ended_at = ?, status = 'cancelled' WHERE id = ?`).run(Date.now(), s.id);
    }
    res.json({ session: sessionRowToJson(getOwned(db, user.id, s.id)!) });
  });

  r.delete('/:id', (req, res) => {
    const user = currentUser(req);
    const info = db.prepare(`DELETE FROM sessions WHERE id = ? AND user_id = ?`).run(Number(req.params.id), user.id);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.json({ ok: true });
  });

  return r;
}
