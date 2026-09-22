import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { countDays, pruneDays, reclaimSpace } from '../retention.js';
import { isValidDateKey, punchWindow } from '../../shared/dates.js';
import { dateParam, ensureDay, findDay, requireDate, sessionRowToJson, UID_RE, type DayRow, type SessionRow } from './shared.js';
import { MAX_PRIORITIES } from '../../shared/settings.js';
import { LIMITS, type Day, type DaySummary, type Priority, type PruneInfo, type Punch } from '../../shared/api.js';

const MAX_RANGE_DAYS = 400;
const MAX_PUNCHES = 40;
const DAY_MS = 86_400_000;

/**
 * A stored instant is a safe integer the client can format; anything else (1e308, say) would
 * throw in `Intl.DateTimeFormat` on every render of that day. Rounded, since the client may
 * send sub-millisecond floats.
 */
function parseInstant(raw: unknown, from: number, to: number): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const ms = Math.round(raw);
  return Number.isSafeInteger(ms) && ms >= from && ms <= to ? ms : null;
}

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

function punchesJson(rows: PunchRow[]): Punch[] {
  return rows.map((p) => ({ position: p.position, kind: p.kind, at: p.at }));
}

// Only the rows that exist are returned; the client pads to the user's `priorityCount`.
function prioritiesJson(rows: PriorityRow[]): Priority[] {
  return [...rows]
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ position: r.position, text: r.text, done: Boolean(r.done), uid: r.uid, addedAt: r.added_at }));
}

/** The full JSON for one existing day; shared by GET /:date and GET /range. */
function dayJson(db: DB, day: DayRow, date: string): Day {
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

function emptyDayJson(date: string): Day {
  return { date, punches: [], priorities: [], overtimeApproved: false, retroNote: '', retroAt: null, sessions: [] };
}

export function daysRouter(db: DB, config: Config): Router {
  const r = Router();

  // Recent days with enough data for the history list. Worked time is computed on the
  // client from punches so the timeclock math has a single home. focus_ms is `activeMs`
  // (shared/timer.ts) in SQL: a finished session's span minus its pauses.
  r.get('/', (req, res) => {
    const user = currentUser(req);
    const limitRaw = Number(req.query.limit ?? 60);
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 365) : 60;
    const days = db
      .prepare(
        `SELECT d.id, d.date, d.retro_at,
           (SELECT COALESCE(SUM(ended_at - started_at - paused_seconds * 1000), 0) FROM sessions s
              WHERE s.day_id = d.id AND s.status = 'completed') AS focus_ms,
           (SELECT COUNT(*) FROM priorities p WHERE p.day_id = d.id AND p.done = 1 AND p.text <> '') AS priorities_done,
           (SELECT COUNT(*) FROM priorities p WHERE p.day_id = d.id AND p.text <> '') AS priorities_total
         FROM days d WHERE d.user_id = ? ORDER BY d.date DESC LIMIT ?`,
      )
      .all(user.id, limit) as { id: number; date: string; retro_at: number | null; focus_ms: number; priorities_done: number; priorities_total: number }[];
    const punchStmt = db.prepare(`SELECT * FROM punches WHERE day_id = ? ORDER BY position`);
    const summaries: DaySummary[] = days.map((d) => ({
      date: d.date,
      punches: punchesJson(punchStmt.all(d.id) as PunchRow[]),
      focusSeconds: Math.round(d.focus_ms / 1000),
      prioritiesDone: d.priorities_done,
      prioritiesTotal: d.priorities_total,
      retroAt: d.retro_at,
    }));
    res.json({ days: summaries });
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

  // Old-day cleanup. GET is the preview the Data tab shows before asking; POST deletes.
  // Literal paths, so they sit before /:date like /range.
  r.get('/prune', (req, res) => {
    const { before } = req.query;
    if (!isValidDateKey(before)) {
      res.status(400).json({ error: 'before must be a date (YYYY-MM-DD).' });
      return;
    }
    const info: PruneInfo = { before, ...countDays(db, currentUser(req).id, before), serverMaxDays: config.retentionDays };
    res.json(info);
  });

  r.post('/prune', (req, res) => {
    const before = (req.body as { before?: unknown })?.before;
    if (!isValidDateKey(before)) {
      res.status(400).json({ error: 'before must be a date (YYYY-MM-DD).' });
      return;
    }
    const deleted = pruneDays(db, currentUser(req).id, before);
    if (deleted > 0) reclaimSpace(db);
    res.json({ deleted });
  });

  r.get('/:date', requireDate, (req, res) => {
    const user = currentUser(req);
    const date = dateParam(req);
    const day = findDay(db, user.id, date);
    res.json(day ? dayJson(db, day, date) : emptyDayJson(date));
  });

  // Full replace. Position parity defines kind: even = in, odd = out.
  r.put('/:date/punches', requireDate, (req, res) => {
    const user = currentUser(req);
    const date = dateParam(req);
    const input = (req.body as { punches?: unknown })?.punches;
    if (!Array.isArray(input)) {
      res.status(400).json({ error: 'punches must be an array.' });
      return;
    }
    if (input.length > MAX_PUNCHES) {
      res.status(400).json({ error: `punches is limited to ${MAX_PUNCHES} rows.` });
      return;
    }
    // A punch belongs to its day: a time days away from the key is a client bug, not data.
    const window = punchWindow(date);
    const punches: { position: number; kind: 'in' | 'out'; at: number | null }[] = [];
    for (let i = 0; i < input.length; i++) {
      const item = input[i] as Record<string, unknown> | null;
      const raw = item?.at;
      const at = raw == null ? null : parseInstant(raw, window.from, window.to);
      if (raw != null && at == null) {
        res.status(400).json({ error: `Punch ${i} has an invalid time.` });
        return;
      }
      punches.push({ position: i, kind: i % 2 === 0 ? 'in' : 'out', at });
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
  r.put('/:date/priorities', requireDate, (req, res) => {
    const user = currentUser(req);
    const date = dateParam(req);
    const input = (req.body as { priorities?: unknown })?.priorities;
    if (!Array.isArray(input) || input.length > MAX_PRIORITIES) {
      res.status(400).json({ error: `priorities must be an array of at most ${MAX_PRIORITIES}.` });
      return;
    }
    // The client mints uids and stamps addedAt when a row first gets text; the server only
    // fills them in for a row with text that arrived without (an older client).
    const rows: Priority[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < input.length; i++) {
      const item = (input[i] ?? {}) as Record<string, unknown>;
      const text = typeof item.text === 'string' ? item.text.slice(0, LIMITS.priorityText) : '';
      const hasText = text.trim() !== '';
      let uid = typeof item.uid === 'string' && UID_RE.test(item.uid) ? item.uid.toLowerCase() : null;
      if (uid && seen.has(uid)) {
        res.status(400).json({ error: `Priority ${i + 1} repeats another row's uid.` });
        return;
      }
      if (!uid && hasText) uid = randomBytes(6).toString('hex');
      if (uid) seen.add(uid);
      // Stamped by the client when the row first got text; never in the future.
      let addedAt = item.addedAt == null ? null : parseInstant(item.addedAt, 0, Date.now() + DAY_MS);
      if (item.addedAt != null && addedAt == null) {
        res.status(400).json({ error: `Priority ${i + 1} has an invalid addedAt.` });
        return;
      }
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

  r.put('/:date/overtime', requireDate, (req, res) => {
    const user = currentUser(req);
    const date = dateParam(req);
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
  r.put('/:date/retro', requireDate, (req, res) => {
    const user = currentUser(req);
    const date = dateParam(req);
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
    if (note !== undefined) db.prepare(`UPDATE days SET retro_note = ? WHERE id = ?`).run(note.slice(0, LIMITS.retroNote), dayId);
    if (done === true) db.prepare(`UPDATE days SET retro_at = COALESCE(retro_at, ?) WHERE id = ?`).run(Date.now(), dayId);
    if (done === false) db.prepare(`UPDATE days SET retro_at = NULL WHERE id = ?`).run(dayId);
    const day = findDay(db, user.id, date)!;
    res.json({ retroNote: day.retro_note, retroAt: day.retro_at });
  });

  return r;
}
