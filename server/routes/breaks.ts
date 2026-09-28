import { Router, type RequestHandler, type Response } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { breakRowToJson, dateParam, endRunningBreak, ensureDay, requireDate, type BreakRow } from './shared.js';
import type { BreakConflict, BreakResponse, OkResponse } from '../../shared/api.js';
import { BREAK_SECONDS } from '../../shared/timer.js';

type OwnedBreak = BreakRow & { date: string };

function getOwned(db: DB, userId: number, id: number): OwnedBreak | undefined {
  return db.prepare(`SELECT b.*, d.date FROM breaks b JOIN days d ON d.id = b.day_id WHERE b.id = ? AND b.user_id = ?`).get(id, userId) as
    OwnedBreak | undefined;
}

/** Mounted at /api/days/:date/breaks (start), like the sessions' start router. */
export function breakStartRouter(db: DB): Router {
  const r = Router({ mergeParams: true });

  // A break starts now and runs for `plannedSeconds`. One that was still running ends here;
  // a focus timer running refuses it, since a break is the time between sessions.
  r.post('/', requireDate, (req, res) => {
    const user = currentUser(req);
    const { plannedSeconds } = (req.body ?? {}) as { plannedSeconds?: unknown };
    if (typeof plannedSeconds !== 'number' || !Number.isInteger(plannedSeconds) || plannedSeconds < BREAK_SECONDS.min || plannedSeconds > BREAK_SECONDS.max) {
      res.status(400).json({ error: `plannedSeconds must be between ${BREAK_SECONDS.min} and ${BREAK_SECONDS.max}.` });
      return;
    }
    if (db.prepare(`SELECT 1 FROM sessions WHERE user_id = ? AND status = 'running'`).get(user.id)) {
      res.status(409).json({ error: 'A focus timer is running.' } satisfies BreakConflict);
      return;
    }
    const id = db.transaction(() => {
      const now = Date.now();
      endRunningBreak(db, user.id, now);
      const dayId = ensureDay(db, user.id, dateParam(req));
      const info = db
        .prepare(`INSERT INTO breaks (day_id, user_id, planned_seconds, started_at, ended_at) VALUES (?, ?, ?, ?, ?)`)
        .run(dayId, user.id, plannedSeconds, now, now + plannedSeconds * 1000);
      return Number(info.lastInsertRowid);
    })();
    res.status(201).json({ break: breakRowToJson(getOwned(db, user.id, id)!) } satisfies BreakResponse);
  });

  return r;
}

export function breaksRouter(db: DB): Router {
  const r = Router();

  // Every /:id route works on the caller's own break or answers 404.
  const loadOwnedBreak: RequestHandler = (req, res, next) => {
    const b = getOwned(db, currentUser(req).id, Number(req.params.id));
    if (!b) {
      res.status(404).json({ error: 'Break not found.' });
      return;
    }
    res.locals.break = b;
    next();
  };
  const owned = (res: Response) => res.locals.break as OwnedBreak;

  // Back early: the break ends now. Idempotent, and a break that already ended keeps its end.
  r.post('/:id/end', loadOwnedBreak, (_req, res) => {
    const b = owned(res);
    const now = Date.now();
    if (b.ended_at > now) db.prepare(`UPDATE breaks SET ended_at = ? WHERE id = ?`).run(Math.max(b.started_at, now), b.id);
    res.json({ break: breakRowToJson(getOwned(db, b.user_id, b.id)!) } satisfies BreakResponse);
  });

  r.delete('/:id', loadOwnedBreak, (_req, res) => {
    db.prepare(`DELETE FROM breaks WHERE id = ?`).run(owned(res).id);
    res.json({ ok: true } satisfies OkResponse);
  });

  return r;
}
