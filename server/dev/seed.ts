import type { DB, UserRow } from '../db.js';
import { hashPassword } from '../auth/password.js';
import { addDays, addMonths, parseDateKey, startOfQuarter } from '../../shared/dates.js';

/**
 * Deterministic sample data for the dev DB and for API tests. Rows are written with plain
 * SQL because the API can only start a session "now"; past days need `started_at` in the
 * past. Everything here must satisfy the same invariants the routes enforce (see AGENTS.md):
 * punch positions 0..n with the last one odd, priority positions 1..n, `uid`/`added_at` only
 * on rows with text, every `priority_uid` resolving on its own day.
 */

export interface SeedOptions {
  userId: number;
  /** Local date key the seeded "today" is built around. */
  today: string;
  /** Epoch ms used for today's clock-in and any running timer. */
  now: number;
  /** Weekdays of history before `today`. */
  days?: number;
  /** Leave a timer running today. */
  running?: boolean;
  /** Also drop the user's settings and logins, not just their days. */
  fresh?: boolean;
}

export interface SeededPunch {
  position: number;
  kind: 'in' | 'out';
  at: number | null;
}

export interface SeededPriority {
  position: number;
  text: string;
  done: boolean;
  uid: string;
  addedAt: number;
}

export interface SeededSession {
  id: number;
  label: string;
  notes: string;
  plannedSeconds: number;
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'completed' | 'cancelled';
  priorityUid: string | null;
}

export interface SeededDay {
  date: string;
  /** Which template built the day; tests pick days by this. */
  kind: DayKind;
  createdAt: number;
  punches: SeededPunch[];
  priorities: SeededPriority[];
  sessions: SeededSession[];
  overtimeApproved: boolean;
  retroNote: string;
  retroAt: number | null;
}

export interface SeedManifest {
  today: string;
  /** Ascending by date; the last entry is `today`. */
  days: SeededDay[];
}

export type DayKind = 'normal' | 'extraPair' | 'overtime' | 'unreviewed' | 'noLunch' | 'today';

export const DEFAULT_HISTORY_DAYS = 10;
export const LOCAL_USERS = { admin: 'admin', member: 'sam', password: 'clockspan-dev' } as const;

const MIN = 60_000;

// ----- calendar helpers (the dev machine's zone, which is what the browser shows) -----

function at(key: string, hour: number, minute: number): number {
  const d = parseDateKey(key);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function isWeekend(key: string): boolean {
  const wd = parseDateKey(key).getDay();
  return wd === 0 || wd === 6;
}

/** Weekdays between `from` and the day before `key` inclusive, for --quarter. */
export function weekdaysSince(from: string, key: string): number {
  let n = 0;
  for (let cur = addDays(key, -1); cur >= from; cur = addDays(cur, -1)) if (!isWeekend(cur)) n++;
  return n;
}

/** First day of the calendar quarter `quartersBack` before the one holding `key`. */
export function quarterStart(key: string, quartersBack = 0): string {
  return addMonths(startOfQuarter(key), -3 * quartersBack);
}

/** The `n` weekdays before `key`, oldest first. */
export function weekdaysBefore(key: string, n: number): string[] {
  const out: string[] = [];
  let cur = key;
  while (out.length < n) {
    cur = addDays(cur, -1);
    if (!isWeekend(cur)) out.unshift(cur);
  }
  return out;
}

// mulberry32: enough randomness to make the days look different, fully repeatable.
function prng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: readonly T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const PRIORITY_TEXTS = [
  'Finish the Q3 expense report',
  'Reply to the vendor about the invoice',
  'Draft the release notes',
  'Fix the login timeout bug',
  "Review Sam's pull request",
  'Update the onboarding doc',
  'Call the bank about the card',
  'Plan next sprint',
  'Clean up the test fixtures',
  'Prep slides for Thursday',
  'Renew the domain',
  'File the timesheet',
];

const UNPLANNED_LABELS = ['Inbox', 'Helped Sam debug the deploy', 'Standup follow-ups', 'Support ticket that came in', 'Expense receipts'];

const RETRO_NOTES = [
  'Morning went to plan. The afternoon went to the vendor call.',
  'Two of three done. The bug took longer than the estimate.',
  'Kept getting pulled into chat. Tomorrow: chat closed until lunch.',
  'Started the hardest one first and it paid off.',
  'One done. Most of the day was meetings that were not on the list.',
  'Finished everything but stayed late to do it.',
];

function uidFor(dayIndex: number, position: number): string {
  // 12 lowercase hex chars, unique across the whole seed (uids only need to be unique per day,
  // but distinct values keep review rollups easy to read).
  return `${dayIndex.toString(16).padStart(4, '0')}${position.toString(16).padStart(2, '0')}`.padEnd(12, 'a');
}

interface Insert {
  db: DB;
  userId: number;
}

function insertDay(ctx: Insert, day: Omit<SeededDay, 'sessions'> & { sessions: Omit<SeededSession, 'id'>[] }): SeededDay {
  const { db, userId } = ctx;
  const info = db
    .prepare(`INSERT INTO days (user_id, date, created_at, overtime_approved, retro_note, retro_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, day.date, day.createdAt, day.overtimeApproved ? 1 : 0, day.retroNote, day.retroAt);
  const dayId = Number(info.lastInsertRowid);
  const punch = db.prepare(`INSERT INTO punches (day_id, position, kind, at) VALUES (?, ?, ?, ?)`);
  for (const p of day.punches) punch.run(dayId, p.position, p.kind, p.at);
  const prio = db.prepare(`INSERT INTO priorities (day_id, position, text, done, uid, added_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const p of day.priorities) prio.run(dayId, p.position, p.text, p.done ? 1 : 0, p.uid, p.addedAt);
  const sess = db.prepare(
    `INSERT INTO sessions (day_id, user_id, label, notes, planned_seconds, started_at, ended_at, status, priority_uid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const sessions: SeededSession[] = day.sessions.map((s) => {
    const r = sess.run(dayId, userId, s.label, s.notes, s.plannedSeconds, s.startedAt, s.endedAt, s.status, s.priorityUid);
    return { id: Number(r.lastInsertRowid), ...s };
  });
  return { ...day, sessions };
}

function punchRows(times: (number | null)[]): SeededPunch[] {
  return times.map((t, position) => ({ position, kind: position % 2 === 0 ? 'in' : 'out', at: t }));
}

function completed(label: string, startedAt: number, minutes: number, priorityUid: string | null, notes = ''): Omit<SeededSession, 'id'> {
  return { label, notes, plannedSeconds: minutes * 60, startedAt, endedAt: startedAt + minutes * MIN, status: 'completed', priorityUid };
}

/** Builds one past weekday. `index` counts from the oldest day; `kind` picks the template. */
function buildPastDay(
  date: string,
  index: number,
  kind: Exclude<DayKind, 'today'>,
  rand: () => number,
): Omit<SeededDay, 'sessions'> & { sessions: Omit<SeededSession, 'id'>[] } {
  const jitter = (spread: number) => Math.round((rand() - 0.5) * 2 * spread);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const texts = shuffle(PRIORITY_TEXTS, rand);

  const clockIn = at(date, 8, 30) + jitter(10) * MIN;
  const createdAt = clockIn - 4 * MIN;
  const lunchOut = at(date, 12, 15) + jitter(10) * MIN;
  const lunchIn = lunchOut + (30 + Math.max(0, jitter(5))) * MIN;
  const clockOut = at(date, 17, 0) + jitter(15) * MIN;

  const priority = (position: number, text: string, done: boolean, addedAt = createdAt): SeededPriority => ({
    position,
    text,
    done,
    uid: uidFor(index, position),
    addedAt,
  });

  const base = { date, kind, createdAt, overtimeApproved: false };

  if (kind === 'extraPair') {
    // An extra out/in pair in the afternoon (positions 3-4) pushes the clock out to position 5.
    const extraOut = at(date, 15, 0);
    const extraIn = extraOut + 20 * MIN;
    const priorities = [priority(1, texts[0]!, true), priority(2, texts[1]!, true), priority(3, texts[2]!, false)];
    const firstStart = clockIn + 15 * MIN;
    // Written after work started: the retrospective flags it as added mid-day.
    priorities.push(priority(4, 'Reply to the recruiter', true, firstStart + 90 * MIN));
    return {
      ...base,
      punches: punchRows([clockIn, lunchOut, lunchIn, extraOut, extraIn, clockOut + 10 * MIN]),
      priorities,
      sessions: [
        completed(texts[0]!, firstStart, 25, priorities[0]!.uid),
        completed(texts[1]!, firstStart + 45 * MIN, 50, priorities[1]!.uid, 'Second pass after the review comments.'),
        completed('Reply to the recruiter', lunchIn + 20 * MIN, 25, priorities[3]!.uid),
        completed(pick(UNPLANNED_LABELS), extraIn + 15 * MIN, 25, null),
      ],
      retroNote: pick(RETRO_NOTES),
      retroAt: clockOut + 15 * MIN,
    };
  }

  if (kind === 'overtime') {
    const earlyIn = at(date, 8, 15);
    const lateOut = at(date, 19, 0);
    const priorities = [
      priority(1, texts[0]!, true, earlyIn - 4 * MIN),
      priority(2, texts[1]!, true, earlyIn - 4 * MIN),
      priority(3, texts[2]!, true, earlyIn - 4 * MIN),
    ];
    return {
      ...base,
      createdAt: earlyIn - 4 * MIN,
      overtimeApproved: true,
      punches: punchRows([earlyIn, at(date, 12, 0), at(date, 12, 30), lateOut]),
      priorities,
      sessions: [
        completed(texts[0]!, at(date, 8, 30), 50, priorities[0]!.uid),
        completed(texts[1]!, at(date, 10, 0), 50, priorities[1]!.uid),
        completed(texts[2]!, at(date, 14, 0), 50, priorities[2]!.uid),
        completed(texts[2]!, at(date, 17, 30), 50, priorities[2]!.uid, 'Kept going after the day ended.'),
      ],
      retroNote: RETRO_NOTES[5]!,
      retroAt: lateOut + 5 * MIN,
    };
  }

  if (kind === 'unreviewed') {
    const priorities = [priority(1, texts[0]!, true), priority(2, texts[1]!, false), priority(3, texts[2]!, false)];
    return {
      ...base,
      punches: punchRows([clockIn, lunchOut, lunchIn, clockOut]),
      priorities,
      sessions: [
        completed(texts[0]!, clockIn + 20 * MIN, 25, priorities[0]!.uid),
        // Cancelled a few minutes in: must not count anywhere.
        {
          label: texts[1]!,
          notes: '',
          plannedSeconds: 25 * 60,
          startedAt: clockIn + 60 * MIN,
          endedAt: clockIn + 65 * MIN,
          status: 'cancelled',
          priorityUid: priorities[1]!.uid,
        },
        completed(pick(UNPLANNED_LABELS), lunchIn + 30 * MIN, 25, null),
      ],
      retroNote: '',
      retroAt: null,
    };
  }

  if (kind === 'noLunch') {
    // A half day: lunch rows exist but were never punched.
    const halfIn = at(date, 9, 0);
    const halfOut = at(date, 13, 30);
    const priorities = [priority(1, texts[0]!, true, halfIn - 4 * MIN), priority(2, texts[1]!, false, halfIn - 4 * MIN)];
    return {
      ...base,
      createdAt: halfIn - 4 * MIN,
      punches: punchRows([halfIn, null, null, halfOut]),
      priorities,
      sessions: [completed(texts[0]!, halfIn + 10 * MIN, 50, priorities[0]!.uid), completed(texts[0]!, halfIn + 70 * MIN, 50, priorities[0]!.uid)],
      retroNote: 'Half day. Left at half one for the appointment.',
      retroAt: halfOut + 2 * MIN,
    };
  }

  const priorities = [priority(1, texts[0]!, true), priority(2, texts[1]!, rand() > 0.4), priority(3, texts[2]!, false)];
  return {
    ...base,
    punches: punchRows([clockIn, lunchOut, lunchIn, clockOut]),
    priorities,
    sessions: [
      completed(texts[0]!, clockIn + 15 * MIN, 25, priorities[0]!.uid),
      completed(texts[1]!, clockIn + 60 * MIN, 50, priorities[1]!.uid),
      completed(pick(UNPLANNED_LABELS), lunchIn + 30 * MIN, 25, null),
    ],
    retroNote: pick(RETRO_NOTES),
    retroAt: clockOut + 5 * MIN,
  };
}

/**
 * Which template a past day gets, by distance back from today (0 = yesterday). The last
 * week of work shows every template once; further back they recur at fixed intervals so a
 * quarter's history is not one flat pattern.
 */
export function kindForDistance(distance: number): Exclude<DayKind, 'today'> {
  const recent = (['normal', 'extraPair', 'overtime', 'unreviewed', 'noLunch'] as const)[distance];
  if (recent) return recent;
  if (distance % 9 === 0) return 'unreviewed';
  if (distance % 7 === 0) return 'overtime';
  if (distance % 5 === 0) return 'extraPair';
  if (distance % 11 === 0) return 'noLunch';
  return 'normal';
}

function buildToday(today: string, now: number, index: number, running: boolean): Omit<SeededDay, 'sessions'> & { sessions: Omit<SeededSession, 'id'>[] } {
  // Two hours ago, on the minute, but never before today started (a seed run at 01:00).
  const clockIn = Math.max(at(today, 0, 5), Math.floor((now - 2 * 3_600_000) / MIN) * MIN);
  const createdAt = clockIn - 3 * MIN;
  const priorities: SeededPriority[] = [
    { position: 1, text: 'Ship the timeclock fix', done: true, uid: uidFor(index, 1), addedAt: createdAt },
    { position: 2, text: 'Answer the two open support threads', done: false, uid: uidFor(index, 2), addedAt: createdAt },
    { position: 3, text: "Write up Friday's plan", done: false, uid: uidFor(index, 3), addedAt: createdAt },
  ];
  const sessions: Omit<SeededSession, 'id'>[] = [
    completed('Ship the timeclock fix', clockIn + 10 * MIN, 50, priorities[0]!.uid),
    completed('Inbox', clockIn + 70 * MIN, 25, null),
  ];
  if (running) {
    sessions.push({
      label: 'Answer the two open support threads',
      notes: '',
      plannedSeconds: 25 * 60,
      startedAt: now - 10 * MIN,
      endedAt: null,
      status: 'running',
      priorityUid: priorities[1]!.uid,
    });
  }
  return {
    date: today,
    kind: 'today',
    createdAt,
    overtimeApproved: false,
    punches: punchRows([clockIn, null, null, null]),
    priorities,
    sessions,
    retroNote: '',
    retroAt: null,
  };
}

/**
 * Replaces the user's days with the sample set. Users are never deleted: in AUTH_MODE=none the
 * running server holds the default user's row for its lifetime, so recreating it would leave
 * the server pointing at a dead id.
 */
export function seedDatabase(db: DB, opts: SeedOptions): SeedManifest {
  const history = opts.days ?? DEFAULT_HISTORY_DAYS;
  const rand = prng(0x5eed);
  const dates = weekdaysBefore(opts.today, history);
  return db.transaction((): SeedManifest => {
    db.prepare(`DELETE FROM days WHERE user_id = ?`).run(opts.userId);
    if (opts.fresh) {
      db.prepare(`DELETE FROM settings WHERE user_id = ?`).run(opts.userId);
      db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(opts.userId);
    }
    const ctx = { db, userId: opts.userId };
    const days = dates.map((date, i) => insertDay(ctx, buildPastDay(date, i, kindForDistance(dates.length - 1 - i), rand)));
    days.push(insertDay(ctx, buildToday(opts.today, opts.now, dates.length, Boolean(opts.running))));
    return { today: opts.today, days };
  })();
}

/** The two local-auth users the seed fills in under AUTH_MODE=local. Idempotent. */
export async function ensureLocalUsers(db: DB): Promise<{ admin: UserRow; member: UserRow }> {
  const get = (username: string) => db.prepare(`SELECT * FROM users WHERE kind = 'local' AND username = ?`).get(username) as UserRow | undefined;
  const create = async (username: string, isAdmin: boolean): Promise<UserRow> => {
    const existing = get(username);
    if (existing) return existing;
    db.prepare(`INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at) VALUES ('local', ?, ?, ?, ?, ?)`).run(
      username,
      await hashPassword(LOCAL_USERS.password),
      username,
      isAdmin ? 1 : 0,
      Date.now(),
    );
    return get(username)!;
  };
  return { admin: await create(LOCAL_USERS.admin, true), member: await create(LOCAL_USERS.member, false) };
}
