import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { countDays, pruneDays, reclaimSpace } from '../retention.js';
import { isWholeNumber } from '../validate.js';
import { DAY_MS, isValidDateKey, punchWindow } from '../../shared/dates.js';
import {
  breakRowToJson,
  DAY_COLUMNS,
  dateParam,
  ensureDay,
  findDay,
  requireDate,
  sessionRowToJson,
  UID_RE,
  type BreakRow,
  type Dated,
  type DayRow,
  type PriorityRow,
  type PunchRow,
  type SessionRow,
} from './shared.js';
import { kindForPosition } from '../../shared/punches.js';
import { MAX_PRIORITIES, SETTING_LIMITS } from '../../shared/settings.js';
import {
  emptyDay,
  LIMITS,
  type Day,
  type OvertimeResponse,
  type PrioritiesResponse,
  type Priority,
  type PruneInfo,
  type PruneResult,
  type Punch,
  type PunchesResponse,
  type RangeResponse,
  type RetroResponse,
  type TargetResponse,
} from '../../shared/api.js';

const MAX_RANGE_DAYS = 400;
const MAX_PUNCHES = 40;

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

/**
 * One row of a list the client replaces whole: an object, or null for an empty row. Anything
 * else is a client bug, and reading fields off it would store an empty row in its place
 * (`(5).at` is undefined), or trip over a method of the same name (`'x'.at`).
 */
function isRow(raw: unknown): raw is Record<string, unknown> | null {
  return raw === null || (typeof raw === 'object' && !Array.isArray(raw));
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

/** A day's child rows: punches by position, sessions and breaks by start, cancelled sessions left out. */
interface DayRows {
  punches: PunchRow[];
  priorities: PriorityRow[];
  sessions: Dated<SessionRow>[];
  breaks: Dated<BreakRow>[];
}

/** A day with none of them; a fresh object each time, since `rangeRows` pushes into its lists. */
const noRows = (): DayRows => ({ punches: [], priorities: [], sessions: [], breaks: [] });

/**
 * The child rows of every day in a user's range, by day id: one query per table rather than
 * one per table per day (a quarter's review would be hundreds). Grouping keeps each query's
 * order. `GET /:date` loads its one day through here too, so a new child table is added in
 * one place. A day with no child rows has no entry.
 */
function rangeRows(db: DB, userId: number, from: string, to: string): Map<number, DayRows> {
  const inRange = `JOIN days d ON d.id = x.day_id WHERE d.user_id = ? AND d.date >= ? AND d.date <= ?`;
  const out = new Map<number, DayRows>();
  const rowsFor = (dayId: number) => {
    let rows = out.get(dayId);
    if (!rows) out.set(dayId, (rows = noRows()));
    return rows;
  };
  for (const p of db.prepare(`SELECT x.* FROM punches x ${inRange} ORDER BY x.position`).all(userId, from, to) as PunchRow[]) rowsFor(p.day_id).punches.push(p);
  for (const p of db.prepare(`SELECT x.* FROM priorities x ${inRange}`).all(userId, from, to) as PriorityRow[]) rowsFor(p.day_id).priorities.push(p);
  const sessions = db
    .prepare(`SELECT x.*, d.date FROM sessions x ${inRange} AND x.status <> 'cancelled' ORDER BY x.started_at`)
    .all(userId, from, to) as DayRows['sessions'];
  for (const s of sessions) rowsFor(s.day_id).sessions.push(s);
  const breaks = db.prepare(`SELECT x.*, d.date FROM breaks x ${inRange} ORDER BY x.started_at`).all(userId, from, to) as DayRows['breaks'];
  for (const b of breaks) rowsFor(b.day_id).breaks.push(b);
  return out;
}

/** The full JSON for one existing day; shared by GET /:date and GET /range. */
function dayJson(day: DayRow, date: string, rows: DayRows): Day {
  return {
    date,
    punches: punchesJson(rows.punches),
    priorities: prioritiesJson(rows.priorities),
    overtimeApproved: Boolean(day.overtime_approved),
    retroNote: day.retro_note,
    retroAt: day.retro_at,
    workMinutes: day.work_minutes,
    sessions: rows.sessions.map(sessionRowToJson),
    breaks: rows.breaks.map(breakRowToJson),
  };
}

export function daysRouter(db: DB, config: Config): Router {
  const r = Router();

  // Full days for a date range, for the review and the History calendar. Only days that exist
  // are returned; the client does the math. Registered before /:date so "range" isn't
  // read as a date.
  r.get('/range', (req, res) => {
    const user = currentUser(req);
    const { from, to } = req.query;
    if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) {
      res.status(400).json({ error: 'from and to must be dates (YYYY-MM-DD) with from <= to.' });
      return;
    }
    const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
    if (span > MAX_RANGE_DAYS) {
      res.status(400).json({ error: `Range is limited to ${MAX_RANGE_DAYS} days.` });
      return;
    }
    const rows = db
      .prepare(`SELECT ${DAY_COLUMNS}, date FROM days WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date`)
      .all(user.id, from, to) as (DayRow & { date: string })[];
    const children = rangeRows(db, user.id, from, to);
    res.json({ days: rows.map((d) => dayJson(d, d.date, children.get(d.id) ?? noRows())) } satisfies RangeResponse);
  });

  // Old-day cleanup. GET is the preview the Data tab shows before asking; POST deletes.
  // Literal paths, so they sit before /:date like /range.
  r.get('/prune', (req, res) => {
    const { before } = req.query;
    if (!isValidDateKey(before)) {
      res.status(400).json({ error: 'before must be a date (YYYY-MM-DD).' });
      return;
    }
    res.json({ before, ...countDays(db, currentUser(req).id, before), serverMaxDays: config.retentionDays } satisfies PruneInfo);
  });

  r.post('/prune', (req, res) => {
    const before = (req.body as { before?: unknown })?.before;
    if (!isValidDateKey(before)) {
      res.status(400).json({ error: 'before must be a date (YYYY-MM-DD).' });
      return;
    }
    const deleted = pruneDays(db, currentUser(req).id, before);
    if (deleted > 0) reclaimSpace(db);
    res.json({ deleted } satisfies PruneResult);
  });

  r.get('/:date', requireDate, (req, res) => {
    const user = currentUser(req);
    const date = dateParam(req);
    const day = findDay(db, user.id, date);
    res.json((day ? dayJson(day, date, rangeRows(db, user.id, date, date).get(day.id) ?? noRows()) : emptyDay(date)) satisfies Day);
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
    const punches: Punch[] = [];
    for (let i = 0; i < input.length; i++) {
      const item: unknown = input[i];
      if (!isRow(item)) {
        res.status(400).json({ error: `Punch ${i} must be an object or null.` });
        return;
      }
      const raw = item?.at;
      const at = raw == null ? null : parseInstant(raw, window.from, window.to);
      if (raw != null && at == null) {
        res.status(400).json({ error: `Punch ${i} has an invalid time.` });
        return;
      }
      punches.push({ position: i, kind: kindForPosition(i), at });
    }
    db.transaction(() => {
      const dayId = ensureDay(db, user.id, date);
      db.prepare(`DELETE FROM punches WHERE day_id = ?`).run(dayId);
      const ins = db.prepare(`INSERT INTO punches (day_id, position, kind, at) VALUES (?, ?, ?, ?)`);
      for (const p of punches) ins.run(dayId, p.position, p.kind, p.at);
    })();
    res.json({ punches } satisfies PunchesResponse);
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
      const row: unknown = input[i];
      if (!isRow(row)) {
        res.status(400).json({ error: `Priority ${i + 1} must be an object or null.` });
        return;
      }
      const item: Record<string, unknown> = row ?? {};
      // Checked like every other field: a value of the wrong kind is a client bug, not a row to guess at.
      if (item.text != null && typeof item.text !== 'string') {
        res.status(400).json({ error: `Priority ${i + 1} has invalid text.` });
        return;
      }
      if (item.uid != null && !(typeof item.uid === 'string' && UID_RE.test(item.uid))) {
        res.status(400).json({ error: `Priority ${i + 1} has an invalid uid.` });
        return;
      }
      const text = typeof item.text === 'string' ? item.text.slice(0, LIMITS.priorityText) : '';
      const hasText = text.trim() !== '';
      let uid = typeof item.uid === 'string' ? item.uid.toLowerCase() : null;
      if (uid && seen.has(uid)) {
        res.status(400).json({ error: `Priority ${i + 1} repeats another row's uid.` });
        return;
      }
      if (!uid && hasText) uid = randomBytes(6).toString('hex');
      if (uid) seen.add(uid);
      // Stamped by the client when the row first got text; at most a day ahead, for a device clock running fast.
      let addedAt = item.addedAt == null ? null : parseInstant(item.addedAt, 0, Date.now() + DAY_MS);
      if (item.addedAt != null && addedAt == null) {
        res.status(400).json({ error: `Priority ${i + 1} has an invalid addedAt.` });
        return;
      }
      if (addedAt == null && hasText) addedAt = Date.now();
      // Checked like every other flag: `Boolean("false")` would tick the row. Null is absent, as for the other fields.
      if (item.done != null && typeof item.done !== 'boolean') {
        res.status(400).json({ error: `Priority ${i + 1} has an invalid done flag.` });
        return;
      }
      rows.push({ position: i + 1, text, done: hasText && item.done === true, uid, addedAt });
    }
    db.transaction(() => {
      const dayId = ensureDay(db, user.id, date);
      db.prepare(`DELETE FROM priorities WHERE day_id = ?`).run(dayId);
      const ins = db.prepare(`INSERT INTO priorities (day_id, position, text, done, uid, added_at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const p of rows) ins.run(dayId, p.position, p.text, p.done ? 1 : 0, p.uid, p.addedAt);
    })();
    res.json({ priorities: rows } satisfies PrioritiesResponse);
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
    res.json({ overtimeApproved: approved } satisfies OvertimeResponse);
  });

  // This day's own work-day length (a half day, a long one); null goes back to the setting.
  // Same bounds as the setting, so every timeclock can take it in its place.
  r.put('/:date/target', requireDate, (req, res) => {
    const user = currentUser(req);
    const date = dateParam(req);
    const minutes = (req.body as { workMinutes?: unknown })?.workMinutes;
    const bounds = SETTING_LIMITS.workMinutes;
    if (minutes !== null && !isWholeNumber(minutes, bounds)) {
      res.status(400).json({ error: `workMinutes must be a whole number from ${bounds.min} to ${bounds.max}, or null.` });
      return;
    }
    const dayId = ensureDay(db, user.id, date);
    db.prepare(`UPDATE days SET work_minutes = ? WHERE id = ?`).run(minutes, dayId);
    res.json({ workMinutes: minutes } satisfies TargetResponse);
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
    // An empty patch changes nothing, so it stores no day either; it answers what is there.
    if (note !== undefined || done !== undefined) {
      const dayId = ensureDay(db, user.id, date);
      if (note !== undefined) db.prepare(`UPDATE days SET retro_note = ? WHERE id = ?`).run(note.slice(0, LIMITS.retroNote), dayId);
      if (done === true) db.prepare(`UPDATE days SET retro_at = COALESCE(retro_at, ?) WHERE id = ?`).run(Date.now(), dayId);
      if (done === false) db.prepare(`UPDATE days SET retro_at = NULL WHERE id = ?`).run(dayId);
    }
    const day = findDay(db, user.id, date);
    res.json({ retroNote: day?.retro_note ?? '', retroAt: day?.retro_at ?? null } satisfies RetroResponse);
  });

  return r;
}
