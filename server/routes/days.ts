import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { ensureDay, findDay, isValidDateKey, sessionRowToJson, type SessionRow } from './shared.js';

export interface PunchRow {
  id: number;
  day_id: number;
  position: number;
  kind: 'in' | 'out';
  at: number | null;
}

export interface PriorityRow {
  id: number;
  day_id: number;
  position: number;
  text: string;
  done: number;
}

function punchesJson(rows: PunchRow[]) {
  return rows.map((p) => ({ position: p.position, kind: p.kind, at: p.at }));
}

function prioritiesJson(rows: PriorityRow[]) {
  const byPos = new Map(rows.map((r) => [r.position, r]));
  return [1, 2, 3].map((position) => {
    const r = byPos.get(position);
    return { position, text: r?.text ?? '', done: Boolean(r?.done) };
  });
}

export function daysRouter(db: DB): Router {
  const r = Router();

  // Recent days with enough data for the history list. Worked time is computed on the
  // client from punches so the timeclock math has a single home.
  r.get('/', (req, res) => {
    const user = currentUser(req);
    const limitRaw = Number(req.query.limit ?? 60);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 365) : 60;
    const days = db
      .prepare(
        `SELECT d.id, d.date,
           (SELECT COALESCE(SUM(ended_at - started_at), 0) FROM sessions s
              WHERE s.day_id = d.id AND s.status = 'completed') AS focus_ms,
           (SELECT COUNT(*) FROM priorities p WHERE p.day_id = d.id AND p.done = 1) AS priorities_done,
           (SELECT COUNT(*) FROM priorities p WHERE p.day_id = d.id AND p.text <> '') AS priorities_total
         FROM days d WHERE d.user_id = ? ORDER BY d.date DESC LIMIT ?`,
      )
      .all(user.id, limit) as { id: number; date: string; focus_ms: number; priorities_done: number; priorities_total: number }[];
    const punchStmt = db.prepare(`SELECT * FROM punches WHERE day_id = ? ORDER BY position`);
    res.json({
      days: days.map((d) => ({
        date: d.date,
        punches: punchesJson(punchStmt.all(d.id) as PunchRow[]),
        focusSeconds: Math.round(d.focus_ms / 1000),
        prioritiesDone: d.priorities_done,
        prioritiesTotal: d.priorities_total,
      })),
    });
  });

  r.get('/:date', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    if (!isValidDateKey(date)) {
      res.status(400).json({ error: 'Invalid date.' });
      return;
    }
    const day = findDay(db, user.id, date);
    if (!day) {
      res.json({ date, punches: [], priorities: prioritiesJson([]), sessions: [] });
      return;
    }
    const punches = db.prepare(`SELECT * FROM punches WHERE day_id = ? ORDER BY position`).all(day.id) as PunchRow[];
    const priorities = db.prepare(`SELECT * FROM priorities WHERE day_id = ?`).all(day.id) as PriorityRow[];
    const sessions = db
      .prepare(`SELECT s.*, d.date FROM sessions s JOIN days d ON d.id = s.day_id WHERE s.day_id = ? AND s.status <> 'cancelled' ORDER BY s.started_at`)
      .all(day.id) as (SessionRow & { date: string })[];
    res.json({
      date,
      punches: punchesJson(punches),
      priorities: prioritiesJson(priorities),
      sessions: sessions.map(sessionRowToJson),
    });
  });

  // Full replace. Position parity defines kind: even = in, odd = out.
  r.put('/:date/punches', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    if (!isValidDateKey(date)) {
      res.status(400).json({ error: 'Invalid date.' });
      return;
    }
    const input = (req.body as { punches?: unknown })?.punches;
    if (!Array.isArray(input) || input.length > 40) {
      res.status(400).json({ error: 'punches must be an array.' });
      return;
    }
    const punches: { position: number; kind: 'in' | 'out'; at: number | null }[] = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i] as Record<string, unknown> | null;
      const at = item?.at;
      if (at !== null && at !== undefined && !(typeof at === 'number' && Number.isFinite(at))) {
        res.status(400).json({ error: `Punch ${i} has an invalid time.` });
        return;
      }
      punches.push({ position: i, kind: i % 2 === 0 ? 'in' : 'out', at: at == null ? null : Math.round(at) });
    }
    db.transaction(() => {
      const dayId = ensureDay(db, user.id, date);
      db.prepare(`DELETE FROM punches WHERE day_id = ?`).run(dayId);
      const ins = db.prepare(`INSERT INTO punches (day_id, position, kind, at) VALUES (?, ?, ?, ?)`);
      for (const p of punches) ins.run(dayId, p.position, p.kind, p.at);
    })();
    res.json({ punches });
  });

  r.put('/:date/priorities', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    if (!isValidDateKey(date)) {
      res.status(400).json({ error: 'Invalid date.' });
      return;
    }
    const input = (req.body as { priorities?: unknown })?.priorities;
    if (!Array.isArray(input)) {
      res.status(400).json({ error: 'priorities must be an array.' });
      return;
    }
    const rows: { position: number; text: string; done: boolean }[] = [];
    for (const item of input as Record<string, unknown>[]) {
      const position = item?.position;
      if (position !== 1 && position !== 2 && position !== 3) continue;
      const text = typeof item.text === 'string' ? item.text.slice(0, 500) : '';
      rows.push({ position, text, done: Boolean(item.done) });
    }
    db.transaction(() => {
      const dayId = ensureDay(db, user.id, date);
      const up = db.prepare(
        `INSERT INTO priorities (day_id, position, text, done) VALUES (?, ?, ?, ?)
         ON CONFLICT(day_id, position) DO UPDATE SET text = excluded.text, done = excluded.done`,
      );
      for (const p of rows) up.run(dayId, p.position, p.text, p.done ? 1 : 0);
    })();
    const dayId = findDay(db, user.id, date)!.id;
    const priorities = db.prepare(`SELECT * FROM priorities WHERE day_id = ?`).all(dayId) as PriorityRow[];
    res.json({ priorities: prioritiesJson(priorities) });
  });

  return r;
}
