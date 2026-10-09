/**
 * Migration 13: each task is stored once. A task (`items`) has the one name and category it shows
 * under on every day; a day's list (`priorities`) names the tasks on it, with each one's place,
 * its tick that day and when it was put there. Board cards and recurring priorities become tasks,
 * and so does each run of a one-off task's rows across days. The old per-day rows stay whole in
 * `priorities_v1`, and the card fields the board no longer uses go into `legacy_*` columns, so
 * nothing stored is lost.
 *
 * Frozen like every migration: it keeps its own copies of the helpers it needs, so a later change
 * to `shared/` can't change how an old database migrates.
 */
import { randomBytes } from 'node:crypto';
import type { DB } from '../db.js';

const SCHEMA = `
  CREATE TABLE items (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uid          TEXT NOT NULL,                             -- minted by the client or the server
    title        TEXT NOT NULL CHECK (title <> ''),
    category_uid TEXT,                                      -- a soft link: a category made on a device can land after
    weekdays     INTEGER CHECK (weekdays BETWEEN 1 AND 127), -- set on a recurring priority: ISO weekdays, bit 0 Monday
    lane         TEXT CHECK (lane IN ('later', 'next')),    -- the board's open lanes; NULL: in neither
    position     INTEGER NOT NULL DEFAULT 0,                -- 1..n within its lane, 0 without one
    created_at   INTEGER NOT NULL,
    archived_at  INTEGER,                                   -- a recurring priority removed in Settings, or a task this migration archived
    deleted_at   INTEGER,                                   -- deleted everywhere: the row stays as a tombstone until the prune
    legacy_done_at   INTEGER,                               -- board_cards.done_at; read only by the prune, NULL on new rows
    legacy_untouched INTEGER,                               -- board_cards.untouched; never read, NULL on new rows
    legacy_uid       TEXT,                                  -- the uid this migration had to replace; never read
    UNIQUE (user_id, uid),
    CHECK (weekdays IS NULL OR lane IS NULL),               -- a recurring priority is never in a lane
    CHECK (deleted_at IS NULL OR (weekdays IS NULL AND lane IS NULL))  -- a tombstone is a one-off in no lane
  );

  -- The old per-day rows, kept whole and never read. They still go with their days.
  ALTER TABLE priorities RENAME TO priorities_v1;
  DROP INDEX priorities_card;

  CREATE TABLE priorities (
    day_id   INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
    item_id  INTEGER NOT NULL REFERENCES items(id),         -- NO ACTION: a task a day names can't be deleted
    position INTEGER NOT NULL,                              -- its row on the sheet; an empty row isn't stored
    done     INTEGER NOT NULL DEFAULT 0,                    -- ticked on this day
    added_at INTEGER NOT NULL,                              -- when it was put on this day's list
    PRIMARY KEY (day_id, item_id),
    UNIQUE (day_id, position)
  ) WITHOUT ROWID;
  CREATE INDEX priorities_item ON priorities(item_id);

  -- NULL: unplanned. sessions.priority_uid stays, unread, like sessions.notes.
  ALTER TABLE sessions ADD COLUMN item_id INTEGER REFERENCES items(id);
  CREATE INDEX sessions_item ON sessions(item_id) WHERE item_id IS NOT NULL;
`;

/** Later and Next numbered 1..n in their order, for every user: Done and held cards left gaps. */
const RENUMBER = `
  UPDATE items SET position = r.n
  FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id, lane ORDER BY position, id) AS n FROM items WHERE lane IS NOT NULL) AS r
  WHERE items.id = r.id;
`;

/** `hasText` as it was: a row with a name. */
function written(text: string): boolean {
  return text.trim() !== '';
}

/** `sameText` as it was: the key two rows of one text share, whatever their case or spacing. */
function textKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** `LOOKBACK_DAYS` as it was: how far apart two open rows of one text may be and still be one task. */
const CHAIN_DAYS = 14;
const DAY_MS = 86_400_000;

/** Whole days from one date key to a later one. A date-only key parses as UTC midnight, so no DST change gets in. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/** The date's ISO weekday as a `weekdays` bit, bit 0 for Monday, read in UTC from the key as the client does. */
function weekdayBit(date: string): number {
  return 1 << ((new Date(date).getUTCDay() + 6) % 7);
}

interface CardRow {
  uid: string;
  title: string;
  category_uid: string | null;
  lane: 'later' | 'next' | 'done';
  position: number;
  created_at: number;
  done_at: number | null;
  untouched: number;
}

interface RecurringRow {
  uid: string;
  title: string;
  category_uid: string | null;
  weekdays: number;
}

/** A row of `priorities_v1` with a uid: written (with text) or emptied. Rows with neither are padding. */
interface Row {
  day_id: number;
  date: string;
  position: number;
  text: string;
  done: number;
  uid: string;
  added_at: number;
  card_uid: string | null;
  recurring_uid: string | null;
  category_uid: string | null;
}

interface NewTask {
  title: string;
  categoryUid: string | null;
  createdAt: number;
  weekdays?: number;
  lane?: 'later' | 'next' | null;
  position?: number;
  archivedAt?: number | null;
  doneAt?: number | null;
  untouched?: number;
}

/** A task named by its rows (a card or recurring priority deleted before, or a one-off): its latest row, and the weekdays its rows fell on. */
interface Named {
  id: number;
  row: Row;
  weekdays: number;
}

export function oneItem(db: DB): void {
  db.exec(SCHEMA);
  const now = Date.now();
  const users = db.prepare(`SELECT id FROM users ORDER BY id`).pluck().all() as number[];
  for (const userId of users) backfill(db, userId, now);
  db.exec(RENUMBER);
  db.exec(`DROP TABLE board_cards; DROP TABLE recurring;`);
}

function backfill(db: DB, userId: number, now: number): void {
  // Every written row has had a uid since migration 3, and the server mints one for each; a row
  // with none was never written in.
  const rows = db
    .prepare(
      `SELECT p.day_id, d.date, p.position, p.text, p.done, p.uid, COALESCE(p.added_at, d.created_at) AS added_at,
              p.card_uid, p.recurring_uid, p.category_uid
       FROM priorities_v1 p JOIN days d ON d.id = p.day_id
       WHERE d.user_id = ? AND p.uid IS NOT NULL
       ORDER BY d.date, p.position`,
    )
    .all(userId) as Row[];

  const insert = db.prepare(
    `INSERT INTO items (user_id, uid, title, category_uid, weekdays, lane, position, created_at, archived_at, legacy_done_at, legacy_untouched, legacy_uid)
     VALUES (@userId, @uid, @title, @categoryUid, @weekdays, @lane, @position, @createdAt, @archivedAt, @doneAt, @untouched, @legacyUid)`,
  );
  const taken = new Set<string>();
  /**
   * A task under `uid`, or under a fresh one when a task of the user's holds it already (the old
   * one kept in `legacy_uid`), so UNIQUE (user_id, uid) can't stop the migration and the server
   * with it. Cards come first, and are unique among themselves.
   */
  const add = (uid: string, task: NewTask): number => {
    let own = uid;
    while (taken.has(own)) own = randomBytes(6).toString('hex');
    taken.add(own);
    const values = { weekdays: null, lane: null, position: 0, archivedAt: null, doneAt: null, untouched: null, ...task };
    return Number(insert.run({ ...values, userId, uid: own, legacyUid: own === uid ? null : uid }).lastInsertRowid);
  };

  // Each card's latest linked day (by its id, emptied rows included), and the days a written row
  // names it on.
  const latestDay = new Map<string, number>();
  const named = new Set<string>();
  const namedOn = new Set<string>();
  for (const r of rows) {
    if (r.card_uid == null) continue;
    latestDay.set(r.card_uid, r.day_id);
    if (written(r.text)) {
      named.add(r.card_uid);
      namedOn.add(`${r.card_uid} ${r.day_id}`);
    }
  }

  const cardTasks = new Map<string, number>();
  // The cards in Later or Next: task id to card uid.
  const laned = new Map<number, string>();
  const wasDone: number[] = [];
  for (const c of db.prepare(`SELECT * FROM board_cards WHERE user_id = ? ORDER BY id`).all(userId) as CardRow[]) {
    const last = latestDay.get(c.uid);
    // Held: a card a save made whose latest linked rows were all emptied, which the board showed nowhere.
    const held = c.untouched === 1 && last !== undefined && !namedOn.has(`${c.uid} ${last}`);
    // Done is worked out from the ticks, so a done card keeps no lane, and a held one stays out of sight.
    const lane = c.lane === 'done' || held ? null : c.lane;
    const task: NewTask = {
      title: c.title,
      categoryUid: c.category_uid,
      createdAt: c.created_at,
      lane,
      position: lane === null ? 0 : c.position,
      // No written row to give it an entry, and no lane: kept under its name, and shown nowhere.
      archivedAt: lane === null && !named.has(c.uid) ? now : null,
      doneAt: c.done_at,
      untouched: c.untouched,
    };
    const id = add(c.uid, task);
    cardTasks.set(c.uid, id);
    if (lane !== null) laned.set(id, c.uid);
    if (c.lane === 'done') wasDone.push(id);
  }

  const routineTasks = new Map<string, number>();
  for (const r of db.prepare(`SELECT * FROM recurring WHERE user_id = ? ORDER BY id`).all(userId) as RecurringRow[]) {
    routineTasks.set(r.uid, add(r.uid, { title: r.title, categoryUid: r.category_uid, weekdays: r.weekdays, createdAt: now }));
  }

  const fromRows = new Map<number, Named>();
  /** A task made from the first of its rows; it takes its latest row's name once they are all walked. */
  const addFromRow = (uid: string, row: Row, task: Pick<NewTask, 'weekdays' | 'archivedAt'>): Named => {
    const made = { id: add(uid, { title: row.text.trim(), categoryUid: row.category_uid, createdAt: row.added_at, ...task }), row, weekdays: 0 };
    fromRows.set(made.id, made);
    return made;
  };
  /** The task of a card or recurring priority the row links; one deleted before (no task) gets one, archived, under its uid. */
  const linked = (tasks: Map<string, number>, uid: string, row: Row, task: Pick<NewTask, 'weekdays'>): number => {
    const known = tasks.get(uid) ?? addFromRow(uid, row, { archivedAt: now, ...task }).id;
    tasks.set(uid, known);
    return known;
  };

  // One-off rows of one text are one task while each is at most CHAIN_DAYS after the last, until
  // a tick ends the chain: a task carried and left open is one task, and the same text a month
  // later, or twice on one day, is another.
  const chains = new Map<string, Named[]>();
  /** The open chain a row of its text continues, if any. */
  const openChain = (row: Row): Named | undefined => {
    const open = (chains.get(textKey(row.text)) ?? []).filter(
      ({ row: last }) => last.done === 0 && last.date < row.date && daysBetween(last.date, row.date) <= CHAIN_DAYS,
    );
    // Of several, the one whose latest row is on the latest day, then the higher on that day's
    // list: a day's positions are unique, so two chains never tie and every run groups alike.
    return open.sort((a, b) => b.row.date.localeCompare(a.row.date) || a.row.position - b.row.position)[0];
  };
  const chained = (row: Row): number => {
    const joined = openChain(row);
    if (joined) return joined.id;
    const started = addFromRow(row.uid, row, {});
    const key = textKey(row.text);
    chains.set(key, [...(chains.get(key) ?? []), started]);
    return started.id;
  };

  type Entry = { dayId: number; itemId: number; position: number; done: number; addedAt: number };
  const entries = new Map<string, Entry>();
  // Each task's entry on its latest day: the rows are walked in date order.
  const latest = new Map<number, Entry>();
  const links: { dayId: number; uid: string; itemId: number }[] = [];

  const drop = db.prepare(`DELETE FROM items WHERE id = ? RETURNING uid`).pluck();
  /**
   * The task of the card a row links. A card's first written row can continue an open chain of
   * its text: rows typed with the board off and carried, until the old daily sweep gave the carried
   * row a card. That chain is the card's work, so its rows become the card's entries (under the
   * card's name, as any card row) and its task goes, freeing its uid. The chain's days are behind
   * the walk, so their entries' keys are never looked up again.
   */
  const carded = (uid: string, row: Row): number => {
    const id = linked(cardTasks, uid, row, {});
    const chain = latest.has(id) ? undefined : openChain(row);
    if (chain) {
      const same = chains.get(textKey(row.text))!;
      same.splice(same.indexOf(chain), 1);
      fromRows.delete(chain.id);
      for (const e of entries.values()) if (e.itemId === chain.id) e.itemId = id;
      for (const l of links) if (l.itemId === chain.id) l.itemId = id;
      taken.delete(drop.get(chain.id) as string);
    }
    return id;
  };

  for (const r of rows) {
    if (!written(r.text)) continue;
    const id =
      r.card_uid != null
        ? carded(r.card_uid, r)
        : r.recurring_uid != null
          ? linked(routineTasks, r.recurring_uid, r, { weekdays: weekdayBit(r.date) })
          : chained(r);
    const name = fromRows.get(id);
    if (name) {
      name.row = r;
      name.weekdays |= weekdayBit(r.date);
    }
    links.push({ dayId: r.day_id, uid: r.uid, itemId: id });
    // One entry per task and day, at its first row's place; a tick on any of its rows that day shows.
    const at = `${r.day_id} ${id}`;
    const entry = entries.get(at) ?? { dayId: r.day_id, itemId: id, position: r.position, done: 0, addedAt: r.added_at };
    entry.done = Math.max(entry.done, r.done);
    entries.set(at, entry);
    latest.set(id, entry);
  }
  // A card in Later or Next whose latest linked row is ticked was put back there after the tick
  // (the board's untick, the correction for a mistaken tick). Done is read from the latest entry's
  // tick, so that tick goes, or the task would show as done again; priorities_v1 keeps it. A linked
  // row on a later day, even emptied, means the card was pulled onto that list after it was done:
  // that tick is real and stays.
  for (const [id, uid] of laned) {
    const entry = latest.get(id);
    if (entry && entry.dayId === latestDay.get(uid)) entry.done = 0;
  }
  // A Done card whose latest entry is open had its ticked row emptied or removed after an open
  // one, and would show as left open: it is archived, as a Done card with no written row is.
  const archive = db.prepare(`UPDATE items SET archived_at = ? WHERE id = ?`);
  for (const id of wasDone) if (latest.get(id)?.done === 0) archive.run(now, id);

  // An emptied row makes no entry. Its sessions stay with the card or recurring priority it links
  // when that is a task; otherwise they keep counting under the row's category, as they did
  // through the row.
  const keepCategory = db.prepare(`UPDATE sessions SET category_uid = COALESCE(category_uid, ?) WHERE day_id = ? AND priority_uid = ?`);
  for (const r of rows) {
    if (written(r.text)) continue;
    const id = r.card_uid != null ? cardTasks.get(r.card_uid) : r.recurring_uid != null ? routineTasks.get(r.recurring_uid) : undefined;
    if (id !== undefined) links.push({ dayId: r.day_id, uid: r.uid, itemId: id });
    else keepCategory.run(r.category_uid, r.day_id, r.uid);
  }

  const entry = db.prepare(`INSERT INTO priorities (day_id, item_id, position, done, added_at) VALUES (@dayId, @itemId, @position, @done, @addedAt)`);
  for (const e of entries.values()) entry.run(e);

  // NULL | x is NULL, so only a recurring priority's weekdays change.
  const name = db.prepare(`UPDATE items SET title = ?, category_uid = ?, weekdays = weekdays | ? WHERE id = ?`);
  for (const { id, row, weekdays } of fromRows.values()) name.run(row.text.trim(), row.category_uid, weekdays, id);

  // A row's uid is unique only within its day's list. A cancelled session counts nowhere, so it
  // names no task (a task it named would be kept for it).
  const link = db.prepare(`UPDATE sessions SET item_id = @itemId WHERE day_id = @dayId AND priority_uid = @uid AND status <> 'cancelled'`);
  for (const l of links) link.run(l);
}
