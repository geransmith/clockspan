import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, ensureDefaultUser, migrate, openDatabase, type DB } from './db.js';
import { countRows } from './dev/harness.js';
import type { ItemRow as SharedItemRow } from './routes/shared.js';

/** A database stopped after migration `upTo`, with foreign keys on as `openDatabase` has them. */
function migratedTo(upTo: number): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, upTo);
  return db;
}

/** A second user, a local account. */
const addSam = (db: DB) =>
  Number(db.prepare(`INSERT INTO users (kind, username, display_name, created_at) VALUES ('local', 'sam', 'Sam', 1)`).run().lastInsertRowid);

describe('openDatabase', () => {
  it('runs every migration on a fresh database', () => {
    const db = openDatabase(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // Re-running is a no-op.
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });

  it('creates the default user once', () => {
    const db = openDatabase(':memory:');
    const a = ensureDefaultUser(db);
    const b = ensureDefaultUser(db);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ kind: 'default', is_admin: 1 });
    db.close();
  });
});

describe('migration 3: priority ids and added-at backfill', () => {
  it('gives existing text rows an id and the earliest plausible time, and leaves empty rows alone', () => {
    // Stop at the schema before the backfill and write rows the old client would have.
    const db = migratedTo(2);
    expect(db.pragma('user_version', { simple: true })).toBe(2);

    const user = ensureDefaultUser(db);
    const withSession = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2026-09-01', 1000)`).run(user.id).lastInsertRowid;
    const withoutSession = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2026-09-02', 2000)`).run(user.id).lastInsertRowid;
    const prio = db.prepare(`INSERT INTO priorities (day_id, position, text, done) VALUES (?, ?, ?, 0)`);
    prio.run(withSession, 1, 'Planned');
    prio.run(withSession, 2, '');
    prio.run(withoutSession, 1, 'Alone');
    db.prepare(
      `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status) VALUES (?, ?, 'x', 600, 500, 1100, 'completed')`,
    ).run(withSession, user.id);

    migrate(db, 3);
    expect(db.pragma('user_version', { simple: true })).toBe(3);

    const rows = db.prepare(`SELECT day_id, position, uid, added_at FROM priorities ORDER BY day_id, position`).all() as {
      day_id: number;
      position: number;
      uid: string | null;
      added_at: number | null;
    }[];
    expect(rows[0]!.uid).toMatch(/^[0-9a-f]{12}$/);
    // Earlier of the day's creation and its first session: the session started first here.
    expect(rows[0]!.added_at).toBe(500);
    expect(rows[1]).toMatchObject({ position: 2, uid: null, added_at: null });
    expect(rows[2]!.uid).toMatch(/^[0-9a-f]{12}$/);
    expect(rows[2]!.added_at).toBe(2000);
    expect(rows[0]!.uid).not.toBe(rows[2]!.uid);
    db.close();
  });
});

describe('migration 4: one running session per user', () => {
  it('refuses a second running row for a user, and only that', () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    const other = addSam(db);
    const day = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2026-09-01', 1000)`).run(user.id).lastInsertRowid;
    const otherDay = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2026-09-01', 1000)`).run(other).lastInsertRowid;
    const insert = db.prepare(
      `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status) VALUES (?, ?, '', 600, 1000, ?, ?)`,
    );
    insert.run(day, user.id, 1500, 'completed');
    insert.run(day, user.id, null, 'running');
    expect(() => insert.run(day, user.id, null, 'running')).toThrow(/UNIQUE/);
    // Another user, and an ended row, are unaffected.
    insert.run(otherDay, other, null, 'running');
    insert.run(day, user.id, 1600, 'cancelled');
    expect(countRows(db, 'sessions')).toBe(4);
    db.close();
  });
});

describe('migration 11: categories', () => {
  it('keeps one category per uid for each user, goes with its user, and gives sessions none', () => {
    const db = migratedTo(10);
    const user = ensureDefaultUser(db);
    const day = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2026-09-01', 1000)`).run(user.id).lastInsertRowid;
    db.prepare(
      `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status) VALUES (?, ?, 'x', 600, 500, 1100, 'completed')`,
    ).run(day, user.id);

    migrate(db, 11);
    expect(db.prepare(`SELECT category_uid FROM sessions`).all()).toEqual([{ category_uid: null }]);
    const other = addSam(db);
    const insert = db.prepare(`INSERT INTO categories (user_id, uid, name, color) VALUES (?, ?, 'Tickets', 'blue')`);
    insert.run(user.id, 'cat000000001');
    expect(db.prepare(`SELECT archived_at FROM categories`).get()).toEqual({ archived_at: null });
    expect(() => insert.run(user.id, 'cat000000001')).toThrow(/UNIQUE/);
    // Uids are only unique per user, and names aren't unique in the table at all.
    insert.run(other, 'cat000000001');
    insert.run(user.id, 'cat000000002');
    db.prepare(`DELETE FROM users WHERE id = ?`).run(other);
    expect(countRows(db, 'categories')).toBe(2);
    db.close();
  });
});

describe('migration 13: each task stored once', () => {
  const NOW = Date.UTC(2026, 9, 8, 12);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface OldRow {
    /** Null for a padded row, never written in; a uid of its own by default. */
    uid?: string | null;
    done?: boolean;
    addedAt?: number | null;
    card?: string;
    recurring?: string;
    category?: string;
  }
  interface OldCard {
    createdAt?: number;
    doneAt?: number;
    untouched?: boolean;
    category?: string;
  }
  type ItemRow = SharedItemRow & { legacy_done_at: number | null; legacy_untouched: number | null; legacy_uid: string | null };

  /** The schema migration 13 starts from, and helpers that write rows as the server before it stored them. */
  function before() {
    const db = migratedTo(12);
    const user = ensureDefaultUser(db).id;
    const day = (date: string, createdAt = 1000) =>
      Number(db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, ?, ?)`).run(user, date, createdAt).lastInsertRowid);
    const row = (dayId: number, position: number, text: string, o: OldRow = {}) => {
      db.prepare(
        `INSERT INTO priorities (day_id, position, text, done, uid, added_at, card_uid, recurring_uid, category_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        dayId,
        position,
        text,
        o.done ? 1 : 0,
        o.uid === undefined ? `row${dayId}at${position}` : o.uid,
        o.addedAt === undefined ? 2000 : o.addedAt,
        o.card ?? null,
        o.recurring ?? null,
        o.category ?? null,
      );
    };
    const card = (uid: string, title: string, lane: 'later' | 'next' | 'done', position: number, o: OldCard = {}) => {
      db.prepare(
        `INSERT INTO board_cards (user_id, uid, title, lane, position, created_at, done_at, untouched, category_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(user, uid, title, lane, position, o.createdAt ?? 500, o.doneAt ?? null, o.untouched ? 1 : 0, o.category ?? null);
    };
    const routine = (uid: string, title: string, weekdays: number, category: string | null = null) => {
      db.prepare(`INSERT INTO recurring (user_id, uid, title, category_uid, weekdays) VALUES (?, ?, ?, ?, ?)`).run(user, uid, title, category, weekdays);
    };
    const session = (dayId: number, priorityUid: string | null, o: { status?: string; category?: string } = {}) =>
      Number(
        db
          .prepare(
            `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status, priority_uid, category_uid)
             VALUES (?, ?, 'x', 1500, 3000, 4500, ?, ?, ?)`,
          )
          .run(dayId, user, o.status ?? 'completed', priorityUid, o.category ?? null).lastInsertRowid,
      );
    return { db, user, day, row, card, routine, session };
  }

  const item = (db: DB, uid: string) => db.prepare(`SELECT * FROM items WHERE uid = ?`).get(uid) as ItemRow | undefined;
  /** The tasks that had to take a fresh uid in place of `uid`, in the order they were made. */
  const replacing = (db: DB, uid: string) => db.prepare(`SELECT * FROM items WHERE legacy_uid = ? ORDER BY id`).all(uid) as ItemRow[];
  /** A day's entries, each by its task's uid. */
  const list = (db: DB, dayId: number) =>
    db
      .prepare(`SELECT i.uid, p.position, p.done, p.added_at FROM priorities p JOIN items i ON i.id = p.item_id WHERE p.day_id = ? ORDER BY p.position`)
      .all(dayId) as { uid: string; position: number; done: number; added_at: number | null }[];
  /** A session's task, by uid, and its own category. */
  const linkOf = (db: DB, sessionId: number) =>
    db.prepare(`SELECT i.uid, s.category_uid FROM sessions s LEFT JOIN items i ON i.id = s.item_id WHERE s.id = ?`).get(sessionId) as {
      uid: string | null;
      category_uid: string | null;
    };
  const FRESH = /^[0-9a-f]{12}$/;

  it('adds tasks and day entries, keeps the old rows whole, and drops the card and recurring tables', () => {
    const { db, day, row, session } = before();
    const mon = day('2026-09-07');
    row(mon, 1, 'Report', { uid: 'row000000001' });
    row(mon, 2, '', { uid: null });
    const s = session(mon, 'row000000001');
    const old = db.prepare(`SELECT * FROM priorities ORDER BY id`).all();

    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(13);
    expect(db.prepare(`SELECT * FROM priorities_v1 ORDER BY id`).all()).toEqual(old);
    // The old link stays on the session, unread, beside the new one.
    expect(db.prepare(`SELECT priority_uid FROM sessions`).all()).toEqual([{ priority_uid: 'row000000001' }]);
    expect(linkOf(db, s).uid).toBe('row000000001');
    const schema = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).all() as {
      type: string;
      name: string;
      sql: string;
    }[];
    const names = schema.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['items', 'priorities', 'priorities_v1', 'priorities_item', 'sessions_item']));
    for (const gone of ['board_cards', 'recurring', 'priorities_card']) expect(names).not.toContain(gone);
    expect(schema.find((x) => x.name === 'priorities')!.sql).toMatch(/WITHOUT ROWID$/);
    // A day takes its entries, its old rows and its sessions with it, and leaves the task.
    db.prepare(`DELETE FROM days WHERE id = ?`).run(mon);
    for (const table of ['priorities', 'priorities_v1', 'sessions']) expect(countRows(db, table), table).toBe(0);
    expect(countRows(db, 'items')).toBe(1);
    db.close();
  });

  it('keeps a task named, out of a lane when it repeats, and one entry per task and day in one place each', () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db).id;
    const insert = db.prepare(`INSERT INTO items (user_id, uid, title, weekdays, lane, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, 1000, ?)`);
    const report = Number(insert.run(user, 'task00000001', 'Report', null, 'next', null).lastInsertRowid);
    const slides = Number(insert.run(user, 'task00000002', 'Slides', null, null, null).lastInsertRowid);
    expect(() => insert.run(user, 'task00000001', 'Other', null, null, null)).toThrow(/UNIQUE/);
    expect(() => insert.run(user, 'task00000003', '', null, null, null)).toThrow(/CHECK/);
    // Done is worked out from the ticks, never a lane.
    expect(() => insert.run(user, 'task00000003', 'Report', null, 'done', null)).toThrow(/CHECK/);
    // A recurring priority is never in a lane, and a tombstone is a one-off in none.
    expect(() => insert.run(user, 'task00000003', 'Queue', 31, 'next', null)).toThrow(/CHECK/);
    expect(() => insert.run(user, 'task00000003', 'Queue', 0, null, null)).toThrow(/CHECK/);
    expect(() => insert.run(user, 'task00000003', 'Gone', null, 'later', 5000)).toThrow(/CHECK/);
    expect(() => insert.run(user, 'task00000003', 'Gone', 31, null, 5000)).toThrow(/CHECK/);
    insert.run(user, 'task00000003', 'Gone', null, null, 5000);

    const day = Number(db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2026-09-07', 1000)`).run(user).lastInsertRowid);
    const entry = db.prepare(`INSERT INTO priorities (day_id, item_id, position, added_at) VALUES (?, ?, ?, 1000)`);
    entry.run(day, report, 1);
    expect(() => entry.run(day, report, 2)).toThrow(/UNIQUE/);
    expect(() => entry.run(day, slides, 1)).toThrow(/UNIQUE/);
    expect(() => entry.run(day, 999, 2)).toThrow(/FOREIGN KEY/);
    entry.run(day, slides, 3);
    expect(db.prepare(`SELECT done FROM priorities WHERE item_id = ?`).get(slides)).toEqual({ done: 0 });
    db.close();
  });

  it("makes each card a task under its uid, in its lane, and its rows' entries name it whatever they read", () => {
    const { db, day, row, card, session } = before();
    card('card00000001', 'Write the report', 'next', 1, { category: 'cat000000001', createdAt: 700 });
    const mon = day('2026-09-07');
    const tue = day('2026-09-08');
    row(mon, 1, 'Draft report', { uid: 'row000000001', card: 'card00000001', category: 'cat000000002', done: true });
    row(tue, 2, 'Report', { uid: 'row000000002', card: 'card00000001', addedAt: 3000 });
    const s = session(mon, 'row000000001');

    migrate(db);
    expect(item(db, 'card00000001')).toMatchObject({
      title: 'Write the report',
      category_uid: 'cat000000001',
      weekdays: null,
      lane: 'next',
      position: 1,
      created_at: 700,
      archived_at: null,
      deleted_at: null,
      legacy_done_at: null,
      legacy_untouched: 0,
      legacy_uid: null,
    });
    expect(list(db, mon)).toEqual([{ uid: 'card00000001', position: 1, done: 1, added_at: 2000 }]);
    expect(list(db, tue)).toEqual([{ uid: 'card00000001', position: 2, done: 0, added_at: 3000 }]);
    expect(linkOf(db, s).uid).toBe('card00000001');
    expect(countRows(db, 'items')).toBe(1);
    db.close();
  });

  it('opens the latest entry of a card the board put back in Later or Next after its tick, and keeps the tick in the old rows', () => {
    const { db, day, row, card } = before();
    // Unticked on the board: out of Done with done_at cleared, its row still ticked.
    card('card00000001', 'Unticked', 'next', 1);
    card('card00000002', 'Unticked, then parked', 'later', 1);
    card('done00000001', 'Done', 'done', 0, { doneAt: 5000 });
    const mon = day('2026-09-07');
    const tue = day('2026-09-08');
    row(mon, 1, 'Unticked', { card: 'card00000001', done: true });
    row(tue, 1, 'Unticked', { card: 'card00000001', done: true });
    row(tue, 2, 'Unticked, then parked', { card: 'card00000002', done: true });
    row(tue, 3, 'Done', { card: 'done00000001', done: true });

    migrate(db);
    expect(item(db, 'card00000001')).toMatchObject({ lane: 'next', position: 1 });
    expect(item(db, 'card00000002')).toMatchObject({ lane: 'later', position: 1 });
    // Only the latest tick goes; an earlier day's stays, and so does a Done card's.
    expect(list(db, mon)).toEqual([{ uid: 'card00000001', position: 1, done: 1, added_at: 2000 }]);
    expect(list(db, tue)).toEqual([
      { uid: 'card00000001', position: 1, done: 0, added_at: 2000 },
      { uid: 'card00000002', position: 2, done: 0, added_at: 2000 },
      { uid: 'done00000001', position: 3, done: 1, added_at: 2000 },
    ]);
    expect(db.prepare(`SELECT done FROM priorities_v1 WHERE day_id = ? ORDER BY position`).pluck().all(tue)).toEqual([1, 1, 1]);
    db.close();
  });

  it('keeps the tick of a card in Later or Next that a later list holds, even emptied there', () => {
    const { db, day, row, card } = before();
    // Done, pulled onto a later list, which moved it to Next, and emptied there.
    card('card00000001', 'Migrate the wiki', 'next', 1);
    const mon = day('2026-09-07');
    const tue = day('2026-09-08');
    row(mon, 1, 'Migrate the wiki', { card: 'card00000001', done: true });
    row(tue, 1, '', { uid: 'empty0000001', card: 'card00000001' });

    migrate(db);
    expect(list(db, mon)).toEqual([{ uid: 'card00000001', position: 1, done: 1, added_at: 2000 }]);
    db.close();
  });

  it('takes a held card out of the lanes, and archives one no written row names', () => {
    const { db, day, row, card, session } = before();
    card('held00000001', 'Held, written before', 'next', 1, { untouched: true });
    card('held00000002', 'Held, never written', 'next', 2, { untouched: true });
    card('card00000003', 'Handled', 'next', 3);
    card('card00000004', 'Made by a save', 'next', 4, { untouched: true });
    const mon = day('2026-09-07');
    const tue = day('2026-09-08');
    row(mon, 1, 'Held, written before', { card: 'held00000001' });
    row(tue, 1, '', { uid: 'empty0000001', card: 'held00000001' });
    row(tue, 2, '', { uid: 'empty0000002', card: 'held00000002' });
    row(tue, 3, 'Made by a save', { uid: 'row000000003', card: 'card00000004' });
    const onHeld = session(tue, 'empty0000001');
    const onNeverWritten = session(tue, 'empty0000002');

    migrate(db);
    expect(item(db, 'held00000001')).toMatchObject({ lane: null, position: 0, archived_at: null, legacy_untouched: 1 });
    expect(item(db, 'held00000002')).toMatchObject({ title: 'Held, never written', lane: null, position: 0, archived_at: NOW });
    // Next closes up over the two.
    expect(item(db, 'card00000003')).toMatchObject({ lane: 'next', position: 1, archived_at: null });
    expect(item(db, 'card00000004')).toMatchObject({ lane: 'next', position: 2, archived_at: null });
    // Emptied rows make no entry, and their sessions stay with the card.
    expect(list(db, mon)).toEqual([{ uid: 'held00000001', position: 1, done: 0, added_at: 2000 }]);
    expect(list(db, tue)).toEqual([{ uid: 'card00000004', position: 3, done: 0, added_at: 2000 }]);
    expect(linkOf(db, onHeld).uid).toBe('held00000001');
    expect(linkOf(db, onNeverWritten).uid).toBe('held00000002');
    db.close();
  });

  it('takes Done cards out of the lanes, keeps done_at and untouched, and archives one whose ticked row was removed or emptied after an open one', () => {
    const { db, day, row, card } = before();
    card('later0000001', 'Later', 'later', 1);
    card('done00000001', 'Done', 'done', 0, { doneAt: 5000, untouched: true });
    card('done00000002', 'Done, row removed', 'done', 0, { doneAt: 6000 });
    card('done00000003', 'Done, row emptied', 'done', 0, { doneAt: 7000 });
    const mon = day('2026-09-07');
    const tue = day('2026-09-08');
    row(mon, 1, 'Done', { card: 'done00000001', done: true });
    row(mon, 2, 'Done, row emptied', { card: 'done00000003' });
    row(tue, 1, '', { uid: 'empty0000001', card: 'done00000003' });

    migrate(db);
    expect(item(db, 'later0000001')).toMatchObject({ lane: 'later', position: 1, archived_at: null, legacy_done_at: null, legacy_untouched: 0 });
    expect(item(db, 'done00000001')).toMatchObject({ lane: null, position: 0, archived_at: null, legacy_done_at: 5000, legacy_untouched: 1 });
    expect(item(db, 'done00000002')).toMatchObject({ lane: null, position: 0, archived_at: NOW, legacy_done_at: 6000, legacy_untouched: 0 });
    // Its latest entry is open: it would show as left open.
    expect(item(db, 'done00000003')).toMatchObject({ lane: null, position: 0, archived_at: NOW, legacy_done_at: 7000 });
    expect(list(db, mon)).toEqual([
      { uid: 'done00000001', position: 1, done: 1, added_at: 2000 },
      { uid: 'done00000003', position: 2, done: 0, added_at: 2000 },
    ]);
    db.close();
  });

  it('gives a card or recurring priority deleted before an archived task under its uid, named from its latest row', () => {
    const { db, day, row, session } = before();
    const mon = day('2026-09-07');
    const wed = day('2026-09-09');
    const nextMon = day('2026-09-14');
    row(mon, 1, 'Old name', { uid: 'row000000001', card: 'gone00000001', category: 'cat000000001', addedAt: 1500 });
    row(wed, 1, '  New name ', { uid: 'row000000002', card: 'gone00000001', category: 'cat000000002' });
    row(mon, 2, 'Weekly call', { uid: 'row000000003', recurring: 'rgone0000001' });
    row(wed, 2, 'Weekly call', { uid: 'row000000004', recurring: 'rgone0000001', done: true });
    row(nextMon, 2, 'Weekly sync', { uid: 'row000000005', recurring: 'rgone0000001', category: 'cat000000003' });
    // A card deleted before, with no written row to name a task from: its sessions keep the row's category.
    row(nextMon, 1, '', { uid: 'empty0000001', card: 'gone00000002', category: 'cat000000004' });
    const s = session(nextMon, 'empty0000001');

    migrate(db);
    expect(item(db, 'gone00000001')).toMatchObject({
      title: 'New name',
      category_uid: 'cat000000002',
      weekdays: null,
      lane: null,
      position: 0,
      created_at: 1500,
      archived_at: NOW,
      legacy_uid: null,
    });
    // Its weekdays are the ones its rows fell on: Monday and Wednesday.
    expect(item(db, 'rgone0000001')).toMatchObject({ title: 'Weekly sync', category_uid: 'cat000000003', weekdays: 0b101, lane: null, archived_at: NOW });
    expect(item(db, 'gone00000002')).toBeUndefined();
    expect(list(db, wed)).toEqual([
      { uid: 'gone00000001', position: 1, done: 0, added_at: 2000 },
      { uid: 'rgone0000001', position: 2, done: 1, added_at: 2000 },
    ]);
    expect(linkOf(db, s)).toEqual({ uid: null, category_uid: 'cat000000004' });
    db.close();
  });

  it('makes each recurring priority a task with its weekdays, in the order they were made', () => {
    const { db, day, row, routine, session } = before();
    routine('rcur00000001', 'Monitor the queue', 0b11111, 'cat000000001');
    routine('rcur00000002', 'Follow-ups', 0b10101);
    const mon = day('2026-09-07');
    const tue = day('2026-09-08');
    row(mon, 4, 'Monitor the queue', { uid: 'row000000001', recurring: 'rcur00000001', done: true });
    row(tue, 4, '', { uid: 'empty0000001', recurring: 'rcur00000001' });
    const s = session(tue, 'empty0000001');

    migrate(db);
    const queue = item(db, 'rcur00000001')!;
    const followUps = item(db, 'rcur00000002')!;
    expect(queue).toMatchObject({
      title: 'Monitor the queue',
      category_uid: 'cat000000001',
      weekdays: 0b11111,
      lane: null,
      position: 0,
      created_at: NOW,
      archived_at: null,
      legacy_untouched: null,
      legacy_uid: null,
    });
    expect(followUps).toMatchObject({ title: 'Follow-ups', weekdays: 0b10101, created_at: NOW });
    expect(queue.id).toBeLessThan(followUps.id);
    expect(list(db, mon)).toEqual([{ uid: 'rcur00000001', position: 4, done: 1, added_at: 2000 }]);
    expect(list(db, tue)).toEqual([]);
    expect(linkOf(db, s).uid).toBe('rcur00000001');
    db.close();
  });

  it('gives a task whose uid another task holds a fresh one, keeps the old one, and its sessions follow', () => {
    const { db, day, row, card, routine, session } = before();
    card('same00000001', 'Report', 'next', 1);
    routine('same00000001', 'Monitor the queue', 31);
    routine('rcur00000001', 'Follow-ups', 31);
    const mon = day('2026-09-07');
    row(mon, 1, 'Monitor the queue', { uid: 'row000000001', recurring: 'same00000001' });
    // A card deleted before under a recurring priority's uid, and a typed row under the card's.
    row(mon, 2, 'Old card', { uid: 'row000000002', card: 'rcur00000001' });
    row(mon, 3, 'Typed', { uid: 'same00000001' });
    const sessions = [session(mon, 'row000000001'), session(mon, 'row000000002'), session(mon, 'same00000001')];

    migrate(db);
    // Cards keep theirs, and so does a recurring priority no card holds.
    expect(item(db, 'same00000001')).toMatchObject({ title: 'Report', legacy_uid: null });
    expect(item(db, 'rcur00000001')).toMatchObject({ title: 'Follow-ups', legacy_uid: null });
    const [queue, typed] = replacing(db, 'same00000001');
    const [oldCard] = replacing(db, 'rcur00000001');
    expect(queue).toMatchObject({ title: 'Monitor the queue', weekdays: 31, archived_at: null });
    expect(typed).toMatchObject({ title: 'Typed', weekdays: null, archived_at: null });
    expect(oldCard).toMatchObject({ title: 'Old card', weekdays: null, archived_at: NOW });
    const fresh = [queue!.uid, oldCard!.uid, typed!.uid];
    for (const uid of fresh) expect(uid).toMatch(FRESH);
    expect(new Set([...fresh, 'same00000001', 'rcur00000001']).size).toBe(5);
    expect(list(db, mon).map((e) => e.uid)).toEqual(fresh);
    expect(sessions.map((s) => linkOf(db, s).uid)).toEqual(fresh);
    db.close();
  });

  it("makes one entry of a card's two rows on one day, at the first one's place, ticked when either is", () => {
    const { db, day, row, card, session } = before();
    card('card00000001', 'Report', 'done', 0, { doneAt: 3000 });
    const mon = day('2026-09-07');
    row(mon, 1, 'Report', { uid: 'row000000001', card: 'card00000001', addedAt: 2000 });
    row(mon, 2, 'Slides', { uid: 'row000000002' });
    row(mon, 3, 'Report again', { uid: 'row000000003', card: 'card00000001', done: true, addedAt: 2500 });
    const sessions = [session(mon, 'row000000001'), session(mon, 'row000000003')];

    migrate(db);
    expect(list(db, mon)).toEqual([
      { uid: 'card00000001', position: 1, done: 1, added_at: 2000 },
      { uid: 'row000000002', position: 2, done: 0, added_at: 2000 },
    ]);
    expect(sessions.map((s) => linkOf(db, s).uid)).toEqual(['card00000001', 'card00000001']);
    db.close();
  });

  it('makes one task of the rows of one text while each comes at most 14 days after an open one', () => {
    const { db, day, row } = before();
    const sep1 = day('2026-09-01');
    const sep15 = day('2026-09-15');
    const sep30 = day('2026-09-30');
    row(sep1, 1, 'Email Bob', { uid: 'email0000001', category: 'cat000000001', addedAt: 1100 });
    // 14 days later, typed differently: the same task, under its latest wording.
    row(sep15, 1, ' email bob ', { uid: 'email0000002', category: 'cat000000002' });
    // 15 days after that: another.
    row(sep30, 1, 'Email Bob', { uid: 'email0000003' });
    // A tick ends the chain, and the same text twice on one day is two tasks.
    row(sep1, 2, 'Call the bank', { uid: 'bank00000001', done: true });
    row(sep15, 2, 'Call the bank', { uid: 'bank00000002' });
    row(sep15, 3, 'Call the bank', { uid: 'bank00000003' });

    migrate(db);
    expect(item(db, 'email0000001')).toMatchObject({ title: 'email bob', category_uid: 'cat000000002', lane: null, created_at: 1100, archived_at: null });
    expect(item(db, 'email0000002')).toBeUndefined();
    expect(item(db, 'email0000003')).toMatchObject({ title: 'Email Bob', category_uid: null });
    expect(list(db, sep15).map((e) => e.uid)).toEqual(['email0000001', 'bank00000002', 'bank00000003']);
    expect(list(db, sep1).map((e) => e.uid)).toEqual(['email0000001', 'bank00000001']);
    expect(countRows(db, 'items')).toBe(5);
    db.close();
  });

  it('joins the open chain whose latest row is on the latest day, then the higher on its list, on every run', () => {
    const grouped = () => {
      const { db, day, row } = before();
      const mon = day('2026-09-07');
      const tue = day('2026-09-08');
      const wed = day('2026-09-09');
      row(mon, 1, 'Report', { uid: 'first0000001' });
      row(mon, 2, 'Report', { uid: 'second000001' });
      row(tue, 1, 'Report', { uid: 'third0000001' });
      row(wed, 2, 'Report', { uid: 'fourth000001' });
      migrate(db);
      const entries = db
        .prepare(
          `SELECT d.date, p.position, i.uid FROM priorities p JOIN days d ON d.id = p.day_id JOIN items i ON i.id = p.item_id ORDER BY d.date, p.position`,
        )
        .all();
      db.close();
      return entries;
    };
    const once = grouped();
    expect(once).toEqual([
      { date: '2026-09-07', position: 1, uid: 'first0000001' },
      { date: '2026-09-07', position: 2, uid: 'second000001' },
      // Both open chains end on Monday: the higher row's.
      { date: '2026-09-08', position: 1, uid: 'first0000001' },
      // That one ends on Tuesday now, the other on Monday.
      { date: '2026-09-09', position: 2, uid: 'first0000001' },
    ]);
    expect(grouped()).toEqual(once);
  });

  it("folds into a card the open chain its first written row continues, and the chain's sessions follow", () => {
    const { db, day, row, card, session } = before();
    card('card00000001', 'Fix the flaky test', 'next', 1, { category: 'cat000000001' });
    card('card00000002', 'Slides', 'next', 2);
    const mon = day('2026-09-07');
    const tue = day('2026-09-08');
    // Typed with the board off; the daily sweep gave Tuesday's carried row a card.
    row(mon, 1, 'flaky test', { uid: 'row000000001', category: 'cat000000002' });
    row(mon, 2, 'Flaky test', { uid: 'row000000002' });
    // A tick ends a chain.
    row(mon, 3, 'Slides', { uid: 'row000000003', done: true });
    row(tue, 1, 'Flaky test', { uid: 'row000000004', card: 'card00000001' });
    row(tue, 2, 'Slides', { uid: 'row000000005', card: 'card00000002' });
    // The chain's uid is free again.
    row(tue, 3, 'Other', { uid: 'row000000001' });
    const s = session(mon, 'row000000001');

    migrate(db);
    // Of the two open chains, the higher on Monday's list, as a row joins one.
    expect(list(db, mon).map((e) => e.uid)).toEqual(['card00000001', 'row000000002', 'row000000003']);
    expect(list(db, tue).map((e) => e.uid)).toEqual(['card00000001', 'card00000002', 'row000000001']);
    expect(item(db, 'card00000001')).toMatchObject({ title: 'Fix the flaky test', category_uid: 'cat000000001', lane: 'next' });
    expect(item(db, 'row000000001')).toMatchObject({ title: 'Other', legacy_uid: null });
    expect(linkOf(db, s).uid).toBe('card00000001');
    expect(countRows(db, 'items')).toBe(5);
    db.close();
  });

  it('links each session to the task of its row on its own day, and leaves the rest unplanned', () => {
    const { db, day, row, session } = before();
    const mon = day('2026-09-07');
    const tue = day('2026-09-08');
    row(mon, 1, 'Report', { uid: 'row000000001' });
    // A row's uid is unique only within its day's list.
    row(tue, 1, 'Slides', { uid: 'row000000001' });
    row(tue, 2, '', { uid: 'empty0000001', category: 'cat000000001' });
    const onMon = session(mon, 'row000000001');
    const onTue = session(tue, 'row000000001');
    const cancelled = session(mon, 'row000000001', { status: 'cancelled' });
    // The server copied the category of a removed row onto its sessions.
    const removed = session(mon, 'gone00000001', { category: 'cat000000002' });
    const emptied = session(tue, 'empty0000001');
    const emptiedOwn = session(tue, 'empty0000001', { category: 'cat000000003' });
    const unplanned = session(tue, null);

    migrate(db);
    const [slides] = replacing(db, 'row000000001');
    expect(linkOf(db, onMon)).toEqual({ uid: 'row000000001', category_uid: null });
    expect(linkOf(db, onTue)).toEqual({ uid: slides!.uid, category_uid: null });
    expect(linkOf(db, cancelled)).toEqual({ uid: null, category_uid: null });
    expect(db.prepare(`SELECT priority_uid FROM sessions WHERE id = ?`).get(cancelled)).toEqual({ priority_uid: 'row000000001' });
    expect(linkOf(db, removed)).toEqual({ uid: null, category_uid: 'cat000000002' });
    // An emptied row with no card makes no task: its sessions count under its category, or their own.
    expect(linkOf(db, emptied)).toEqual({ uid: null, category_uid: 'cat000000001' });
    expect(linkOf(db, emptiedOwn)).toEqual({ uid: null, category_uid: 'cat000000003' });
    expect(linkOf(db, unplanned)).toEqual({ uid: null, category_uid: null });
    db.close();
  });

  it("leaves padded rows out, and keeps each entry at its row's place", () => {
    const { db, day, row } = before();
    const mon = day('2026-09-07', 1234);
    row(mon, 1, '', { uid: null });
    row(mon, 2, 'Report', { uid: 'row000000001' });
    row(mon, 3, '', { uid: null });
    // An added time the row lacks is its day's.
    row(mon, 4, 'Slides', { uid: 'row000000002', addedAt: null });

    migrate(db);
    expect(list(db, mon)).toEqual([
      { uid: 'row000000001', position: 2, done: 0, added_at: 2000 },
      { uid: 'row000000002', position: 4, done: 0, added_at: 1234 },
    ]);
    expect(countRows(db, 'items')).toBe(2);
    db.close();
  });

  it('lets a user go with all of it, and refuses to delete a task a day or a session names', () => {
    const { db, user, day, row, card, routine, session } = before();
    const other = addSam(db);
    card('card00000001', 'Report', 'next', 1);
    card('held00000001', 'Held', 'next', 2, { untouched: true });
    routine('rcur00000001', 'Monitor the queue', 31);
    const mon = day('2026-09-07');
    row(mon, 1, 'Report', { uid: 'row000000001', card: 'card00000001' });
    row(mon, 2, '', { uid: 'empty0000001', card: 'held00000001' });
    row(mon, 3, 'Monitor the queue', { uid: 'row000000003', recurring: 'rcur00000001' });
    row(mon, 4, 'Typed', { uid: 'row000000004' });
    session(mon, 'row000000001');
    session(mon, 'empty0000001');
    // Uids are only unique per user.
    db.prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at) VALUES (?, 'card00000001', 'Theirs', 'later', 1, 500)`).run(other);

    migrate(db);
    const remove = db.prepare(`DELETE FROM items WHERE user_id = ? AND uid = ?`);
    expect(() => remove.run(user, 'card00000001')).toThrow(/FOREIGN KEY/);
    expect(() => remove.run(user, 'held00000001')).toThrow(/FOREIGN KEY/);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(user);
    for (const table of ['days', 'priorities', 'priorities_v1', 'sessions']) expect(countRows(db, table), table).toBe(0);
    expect(db.prepare(`SELECT user_id, uid, title FROM items`).all()).toEqual([{ user_id: other, uid: 'card00000001', title: 'Theirs' }]);
    db.close();
  });
});

describe("the README's script for switching from none to local", () => {
  // README.md → "Switching modes later": run by hand to give the implicit user's data to the new
  // account. A table that gains a user_id column has to join it, or its rows stay with the old
  // user: still listed on the moved days, which find them by day_id, but refused by every
  // ownership check.
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  // `.bail on` is the sqlite3 shell's; exec() stops at the first error by itself.
  const sql = (/<<'SQL'\n([\s\S]*?)\nSQL\n/.exec(readme)?.[1] ?? '').replace(/^\..*\n/gm, '');

  it('moves every table that has a user_id, except sign-in sessions', () => {
    const db = openDatabase(':memory:');
    const rows = db.prepare(`SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table' AND c.name = 'user_id'`).all();
    // Sign-in sessions stay behind: the new account signs in for itself.
    const owned = (rows as { name: string }[]).map(({ name }) => name).filter((name) => name !== 'auth_sessions');
    const moved = [...sql.matchAll(/^UPDATE (\w+)/gm)].map(([, table]) => table);
    expect(moved.sort()).toEqual(owned.sort());
    db.close();
  });

  it("hands the old user's rows to the first local account on a migrated database, settings included", () => {
    const db = migratedTo(12);
    const old = ensureDefaultUser(db);
    const admin = Number(
      db.prepare(`INSERT INTO users (kind, username, display_name, is_admin, created_at) VALUES ('local', 'admin', 'Admin', 1, 1)`).run().lastInsertRowid,
    );
    const day = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2026-09-01', 1000)`).run(old.id).lastInsertRowid;
    db.prepare(`INSERT INTO priorities (day_id, position, text, uid, added_at, card_uid) VALUES (?, 1, 'Report', 'row000000001', 1000, 'card00000001')`).run(
      day,
    );
    db.prepare(
      `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status, priority_uid)
       VALUES (?, ?, '', 600, 1000, 1600, 'completed', 'row000000001')`,
    ).run(day, old.id);
    db.prepare(`INSERT INTO breaks (day_id, user_id, planned_seconds, started_at, ended_at) VALUES (?, ?, 300, 1600, 1900)`).run(day, old.id);
    db.prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at) VALUES (?, 'card00000001', 'Report', 'later', 1, 1000)`).run(old.id);
    db.prepare(`INSERT INTO categories (user_id, uid, name, color) VALUES (?, 'cat000000001', 'Tickets', 'blue')`).run(old.id);
    db.prepare(`INSERT INTO recurring (user_id, uid, title, weekdays) VALUES (?, 'rcur00000001', 'Monitor the queue', 31)`).run(old.id);
    const settings = db.prepare(`INSERT INTO settings (user_id, json) VALUES (?, ?)`);
    settings.run(old.id, '{"from":"none"}');
    settings.run(admin, '{"from":"admin"}');
    migrate(db);

    db.exec(sql);

    for (const table of ['days', 'sessions', 'breaks', 'items', 'categories', 'settings']) {
      expect(db.prepare(`SELECT DISTINCT user_id FROM ${table}`).all(), table).toEqual([{ user_id: admin }]);
    }
    expect(countRows(db, 'items')).toBe(2);
    // A day's list, old rows included, goes with its day.
    for (const table of ['priorities', 'priorities_v1']) {
      expect(db.prepare(`SELECT d.user_id FROM ${table} p JOIN days d ON d.id = p.day_id`).all(), table).toEqual([{ user_id: admin }]);
    }
    expect(db.prepare(`SELECT json FROM settings`).get()).toEqual({ json: '{"from":"none"}' });
    db.close();
  });
});
