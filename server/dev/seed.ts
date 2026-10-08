import type { Config } from '../config.js';
import { findLocalUser, insertLocalUser, type DB, type UserRow } from '../db.js';
import { upsertOidcUser } from '../auth/oidc.js';
import { hashPassword } from '../auth/password.js';
import { revokeSessions } from '../auth/session.js';
import { boardJson, weekdayMask } from '../board.js';
import { addDays, atTime, HOUR_MS, isoWeekday, isWeekend, MINUTE_MS } from '../../shared/dates.js';
import { kindForPosition } from '../../shared/punches.js';
import type { Board, Break, Category, Day, OpenLane, Priority, Punch, Recurring, Session } from '../../shared/api.js';

/**
 * Deterministic sample data for the dev DB and for API tests. Rows are written with plain
 * SQL because the API can only start a session "now"; past days need `started_at` in the
 * past. Everything here must satisfy the same invariants the routes enforce (see AGENTS.md):
 * punch positions 0..n with the last one odd, priority positions from 1, every entry naming a
 * task that exists, at most one entry per task on a day, every session's task listed on its own
 * day, no cancelled session with a task, no two sessions or breaks of a day overlapping, a
 * recurring priority listed only on its weekdays and never in a lane, no task named by nothing
 * that isn't in a lane, and every `categoryUid` naming a seeded category.
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

/** An entry: a task on a day's list, so it always has its uid and addedAt. */
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
  /** The board as `GET /board` answers it at `now`. */
  board: Board;
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

/** The board's categories, in the order they were made. */
export const SEEDED_CATEGORIES = [
  { uid: 'cat000000001', name: 'Tickets', color: 'blue', archived: false },
  { uid: 'cat000000002', name: 'Follow-ups', color: 'teal', archived: false },
  { uid: 'cat000000003', name: 'Knowledge base', color: 'purple', archived: false },
  { uid: 'cat000000004', name: 'Admin', color: 'grey', archived: false },
] as const satisfies readonly Category[];
type CategoryName = (typeof SEEDED_CATEGORIES)[number]['name'];

/**
 * The category each sample text counts under, the same on every day: most tasks have one, and so
 * do the unplanned "Inbox" sessions. The rest (a personal errand, a review for a colleague, the
 * recruiter's reply) have none.
 */
const CATEGORY_OF: Readonly<Record<string, CategoryName>> = {
  'Finish the expense report': 'Admin',
  'Reply to the vendor about the invoice': 'Follow-ups',
  'Draft the release notes': 'Knowledge base',
  'Fix the login timeout bug': 'Tickets',
  'Update the onboarding doc': 'Knowledge base',
  'Plan next sprint': 'Admin',
  'Clean up the test fixtures': 'Tickets',
  'Prep slides for the team meeting': 'Admin',
  'Renew the domain': 'Admin',
  'File the timesheet': 'Admin',
  'Ship the timeclock fix': 'Tickets',
  'Answer the two open support threads': 'Follow-ups',
  'Write a KB for the SSO reset': 'Knowledge base',
  'Review canned replies': 'Knowledge base',
  'Look into the export timeout': 'Tickets',
  'Follow up on the Acme SLA': 'Follow-ups',
  'Monitor the queue': 'Tickets',
  'Follow-ups': 'Follow-ups',
  Inbox: 'Tickets',
};

/** The uid of the category `text` counts under, or null. */
function categoryFor(text: string): string | null {
  return SEEDED_CATEGORIES.find((c) => c.name === CATEGORY_OF[text])?.uid ?? null;
}

/** Every one-off task the templates put on a list. A text is one task on every day it is on, its uid its place here (`taskUid`). */
const TASK_TEXTS: readonly string[] = [...PRIORITY_TEXTS, 'Reply to the recruiter', 'Ship the timeclock fix', 'Answer the two open support threads'];

function taskUid(text: string): string {
  return `task${(TASK_TEXTS.indexOf(text) + 1).toString(16).padStart(8, '0')}`;
}

/** What only the server works out, filled in once every day is built (`withCounts`). */
const UNCOUNTED = { archived: false, listed: 0, earlier: 0, logged: 0 } as const;

/** The entry for the one-off task `text` at `position`, in the task's category. */
function oneOff(position: number, text: string, done: boolean, addedAt: number): SeededPriority {
  return { position, text, done, uid: taskUid(text), addedAt, categoryUid: categoryFor(text), recurring: false, ...UNCOUNTED };
}

/**
 * The board's recurring priorities, in the order they were made: routine support work, each in
 * its category. Every past weekday lists the ones due on it (`routineRows`); today lists none.
 */
export const SEEDED_RECURRING: readonly Recurring[] = [
  { uid: 'rcur00000001', title: 'Monitor the queue', categoryUid: categoryFor('Monitor the queue'), weekdays: [1, 2, 3, 4, 5] },
  { uid: 'rcur00000002', title: 'Follow-ups', categoryUid: categoryFor('Follow-ups'), weekdays: [1, 3, 5] },
];

/**
 * The routines each template's day ticked, of the ones due on it: the queue gets watched every
 * day but the one a call took over, and the follow-ups get done on normal and overtime days and
 * missed on the rest.
 */
const ROUTINES_DONE: Readonly<Record<Exclude<DayKind, 'today'>, readonly string[]>> = {
  normal: ['Monitor the queue', 'Follow-ups'],
  extraPair: ['Monitor the queue'],
  overtime: ['Monitor the queue', 'Follow-ups'],
  unreviewed: [],
  noLunch: ['Monitor the queue'],
};

/**
 * An entry for each recurring priority due on `date`'s weekday, after the day's `after` one-off
 * rows: written with the list, ticked as `ROUTINES_DONE` says.
 */
function routineRows(date: string, kind: Exclude<DayKind, 'today'>, after: number, addedAt: number): SeededPriority[] {
  return SEEDED_RECURRING.filter((r) => r.weekdays.includes(isoWeekday(date))).map((r, i) => ({
    position: after + i + 1,
    text: r.title,
    done: ROUTINES_DONE[kind].includes(r.title),
    uid: r.uid,
    addedAt,
    categoryUid: r.categoryUid,
    recurring: true,
    ...UNCOUNTED,
  }));
}

/**
 * Retrospective notes, a few per template so they say what that template's day did. A normal
 * day always ticks its first priority, sometimes its second, never its third, and logs one
 * session after lunch that was not on the list, so it takes from one of the first two. The
 * notes speak of the one-off rows: the routines come after them on the list.
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

/** Captured on the board, never on a list: the parking lot and one queued for next. */
const CAPTURED: readonly [title: string, lane: OpenLane][] = [
  ['Write a KB for the SSO reset', 'later'],
  ['Review canned replies', 'later'],
  ['Look into the export timeout', 'later'],
  ['Follow up on the Acme SLA', 'next'],
];

/** A day as the templates build it, before the inserts give its sessions and breaks ids. */
type DayDraft = Omit<SeededDay, 'sessions' | 'breaks'> & { sessions: Omit<SeededSession, 'id'>[]; breaks: Omit<SeededBreak, 'id'>[] };

/** Writes a day, its entries naming the tasks in `items` (uid to id) and its sessions on them. */
function insertDay(db: DB, userId: number, day: DayDraft, items: ReadonlyMap<string, number>): SeededDay {
  const info = db
    .prepare(`INSERT INTO days (user_id, date, created_at, overtime_approved, retro_note, retro_at, work_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, day.date, day.createdAt, day.overtimeApproved ? 1 : 0, day.retroNote, day.retroAt, day.workMinutes);
  const dayId = Number(info.lastInsertRowid);
  const punch = db.prepare(`INSERT INTO punches (day_id, position, kind, at) VALUES (?, ?, ?, ?)`);
  for (const p of day.punches) punch.run(dayId, p.position, p.kind, p.at);
  const entry = db.prepare(`INSERT INTO priorities (day_id, item_id, position, done, added_at) VALUES (?, ?, ?, ?, ?)`);
  for (const p of day.priorities) entry.run(dayId, items.get(p.uid), p.position, p.done ? 1 : 0, p.addedAt);
  const sess = db.prepare(
    `INSERT INTO sessions (day_id, user_id, label, planned_seconds, started_at, ended_at, status, item_id, paused_seconds, category_uid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const sessions: SeededSession[] = day.sessions.map((s) => {
    // A session on a task counts under the task's category, so it keeps none of its own.
    const [itemId, own] = s.priorityUid == null ? [null, s.categoryUid] : [items.get(s.priorityUid), null];
    const r = sess.run(dayId, userId, s.label, s.plannedSeconds, s.startedAt, s.endedAt, s.status, itemId, s.pausedSeconds, own);
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
 * A finished session planned for `minutes`: on a task, which gives its label, its name and the
 * category it counts under, or unplanned under a label, with the label's category picked in the
 * log. Worked shorter, it was finished early; paused, its end moves out by the pause, which the
 * log leaves out, the way the finish route records it. The running row is this shape with
 * `status` set over it and `endedAt: null`, and the cancelled one is `cancelled`'s.
 */
function completed(work: SeededPriority | string, startedAt: number, minutes: number, worked = minutes, paused = 0): Omit<SeededSession, 'id'> {
  const task = typeof work === 'string' ? null : work;
  return {
    label: task?.text ?? (work as string),
    plannedSeconds: minutes * 60,
    startedAt,
    endedAt: startedAt + (worked + paused) * MINUTE_MS,
    status: 'completed',
    priorityUid: task?.uid ?? null,
    title: task?.text ?? null,
    pausedSeconds: paused * 60,
    categoryUid: task ? task.categoryUid : categoryFor(work as string),
  };
}

/** The session cancelled: it counts nowhere, and a cancel lets go of its task. */
function cancelled(session: Omit<SeededSession, 'id'>): Omit<SeededSession, 'id'> {
  return { ...session, status: 'cancelled', priorityUid: null, title: null, categoryUid: null };
}

/** A break planned for `minutes`; one `took` less was ended early. */
function rested(startedAt: number, minutes: number, took = minutes): Omit<SeededBreak, 'id'> {
  return { plannedSeconds: minutes * 60, startedAt, endedAt: startedAt + took * MINUTE_MS };
}

/** Builds one past weekday. `index` counts from the oldest day; `kind` picks the template. */
function buildPastDay(date: string, kind: Exclude<DayKind, 'today'>, rand: () => number, note: (pool: readonly string[]) => string): DayDraft {
  const jitter = (spread: number) => Math.round((rand() - 0.5) * 2 * spread);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const texts = shuffle(PRIORITY_TEXTS, rand);

  const clockIn = atTime(date, 8, 30) + jitter(10) * MINUTE_MS;
  const createdAt = clockIn - 4 * MINUTE_MS;
  const lunchOut = atTime(date, 12, 15) + jitter(10) * MINUTE_MS;
  const lunchIn = lunchOut + (30 + Math.max(0, jitter(5))) * MINUTE_MS;
  const clockOut = atTime(date, 17, 0) + jitter(15) * MINUTE_MS;

  const priority = (position: number, text: string, done: boolean, addedAt = createdAt) => oneOff(position, text, done, addedAt);
  // The routines due on the day, after its `after` one-off rows, written with them.
  const routines = (after: number, addedAt = createdAt) => routineRows(date, kind, after, addedAt);
  // A 25-minute session on the routine titled so, in a gap the template leaves; none when it isn't due that day.
  const onRoutine = (rows: SeededPriority[], title: string, startedAt: number) => {
    const row = rows.find((p) => p.text === title);
    return row ? [completed(row, startedAt, 25)] : [];
  };

  const base = { date, kind, createdAt, overtimeApproved: false, workMinutes: null };

  if (kind === 'extraPair') {
    // An extra out/in pair in the afternoon (positions 3-4) pushes the clock out to position 5.
    const extraOut = atTime(date, 15, 0);
    const extraIn = extraOut + 20 * MINUTE_MS;
    const priorities = [priority(1, texts[0]!, true), priority(2, texts[1]!, true), priority(3, texts[2]!, false)];
    const firstStart = clockIn + 15 * MINUTE_MS;
    // Written after work started: the retrospective flags it as added mid-day.
    priorities.push(priority(4, 'Reply to the recruiter', true, firstStart + 90 * MINUTE_MS));
    const routine = routines(priorities.length);
    return {
      ...base,
      punches: punchRows([clockIn, lunchOut, lunchIn, extraOut, extraIn, clockOut + 10 * MINUTE_MS]),
      priorities: [...priorities, ...routine],
      sessions: [
        completed(priorities[0]!, firstStart, 25),
        completed(priorities[1]!, firstStart + 45 * MINUTE_MS, 50),
        completed(priorities[3]!, lunchIn + 20 * MINUTE_MS, 25),
        ...onRoutine(routine, 'Monitor the queue', lunchIn + 50 * MINUTE_MS),
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
    const routine = routines(priorities.length, planned);
    return {
      ...base,
      createdAt: planned,
      overtimeApproved: true,
      punches: punchRows([earlyIn, atTime(date, 12, 0), atTime(date, 12, 30), atTime(date, 17, 15), atTime(date, 17, 45), lateOut]),
      priorities: [...priorities, ...routine],
      sessions: [
        completed(priorities[0]!, atTime(date, 8, 30), 50),
        completed(priorities[1]!, atTime(date, 10, 0), 50),
        ...onRoutine(routine, 'Monitor the queue', atTime(date, 11, 0)),
        completed(priorities[2]!, atTime(date, 14, 0), 50),
        ...onRoutine(routine, 'Follow-ups', atTime(date, 15, 0)),
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
      // The call took the routines too: on the list, no time, not ticked.
      priorities: [...priorities, ...routines(priorities.length)],
      sessions: [
        completed(priorities[0]!, clockIn + 20 * MINUTE_MS, 25),
        // Cancelled a few minutes in: must not count anywhere.
        cancelled(completed(priorities[1]!, clockIn + 60 * MINUTE_MS, 25, 5)),
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
    const routine = routines(priorities.length, planned);
    return {
      ...base,
      createdAt: planned,
      workMinutes: 270,
      punches: punchRows([halfIn, null, null, halfOut]),
      priorities: [...priorities, ...routine],
      sessions: [
        completed(priorities[0]!, halfIn + 10 * MINUTE_MS, 50),
        completed(priorities[0]!, halfIn + 70 * MINUTE_MS, 50),
        ...onRoutine(routine, 'Monitor the queue', halfIn + 130 * MINUTE_MS),
      ],
      breaks: [rested(halfIn + 60 * MINUTE_MS, 10)],
      retroNote: note(NOTES.noLunch),
      retroAt: halfOut + 2 * MINUTE_MS,
    };
  }

  const twoDone = rand() > 0.4;
  const priorities = [priority(1, texts[0]!, true), priority(2, texts[1]!, twoDone), priority(3, texts[2]!, false)];
  const routine = routines(priorities.length);
  return {
    ...base,
    punches: punchRows([clockIn, lunchOut, lunchIn, clockOut]),
    priorities: [...priorities, ...routine],
    sessions: [
      completed(priorities[0]!, clockIn + 15 * MINUTE_MS, 25),
      completed(priorities[1]!, clockIn + 60 * MINUTE_MS, 50),
      completed(pick(UNPLANNED_LABELS), lunchIn + 30 * MINUTE_MS, 25),
      ...onRoutine(routine, 'Monitor the queue', lunchIn + 60 * MINUTE_MS),
      ...onRoutine(routine, 'Follow-ups', lunchIn + 100 * MINUTE_MS),
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
function buildToday(today: string, now: number, running: boolean, last: Pick<DayDraft, 'priorities' | 'retroAt'> | undefined): DayDraft {
  // Two hours ago, on the minute, but never before today started (a seed run at 01:00) or after now.
  const clockIn = Math.min(now, Math.max(atTime(today, 0, 5), Math.floor((now - 2 * HOUR_MS) / MINUTE_MS) * MINUTE_MS));
  // Planned the evening before with Plan next, which carries over what that day left open; the
  // planner's save is what stored today's row. With no history, written on arrival.
  const plannedAt = last?.retroAt != null ? last.retroAt + 2 * MINUTE_MS : clockIn - 3 * MINUTE_MS;
  // The same task on the new day, with its own addedAt. A routine left open isn't carried over: it
  // comes back on its own weekdays.
  const carried = last?.priorities.find((p) => !p.done && !p.recurring);
  const row = (position: number, text: string, done: boolean) => oneOff(position, text, done, plannedAt);
  const priorities = [
    row(1, carried?.text ?? 'Update the onboarding doc', false),
    row(2, 'Ship the timeclock fix', true),
    row(3, 'Answer the two open support threads', false),
  ];

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
 * Each entry with what the server works out for it from every seeded day: how many days list its
 * task, how many of those are before its own, and the focus completed on the task.
 */
function withCounts(days: DayDraft[]): DayDraft[] {
  const dates = new Map<string, string[]>();
  const logged = new Map<string, number>();
  for (const day of days) {
    for (const p of day.priorities) dates.set(p.uid, [...(dates.get(p.uid) ?? []), day.date]);
    for (const s of day.sessions) {
      if (s.status !== 'completed' || s.priorityUid == null) continue;
      logged.set(s.priorityUid, (logged.get(s.priorityUid) ?? 0) + (s.endedAt! - s.startedAt) / 1000 - s.pausedSeconds);
    }
  }
  return days.map((day) => ({
    ...day,
    priorities: day.priorities.map((p) => {
      const on = dates.get(p.uid)!;
      return { ...p, listed: on.length, earlier: on.filter((d) => d < day.date).length, logged: logged.get(p.uid) ?? 0 };
    }),
  }));
}

/**
 * The tasks and the board: the categories, the recurring priorities, a task for every one-off text
 * the days list, and the captured tasks, handled on the board. The last weekday's and today's open
 * one-offs are in Next, as the board had them, today's above the last weekday's and both above
 * the captured one; a done one is in no lane, since its tick says where it shows, and so are the
 * older days' tasks. Returns each task's id by its uid, for the entries and sessions that name it.
 */
function insertItems(db: DB, userId: number, days: DayDraft[]): Map<string, number> {
  const category = db.prepare(`INSERT INTO categories (user_id, uid, name, color) VALUES (?, ?, ?, ?)`);
  for (const c of SEEDED_CATEGORIES) category.run(userId, c.uid, c.name, c.color);
  const insert = db.prepare(
    `INSERT INTO items (user_id, uid, title, category_uid, weekdays, lane, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const ids = new Map<string, number>();
  const add = (uid: string, title: string, categoryUid: string | null, weekdays: number | null, lane: OpenLane | null, position: number, createdAt: number) =>
    ids.set(uid, (insert.get(userId, uid, title, categoryUid, weekdays, lane, position, createdAt) as { id: number }).id);

  const first = days[0]!;
  for (const r of SEEDED_RECURRING) add(r.uid, r.title, r.categoryUid, weekdayMask(r.weekdays), null, 0, first.createdAt);
  const [last, today] = days.length > 1 ? days.slice(-2) : [undefined, first];
  let next: string[] = [];
  for (const day of [last, today]) {
    const fresh = (day?.priorities ?? []).filter((p) => !p.recurring && !p.done && !next.includes(p.uid)).map((p) => p.uid);
    next = [...fresh, ...next];
  }
  const captured = CAPTURED.map(([title, lane], i) => ({ uid: `card${String(i + 1).padStart(8, '0')}`, title, lane }));
  const order = {
    later: captured.filter((c) => c.lane === 'later').map((c) => c.uid),
    next: [...next, ...captured.filter((c) => c.lane === 'next').map((c) => c.uid)],
  };
  const laneOf = (uid: string): [OpenLane | null, number] => {
    const lane = (['later', 'next'] as const).find((l) => order[l].includes(uid));
    return lane ? [lane, order[lane].indexOf(uid) + 1] : [null, 0];
  };
  for (const day of days) {
    for (const p of day.priorities) {
      if (p.recurring || ids.has(p.uid)) continue;
      add(p.uid, p.text, p.categoryUid, null, ...laneOf(p.uid), p.addedAt);
    }
  }
  // Captured a few minutes apart, just before the last weekday's list was written.
  const capturedAt = (last ?? today!).createdAt;
  captured.forEach((c, i) => add(c.uid, c.title, categoryFor(c.title), null, ...laneOf(c.uid), capturedAt - (captured.length - i) * 5 * MINUTE_MS));
  return ids;
}

/**
 * Replaces the user's days, tasks (deleted ones' tombstones included: the sample's uids are fixed,
 * and one left from a task deleted in the browser would hold its uid) and categories with the
 * sample set. Users are never deleted: in AUTH_MODE=none the running server holds the default
 * user's row for its lifetime, so recreating it would leave the server pointing at a dead id.
 */
export function seedDatabase(db: DB, opts: SeedOptions): SeedManifest {
  const history = opts.days ?? DEFAULT_HISTORY_DAYS;
  const rand = prng(0x5eed);
  const note = noteRotation();
  const dates = weekdaysBefore(opts.today, history);
  return db.transaction((): SeedManifest => {
    // The days first: their entries and sessions name the tasks.
    db.prepare(`DELETE FROM days WHERE user_id = ?`).run(opts.userId);
    db.prepare(`DELETE FROM items WHERE user_id = ?`).run(opts.userId);
    db.prepare(`DELETE FROM categories WHERE user_id = ?`).run(opts.userId);
    if (opts.fresh) {
      db.prepare(`DELETE FROM settings WHERE user_id = ?`).run(opts.userId);
      revokeSessions(db, opts.userId);
    }
    const past = dates.map((date, i) => buildPastDay(date, kindForDistance(dates.length - 1 - i), rand, note));
    const drafts = withCounts([...past, buildToday(opts.today, opts.now, Boolean(opts.running), past.at(-1))]);
    const items = insertItems(db, opts.userId, drafts);
    const days = drafts.map((draft) => insertDay(db, opts.userId, draft, items));
    return { days, board: boardJson(db, opts.userId, opts.now) };
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
