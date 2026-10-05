import type { RequestHandler, Response, Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse } from '../refuse.js';
import { endRunningBreak, ensureDay, findDay, getOwned, ownedRouter, parsePlannedSeconds, runningSession, sessionRowToJson, UID_RE } from './shared.js';
import { LIMITS, type OkResponse, type RunningResponse, type SessionConflict, type SessionResponse } from '../../shared/api.js';
import { pausedSecondsAfter, PLANNED_SECONDS, plannedEndAt } from '../../shared/timer.js';

/**
 * A session's priority link: undefined = not mentioned, null = unplanned, a uid that must
 * exist on that day (`dayId` undefined: a day not stored yet, which has none). Returns an
 * error message for anything else.
 */
function parsePriorityUid(db: DB, dayId: number | undefined, raw: unknown): { uid: string | null | undefined } | { error: string } {
  if (raw === undefined) return { uid: undefined };
  if (raw === null) return { uid: null };
  if (typeof raw !== 'string' || !UID_RE.test(raw)) return { error: 'priorityUid must be a priority id or null.' };
  const uid = raw.toLowerCase();
  const hit = dayId !== undefined && db.prepare(`SELECT 1 FROM priorities WHERE day_id = ? AND uid = ?`).get(dayId, uid);
  return hit ? { uid } : { error: 'That priority is not on this day.' };
}

/**
 * A session's label: undefined = not mentioned, a string cut to `LIMITS.sessionLabel`. Anything
 * else is refused, on start as on PATCH.
 */
function parseLabel(raw: unknown): { label: string | undefined } | { error: string } {
  if (raw === undefined) return { label: undefined };
  if (typeof raw !== 'string') return { error: 'label must be a string.' };
  return { label: raw.slice(0, LIMITS.sessionLabel) };
}

/** `POST /days/:date/sessions`, registered on the days router, whose date check has already run. */
export function startSession(db: DB): RequestHandler<{ date: string }> {
  return (req, res) => {
    const user = currentUser(req);
    const date = req.params.date;
    const { label, plannedSeconds, priorityUid } = req.body as { label?: unknown; plannedSeconds?: unknown; priorityUid?: unknown };
    const planned = parsePlannedSeconds(plannedSeconds, PLANNED_SECONDS);
    if ('error' in planned) return refuse(res, 400, planned.error);
    const name = parseLabel(label);
    if ('error' in name) return refuse(res, 400, name.error);
    const existing = runningSession(db, user.id);
    if (existing) {
      res.status(409).json({ error: 'A timer is already running.', session: sessionRowToJson(existing) } satisfies SessionConflict);
      return;
    }
    // Checked before the day is stored, so a refused start leaves no empty day behind.
    const link = parsePriorityUid(db, findDay(db, user.id, date)?.id, priorityUid);
    if ('error' in link) return refuse(res, 400, link.error);
    const id = db.transaction(() => {
      const dayId = ensureDay(db, user.id, date);
      const now = Date.now();
      // Back to work, on any device: a break still running ends here.
      endRunningBreak(db, user.id, now);
      const info = db
        .prepare(
          `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status, priority_uid)
           VALUES (?, ?, ?, ?, ?, NULL, 'running', ?)`,
        )
        .run(dayId, user.id, name.label ?? '', planned.seconds, now, link.uid ?? null);
      return Number(info.lastInsertRowid);
    })();
    res.status(201).json({ session: sessionRowToJson(getOwned(db, 'sessions', user.id, id)!) } satisfies SessionResponse);
  };
}

export function sessionsRouter(db: DB): Router {
  // Every /:id route works on the caller's own session or answers 404 (`ownedRouter`).
  const { router: r, owned } = ownedRouter(db, 'sessions');

  r.get('/running', (req, res) => {
    const s = runningSession(db, currentUser(req).id);
    res.json({ session: s ? sessionRowToJson(s) : null } satisfies RunningResponse);
  });

  const reply = (res: Response, userId: number, id: number) =>
    res.json({ session: sessionRowToJson(getOwned(db, 'sessions', userId, id)!) } satisfies SessionResponse);

  r.patch('/:id', (req, res) => {
    const s = owned(res);
    const { plannedSeconds, label, priorityUid } = req.body as { plannedSeconds?: unknown; label?: unknown; priorityUid?: unknown };
    const link = parsePriorityUid(db, s.day_id, priorityUid);
    if ('error' in link) return refuse(res, 400, link.error);
    let planned = s.planned_seconds;
    if (plannedSeconds !== undefined) {
      const parsed = parsePlannedSeconds(plannedSeconds, PLANNED_SECONDS);
      if ('error' in parsed) return refuse(res, 400, parsed.error);
      if (s.status !== 'running') return refuse(res, 409, 'Only a running timer can be adjusted.');
      planned = parsed.seconds;
    }
    const name = parseLabel(label);
    if ('error' in name) return refuse(res, 400, name.error);
    db.prepare(`UPDATE sessions SET planned_seconds = ?, label = ?, priority_uid = ? WHERE id = ?`).run(
      planned,
      name.label ?? s.label,
      link.uid === undefined ? s.priority_uid : link.uid,
      s.id,
    );
    reply(res, s.user_id, s.id);
  });

  // A paused session stays 'running' with paused_at set; resuming folds the pause into
  // paused_seconds. Both are idempotent like finish and cancel: the row is answered as it is.
  r.post('/:id/pause', (_req, res) => {
    const s = owned(res);
    if (s.status !== 'running') return refuse(res, 409, 'Only a running timer can be paused.');
    if (s.paused_at == null) db.prepare(`UPDATE sessions SET paused_at = ? WHERE id = ?`).run(Date.now(), s.id);
    reply(res, s.user_id, s.id);
  });

  r.post('/:id/resume', (_req, res) => {
    const s = owned(res);
    if (s.status !== 'running') return refuse(res, 409, 'Only a running timer can be resumed.');
    if (s.paused_at != null) {
      const pausedSeconds = pausedSecondsAfter({ pausedAt: s.paused_at, pausedSeconds: s.paused_seconds }, Date.now());
      db.prepare(`UPDATE sessions SET paused_seconds = ?, paused_at = NULL WHERE id = ?`).run(pausedSeconds, s.id);
    }
    reply(res, s.user_id, s.id);
  });

  // Ends now, but never later than the planned end: a timer that ran out unattended is
  // recorded with its planned duration. `countOverrun: true` is the user choosing to log the
  // time past the end as well (they were there for it). A session finished while paused ends
  // when the pause began (no work happened since), so the log excludes every pause.
  r.post('/:id/finish', (req, res) => {
    const s = owned(res);
    const { countOverrun } = req.body as { countOverrun?: unknown };
    if (countOverrun !== undefined && typeof countOverrun !== 'boolean') return refuse(res, 400, 'countOverrun must be a boolean.');
    if (s.status === 'running') {
      const now = Date.now();
      const timing = { startedAt: s.started_at, plannedSeconds: s.planned_seconds, pausedSeconds: s.paused_seconds, pausedAt: s.paused_at };
      const until = s.paused_at ?? now;
      // The planned end as of `until`: while paused it moves forward with the clock, so read at
      // `now` it would let a pause that began after the end count the overrun anyway.
      const endedAt = countOverrun ? until : Math.min(until, plannedEndAt(timing, until));
      db.prepare(`UPDATE sessions SET ended_at = ?, paused_at = NULL, status = 'completed' WHERE id = ?`).run(endedAt, s.id);
    }
    reply(res, s.user_id, s.id);
  });

  r.post('/:id/cancel', (_req, res) => {
    const s = owned(res);
    if (s.status === 'running') {
      // A paused session ends where its pause began, as on finish, so the pause isn't counted.
      db.prepare(`UPDATE sessions SET ended_at = COALESCE(paused_at, ?), paused_at = NULL, status = 'cancelled' WHERE id = ?`).run(Date.now(), s.id);
    }
    reply(res, s.user_id, s.id);
  });

  r.delete('/:id', (_req, res) => {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(owned(res).id);
    res.json({ ok: true } satisfies OkResponse);
  });

  return r;
}
