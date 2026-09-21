import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, ensureDefaultUser, migrate, openDatabase } from './db.js';

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
