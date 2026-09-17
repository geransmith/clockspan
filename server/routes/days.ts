import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { ensureDay, findDay, isValidDateKey, sessionRowToJson, UID_RE, type DayRow, type SessionRow } from './shared.js';
import { MAX_PRIORITIES } from './settings.js';

const MAX_RANGE_DAYS = 400;
const MAX_RETRO_NOTE = 4000;

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
  uid: string | null;
  added_at: number | null;
}

function punchesJson(rows: PunchRow[]) {
  return rows.map((p) => ({ position: p.position, kind: p.kind, at: p.at }));
}

// Only the rows that exist are returned; the client pads to the user's `priorityCount`.
function prioritiesJson(rows: PriorityRow[]) {
  return [...rows]
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ position: r.position, text: r.text, done: Boolean(r.done), uid: r.uid, addedAt: r.added_at }));
}

/** The full JSON for one existing day; shared by GET /:date and GET /range. */
function dayJson(db: DB, day: DayRow, date: string) {
  const punches = db.prepare(`SELECT * FROM punches WHERE day_id = ? ORDER BY position`).all(day.id) as PunchRow[];
  const priorities = db.prepare(`SELECT * FROM priorities WHERE day_id = ?`).all(day.id) as PriorityRow[];
  const sessions = db
    .prepare(`SELECT s.*, d.date FROM sessions s JOIN days d ON d.id = s.day_id WHERE s.day_id = ? AND s.status <> 'cancelled' ORDER BY s.started_at`)
    .all(day.id) as (SessionRow & { date: string })[];
  return {
    date,
    punches: punchesJson(punches),
    priorities: prioritiesJson(priorities),
    overtimeApproved: Boolean(day.overtime_approved),
    retroNote: day.retro_note,
    retroAt: day.retro_at,
    sessions: sessions.map(sessionRowToJson),
  };
}

function emptyDayJson(date: string) {
  return { date, punches: [], priorities: [], overtimeApproved: false, retroNote: '', retroAt: null, sessions: [] };
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
        `SELECT d.id, d.date, d.retro_at,
           (SELECT COALESCE(SUM(ended_at - started_at), 0) FROM sessions s
              WHERE s.day_id = d.id AND s.status = 'completed') AS focus_ms,
           (SELECT COUNT(*) FROM priorities p WHERE p.day_id = d.id AND p.done = 1 AND p.text <> '') AS priorities_done,
           (SELECT COUNT(*) FROM priorities p WHERE p.day_id = d.id AND p.text <> '') AS priorities_total
         FROM days d WHERE d.user_id = ? ORDER BY d.date DESC LIMIT ?`,
      )
      .all(user.id, limit) as { id: number; date: string; retro_at: number | null; focus_ms: number; priorities_done: number; priorities_total: number }[];
    const punchStmt = db.prepare(`SELECT * FROM punches WHERE day_id = ? ORDER BY position`);
    res.json({
      days: days.map((d) => ({
        date: d.date,
        punches: punchesJson(punchStmt.all(d.id) as PunchRow[]),
        focusSeconds: Math.round(d.focus_ms / 1000),
        prioritiesDone: d.priorities_done,
        prioritiesTotal: d.priorities_total,
        retroAt: d.retro_at,
      })),
    });
  });

  // Full days for a date range, for the week / month / quarter review. Only days that exist
  // are returned; the client does the math. Registered before /:date so "range" isn't
  // read as a date.
  r.get('/range', (req, res) => {
    const user = currentUser(req);
    const { from, to } = req.query;
    if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) {
      res.status(400).json({ error: 'from and to must be dates (YYYY-MM-DD) with from <= to.' });
      return;
    }
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (span > MAX_RANGE_DAYS) {
      res.status(400).json({ error: `Range is limited to ${MAX_RANGE_DAYS} days.` });
      return;
    }
    const rows = db
      .prepare(`SELECT id, date, overtime_approved, retro_note, retro_at FROM days WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date`)
      .all(user.id, from, to) as (DayRow & { date: string })[];
    res.json({ days: rows.map((d) => dayJson(db, d, d.date)) });
  });

  r.get('/:date', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    if (!isValidDateKey(date)) {
      res.status(400).json({ error: 'Invalid date.' });
      return;
    }
    const day = findDay(db, user.id, date);
    res.json(day ? dayJson(db, day, date) : emptyDayJson(date));
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

  // Full replace, like punches: array order is the position, so removing a row is just
  // sending the list without it. An empty row can never be "done".
  r.put('/:date/priorities', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    if (!isValidDateKey(date)) {
      res.status(400).json({ error: 'Invalid date.' });
      return;
    }
    const input = (req.body as { priorities?: unknown })?.priorities;
    if (!Array.isArray(input) || input.length > MAX_PRIORITIES) {
      res.status(400).json({ error: `priorities must be an array of at most ${MAX_PRIORITIES}.` });
      return;
    }
    // The client mints uids and stamps addedAt when a row first gets text; the server only
    // fills them in for a row with text that arrived without (an older client).
    const rows: { position: number; text: string; done: boolean; uid: string | null; addedAt: number | null }[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < input.length; i++) {
      const item = (input[i] ?? {}) as Record<string, unknown>;
      const text = typeof item.text === 'string' ? item.text.slice(0, 500) : '';
      const hasText = text.trim() !== '';
      let uid = typeof item.uid === 'string' && UID_RE.test(item.uid) ? item.uid.toLowerCase() : null;
      if (uid && seen.has(uid)) {
        res.status(400).json({ error: `Priority ${i + 1} repeats another row's uid.` });
        return;
      }
      if (!uid && hasText) uid = randomBytes(6).toString('hex');
      if (uid) seen.add(uid);
      let addedAt = typeof item.addedAt === 'number' && Number.isFinite(item.addedAt) ? Math.round(item.addedAt) : null;
      if (addedAt == null && hasText) addedAt = Date.now();
      rows.push({ position: i + 1, text, done: hasText && Boolean(item.done), uid, addedAt });
    }
    db.transaction(() => {
      const dayId = ensureDay(db, user.id, date);
      db.prepare(`DELETE FROM priorities WHERE day_id = ?`).run(dayId);
      const ins = db.prepare(`INSERT INTO priorities (day_id, position, text, done, uid, added_at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const p of rows) ins.run(dayId, p.position, p.text, p.done ? 1 : 0, p.uid, p.addedAt);
    })();
    res.json({ priorities: rows });
  });

  r.put('/:date/overtime', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    if (!isValidDateKey(date)) {
      res.status(400).json({ error: 'Invalid date.' });
      return;
    }
    const approved = (req.body as { approved?: unknown })?.approved;
    if (typeof approved !== 'boolean') {
      res.status(400).json({ error: 'approved must be a boolean.' });
      return;
    }
    const dayId = ensureDay(db, user.id, date);
    db.prepare(`UPDATE days SET overtime_approved = ? WHERE id = ?`).run(approved ? 1 : 0, dayId);
    res.json({ overtimeApproved: approved });
  });

  // The day's retrospective: a free-text "why" and whether it has been reviewed. Marking it
  // reviewed keeps the first reviewed-at; un-marking clears it.
  r.put('/:date/retro', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    if (!isValidDateKey(date)) {
      res.status(400).json({ error: 'Invalid date.' });
      return;
    }
    const { note, done } = (req.body ?? {}) as { note?: unknown; done?: unknown };
    if (note !== undefined && typeof note !== 'string') {
      res.status(400).json({ error: 'note must be a string.' });
      return;
    }
    if (done !== undefined && typeof done !== 'boolean') {
      res.status(400).json({ error: 'done must be a boolean.' });
      return;
    }
    const dayId = ensureDay(db, user.id, date);
    if (note !== undefined) db.prepare(`UPDATE days SET retro_note = ? WHERE id = ?`).run(note.slice(0, MAX_RETRO_NOTE), dayId);
    if (done === true) db.prepare(`UPDATE days SET retro_at = COALESCE(retro_at, ?) WHERE id = ?`).run(Date.now(), dayId);
    if (done === false) db.prepare(`UPDATE days SET retro_at = NULL WHERE id = ?`).run(dayId);
    const day = findDay(db, user.id, date)!;
    res.json({ retroNote: day.retro_note, retroAt: day.retro_at });
  });

  return r;
}
