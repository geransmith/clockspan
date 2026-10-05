import type { Config } from '../config.js';
import { findLocalUser, insertLocalUser, type DB, type UserRow } from '../db.js';
import { upsertOidcUser } from '../auth/oidc.js';
import { hashPassword } from '../auth/password.js';
import { revokeSessions } from '../auth/session.js';
import { addDays, atTime, HOUR_MS, isWeekend, MINUTE_MS } from '../../shared/dates.js';
import { kindForPosition } from '../../shared/punches.js';
import type { Break, Day, Priority, Punch, Session } from '../../shared/api.js';

/**
 * Deterministic sample data for the dev DB and for API tests. Rows are written with plain
 * SQL because the API can only start a session "now"; past days need `started_at` in the
 * past. Everything here must satisfy the same invariants the routes enforce (see AGENTS.md):
 * punch positions 0..n with the last one odd, priority positions 1..n, `uid`/`added_at` only
 * on rows with text, every `priority_uid` resolving on its own day, and no two sessions or
 * breaks of a day overlapping.
 */

export interface SeedOptions {
  userId: number;
  /** Local date key the seeded "today" is built around. */
  today: string;
  /** An instant on `today`: its clock-in is two hours before, and nothing on it ends after. */
  now: number;
  /** Weekdays of history before `today`. */
  days?: number;
  /** Leave a timer running today. */
  running?: boolean;
  /** Also drop the user's settings and logins, not just their days. */
  fresh?: boolean;
}

/** A priority row with text, so it always has its uid and addedAt. */
type SeededPriority = Priority & { uid: string; addedAt: number };
type SeededSession = Omit<Session, 'date' | 'pausedAt' | 'durationSeconds'>;
type SeededBreak = Omit<Break, 'date'>;

export type SeededDay = Omit<Day, 'priorities' | 'sessions' | 'breaks'> & {
  /** Which template built the day; tests pick days by this. */
  kind: DayKind;
  createdAt: number;
  priorities: SeededPriority[];
  sessions: SeededSession[];
  breaks: SeededBreak[];
};

export interface SeedManifest {
  /** Ascending by date; the last entry is `today`. */
  days: SeededDay[];
}

export type DayKind = 'normal' | 'extraPair' | 'overtime' | 'unreviewed' | 'noLunch' | 'today';

export const DEFAULT_HISTORY_DAYS = 10;
export const LOCAL_USERS = { admin: 'admin', member: 'sam', password: 'clockspan-dev' } as const;

// ----- calendar helpers (the dev machine's zone, which is what the browser shows) -----

/** Weekdays between `from` and the day before `key` inclusive, for --quarter. */
export function weekdaysSince(from: string, key: string): number {
  let n = 0;
  for (let cur = addDays(key, -1); cur >= from; cur = addDays(cur, -1)) if (!isWeekend(cur)) n++;
  return n;
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

// Any of these can land on any weekday of any quarter, so none of them names one.
const PRIORITY_TEXTS = [
  'Finish the expense report',
  'Reply to the vendor about the invoice',
  'Draft the release notes',
  'Fix the login timeout bug',
  "Review Sam's pull request",
  'Update the onboarding doc',
  'Call the bank about the card',
  'Plan next sprint',
  'Clean up the test fixtures',
  'Prep slides for the team meeting',
  'Renew the domain',
  'File the timesheet',
];

const UNPLANNED_LABELS = ['Inbox', 'Helped Sam debug the deploy', 'Standup follow-ups', 'Support ticket that came in', 'Expense receipts'];

/**
 * Retrospective notes, a few per template so they say what that template's day did. A normal
 * day always ticks its first priority, sometimes its second, never its third, and logs one
 * session after lunch that was not on the list, so it takes from one of the first two.
 */
const NOTES = {
  twoDone: [
    'Two of three done. The third needs a quiet morning.',
    'Started with the hardest one and it paid off.',
    'Morning went to plan. After lunch it was whatever came in.',
  ],
  oneDone: [
    'One done. The second took longer than the estimate.',
    'Kept getting pulled into chat. Tomorrow: chat closed until lunch.',
    'One done. Most of the day was meetings that were not on the list.',
  ],
  extraPair: [
    'The recruiter email came in mid-morning and had to go out today, so the third one waited.',
    'Added the recruiter reply mid-morning. Out for twenty minutes at three for the pharmacy.',
  ],
  overtime: ['Finished everything but stayed late to do it.', 'All three done. Stayed until 7:30 with the overtime approved.'],
  unreviewed: [
    'Stopped the second one five minutes in for a call and never got back to it.',
    'The second one lasted five minutes before a call. Did not get back to it.',
  ],
  noLunch: ['Half day. Left at 1:30 for the appointment.', 'Half day for the car inspection. Got one of the two done.'],
} as const;

/** Hands out each pool's notes in turn, so two days from one template never read the same side by side. */
function noteRotation(): (pool: readonly string[]) => string {
  const used = new Map<readonly string[], number>();
  return (pool) => {
    const n = used.get(pool) ?? 0;
    used.set(pool, n + 1);
    return pool[n % pool.length]!;
  };
}

function uidFor(dayIndex: number, position: number): string {
  // 12 lowercase hex chars, unique across the whole seed (uids only need to be unique per day,
  // but distinct values keep review rollups easy to read).
  return `${dayIndex.toString(16).padStart(4, '0')}${position.toString(16).padStart(2, '0')}`.padEnd(12, 'a');
}

/** A day as the templates build it, before the inserts give its sessions and breaks ids. */
type DayDraft = Omit<SeededDay, 'sessions' | 'breaks'> & { sessions: Omit<SeededSession, 'id'>[]; breaks: Omit<SeededBreak, 'id'>[] };

function insertDay(db: DB, userId: number, day: DayDraft): SeededDay {
  const info = db
    .prepare(`INSERT INTO days (user_id, date, created_at, overtime_approved, retro_note, retro_at, work_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, day.date, day.createdAt, day.overtimeApproved ? 1 : 0, day.retroNote, day.retroAt, day.workMinutes);
  const dayId = Number(info.lastInsertRowid);
  const punch = db.prepare(`INSERT INTO punches (day_id, position, kind, at) VALUES (?, ?, ?, ?)`);
  for (const p of day.punches) punch.run(dayId, p.position, p.kind, p.at);
  const prio = db.prepare(`INSERT INTO priorities (day_id, position, text, done, uid, added_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const p of day.priorities) prio.run(dayId, p.position, p.text, p.done ? 1 : 0, p.uid, p.addedAt);
  const sess = db.prepare(
    `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status, priority_uid, paused_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const sessions: SeededSession[] = day.sessions.map((s) => {
    const r = sess.run(dayId, userId, s.label, s.plannedSeconds, s.startedAt, s.endedAt, s.status, s.priorityUid, s.pausedSeconds);
    return { id: Number(r.lastInsertRowid), ...s };
  });
  const rest = db.prepare(`INSERT INTO breaks (day_id, user_id, planned_seconds, started_at, ended_at) VALUES (?, ?, ?, ?, ?)`);
  const breaks: SeededBreak[] = day.breaks.map((b) => {
    const r = rest.run(dayId, userId, b.plannedSeconds, b.startedAt, b.endedAt);
    return { id: Number(r.lastInsertRowid), ...b };
  });
  return { ...day, sessions, breaks };
}

function punchRows(times: (number | null)[]): Punch[] {
  return times.map((t, position) => ({ position, kind: kindForPosition(position), at: t }));
}

/**
 * A finished session planned for `minutes`: for a priority row, which gives its label and uid,
 * or unplanned under a label. Worked shorter, it was finished early; paused, its end moves out
 * by the pause, which the log leaves out, the way the finish route records it. The cancelled
 * and running rows are this shape with `status` set over it, and for a running row
 * `endedAt: null`.
 */
function completed(work: SeededPriority | string, startedAt: number, minutes: number, worked = minutes, paused = 0): Omit<SeededSession, 'id'> {
  return {
    label: typeof work === 'string' ? work : work.text,
    plannedSeconds: minutes * 60,
    startedAt,
    endedAt: startedAt + (worked + paused) * MINUTE_MS,
    status: 'completed',
    priorityUid: typeof work === 'string' ? null : work.uid,
    pausedSeconds: paused * 60,
  };
}

/** A break planned for `minutes`; one `took` less was ended early. */
function rested(startedAt: number, minutes: number, took = minutes): Omit<SeededBreak, 'id'> {
  return { plannedSeconds: minutes * 60, startedAt, endedAt: startedAt + took * MINUTE_MS };
}

/** Builds one past weekday. `index` counts from the oldest day; `kind` picks the template. */
function buildPastDay(date: string, index: number, kind: Exclude<DayKind, 'today'>, rand: () => number, note: (pool: readonly string[]) => string): DayDraft {
  const jitter = (spread: number) => Math.round((rand() - 0.5) * 2 * spread);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const texts = shuffle(PRIORITY_TEXTS, rand);

  const clockIn = atTime(date, 8, 30) + jitter(10) * MINUTE_MS;
  const createdAt = clockIn - 4 * MINUTE_MS;
  const lunchOut = atTime(date, 12, 15) + jitter(10) * MINUTE_MS;
  const lunchIn = lunchOut + (30 + Math.max(0, jitter(5))) * MINUTE_MS;
  const clockOut = atTime(date, 17, 0) + jitter(15) * MINUTE_MS;

  const priority = (position: number, text: string, done: boolean, addedAt = createdAt): SeededPriority => ({
    position,
    text,
    done,
    uid: uidFor(index, position),
    addedAt,
  });

  const base = { date, kind, createdAt, overtimeApproved: false, workMinutes: null };

  if (kind === 'extraPair') {
    // An extra out/in pair in the afternoon (positions 3-4) pushes the clock out to position 5.
    const extraOut = atTime(date, 15, 0);
    const extraIn = extraOut + 20 * MINUTE_MS;
    const priorities = [priority(1, texts[0]!, true), priority(2, texts[1]!, true), priority(3, texts[2]!, false)];
    const firstStart = clockIn + 15 * MINUTE_MS;
    // Written after work started: the retrospective flags it as added mid-day.
    priorities.push(priority(4, 'Reply to the recruiter', true, firstStart + 90 * MINUTE_MS));
    return {
      ...base,
      punches: punchRows([clockIn, lunchOut, lunchIn, extraOut, extraIn, clockOut + 10 * MINUTE_MS]),
      priorities,
      sessions: [
        completed(priorities[0]!, firstStart, 25),
        completed(priorities[1]!, firstStart + 45 * MINUTE_MS, 50),
        completed(priorities[3]!, lunchIn + 20 * MINUTE_MS, 25),
        completed(pick(UNPLANNED_LABELS), extraIn + 15 * MINUTE_MS, 25),
      ],
      breaks: [rested(firstStart + 25 * MINUTE_MS, 5)],
      retroNote: note(NOTES.extraPair),
      retroAt: clockOut + 15 * MINUTE_MS,
    };
  }

  if (kind === 'overtime') {
    // Over ten hours worked, so a second meal period is owed (California): taken as an out / in
    // pair after lunch, well before the tenth hour ends.
    const earlyIn = atTime(date, 8, 15);
    const lateOut = atTime(date, 19, 30);
    const planned = earlyIn - 4 * MINUTE_MS;
    const priorities = [priority(1, texts[0]!, true, planned), priority(2, texts[1]!, true, planned), priority(3, texts[2]!, true, planned)];
    return {
      ...base,
      createdAt: planned,
      overtimeApproved: true,
      punches: punchRows([earlyIn, atTime(date, 12, 0), atTime(date, 12, 30), atTime(date, 17, 15), atTime(date, 17, 45), lateOut]),
      priorities,
      sessions: [
        completed(priorities[0]!, atTime(date, 8, 30), 50),
        completed(priorities[1]!, atTime(date, 10, 0), 50),
        completed(priorities[2]!, atTime(date, 14, 0), 50),
        completed(priorities[2]!, atTime(date, 18, 0), 50),
      ],
      breaks: [],
      retroNote: note(NOTES.overtime),
      retroAt: lateOut + 5 * MINUTE_MS,
    };
  }

  if (kind === 'unreviewed') {
    const priorities = [priority(1, texts[0]!, true), priority(2, texts[1]!, false), priority(3, texts[2]!, false)];
    return {
      ...base,
      punches: punchRows([clockIn, lunchOut, lunchIn, clockOut]),
      priorities,
      sessions: [
        completed(priorities[0]!, clockIn + 20 * MINUTE_MS, 25),
        // Cancelled a few minutes in: must not count anywhere.
        { ...completed(priorities[1]!, clockIn + 60 * MINUTE_MS, 25, 5), status: 'cancelled' },
        completed(pick(UNPLANNED_LABELS), lunchIn + 30 * MINUTE_MS, 25),
      ],
      breaks: [],
      // Written, but the day was never marked reviewed.
      retroNote: note(NOTES.unreviewed),
      retroAt: null,
    };
  }

  if (kind === 'noLunch') {
    // A half day: its own 4.5 h work day, so it ends on target, and lunch rows never punched.
    const halfIn = atTime(date, 9, 0);
    const halfOut = atTime(date, 13, 30);
    const planned = halfIn - 4 * MINUTE_MS;
    const priorities = [priority(1, texts[0]!, true, planned), priority(2, texts[1]!, false, planned)];
    return {
      ...base,
      createdAt: planned,
      workMinutes: 270,
      punches: punchRows([halfIn, null, null, halfOut]),
      priorities,
      sessions: [completed(priorities[0]!, halfIn + 10 * MINUTE_MS, 50), completed(priorities[0]!, halfIn + 70 * MINUTE_MS, 50)],
      breaks: [rested(halfIn + 60 * MINUTE_MS, 10)],
      retroNote: note(NOTES.noLunch),
      retroAt: halfOut + 2 * MINUTE_MS,
    };
  }

  const twoDone = rand() > 0.4;
  const priorities = [priority(1, texts[0]!, true), priority(2, texts[1]!, twoDone), priority(3, texts[2]!, false)];
  return {
    ...base,
    punches: punchRows([clockIn, lunchOut, lunchIn, clockOut]),
    priorities,
    sessions: [
      completed(priorities[0]!, clockIn + 15 * MINUTE_MS, 25),
      completed(priorities[1]!, clockIn + 60 * MINUTE_MS, 50),
      completed(pick(UNPLANNED_LABELS), lunchIn + 30 * MINUTE_MS, 25),
    ],
    // A fifth of each session before it, the way Suggest breaks sizes them.
    breaks: [rested(clockIn + 40 * MINUTE_MS, 5), rested(clockIn + 110 * MINUTE_MS, 10)],
    retroNote: note(twoDone ? NOTES.twoDone : NOTES.oneDone),
    retroAt: clockOut + 5 * MINUTE_MS,
  };
}

/**
 * Which template a past day gets, by distance back from today (0 = the last weekday). The
 * last week of work shows every template once; further back they recur at fixed intervals so
 * a quarter's history is not one flat pattern. The last weekday is the one with a row added
 * mid-day, since the README's retrospective shot shows it.
 */
export function kindForDistance(distance: number): Exclude<DayKind, 'today'> {
  const recent = (['extraPair', 'normal', 'overtime', 'unreviewed', 'noLunch'] as const)[distance];
  if (recent) return recent;
  if (distance % 9 === 0) return 'unreviewed';
  if (distance % 7 === 0) return 'overtime';
  if (distance % 5 === 0) return 'extraPair';
  if (distance % 11 === 0) return 'noLunch';
  return 'normal';
}

/** `last` is the weekday before, whose retrospective planned today's list; none with no history. */
function buildToday(today: string, now: number, index: number, running: boolean, last: Pick<SeededDay, 'priorities' | 'retroAt'> | undefined): DayDraft {
  // Two hours ago, on the minute, but never before today started (a seed run at 01:00) or after now.
  const clockIn = Math.min(now, Math.max(atTime(today, 0, 5), Math.floor((now - 2 * HOUR_MS) / MINUTE_MS) * MINUTE_MS));
  // Planned the evening before with Plan next, which carries over what that day left open; the
  // planner's save is what stored today's row. With no history, written on arrival.
  const plannedAt = last?.retroAt != null ? last.retroAt + 2 * MINUTE_MS : clockIn - 3 * MINUTE_MS;
  const carried = last?.priorities.find((p) => !p.done)?.text ?? 'Update the onboarding doc';
  const row = (position: number, text: string, done: boolean): SeededPriority => ({ position, text, done, uid: uidFor(index, position), addedAt: plannedAt });
  const priorities = [row(1, carried, false), row(2, 'Ship the timeclock fix', true), row(3, 'Answer the two open support threads', false)];

  const runningFrom = Math.max(clockIn, now - 10 * MINUTE_MS);
  // A run soon after midnight has less than two hours for these, so keep only what ended
  // before the running timer started (or before now): nothing overlaps it, and no break is
  // still running beside it, which the server would refuse.
  const until = running ? runningFrom : now;
  const sessions = [
    completed(priorities[1]!, clockIn + 10 * MINUTE_MS, 50),
    // Paused eight minutes for a question, then finished three minutes short of the plan.
    completed('Inbox', clockIn + 70 * MINUTE_MS, 25, 22, 8),
  ].filter((s) => s.endedAt! <= until);
  if (running) sessions.push({ ...completed(priorities[2]!, runningFrom, 25), endedAt: null, status: 'running' });
  return {
    date: today,
    kind: 'today',
    createdAt: plannedAt,
    overtimeApproved: false,
    workMinutes: null,
    punches: punchRows([clockIn, null, null, null]),
    priorities,
    sessions,
    // The second was ended early, back at the desk before its ten minutes were up.
    breaks: [rested(clockIn + 60 * MINUTE_MS, 10), rested(clockIn + 102 * MINUTE_MS, 10, 6)].filter((b) => b.endedAt <= until),
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
  const note = noteRotation();
  const dates = weekdaysBefore(opts.today, history);
  return db.transaction((): SeedManifest => {
    db.prepare(`DELETE FROM days WHERE user_id = ?`).run(opts.userId);
    if (opts.fresh) {
      db.prepare(`DELETE FROM settings WHERE user_id = ?`).run(opts.userId);
      revokeSessions(db, opts.userId);
    }
    const days = dates.map((date, i) => insertDay(db, opts.userId, buildPastDay(date, i, kindForDistance(dates.length - 1 - i), rand, note)));
    days.push(insertDay(db, opts.userId, buildToday(opts.today, opts.now, dates.length, Boolean(opts.running), days.at(-1))));
    return { days };
  })();
}

/**
 * The two local-auth users the seed fills in under AUTH_MODE=local. Idempotent: an existing
 * account is reused whatever the case of its name, as sign-in matches names.
 */
export async function ensureLocalUsers(db: DB): Promise<{ admin: UserRow; member: UserRow }> {
  const create = async (username: string, isAdmin: boolean): Promise<UserRow> => {
    const existing = findLocalUser(db, username);
    return existing ?? insertLocalUser(db, username, await hashPassword(LOCAL_USERS.password), { isAdmin, mustChangePassword: false })!;
  };
  return { admin: await create(LOCAL_USERS.admin, true), member: await create(LOCAL_USERS.member, false) };
}

/** The account the seed fills under AUTH_MODE=oidc. The provider never sees it; a browser signs in with a `--sessions` cookie. */
export const OIDC_DEV_USER = { sub: 'clockspan-dev', name: 'Dev User' } as const;

/** Idempotent, and stored the way a real sign-in would store the provider's subject. */
export function ensureOidcDevUser(db: DB, config: Config): UserRow {
  return upsertOidcUser(db, config.oidc!.issuer, OIDC_DEV_USER.sub, OIDC_DEV_USER.name);
}
