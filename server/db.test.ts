import fs from 'node:fs';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, ensureDefaultUser, migrate, openDatabase } from './db.js';
import { countRows } from './dev/harness.js';

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
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, 2);
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

    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);

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
    const other = Number(db.prepare(`INSERT INTO users (kind, username, display_name, created_at) VALUES ('local', 'sam', 'Sam', 1)`).run().lastInsertRowid);
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

describe('migration 9: priority links', () => {
  it("adds each row's card, recurring priority and category, none on the rows already there, and indexes the cards", () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, 8);
    const user = ensureDefaultUser(db);
    const day = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2026-09-01', 1000)`).run(user.id).lastInsertRowid;
    db.prepare(`INSERT INTO priorities (day_id, position, text, done, uid, added_at) VALUES (?, 1, 'Report', 0, 'abcdef123456', 1000)`).run(day);

    migrate(db);
    expect(db.prepare(`SELECT text, card_uid, recurring_uid, category_uid FROM priorities`).all()).toEqual([
      { text: 'Report', card_uid: null, recurring_uid: null, category_uid: null },
    ]);
    // A card's rows across days are looked up by card; rows with none stay out of the index.
    const index = db.prepare(`SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = 'priorities_card'`).get() as {
      tbl_name: string;
      sql: string;
    };
    expect(index.tbl_name).toBe('priorities');
    expect(index.sql).toMatch(/\(card_uid\) WHERE card_uid IS NOT NULL$/);
    db.close();
  });
});

describe('migration 10: board cards', () => {
  it('keeps one card per uid for each user, in Later, Next or Done, and goes with its user', () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    const other = Number(db.prepare(`INSERT INTO users (kind, username, display_name, created_at) VALUES ('local', 'sam', 'Sam', 1)`).run().lastInsertRowid);
    const insert = db.prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at) VALUES (?, ?, 'Report', ?, 1, 1000)`);
    insert.run(user.id, 'card00000001', 'later');
    expect(db.prepare(`SELECT untouched, done_at FROM board_cards`).get()).toEqual({ untouched: 0, done_at: null });
    expect(() => insert.run(user.id, 'card00000001', 'next')).toThrow(/UNIQUE/);
    // In progress is today's rows, never a lane.
    expect(() => insert.run(user.id, 'card00000002', 'progress')).toThrow(/CHECK/);
    // Uids are only unique per user.
    insert.run(other, 'card00000001', 'done');
    db.prepare(`DELETE FROM users WHERE id = ?`).run(other);
    expect(countRows(db, 'board_cards')).toBe(1);
    db.close();
  });
});

describe('migration 11: categories', () => {
  it('keeps one category per uid for each user, goes with its user, and gives sessions and cards none', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, 10);
    const user = ensureDefaultUser(db);
    const day = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2026-09-01', 1000)`).run(user.id).lastInsertRowid;
    db.prepare(
      `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status) VALUES (?, ?, 'x', 600, 500, 1100, 'completed')`,
    ).run(day, user.id);
    db.prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at) VALUES (?, 'card00000001', 'Report', 'later', 1, 1000)`).run(user.id);

    migrate(db);
    expect(db.prepare(`SELECT category_uid FROM sessions`).all()).toEqual([{ category_uid: null }]);
    expect(db.prepare(`SELECT category_uid FROM board_cards`).all()).toEqual([{ category_uid: null }]);
    const other = Number(db.prepare(`INSERT INTO users (kind, username, display_name, created_at) VALUES ('local', 'sam', 'Sam', 1)`).run().lastInsertRowid);
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

describe('migration 12: recurring priorities', () => {
  it('keeps one recurring priority per uid for each user, on at least one weekday, and goes with its user', () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    const other = Number(db.prepare(`INSERT INTO users (kind, username, display_name, created_at) VALUES ('local', 'sam', 'Sam', 1)`).run().lastInsertRowid);
    const insert = db.prepare(`INSERT INTO recurring (user_id, uid, title, weekdays) VALUES (?, ?, 'Monitor the queue', ?)`);
    insert.run(user.id, 'rcur00000001', 0b0011111);
    expect(db.prepare(`SELECT category_uid FROM recurring`).get()).toEqual({ category_uid: null });
    expect(() => insert.run(user.id, 'rcur00000001', 1)).toThrow(/UNIQUE/);
    // A mask of the seven weekdays, bit 0 for Monday, with at least one of them set.
    expect(() => insert.run(user.id, 'rcur00000002', 0)).toThrow(/CHECK/);
    expect(() => insert.run(user.id, 'rcur00000002', 0b10000000)).toThrow(/CHECK/);
    insert.run(user.id, 'rcur00000002', 0b1111111);
    // Uids are only unique per user.
    insert.run(other, 'rcur00000001', 1);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(other);
    expect(countRows(db, 'recurring')).toBe(2);
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

  it("hands the old user's rows to the first local account, settings included", () => {
    const db = openDatabase(':memory:');
    const old = ensureDefaultUser(db);
    const admin = Number(
      db.prepare(`INSERT INTO users (kind, username, display_name, is_admin, created_at) VALUES ('local', 'admin', 'Admin', 1, 1)`).run().lastInsertRowid,
    );
    const day = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, '2026-09-01', 1000)`).run(old.id).lastInsertRowid;
    db.prepare(
      `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status) VALUES (?, ?, '', 600, 1000, 1600, 'completed')`,
    ).run(day, old.id);
    db.prepare(`INSERT INTO breaks (day_id, user_id, planned_seconds, started_at, ended_at) VALUES (?, ?, 300, 1600, 1900)`).run(day, old.id);
    db.prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at) VALUES (?, 'card00000001', 'Report', 'later', 1, 1000)`).run(old.id);
    db.prepare(`INSERT INTO categories (user_id, uid, name, color) VALUES (?, 'cat000000001', 'Tickets', 'blue')`).run(old.id);
    db.prepare(`INSERT INTO recurring (user_id, uid, title, weekdays) VALUES (?, 'rcur00000001', 'Monitor the queue', 31)`).run(old.id);
    const settings = db.prepare(`INSERT INTO settings (user_id, json) VALUES (?, ?)`);
    settings.run(old.id, '{"from":"none"}');
    settings.run(admin, '{"from":"admin"}');

    db.exec(sql);

    for (const table of ['days', 'sessions', 'breaks', 'board_cards', 'categories', 'recurring', 'settings']) {
      expect(db.prepare(`SELECT user_id FROM ${table}`).all(), table).toEqual([{ user_id: admin }]);
    }
    expect(db.prepare(`SELECT json FROM settings`).get()).toEqual({ json: '{"from":"none"}' });
    db.close();
  });
});
