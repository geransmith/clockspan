import type { RequestHandler, Response, Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse } from '../refuse.js';
import { collectItems } from '../board.js';
import {
  endRunningBreak,
  ensureDay,
  findDay,
  getOwned,
  ownedRouter,
  parseCategoryUid,
  parsePlannedSeconds,
  runningSession,
  sessionRowToJson,
  UID_RE,
} from './shared.js';
import { LIMITS, type OkResponse, type RunningResponse, type SessionConflict, type SessionResponse } from '../../shared/api.js';
import { pausedSecondsAfter, PLANNED_SECONDS, plannedEndAt } from '../../shared/timer.js';

/**
 * A session's task, from its `priorityUid`: undefined = not mentioned, null = unplanned, else the
 * task with that uid, which that day's list must hold (`dayId` undefined: a day not stored yet,
 * which holds none). A deleted task is on no list, so it is refused the same way. Returns an error
 * message for anything else.
 */
function parsePriorityUid(db: DB, dayId: number | undefined, raw: unknown): { itemId: number | null | undefined } | { error: string } {
  if (raw === undefined) return { itemId: undefined };
  if (raw === null) return { itemId: null };
  if (typeof raw !== 'string' || !UID_RE.test(raw)) return { error: 'priorityUid must be a priority id or null.' };
  const hit =
    dayId === undefined
      ? undefined
      : (db.prepare(`SELECT i.id FROM priorities p JOIN items i ON i.id = p.item_id WHERE p.day_id = ? AND i.uid = ?`).get(dayId, raw.toLowerCase()) as
          { id: number } | undefined);
  return hit ? { itemId: hit.id } : { error: 'That priority is not on this day.' };
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
          `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status, item_id)
           VALUES (?, ?, ?, ?, ?, NULL, 'running', ?)`,
        )
        .run(dayId, user.id, name.label ?? '', planned.seconds, now, link.itemId ?? null);
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

  // A session with a task counts under the task's category, so one of its own is taken only by a
  // session left with no task: a category sent for one that keeps its task is refused, a link to a
  // task drops it, and null takes it off any session. A session that loses its task keeps the
  // task's name as its label, unless a label is sent with it, and no category unless one is sent;
  // the task it left is cleaned up when nothing else names it (`collectItems`).
  r.patch('/:id', (req, res) => {
    const s = owned(res);
    const { plannedSeconds, label, priorityUid, categoryUid } = req.body as {
      plannedSeconds?: unknown;
      label?: unknown;
      priorityUid?: unknown;
      categoryUid?: unknown;
    };
    const link = parsePriorityUid(db, s.day_id, priorityUid);
    if ('error' in link) return refuse(res, 400, link.error);
    const category = parseCategoryUid(categoryUid);
    if ('error' in category) return refuse(res, 400, category.error);
    const itemId = link.itemId === undefined ? s.item_id : link.itemId;
    if (itemId != null && category.categoryUid != null) return refuse(res, 400, 'A session on a priority counts under its category.');
    let planned = s.planned_seconds;
    if (plannedSeconds !== undefined) {
      const parsed = parsePlannedSeconds(plannedSeconds, PLANNED_SECONDS);
      if ('error' in parsed) return refuse(res, 400, parsed.error);
      if (s.status !== 'running') return refuse(res, 409, 'Only a running timer can be adjusted.');
      planned = parsed.seconds;
    }
    const name = parseLabel(label);
    if ('error' in name) return refuse(res, 400, name.error);
    const left = s.item_id != null && itemId !== s.item_id;
    // A session that leaves its task takes no category with it, nor one it held before it had it.
    const own = itemId != null ? null : category.categoryUid !== undefined ? category.categoryUid : left ? null : s.category_uid;
    // The task's current name, so the session keeps reading under the name it showed.
    const called = name.label ?? (left && itemId == null ? s.item_title!.slice(0, LIMITS.sessionLabel) : s.label);
    db.transaction(() => {
      db.prepare(`UPDATE sessions SET planned_seconds = ?, label = ?, item_id = ?, category_uid = ? WHERE id = ?`).run(planned, called, itemId, own, s.id);
      if (left) collectItems(db, s.user_id, [s.item_id!]);
    })();
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

  // A cancelled session counts nowhere and is never shown, so it lets go of its task, which goes
  // too when nothing else names it.
  r.post('/:id/cancel', (_req, res) => {
    const s = owned(res);
    if (s.status === 'running') {
      db.transaction(() => {
        // A paused session ends where its pause began, as on finish, so the pause isn't counted.
        db.prepare(`UPDATE sessions SET ended_at = COALESCE(paused_at, ?), paused_at = NULL, status = 'cancelled', item_id = NULL WHERE id = ?`).run(
          Date.now(),
          s.id,
        );
        if (s.item_id != null) collectItems(db, s.user_id, [s.item_id]);
      })();
    }
    reply(res, s.user_id, s.id);
  });

  r.delete('/:id', (_req, res) => {
    const s = owned(res);
    db.transaction(() => {
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(s.id);
      if (s.item_id != null) collectItems(db, s.user_id, [s.item_id]);
    })();
    res.json({ ok: true } satisfies OkResponse);
  });

  return r;
}
