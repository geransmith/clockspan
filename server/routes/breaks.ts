import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { breakRowToJson, dateParam, endRunningBreak, ensureDay, getOwned, ownedRouter, parsePlannedSeconds, requireDate, runningSession } from './shared.js';
import type { BreakEndResponse, BreakResponse, OkResponse } from '../../shared/api.js';
import { BREAK_SECONDS, MIN_BREAK_MS } from '../../shared/timer.js';

/** Mounted at /api/days/:date/breaks (start), like the sessions' start router. */
export function breakStartRouter(db: DB): Router {
  const r = Router({ mergeParams: true });

  // A break starts now and runs for `plannedSeconds`. One that was still running ends here;
  // a focus timer running refuses it, since a break is the time between sessions.
  r.post('/', requireDate, (req, res) => {
    const user = currentUser(req);
    const { plannedSeconds } = (req.body ?? {}) as { plannedSeconds?: unknown };
    const planned = parsePlannedSeconds(plannedSeconds, BREAK_SECONDS);
    if ('error' in planned) {
      res.status(400).json({ error: planned.error });
      return;
    }
    if (runningSession(db, user.id)) {
      res.status(409).json({ error: 'A focus timer is running.' });
      return;
    }
    const id = db.transaction(() => {
      const now = Date.now();
      endRunningBreak(db, user.id, now);
      const dayId = ensureDay(db, user.id, dateParam(req));
      const info = db
        .prepare(`INSERT INTO breaks (day_id, user_id, planned_seconds, started_at, ended_at) VALUES (?, ?, ?, ?, ?)`)
        .run(dayId, user.id, planned.seconds, now, now + planned.seconds * 1000);
      return Number(info.lastInsertRowid);
    })();
    res.status(201).json({ break: breakRowToJson(getOwned(db, 'breaks', user.id, id)!) } satisfies BreakResponse);
  });

  return r;
}

export function breaksRouter(db: DB): Router {
  // Every /:id route works on the caller's own break or answers 404 (`ownedRouter`).
  const { router: r, owned } = ownedRouter(db, 'breaks');

  // Back early: the break ends now, or is dropped if it ran under a minute (answered as null).
  // Idempotent, and a break that already ended keeps its end.
  r.post('/:id/end', (_req, res) => {
    const b = owned(res);
    const now = Date.now();
    if (b.ended_at > now && now - b.started_at < MIN_BREAK_MS) {
      db.prepare(`DELETE FROM breaks WHERE id = ?`).run(b.id);
      res.json({ break: null } satisfies BreakEndResponse);
      return;
    }
    if (b.ended_at > now) db.prepare(`UPDATE breaks SET ended_at = ? WHERE id = ?`).run(now, b.id);
    res.json({ break: breakRowToJson(getOwned(db, 'breaks', b.user_id, b.id)!) } satisfies BreakEndResponse);
  });

  r.delete('/:id', (_req, res) => {
    db.prepare(`DELETE FROM breaks WHERE id = ?`).run(owned(res).id);
    res.json({ ok: true } satisfies OkResponse);
  });

  return r;
}
