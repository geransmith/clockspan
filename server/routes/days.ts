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
import { kindForPosition, MAX_PUNCHES } from '../../shared/punches.js';
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

// The rows as last saved, empty ones included; the client pads to the user's `priorityCount`.
function prioritiesJson(rows: PriorityRow[]): Priority[] {
  return rows.map((r) => ({ position: r.position, text: r.text, done: Boolean(r.done), uid: r.uid, addedAt: r.added_at }));
}

/**
 * Rows by their day's id, each list in the rows' order. Not `Map.groupBy`: it is ES2024, and
 * oxlint's type-aware rules check server files without that lib, whatever the tsconfigs say.
 */
function byDay<Row extends { day_id: number }>(rows: Row[]): Map<number, Row[]> {
  const out = new Map<number, Row[]>();
  for (const row of rows) {
    const list = out.get(row.day_id);
    if (list) list.push(row);
    else out.set(row.day_id, [row]);
  }
  return out;
}

/**
 * The child rows of every day in a user's range, each table grouped by day id: one query per
 * table rather than one per table per day (a quarter's review would be hundreds). Grouping keeps
 * each query's order: punches and priorities by position, sessions and breaks by start, with
 * cancelled sessions left out.
 */
function rangeRows(db: DB, userId: number, from: string, to: string) {
  const inRange = `JOIN days d ON d.id = x.day_id WHERE d.user_id = ? AND d.date >= ? AND d.date <= ?`;
  const all = (sql: string) => db.prepare(sql).all(userId, from, to);
  return {
    punches: byDay(all(`SELECT x.* FROM punches x ${inRange} ORDER BY x.position`) as PunchRow[]),
    priorities: byDay(all(`SELECT x.* FROM priorities x ${inRange} ORDER BY x.position`) as PriorityRow[]),
    sessions: byDay(all(`SELECT x.*, d.date FROM sessions x ${inRange} AND x.status <> 'cancelled' ORDER BY x.started_at`) as Dated<SessionRow>[]),
    breaks: byDay(all(`SELECT x.*, d.date FROM breaks x ${inRange} ORDER BY x.started_at`) as Dated<BreakRow>[]),
  };
}
type ChildRows = ReturnType<typeof rangeRows>;

/** The full JSON for one existing day, its child rows taken from its range's. */
function dayJson(day: DayRow, rows: ChildRows): Day {
  const of = <T>(byDayId: Map<number, T[]>): T[] => byDayId.get(day.id) ?? [];
  return {
    date: day.date,
    punches: punchesJson(of(rows.punches)),
    priorities: prioritiesJson(of(rows.priorities)),
    overtimeApproved: Boolean(day.overtime_approved),
    retroNote: day.retro_note,
    retroAt: day.retro_at,
    workMinutes: day.work_minutes,
    sessions: of(rows.sessions).map(sessionRowToJson),
    breaks: of(rows.breaks).map(breakRowToJson),
  };
}

/**
 * Every existing day of a user's range as full JSON, in date order: `GET /range`, and
 * `GET /:date` as a one-day range, so a new per-day field or child table is loaded in one place.
 */
function daysInRange(db: DB, userId: number, from: string, to: string): Day[] {
  const days = db.prepare(`SELECT ${DAY_COLUMNS} FROM days WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date`).all(userId, from, to) as DayRow[];
  const children = rangeRows(db, userId, from, to);
  return days.map((day) => dayJson(day, children));
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
    res.json({ days: daysInRange(db, user.id, from, to) } satisfies RangeResponse);
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
    const date = dateParam(req);
    res.json((daysInRange(db, currentUser(req).id, date, date)[0] ?? emptyDay(date)) satisfies Day);
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
    // The web app mints a uid and stamps addedAt the first time a row gets text, and always sends
    // both. The server fills them in for a text row that arrives without (curl, the route tests),
    // so every row with text has a uid a session can point at and an addedAt the retro can judge.
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
