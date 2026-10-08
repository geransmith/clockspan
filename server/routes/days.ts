import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse } from '../refuse.js';
import { countDays, pruneDays, reclaimSpace } from '../retention.js';
import { mirrorCards } from '../board.js';
import { isWholeNumber } from '../validate.js';
import { DAY_MS, daysBetween, isValidDateKey, punchWindow } from '../../shared/dates.js';
import {
  breakRowToJson,
  DAY_COLUMNS,
  ensureDay,
  findDay,
  sessionRowToJson,
  UID_RE,
  type BreakRow,
  type Dated,
  type DayRow,
  type PriorityRow,
  type PunchRow,
  type SessionRow,
} from './shared.js';
import { startBreak } from './breaks.js';
import { startSession } from './sessions.js';
import { hasText, mergePriorities, repeatedLink } from '../../shared/priorities.js';
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
 * One row of a list the client replaces whole: a plain object. Anything
 * else is a client bug, and reading fields off it would store an empty row in its place
 * (`(5).at` is undefined), or trip over a method of the same name (`'x'.at`).
 */
function isRow(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function punchesJson(rows: PunchRow[]): Punch[] {
  return rows.map((p) => ({ position: p.position, kind: p.kind, at: p.at }));
}

/** A stored row as the API sends it, for a day's answer and for the merge a priorities save goes through. */
function priorityJson(r: PriorityRow): Priority {
  return {
    position: r.position,
    text: r.text,
    done: Boolean(r.done),
    uid: r.uid,
    addedAt: r.added_at,
    cardUid: r.card_uid,
    recurringUid: r.recurring_uid,
    categoryUid: r.category_uid,
  };
}

/** A day's priority rows as stored, in order. */
function storedPriorities(db: DB, dayId: number): Priority[] {
  return (db.prepare(`SELECT * FROM priorities WHERE day_id = ? ORDER BY position`).all(dayId) as PriorityRow[]).map(priorityJson);
}

/** What a list of priority rows is called in the errors: the list sent, or the base it was built on. */
interface RowsLabel {
  list: string;
  row: string;
}
const SENT_ROWS: RowsLabel = { list: 'priorities', row: 'Priority' };
const BASE_ROWS: RowsLabel = { list: 'base', row: 'Base row' };

/** A row's links to its task, as the errors name them. */
const LINK_NAMES = { cardUid: 'card', recurringUid: 'recurring priority', categoryUid: 'category' } as const;
type LinkField = keyof typeof LINK_NAMES;
const LINK_FIELDS = Object.keys(LINK_NAMES) as LinkField[];

/** A row as a request sent it: `categoryUid` is undefined where the field was left out (`withCategories` fills it in). */
type SentPriority = Omit<Priority, 'categoryUid'> & { categoryUid: string | null | undefined };

/**
 * A list of priority rows from a request, numbered from 1, or the message to refuse it with.
 * The web app mints a uid and stamps addedAt the first time a row gets text, and always sends
 * both. The server fills them in for a text row that arrives without (curl, the route tests), so
 * every row with text has a uid a session can point at and an addedAt the retro can judge. A
 * list and its base are read with one `now`, so a row the merge compares across them isn't
 * changed by two stamps a millisecond apart. A card or recurring priority left out is none (a
 * stored row keeps its own anyway: `MERGED`); a category left out is filled in once the stored
 * rows are read. A row never written in (no uid) is a free slot and holds no links.
 */
function parsePriorityRows(input: unknown, label: RowsLabel, now: number): SentPriority[] | string {
  if (!Array.isArray(input) || input.length > MAX_PRIORITIES) return `${label.list} must be an array of at most ${MAX_PRIORITIES}.`;
  const rows: SentPriority[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const item: unknown = input[i];
    const name = `${label.row} ${i + 1}`;
    if (!isRow(item)) return `${name} must be an object.`;
    // Checked like every other field: a value of the wrong kind is a client bug, not a row to guess at.
    if (item.text != null && typeof item.text !== 'string') return `${name} has invalid text.`;
    if (item.uid != null && !(typeof item.uid === 'string' && UID_RE.test(item.uid))) return `${name} has an invalid uid.`;
    const text = typeof item.text === 'string' ? item.text.slice(0, LIMITS.priorityText) : '';
    const written = hasText({ text });
    let uid = typeof item.uid === 'string' ? item.uid.toLowerCase() : null;
    if (uid && seen.has(uid)) return `${name} repeats another row's uid.`;
    if (!uid && written) uid = randomBytes(6).toString('hex');
    if (uid) seen.add(uid);
    // Stamped by the client when the row first got text; at most a day ahead, for a device clock running fast.
    let addedAt = item.addedAt == null ? null : parseInstant(item.addedAt, 0, now + DAY_MS);
    if (item.addedAt != null && addedAt == null) return `${name} has an invalid addedAt.`;
    if (addedAt == null && written) addedAt = now;
    // Checked like every other flag: `Boolean("false")` would tick the row. Null is absent, as for the other fields.
    if (item.done != null && typeof item.done !== 'boolean') return `${name} has an invalid done flag.`;
    const links: Partial<Record<LinkField, string | null>> = {};
    for (const field of LINK_FIELDS) {
      const raw = item[field];
      if (raw != null && !(typeof raw === 'string' && UID_RE.test(raw))) return `${name} has an invalid ${LINK_NAMES[field]}.`;
      if (raw !== undefined) links[field] = typeof raw === 'string' ? raw.toLowerCase() : null;
    }
    if (links.cardUid != null && links.recurringUid != null) return `${name} can't be both a card and a recurring priority.`;
    const free = uid == null;
    rows.push({
      position: i + 1,
      text,
      done: written && item.done === true,
      uid,
      addedAt,
      cardUid: free ? null : (links.cardUid ?? null),
      recurringUid: free ? null : (links.recurringUid ?? null),
      categoryUid: free ? null : links.categoryUid,
    });
  }
  return rows;
}

/**
 * Each row's category where the request left the field out: that of the same uid's row in the
 * first of `sources` that holds it, else none. A field a client didn't send is one it didn't
 * change (a tab from before links), so the merge keeps the stored value.
 */
function withCategories(rows: SentPriority[], ...sources: Priority[][]): Priority[] {
  return rows.map(({ categoryUid, ...p }) => {
    if (categoryUid !== undefined) return { ...p, categoryUid };
    const from = sources.map((list) => list.find((s) => s.uid === p.uid)).find((s) => s != null);
    return { ...p, categoryUid: from?.categoryUid ?? null };
  });
}

/**
 * `touched` from a priorities save: the cards a board action handled through their rows,
 * lowercased. None when left out; null when it isn't a list of at most one id per row.
 */
function parseTouched(raw: unknown): Set<string> | null {
  if (raw === undefined) return new Set();
  if (!Array.isArray(raw) || raw.length > MAX_PRIORITIES) return null;
  const ids: unknown[] = raw;
  if (!ids.every((id): id is string => typeof id === 'string' && UID_RE.test(id))) return null;
  return new Set(ids.map((id) => id.toLowerCase()));
}

/**
 * The sessions logged on a row this save removed take the row's category, unless they have one
 * of their own: the row is gone, so nothing else says what that time was for. An emptied row
 * stays on the list and keeps its category, which its sessions count under through it.
 */
function keepSessionCategories(db: DB, dayId: number, stored: Priority[], list: Priority[]): void {
  const listed = new Set(list.map((p) => p.uid));
  const keep = db.prepare(`UPDATE sessions SET category_uid = ? WHERE day_id = ? AND priority_uid = ? AND category_uid IS NULL`);
  for (const row of stored) if (row.categoryUid != null && !listed.has(row.uid)) keep.run(row.categoryUid, dayId, row.uid);
}

/**
 * The sessions logged on an emptied or removed row this save writes in again drop a category of
 * their own (one picked in the log while the row was empty, or the row's, copied when it was
 * removed): the row decides from then on. Left on, that category would be hidden behind the row
 * and take the time over when the row is emptied or removed. Every text row the stored list
 * doesn't hold as one is checked: a uid new to the server has no sessions, since a session names
 * only a row its day holds.
 */
function dropSessionCategories(db: DB, dayId: number, stored: Priority[], list: Priority[]): void {
  const written = new Set(stored.filter(hasText).map((p) => p.uid));
  const drop = db.prepare(`UPDATE sessions SET category_uid = NULL WHERE day_id = ? AND priority_uid = ?`);
  for (const row of list) if (hasText(row) && !written.has(row.uid)) drop.run(dayId, row.uid);
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
    // The rows as stored, empty ones included; the client pads to the user's `priorityCount`.
    priorities: of(rows.priorities).map(priorityJson),
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

  // Every route here with a :date in its path, one added later included, has the date checked
  // once before its handler runs. /range and /prune are literal paths, so it never runs for them.
  r.param('date', (_req, res, next, date: string) => {
    if (!isValidDateKey(date)) return refuse(res, 400, 'Invalid date.');
    next();
  });

  // Full days for a date range, for the review and the History calendar. Only days that exist
  // are returned; the client does the math. Registered before /:date so "range" isn't
  // read as a date.
  r.get('/range', (req, res) => {
    const user = currentUser(req);
    const { from, to } = req.query;
    if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) return refuse(res, 400, 'from and to must be dates (YYYY-MM-DD) with from <= to.');
    // Both ends are included, so a span of MAX_RANGE_DAYS is one day too many.
    if (daysBetween(from, to) >= MAX_RANGE_DAYS) return refuse(res, 400, `Range is limited to ${MAX_RANGE_DAYS} days.`);
    res.json({ days: daysInRange(db, user.id, from, to) } satisfies RangeResponse);
  });

  // Old-day cleanup. GET is the preview the Data tab shows before asking; POST deletes.
  // Literal paths, so they sit before /:date like /range.
  r.get('/prune', (req, res) => {
    const { before } = req.query;
    if (!isValidDateKey(before)) return refuse(res, 400, 'before must be a date (YYYY-MM-DD).');
    res.json({ before, ...countDays(db, currentUser(req).id, before), serverMaxDays: config.retentionDays } satisfies PruneInfo);
  });

  r.post('/prune', (req, res) => {
    const before = (req.body as { before?: unknown }).before;
    if (!isValidDateKey(before)) return refuse(res, 400, 'before must be a date (YYYY-MM-DD).');
    const pruned = pruneDays(db, currentUser(req).id, before);
    if (pruned.days > 0 || pruned.cards > 0) reclaimSpace(db);
    res.json({ deleted: pruned.days } satisfies PruneResult);
  });

  r.get('/:date', (req, res) => {
    const { date } = req.params;
    res.json((daysInRange(db, currentUser(req).id, date, date)[0] ?? emptyDay(date)) satisfies Day);
  });

  // Full replace. Position parity defines kind: even = in, odd = out.
  r.put('/:date/punches', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    const input = (req.body as { punches?: unknown }).punches;
    if (!Array.isArray(input)) return refuse(res, 400, 'punches must be an array.');
    if (input.length > MAX_PUNCHES) return refuse(res, 400, `punches is limited to ${MAX_PUNCHES} rows.`);
    // A punch belongs to its day: a time days away from the key is a client bug, not data.
    const window = punchWindow(date);
    const punches: Punch[] = [];
    for (let i = 0; i < input.length; i++) {
      const item: unknown = input[i];
      if (!isRow(item)) return refuse(res, 400, `Punch ${i} must be an object.`);
      const raw = item.at;
      const at = raw == null ? null : parseInstant(raw, window.from, window.to);
      if (raw != null && at == null) return refuse(res, 400, `Punch ${i} has an invalid time.`);
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

  // Array order is the position, so removing a row is sending the list without it. `base` is
  // the list the client built this one on: the server lays the changes made since onto what it
  // holds (`mergePriorities`), so a device saving on an old copy keeps what another device did
  // meanwhile. With no base (curl, a tab from before merging) the list replaces the stored one,
  // like punches, but for a stored row's card and recurring priority, which never change. An
  // empty row can never be "done". A list that links two text rows to one card or one recurring
  // priority is refused when one of the two is new here (`repeatedLink`); of two the server
  // already holds, the merge keeps one. The board's cards follow the list in the same
  // transaction (`mirrorCards`): `cards` (the board is on and the day is today or later, which
  // only the client knows) makes a card for each text row without one, and `touched` names the
  // cards a board action handled through their rows. So do the sessions logged on a removed row,
  // which take its category (`keepSessionCategories`), and those on an emptied or removed row
  // this save writes in again, which drop their own (`dropSessionCategories`).
  r.put('/:date/priorities', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    const body = req.body as { priorities?: unknown; base?: unknown; cards?: unknown; touched?: unknown };
    const now = Date.now();
    const sent = parsePriorityRows(body.priorities, SENT_ROWS, now);
    if (typeof sent === 'string') return refuse(res, 400, sent);
    const sentBase = body.base == null ? null : parsePriorityRows(body.base, BASE_ROWS, now);
    if (typeof sentBase === 'string') return refuse(res, 400, sentBase);
    if (body.cards !== undefined && typeof body.cards !== 'boolean') return refuse(res, 400, 'cards must be a boolean.');
    const touched = parseTouched(body.touched);
    if (!touched) return refuse(res, 400, `touched must be a list of at most ${MAX_PRIORITIES} card ids.`);
    const saved = db.transaction((): Priority[] | string => {
      const day = findDay(db, user.id, date);
      const stored = day ? storedPriorities(db, day.id) : [];
      const base = sentBase ? withCategories(sentBase, stored) : stored;
      const mine = withCategories(sent, base, stored);
      const repeat = repeatedLink(mine, new Set(stored.map((p) => p.uid)));
      // Refused before the day is made, so a refusal stores nothing.
      if (repeat) return `Priority ${repeat.position} repeats another row's ${LINK_NAMES[repeat.field]}.`;
      const dayId = day?.id ?? ensureDay(db, user.id, date);
      const merged = mergePriorities(stored, base, mine);
      const list = mirrorCards(db, user.id, date, stored, merged, now, { makeCards: body.cards === true, touched });
      db.prepare(`DELETE FROM priorities WHERE day_id = ?`).run(dayId);
      const ins = db.prepare(
        `INSERT INTO priorities (day_id, position, text, done, uid, added_at, card_uid, recurring_uid, category_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of list) ins.run(dayId, p.position, p.text, p.done ? 1 : 0, p.uid, p.addedAt, p.cardUid, p.recurringUid, p.categoryUid);
      keepSessionCategories(db, dayId, stored, list);
      dropSessionCategories(db, dayId, stored, list);
      return list;
    })();
    if (typeof saved === 'string') return refuse(res, 400, saved);
    res.json({ priorities: saved } satisfies PrioritiesResponse);
  });

  r.put('/:date/overtime', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    const approved = (req.body as { approved?: unknown }).approved;
    if (typeof approved !== 'boolean') return refuse(res, 400, 'approved must be a boolean.');
    const dayId = ensureDay(db, user.id, date);
    db.prepare(`UPDATE days SET overtime_approved = ? WHERE id = ?`).run(approved ? 1 : 0, dayId);
    res.json({ overtimeApproved: approved } satisfies OvertimeResponse);
  });

  // This day's own work-day length (a half day, a long one); null goes back to the setting.
  // Same bounds as the setting, so every timeclock can take it in its place.
  r.put('/:date/target', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    const minutes = (req.body as { workMinutes?: unknown }).workMinutes;
    const bounds = SETTING_LIMITS.workMinutes;
    if (minutes !== null && !isWholeNumber(minutes, bounds))
      return refuse(res, 400, `workMinutes must be a whole number from ${bounds.min} to ${bounds.max}, or null.`);
    const dayId = ensureDay(db, user.id, date);
    db.prepare(`UPDATE days SET work_minutes = ? WHERE id = ?`).run(minutes, dayId);
    res.json({ workMinutes: minutes } satisfies TargetResponse);
  });

  // The day's retrospective: a free-text "why" and whether it has been reviewed. Marking it
  // reviewed keeps the first reviewed-at; un-marking clears it.
  r.put('/:date/retro', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    const { note, done } = req.body as { note?: unknown; done?: unknown };
    if (note !== undefined && typeof note !== 'string') return refuse(res, 400, 'note must be a string.');
    if (done !== undefined && typeof done !== 'boolean') return refuse(res, 400, 'done must be a boolean.');
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

  r.post('/:date/sessions', startSession(db));
  r.post('/:date/breaks', startBreak(db));

  return r;
}
