import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { oneItem } from './migrations/oneItem.js';

export type DB = Database.Database;

/** SQL, or a function for a change that needs code (a backfill), kept in `migrations/` and frozen like the SQL. */
export type Migration = string | ((db: DB) => void);

// Append-only. Each entry runs once, in order, in a transaction of its own, guarded by PRAGMA user_version.
export const MIGRATIONS: Migration[] = [
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
  // One running timer per user, in the schema. The handlers are synchronous so the API never
  // made two, but the timer bar, GET /sessions/running and the prune guard all assume it.
  `
  DROP INDEX sessions_running;
  CREATE UNIQUE INDEX sessions_running ON sessions(user_id) WHERE status = 'running';
  `,
  // Pause: a paused session stays 'running' (one per user, the bar, the prune guard) with
  // paused_at set; paused_seconds is the total of the pauses that have already ended.
  `
  ALTER TABLE sessions ADD COLUMN paused_seconds INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN paused_at INTEGER;
  `,
  // A password someone else chose (an admin adding the account, or one the CLI generated) is
  // temporary: until the user sets their own, only the password change is open to them.
  `ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;`,
  // A day's own work-day length in minutes (a half day); null is the user's usual one.
  `ALTER TABLE days ADD COLUMN work_minutes INTEGER;`,
  // Breaks between focus sessions, logged with the day. ended_at is the planned end from the
  // start and moves back when a break is ended early, so nothing has to finish a break that
  // runs out: it is running while ended_at is ahead of now.
  `
  CREATE TABLE breaks (
    id              INTEGER PRIMARY KEY,
    day_id          INTEGER NOT NULL REFERENCES days(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    planned_seconds INTEGER NOT NULL,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER NOT NULL
  );
  CREATE INDEX breaks_day ON breaks(day_id);
  CREATE INDEX breaks_user_end ON breaks(user_id, ended_at);
  `,
  // Each day's row keeps its own uid; these tie the rows of one task across days: the board card
  // it is on, the recurring priority it was added from, the category it counts under. Soft links,
  // checked for shape only, like sessions.priority_uid. A card's rows are looked up by card.
  `
  ALTER TABLE priorities ADD COLUMN card_uid TEXT;
  ALTER TABLE priorities ADD COLUMN recurring_uid TEXT;
  ALTER TABLE priorities ADD COLUMN category_uid TEXT;
  CREATE INDEX priorities_card ON priorities(card_uid) WHERE card_uid IS NOT NULL;
  `,
  // Board cards. Rows point at a card by its uid (priorities.card_uid); a card never shares a uid
  // with a row. In progress is never stored: it is today's open rows. Position is 1..n within
  // Later or Next, 0 in Done. untouched marks a card a priorities save made that the board has
  // not handled since, which goes when its row is removed. UNIQUE (user_id, uid) is the index
  // every lookup by user goes through.
  `
  CREATE TABLE board_cards (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uid        TEXT NOT NULL,
    title      TEXT NOT NULL,
    lane       TEXT NOT NULL CHECK (lane IN ('later','next','done')),
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    done_at    INTEGER,
    untouched  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, uid)
  );
  `,
  // Categories. A removed one is archived, never deleted, so past time keeps its name. Rows,
  // cards and sessions point at one by its uid, a soft link like the others. Names are unique
  // among a user's categories in the route, not here: a UNIQUE on the name would stop the
  // README's handover script on a name both accounts used. A session's own category is one
  // picked in the log, or its removed row's, which a priorities save copies onto it.
  `
  CREATE TABLE categories (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uid         TEXT NOT NULL,
    name        TEXT NOT NULL,
    color       TEXT NOT NULL,
    archived_at INTEGER,
    UNIQUE (user_id, uid)
  );
  ALTER TABLE sessions    ADD COLUMN category_uid TEXT;
  ALTER TABLE board_cards ADD COLUMN category_uid TEXT;
  `,
  // Recurring priorities. The rows one adds point at it by its uid (priorities.recurring_uid),
  // a soft link that outlives it: deleting one deletes the row here only. weekdays is a mask of
  // ISO weekdays, bit 0 for Monday to bit 6 for Sunday; the API speaks lists of 1..7. Nothing on
  // the server looks rows up by recurring_uid (the client works out the offer and the review),
  // so it has no index.
  `
  CREATE TABLE recurring (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uid          TEXT NOT NULL,
    title        TEXT NOT NULL,
    category_uid TEXT,
    weekdays     INTEGER NOT NULL CHECK (weekdays BETWEEN 1 AND 127),
    UNIQUE (user_id, uid)
  );
  `,
  // Each task stored once: a board card, a recurring priority or a priority typed on a day is a
  // row of `items`, and a day's list names the tasks on it. The old rows stay in priorities_v1.
  oneItem,
];

export function openDatabase(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // The seed and reset-password commands write to the same file while the server runs.
  const db = new Database(dbPath, { timeout: 5000 });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Runs pending migrations up to `upTo` (all of them by default; tests stop early). */
export function migrate(db: DB, upTo: number = MIGRATIONS.length): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < upTo; v++) {
    const step = MIGRATIONS[v]!;
    db.transaction(() => {
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export interface UserRow {
  id: number;
  /** The users table's CHECK. */
  kind: 'default' | 'local' | 'oidc';
  username: string | null;
  password_hash: string | null;
  oidc_sub: string | null;
  display_name: string;
  is_admin: number;
  created_at: number;
  must_change_password: number;
}

/**
 * The local account a typed name belongs to. Names match whatever their case ("Sam" is "sam");
 * an install from before that rule may hold both spellings, and there the exact one wins.
 */
export function findLocalUser(db: DB, username: string): UserRow | undefined {
  return db
    .prepare(`SELECT * FROM users WHERE kind = 'local' AND username = ? COLLATE NOCASE ORDER BY username = ? DESC, id LIMIT 1`)
    .get(username, username) as UserRow | undefined;
}

/** Whether a local account exists; none yet means the first visit is setup. */
export function hasLocalUser(db: DB): boolean {
  return (db.prepare(`SELECT EXISTS(SELECT 1 FROM users WHERE kind = 'local') AS found`).get() as { found: number }).found === 1;
}

/**
 * A new local account, or undefined when the name is taken. The check is part of the insert, so
 * two creates for one name can't both pass it, and it ignores case as sign-in does: "Sam" can't
 * be added beside "sam".
 */
export function insertLocalUser(
  db: DB,
  username: string,
  passwordHash: string,
  { isAdmin, mustChangePassword }: { isAdmin: boolean; mustChangePassword: boolean },
): UserRow | undefined {
  return db
    .prepare(
      `INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at, must_change_password)
       SELECT 'local', @username, @passwordHash, @username, @isAdmin, @now, @mustChangePassword
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = @username COLLATE NOCASE)
       RETURNING *`,
    )
    .get({ username, passwordHash, isAdmin: Number(isAdmin), mustChangePassword: Number(mustChangePassword), now: Date.now() }) as UserRow | undefined;
}

/** In AUTH_MODE=none every request acts as this single user. */
export function ensureDefaultUser(db: DB): UserRow {
  const existing = db.prepare(`SELECT * FROM users WHERE kind = 'default'`).get() as UserRow | undefined;
  return (
    existing ??
    (db.prepare(`INSERT INTO users (kind, display_name, is_admin, created_at) VALUES ('default', 'You', 1, ?) RETURNING *`).get(Date.now()) as UserRow)
  );
}
