import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

// Append-only. Each entry runs once, in order, guarded by PRAGMA user_version.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('default','local','oidc')),
    username      TEXT UNIQUE,
    password_hash TEXT,
    oidc_sub      TEXT UNIQUE,
    display_name  TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE auth_sessions (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
  CREATE TABLE settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    json    TEXT NOT NULL
  );
  CREATE TABLE days (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, date)
  );
  CREATE TABLE punches (
    id       INTEGER PRIMARY KEY,
    day_id   INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    kind     TEXT NOT NULL CHECK (kind IN ('in','out')),
    at       INTEGER,
    UNIQUE (day_id, position)
  );
  CREATE TABLE priorities (
    id       INTEGER PRIMARY KEY,
    day_id   INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    text     TEXT NOT NULL DEFAULT '',
    done     INTEGER NOT NULL DEFAULT 0,
    UNIQUE (day_id, position)
  );
  CREATE TABLE sessions (
    id              INTEGER PRIMARY KEY,
    day_id          INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label           TEXT NOT NULL DEFAULT '',
    notes           TEXT NOT NULL DEFAULT '',
    planned_seconds INTEGER NOT NULL,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    status          TEXT NOT NULL CHECK (status IN ('running','completed','cancelled'))
  );
  CREATE INDEX sessions_day ON sessions(day_id);
  CREATE INDEX sessions_running ON sessions(user_id) WHERE status = 'running';
  `,
  // Per-day "overtime approved" flag: silences that day's clock-out alarm only.
  `ALTER TABLE days ADD COLUMN overtime_approved INTEGER NOT NULL DEFAULT 0;`,
  // Plan vs. actual: a stable id per priority so sessions can point at one after rows are
  // renumbered, when it was written, and the day's retrospective note / reviewed-at.
  `
  ALTER TABLE priorities ADD COLUMN uid TEXT;
  ALTER TABLE priorities ADD COLUMN added_at INTEGER;
  UPDATE priorities SET uid = lower(hex(randomblob(6))) WHERE uid IS NULL AND text <> '';
  UPDATE priorities SET added_at = (
    SELECT MIN(d.created_at, COALESCE((SELECT MIN(s.started_at) FROM sessions s WHERE s.day_id = d.id), d.created_at))
    FROM days d WHERE d.id = priorities.day_id
  ) WHERE added_at IS NULL AND text <> '';
  ALTER TABLE sessions ADD COLUMN priority_uid TEXT;
  ALTER TABLE days ADD COLUMN retro_note TEXT NOT NULL DEFAULT '';
  ALTER TABLE days ADD COLUMN retro_at INTEGER;
  `,
];

export function openDatabase(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** Runs pending migrations up to `upTo` (all of them by default; tests stop early). */
export function migrate(db: DB, upTo: number = MIGRATIONS.length): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < upTo; v++) {
    const sql = MIGRATIONS[v]!;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export interface UserRow {
  id: number;
  kind: 'default' | 'local' | 'oidc';
  username: string | null;
  password_hash: string | null;
  oidc_sub: string | null;
  display_name: string;
  is_admin: number;
  created_at: number;
}

/** In AUTH_MODE=none every request acts as this single user. */
export function ensureDefaultUser(db: DB): UserRow {
  const existing = db.prepare(`SELECT * FROM users WHERE kind = 'default'`).get() as UserRow | undefined;
  if (existing) return existing;
  const info = db.prepare(`INSERT INTO users (kind, display_name, is_admin, created_at) VALUES ('default', 'You', 1, ?)`).run(Date.now());
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid) as UserRow;
}
