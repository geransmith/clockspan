import { Router, type RequestHandler, type Response } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { dateParam, ensureDay, requireDate, sessionRowToJson, UID_RE, type SessionRow } from './shared.js';
import { LIMITS } from '../../shared/api.js';
import { plannedEndAt } from '../../shared/timer.js';

const MIN_PLANNED = 60;
const MAX_PLANNED = 8 * 3600;

type OwnedSession = SessionRow & { date: string };

/** A whole number of seconds within the timer's range, or the message to send back. */
function parsePlannedSeconds(raw: unknown): { seconds: number } | { error: string } {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= MIN_PLANNED && raw <= MAX_PLANNED) return { seconds: raw };
  return { error: `plannedSeconds must be between ${MIN_PLANNED} and ${MAX_PLANNED}.` };
}

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

function getOwned(db: DB, userId: number, id: number): OwnedSession | undefined {
  return db.prepare(`SELECT s.*, d.date FROM sessions s JOIN days d ON d.id = s.day_id WHERE s.id = ? AND s.user_id = ?`).get(id, userId) as
    OwnedSession | undefined;
}

function running(db: DB, userId: number): OwnedSession | undefined {
  return db.prepare(`SELECT s.*, d.date FROM sessions s JOIN days d ON d.id = s.day_id WHERE s.user_id = ? AND s.status = 'running' LIMIT 1`).get(userId) as
    OwnedSession | undefined;
}

/** Mounted at /api/days/:date/sessions (start) — separate router so params flow cleanly. */
export function sessionStartRouter(db: DB): Router {
  const r = Router({ mergeParams: true });

  r.post('/', requireDate, (req, res) => {
    const user = currentUser(req);
    const date = dateParam(req);
    const { label, plannedSeconds, priorityUid } = (req.body ?? {}) as { label?: unknown; plannedSeconds?: unknown; priorityUid?: unknown };
    const planned = parsePlannedSeconds(plannedSeconds);
    if ('error' in planned) {
      res.status(400).json({ error: planned.error });
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
        .run(dayId, user.id, typeof label === 'string' ? label.slice(0, LIMITS.sessionLabel) : '', planned.seconds, Date.now(), link.uid ?? null);
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

  // Every /:id route below works on the caller's own session or answers 404; the row is
  // handed on through res.locals so the handlers don't repeat the lookup.
  const loadOwnedSession: RequestHandler = (req, res, next) => {
    const s = getOwned(db, currentUser(req).id, Number(req.params.id));
    if (!s) {
      res.status(404).json({ error: 'Session not found.' });
      return;
    }
    res.locals.session = s;
    next();
  };
  const owned = (res: Response) => res.locals.session as OwnedSession;
  const reply = (res: Response, userId: number, id: number) => res.json({ session: sessionRowToJson(getOwned(db, userId, id)!) });

  r.patch('/:id', loadOwnedSession, (req, res) => {
    const s = owned(res);
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
      const planned = parsePlannedSeconds(plannedSeconds);
      if ('error' in planned) {
        res.status(400).json({ error: planned.error });
        return;
      }
      if (s.status !== 'running') {
        res.status(409).json({ error: 'Only a running timer can be adjusted.' });
        return;
      }
      next.planned = planned.seconds;
    }
    if (label !== undefined) {
      if (typeof label !== 'string') {
        res.status(400).json({ error: 'label must be a string.' });
        return;
      }
      next.label = label.slice(0, LIMITS.sessionLabel);
    }
    if (notes !== undefined) {
      if (typeof notes !== 'string') {
        res.status(400).json({ error: 'notes must be a string.' });
        return;
      }
      next.notes = notes.slice(0, LIMITS.sessionNotes);
    }
    db.prepare(`UPDATE sessions SET planned_seconds = ?, label = ?, notes = ?, priority_uid = ? WHERE id = ?`).run(
      next.planned,
      next.label,
      next.notes,
      next.priorityUid,
      s.id,
    );
    reply(res, s.user_id, s.id);
  });

  // A paused session stays 'running' with paused_at set; resuming folds the pause into
  // paused_seconds. Both are idempotent like finish and cancel: the row is answered as it is.
  r.post('/:id/pause', loadOwnedSession, (_req, res) => {
    const s = owned(res);
    if (s.status !== 'running') {
      res.status(409).json({ error: 'Only a running timer can be paused.' });
      return;
    }
    if (s.paused_at == null) db.prepare(`UPDATE sessions SET paused_at = ? WHERE id = ?`).run(Date.now(), s.id);
    reply(res, s.user_id, s.id);
  });

  r.post('/:id/resume', loadOwnedSession, (_req, res) => {
    const s = owned(res);
    if (s.status !== 'running') {
      res.status(409).json({ error: 'Only a running timer can be resumed.' });
      return;
    }
    if (s.paused_at != null) {
      const paused = Math.round((Date.now() - s.paused_at) / 1000);
      db.prepare(`UPDATE sessions SET paused_seconds = paused_seconds + ?, paused_at = NULL WHERE id = ?`).run(paused, s.id);
    }
    reply(res, s.user_id, s.id);
  });

  // Ends now, but never later than the planned end: a timer that ran out unattended is
  // recorded with its planned duration. `countOverrun: true` is the user choosing to log the
  // time past the end as well (they were there for it). A session finished while paused ends
  // when the pause began (no work happened since), so the log excludes every pause.
  r.post('/:id/finish', loadOwnedSession, (req, res) => {
    const s = owned(res);
    const { countOverrun } = (req.body ?? {}) as { countOverrun?: unknown };
    if (countOverrun !== undefined && typeof countOverrun !== 'boolean') {
      res.status(400).json({ error: 'countOverrun must be a boolean.' });
      return;
    }
    if (s.status === 'running') {
      const now = Date.now();
      const timing = { startedAt: s.started_at, plannedSeconds: s.planned_seconds, pausedSeconds: s.paused_seconds, pausedAt: s.paused_at };
      const until = s.paused_at ?? now;
      const endedAt = countOverrun ? until : Math.min(until, plannedEndAt(timing, now));
      db.prepare(`UPDATE sessions SET ended_at = ?, paused_at = NULL, status = 'completed' WHERE id = ?`).run(endedAt, s.id);
    }
    reply(res, s.user_id, s.id);
  });

  r.post('/:id/cancel', loadOwnedSession, (_req, res) => {
    const s = owned(res);
    if (s.status === 'running') {
      db.prepare(`UPDATE sessions SET ended_at = ?, paused_at = NULL, status = 'cancelled' WHERE id = ?`).run(Date.now(), s.id);
    }
    reply(res, s.user_id, s.id);
  });

  r.delete('/:id', loadOwnedSession, (_req, res) => {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(owned(res).id);
    res.json({ ok: true });
  });

  return r;
}
