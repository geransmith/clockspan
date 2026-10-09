import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { currentUser } from '../auth/middleware.js';
import { refuse, STALE_CLIENT } from '../refuse.js';
import { countDays, pruneDays, reclaimSpace } from '../retention.js';
import { collectItems, inList, itemCounts, nextFromLater, type ItemCounts } from '../board.js';
import { isWholeNumber } from '../validate.js';
import { DAY_MS, daysBetween, isValidDateKey, punchWindow } from '../../shared/dates.js';
import {
  breakRowToJson,
  DAY_COLUMNS,
  ensureDay,
  findDay,
  parseUidField,
  sessionRowToJson,
  SESSIONS,
  UID_RE,
  type BreakRow,
  type Dated,
  type DayRow,
  type ItemRow,
  type PunchRow,
  type SessionRow,
} from './shared.js';
import { startBreak } from './breaks.js';
import { startSession } from './sessions.js';
import { mergePriorities } from '../../shared/priorities.js';
import { taskTitle } from '../../shared/text.js';
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

/** A day's entry with its task, as `ENTRIES` reads it. */
interface EntryRow {
  day_id: number;
  date: string;
  position: number;
  done: number;
  added_at: number;
  item_id: number;
  uid: string;
  title: string;
  category_uid: string | null;
  weekdays: number | null;
  archived_at: number | null;
}

/** Entries (`x`) with their day's date and their task's uid, current name and category. */
const ENTRIES = `SELECT x.day_id, x.position, x.done, x.added_at, x.item_id, i.uid, i.title, i.category_uid, i.weekdays, i.archived_at, d.date
  FROM priorities x JOIN items i ON i.id = x.item_id JOIN days d ON d.id = x.day_id`;

/** An entry as the API sends it, with its task's counts (`itemCounts`): its focus on other days, since the day's own log is sent beside it. */
function priorityJson(r: EntryRow, counts: ReadonlyMap<number, ItemCounts>): Priority {
  const { dates, logged, loggedOn } = counts.get(r.item_id)!;
  return {
    position: r.position,
    text: r.title,
    done: Boolean(r.done),
    uid: r.uid,
    addedAt: r.added_at,
    categoryUid: r.category_uid,
    recurring: r.weekdays != null,
    archived: r.archived_at != null,
    listed: dates.length,
    earlier: dates.filter((d) => d < r.date).length,
    logged: logged - (loggedOn.get(r.date) ?? 0),
  };
}

/** A day's list as stored, in order, each task's counts read once for all of them. */
function storedPriorities(db: DB, dayId: number): Priority[] {
  const rows = db.prepare(`${ENTRIES} WHERE x.day_id = ? ORDER BY x.position`).all(dayId) as EntryRow[];
  const counts = itemCounts(
    db,
    rows.map((r) => r.item_id),
  );
  return rows.map((r) => priorityJson(r, counts));
}

/** What a list of priority rows is called in the errors: the list sent, or the base it was built on. */
interface RowsLabel {
  list: string;
  row: string;
}
const SENT_ROWS: RowsLabel = { list: 'priorities', row: 'Priority' };
const BASE_ROWS: RowsLabel = { list: 'base', row: 'Base row' };

/**
 * A list of priority rows from a request, numbered from 1, or the message to refuse it with. A
 * row is its task (`uid`), or a free row (no uid, no text) where none is. The web app mints a uid
 * and stamps addedAt the first time a row gets text, and always sends both. The server fills them
 * in for a text row that arrives without (curl, the route tests), so every row with text names a
 * task. A row with a uid needs a name: a task's is never blank. A list and its base are read with
 * one `now`, so a row the merge compares across them isn't changed by two stamps a millisecond
 * apart. The fields the server works out (`recurring`, `listed` and the rest) are neither read nor
 * refused. A row's text is stored as `taskTitle` gives it. The uids of the rows sent with no
 * `categoryUid` go in `unsaid`, when given, so the save can read their category as unchanged.
 */
function parsePriorityRows(input: unknown, label: RowsLabel, now: number, unsaid?: Set<string>): Priority[] | string {
  if (!Array.isArray(input) || input.length > MAX_PRIORITIES) return `${label.list} must be an array of at most ${MAX_PRIORITIES}.`;
  const rows: Priority[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const item: unknown = input[i];
    const name = `${label.row} ${i + 1}`;
    if (!isRow(item)) return `${name} must be an object.`;
    // Checked like every other field: a value of the wrong kind is a client bug, not a row to guess at.
    if (item.text != null && typeof item.text !== 'string') return `${name} has invalid text.`;
    if (item.uid != null && !(typeof item.uid === 'string' && UID_RE.test(item.uid))) return `${name} has an invalid uid.`;
    const text = typeof item.text === 'string' ? taskTitle(item.text) : '';
    const written = text !== '';
    let uid = typeof item.uid === 'string' ? item.uid.toLowerCase() : null;
    if (uid && !written) return `${name} needs a name.`;
    if (uid && seen.has(uid)) return `${name} repeats another row's uid.`;
    if (!uid && written) uid = randomBytes(6).toString('hex');
    if (uid) seen.add(uid);
    // Stamped by the client when the row first got text; at most a day ahead, for a device clock running fast.
    let addedAt = item.addedAt == null ? null : parseInstant(item.addedAt, 0, now + DAY_MS);
    if (item.addedAt != null && addedAt == null) return `${name} has an invalid addedAt.`;
    if (addedAt == null && written) addedAt = now;
    // Checked like every other flag: `Boolean("false")` would tick the row. Null is absent, as for the other fields.
    if (item.done != null && typeof item.done !== 'boolean') return `${name} has an invalid done flag.`;
    const category = parseUidField(item.categoryUid, `${name} has an invalid category.`);
    if ('error' in category) return category.error;
    if (uid && !('categoryUid' in item)) unsaid?.add(uid);
    rows.push({
      position: i + 1,
      text,
      done: written && item.done === true,
      uid,
      addedAt,
      categoryUid: uid == null ? null : (category.uid ?? null),
      recurring: false,
      archived: false,
      listed: 0,
      earlier: 0,
      logged: 0,
    });
  }
  return rows;
}

/**
 * Whether a priorities save is shaped as a page loaded before tasks were stored once sends it:
 * `cards` or `touched`, sent on every save whatever their value, or a row with a card or
 * recurring-priority link. Such a page can't save until it reloads.
 */
function staleShape(body: Record<string, unknown>): boolean {
  const rows: unknown[] = Array.isArray(body.priorities) ? body.priorities : [];
  return 'cards' in body || 'touched' in body || rows.some((r) => isRow(r) && ('cardUid' in r || 'recurringUid' in r));
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
  const range = `d.user_id = ? AND d.date >= ? AND d.date <= ?`;
  const inRange = `JOIN days d ON d.id = x.day_id WHERE ${range}`;
  const all = (sql: string) => db.prepare(sql).all(userId, from, to);
  const entries = all(`${ENTRIES} WHERE ${range} ORDER BY x.position`) as EntryRow[];
  return {
    punches: byDay(all(`SELECT x.* FROM punches x ${inRange} ORDER BY x.position`) as PunchRow[]),
    priorities: byDay(entries),
    counts: itemCounts(
      db,
      entries.map((e) => e.item_id),
    ),
    sessions: byDay(all(`${SESSIONS} WHERE ${range} AND x.status <> 'cancelled' ORDER BY x.started_at`) as SessionRow[]),
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
    // The entries as stored, with gaps where free rows sat; the client pads to the user's `priorityCount`.
    priorities: of(rows.priorities).map((r) => priorityJson(r, rows.counts)),
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
    if (pruned.days > 0 || pruned.items > 0) reclaimSpace(db);
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

  // Array order is the position, so removing a row is sending the list without it; a free row
  // holds its place and isn't stored. `base` is the list the client built this one on: the server
  // lays the changes made since onto what it holds (`mergePriorities`), so a device saving on an
  // old copy keeps what another device did meanwhile. With no base (curl) the stored list stands
  // in for it. A row naming a deleted task is dropped before the merge, from the list and the
  // base, so a device that still has the task can't bring it back, and the rest is stored. The
  // tasks follow in the same transaction: a uid new to the user makes its task, and a row this
  // device renamed or recategorised since its base writes that to its task, on every day. A task
  // in Later added open to its latest list goes to Next (`nextFromLater`), and one the save took
  // off its last list goes when nothing else names it (`collectItems`).
  r.put('/:date/priorities', (req, res) => {
    const user = currentUser(req);
    const { date } = req.params;
    const body = req.body as Record<string, unknown>;
    if (staleShape(body)) return refuse(res, 409, STALE_CLIENT);
    const now = Date.now();
    const unsaid = new Set<string>();
    const sent = parsePriorityRows(body.priorities, SENT_ROWS, now, unsaid);
    if (typeof sent === 'string') return refuse(res, 400, sent);
    const sentBase = body.base == null ? null : parsePriorityRows(body.base, BASE_ROWS, now);
    if (typeof sentBase === 'string') return refuse(res, 400, sentBase);
    const saved = db.transaction((): Priority[] | null => {
      const day = findDay(db, user.id, date);
      const stored = day ? storedPriorities(db, day.id) : [];
      // A row sent with no category (curl, a script) keeps the one its base gives it: left out is unchanged.
      const baseCategory = new Map((sentBase ?? stored).map((p) => [p.uid, p.categoryUid]));
      for (const p of sent) if (p.uid != null && unsaid.has(p.uid)) p.categoryUid = baseCategory.get(p.uid) ?? null;
      const uids = [...stored, ...sent, ...(sentBase ?? [])].flatMap((p) => (p.uid == null ? [] : [p.uid]));
      // Tombstones included: their rows are dropped, and their uids stay taken.
      const known = new Map(
        (db.prepare(`SELECT * FROM items WHERE user_id = ? AND uid IN (SELECT value FROM json_each(?))`).all(user.id, inList(uids)) as ItemRow[]).map((i) => [
          i.uid,
          i,
        ]),
      );
      const live = (p: Priority) => p.uid == null || known.get(p.uid)?.deleted_at == null;
      const mine = sent.filter(live);
      const base = sentBase?.filter(live) ?? stored;
      const merged = mergePriorities(stored, base, mine);
      // Refused before the day is made, so a refusal stores nothing.
      if (merged.length > MAX_PRIORITIES) return null;
      const dayId = day?.id ?? ensureDay(db, user.id, date);
      const mineBy = new Map(mine.map((p) => [p.uid, p]));
      const baseBy = new Map(base.map((p) => [p.uid, p]));
      const storedUids = new Set(stored.map((p) => p.uid));
      const create = db.prepare(`INSERT INTO items (user_id, uid, title, category_uid, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *`);
      const rename = db.prepare(`UPDATE items SET title = ? WHERE id = ?`);
      const recategorise = db.prepare(`UPDATE items SET category_uid = ? WHERE id = ?`);
      const added: ItemRow[] = [];
      const entries = merged.flatMap((p) => {
        if (p.uid == null) return [];
        let item = known.get(p.uid);
        const m = mineBy.get(p.uid);
        const b = baseBy.get(p.uid);
        if (!item) {
          item = create.get(user.id, p.uid, p.text, p.categoryUid, now) as ItemRow;
        } else if (m && b) {
          // Only what this device changed: a rename or a category made elsewhere since stands.
          if (m.text !== b.text) rename.run(m.text, item.id);
          if (m.categoryUid !== b.categoryUid) recategorise.run(m.categoryUid, item.id);
        }
        if (!storedUids.has(p.uid) && !p.done) added.push(item);
        return [{ itemId: item.id, position: p.position, done: p.done, addedAt: p.addedAt! }];
      });
      db.prepare(`DELETE FROM priorities WHERE day_id = ?`).run(dayId);
      const ins = db.prepare(`INSERT INTO priorities (day_id, item_id, position, done, added_at) VALUES (?, ?, ?, ?, ?)`);
      for (const e of entries) ins.run(dayId, e.itemId, e.position, e.done ? 1 : 0, e.addedAt);
      nextFromLater(db, user.id, date, added);
      const kept = new Set(entries.map((e) => e.itemId));
      const removed = stored.map((p) => known.get(p.uid!)!.id).filter((id) => !kept.has(id));
      collectItems(db, user.id, removed);
      return storedPriorities(db, dayId);
    })();
    if (saved === null) return refuse(res, 409, `This day's list already has ${MAX_PRIORITIES} priorities with another device's. Remove one first.`);
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
