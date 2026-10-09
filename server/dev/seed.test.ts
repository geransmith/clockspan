import { describe, expect, it, vi } from 'vitest';
import { ensureDefaultUser, openDatabase, type DB } from '../db.js';
import { insertSession, SESSION_COOKIE } from '../auth/session.js';
import { countRows, SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from './harness.js';
import { addMonths, atTime, DAY_MS, isoWeekday, isWeekend, MINUTE_MS, punchWindow, startOfQuarter, todayKey } from '../../shared/dates.js';
import type { ItemRow } from '../routes/shared.js';
import { LIMITS, type Board, type BoardCard, type Day } from '../../shared/api.js';
import { DEFAULT_SETTINGS, SETTING_LIMITS } from '../../shared/settings.js';
import { BREAK_SECONDS, MIN_BREAK_MS, PLANNED_SECONDS } from '../../shared/timer.js';
import {
  DEFAULT_HISTORY_DAYS,
  ensureLocalUsers,
  ensureOidcDevUser,
  kindForDistance,
  LOCAL_USERS,
  OIDC_DEV_USER,
  SEEDED_CATEGORIES,
  SEEDED_RECURRING,
  seedDatabase,
  weekdaysBefore,
  weekdaysSince,
  type SeededDay,
  type SeedManifest,
} from './seed.js';

const counts = (db: DB) =>
  Object.fromEntries(
    ['days', 'punches', 'priorities', 'sessions', 'breaks', 'items', 'categories', 'settings', 'auth_sessions'].map((t) => [t, countRows(db, t)]),
  );

/**
 * The tasks a seed wrote, against its days: every entry names a task that exists and reads back
 * its name, its category and whether it repeats, a day lists a task once, a recurring priority
 * only on its weekdays, every task is named by a day or is in a lane or repeats, Later and Next
 * are numbered from 1, every category named is one of the board's, and today's first row is the
 * task the last weekday left open.
 */
function expectTasksInStep(db: DB, m: SeedManifest) {
  expect(m.board.categories).toEqual(SEEDED_CATEGORIES);
  expect(m.board.recurring).toEqual(SEEDED_RECURRING);
  const routines = new Map(m.board.recurring.map((r) => [r.uid, r]));
  const categories = new Set(m.board.categories.map((c) => c.uid));
  const resolves = (uid: string | null) => uid === null || categories.has(uid);
  const tasks = new Map((db.prepare(`SELECT * FROM items`).all() as ItemRow[]).map((i) => [i.uid, i]));
  expect([...tasks.values()].every((t) => resolves(t.category_uid) && t.deleted_at == null && t.archived_at == null)).toBe(true);
  for (const day of m.days) {
    expect(new Set(day.priorities.map((p) => p.uid)).size, day.date).toBe(day.priorities.length);
    expect(day.sessions.every((s) => resolves(s.categoryUid))).toBe(true);
    for (const p of day.priorities) {
      const task = tasks.get(p.uid)!;
      expect([task.title, task.category_uid, task.note, task.weekdays != null], `${day.date} ${p.text}`).toEqual([p.text, p.categoryUid, p.note, p.recurring]);
      if (p.recurring) expect(routines.get(p.uid)!.weekdays, `${day.date} ${p.text}`).toContain(isoWeekday(day.date));
    }
  }
  const named = new Set(m.days.flatMap((d) => d.priorities.map((p) => p.uid)));
  for (const t of tasks.values()) expect(named.has(t.uid) || t.lane != null || t.weekdays != null, t.title).toBe(true);
  for (const lane of ['later', 'next'] as const) {
    const positions = [...tasks.values()].filter((t) => t.lane === lane).map((t) => t.position);
    expect(positions.sort((a, b) => a - b)).toEqual(positions.map((_, i) => i + 1));
  }
  const [last, today] = [m.days.at(-2), m.days.at(-1)!];
  if (last) {
    const source = last.priorities.find((p) => !p.done && !p.recurring)!;
    expect(today.priorities[0]).toMatchObject({ uid: source.uid, text: source.text, categoryUid: source.categoryUid });
    expect(today.priorities[0]!.addedAt).not.toBe(source.addedAt);
  }
}

/** The clocked-in stretches of a day: its set punches in order, in → out, today's last one open until `now`. */
function workedSpans(day: SeededDay, now: number): [number, number][] {
  const set = day.punches.filter((p) => p.at != null).map((p) => p.at!);
  const spans: [number, number][] = [];
  for (let i = 0; i < set.length; i += 2) spans.push([set[i]!, set[i + 1] ?? now]);
  return spans;
}

/**
 * What a seeded day must look like to pass for one the app wrote at `now`: on its own date,
 * nothing after `now`, sessions and breaks one after another inside the clocked-in time,
 * and every value inside the bounds the routes check.
 */
function expectConsistent(m: SeedManifest, now: number) {
  for (const day of m.days) {
    const window = punchWindow(day.date);
    for (const p of day.punches.filter((p) => p.at != null)) {
      expect(todayKey(p.at!)).toBe(day.date);
      expect(p.at!).toBeGreaterThanOrEqual(window.from);
      expect(p.at!).toBeLessThanOrEqual(Math.min(window.to, now));
    }
    for (const p of day.priorities) {
      expect(p.addedAt).toBeLessThanOrEqual(now + DAY_MS);
      expect(p.text.length).toBeLessThanOrEqual(LIMITS.priorityText);
    }
    expect(day.retroNote.length).toBeLessThanOrEqual(LIMITS.retroNote);
    if (day.workMinutes != null) {
      expect(day.workMinutes).toBeGreaterThanOrEqual(SETTING_LIMITS.workMinutes.min);
      expect(day.workMinutes).toBeLessThanOrEqual(SETTING_LIMITS.workMinutes.max);
    }

    for (const s of day.sessions) {
      expect(s.plannedSeconds).toBeGreaterThanOrEqual(PLANNED_SECONDS.min);
      expect(s.plannedSeconds).toBeLessThanOrEqual(PLANNED_SECONDS.max);
      expect(s.label.length).toBeLessThanOrEqual(LIMITS.sessionLabel);
    }
    for (const b of day.breaks) {
      expect(b.plannedSeconds).toBeGreaterThanOrEqual(BREAK_SECONDS.min);
      expect(b.plannedSeconds).toBeLessThanOrEqual(BREAK_SECONDS.max);
      // Its planned end, or earlier when ended early; never so short the server would have dropped it.
      expect(b.endedAt - b.startedAt).toBeGreaterThanOrEqual(MIN_BREAK_MS);
      expect(b.endedAt).toBeLessThanOrEqual(b.startedAt + b.plannedSeconds * 1000);
    }

    // A running session runs until now; a break still running beside it is what the server refuses.
    const spans = [
      ...day.sessions.map((s): [number, number] => [s.startedAt, s.endedAt ?? now]),
      ...day.breaks.map((b): [number, number] => [b.startedAt, b.endedAt]),
    ].sort((a, b) => a[0] - b[0]);
    const worked = workedSpans(day, now);
    spans.forEach(([start, end], i) => {
      expect(end).toBeGreaterThanOrEqual(start);
      expect(end).toBeLessThanOrEqual(now);
      if (i > 0) expect(start).toBeGreaterThanOrEqual(spans[i - 1]![1]);
      expect(worked.some(([from, to]) => start >= from && end <= to)).toBe(true);
    });
  }
}

const workedMinutes = (day: SeededDay) => workedSpans(day, 0).reduce((n, [from, to]) => n + (to - from) / MINUTE_MS, 0);

describe('seedDatabase', () => {
  it('writes rows that satisfy the same rules the routes enforce', () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    const m = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW, running: true });

    expect(m.days).toHaveLength(DEFAULT_HISTORY_DAYS + 1);
    expect(m.days.at(-1)!.date).toBe(SEED_TODAY);
    expect(m.days.map((d) => d.date)).toEqual(m.days.map((d) => d.date).sort());
    for (const day of m.days) {
      expect(isWeekend(day.date)).toBe(false);

      // Punches: positions 0..n, parity kinds, the last row is a Clock out.
      expect(day.punches.map((p) => p.position)).toEqual(day.punches.map((_, i) => i));
      expect(day.punches.every((p) => p.kind === (p.position % 2 === 0 ? 'in' : 'out'))).toBe(true);
      expect(day.punches.length % 2).toBe(0);
      expect(day.punches.length).toBeGreaterThanOrEqual(4);
      const set = day.punches.filter((p) => p.at != null).map((p) => p.at!);
      expect(set).toEqual([...set].sort((a, b) => a - b));

      // Priorities: positions 1..n, each naming its task, with a time.
      expect(day.priorities.map((p) => p.position)).toEqual(day.priorities.map((_, i) => i + 1));
      for (const p of day.priorities) {
        expect(p.text).not.toBe('');
        expect(p.uid).toMatch(/^[a-z0-9]{12}$/);
        expect(p.addedAt).toBeGreaterThan(0);
      }

      // Sessions: each task is on the same day's list, and a cancelled one has none.
      const uids = new Set(day.priorities.map((p) => p.uid));
      for (const s of day.sessions) {
        if (s.priorityUid !== null) expect(uids.has(s.priorityUid)).toBe(true);
        if (s.status === 'cancelled') expect(s.priorityUid).toBeNull();
        if (s.status === 'running') expect(s.endedAt).toBeNull();
        else expect(s.endedAt).toBeGreaterThan(s.startedAt);
      }
      expect(day.createdAt).toBeLessThan(day.punches[0]!.at!);
    }

    expectConsistent(m, SEED_NOW);
    expectTasksInStep(db, m);
    // Captured on the board: three in Later and one in Next, on no list.
    const named = (uid: string | null) => m.board.categories.find((c) => c.uid === uid)?.name;
    expect(m.board.cards.filter((c) => c.listDate == null).map((c) => [c.lane, c.position, c.title, named(c.categoryUid)])).toEqual([
      ['later', 1, 'Write a KB for the SSO reset', 'Knowledge base'],
      ['later', 2, 'Review canned replies', 'Knowledge base'],
      ['later', 3, 'Look into the export timeout', 'Tickets'],
      ['next', 1, 'Follow up on the Acme SLA', 'Follow-ups'],
    ]);
    // A task typed on a list has no lane.
    expect(m.board.cards.filter((c) => c.listDate != null && c.lane != null)).toEqual([]);
    // Two tasks have a note, one of them on two lines.
    expect(m.board.cards.filter((c) => c.note !== '').map((c) => [c.title, c.note.split('\n').length])).toEqual([
      ['Write a KB for the SSO reset', 1],
      ['Answer the two open support threads', 2],
    ]);
    const extra = m.days.at(-2)!;
    const today = m.days.at(-1)!;
    // Most rows have a category, and so does each unplanned Inbox session; a session on a task
    // counts under the task's, and is named by it.
    const rows = m.days.flatMap((d) => d.priorities);
    expect(rows.filter((p) => p.categoryUid != null).length).toBeGreaterThan(rows.length / 2);
    const sessions = m.days.flatMap((d) => d.sessions.map((s) => ({ ...s, row: d.priorities.find((p) => p.uid === s.priorityUid) })));
    expect(sessions.filter((s) => s.row == null && s.categoryUid != null).every((s) => s.label === 'Inbox' && named(s.categoryUid) === 'Tickets')).toBe(true);
    expect(sessions.filter((s) => s.label === 'Inbox').every((s) => named(s.categoryUid) === 'Tickets')).toBe(true);
    for (const s of sessions.filter((s) => s.row != null)) expect([s.title, s.categoryUid]).toEqual([s.row!.text, s.row!.categoryUid]);
    expect(countRows(db, 'items', 'weekdays IS NULL')).toBe(new Set(rows.filter((p) => !p.recurring).map((p) => p.uid)).size + 4);
    // Two recurring priorities for support work, each in its category.
    expect(m.board.recurring.map((r) => [r.title, r.weekdays, named(r.categoryUid)])).toEqual([
      ['Monitor the queue', [1, 2, 3, 4, 5], 'Tickets'],
      ['Follow-ups', [1, 3, 5], 'Follow-ups'],
    ]);
    expect(countRows(db, 'items', 'weekdays IS NOT NULL')).toBe(m.board.recurring.length);
    // Each past weekday lists the routines due on it, after its one-off rows and written with them.
    for (const day of m.days.slice(0, -1)) {
      const due = SEEDED_RECURRING.filter((r) => r.weekdays.includes(isoWeekday(day.date))).map((r) => r.uid);
      const routines = day.priorities.filter((p) => p.recurring);
      expect(
        routines.map((p) => p.uid),
        day.date,
      ).toEqual(due);
      expect(routines.map((p) => p.position)).toEqual(due.map((_, i) => day.priorities.length - due.length + i + 1));
      expect(routines.every((p) => p.addedAt === day.createdAt)).toBe(true);
    }
    // The same schedule by date, so a wrong weekday in the shared isoWeekday can't pass both: the
    // follow-ups fall on the Mondays, Wednesdays and Fridays before Wednesday 16 September.
    const followUps = SEEDED_RECURRING.find((r) => r.title === 'Follow-ups')!.uid;
    expect(m.days.filter((d) => d.priorities.some((p) => p.uid === followUps)).map((d) => d.date)).toEqual([
      '2026-09-02',
      '2026-09-04',
      '2026-09-07',
      '2026-09-09',
      '2026-09-11',
      '2026-09-14',
    ]);
    // Some ticked, some missed, some with focus logged; none on today.
    const routineRows = m.days.flatMap((d) => d.priorities.filter((p) => p.recurring).map((p) => ({ ...p, day: d })));
    expect(routineRows.some((p) => p.done) && routineRows.some((p) => !p.done)).toBe(true);
    expect(routineRows.some((p) => p.day.sessions.some((s) => s.priorityUid === p.uid))).toBe(true);
    expect(m.days.at(-1)!.priorities.some((p) => p.recurring)).toBe(false);

    // Every template shows up in the last week, and today has the one running timer.
    expect(new Set(m.days.map((d) => d.kind))).toEqual(new Set(['normal', 'extraPair', 'overtime', 'unreviewed', 'noLunch', 'today']));
    expect(countRows(db, 'sessions', `status = 'running'`)).toBe(1);
    expect(m.days.at(-1)!.sessions.filter((s) => s.status === 'running')).toHaveLength(1);
    const unreviewed = m.days.find((d) => d.kind === 'unreviewed')!;
    expect(unreviewed.retroAt).toBeNull();
    expect(unreviewed.retroNote).not.toBe('');
    // Past ten hours worked, so the second meal period applies, and it was taken after lunch.
    const overtime = m.days.find((d) => d.kind === 'overtime')!;
    expect(overtime.overtimeApproved).toBe(true);
    expect(workedMinutes(overtime)).toBeGreaterThan(DEFAULT_SETTINGS.secondMealAfterMinutes);
    expect(overtime.punches).toHaveLength(6);
    // The half day ends on its own target rather than short of the usual one.
    const half = m.days.find((d) => d.kind === 'noLunch')!;
    expect(half.punches.map((p) => p.at == null)).toEqual([false, true, true, false]);
    expect(workedMinutes(half)).toBe(half.workMinutes);
    expect(m.days.filter((d) => d.workMinutes != null)).toEqual([half]);
    // The last weekday, which the README's retrospective shot shows, has a row added mid-day.
    expect(extra.kind).toBe('extraPair');
    expect(extra.punches).toHaveLength(6);
    const firstStart = Math.min(...extra.sessions.filter((s) => s.status === 'completed').map((s) => s.startedAt));
    expect(extra.priorities.filter((p) => p.addedAt > firstStart)).toHaveLength(1);

    // Today's list was planned at the end of that day's retrospective (expectTasksInStep checks the carry).
    expect(today.priorities.every((p) => p.addedAt > extra.retroAt! && p.addedAt < today.punches[0]!.at!)).toBe(true);
    // A session paused and finished short of its plan, and a break ended early.
    const paused = today.sessions.find((s) => s.pausedSeconds > 0)!;
    expect(paused.endedAt! - paused.startedAt - paused.pausedSeconds * 1000).toBeLessThan(paused.plannedSeconds * 1000);
    expect(today.breaks.some((b) => b.endedAt < b.startedAt + b.plannedSeconds * 1000)).toBe(true);

    // What the manifest says is what the DB holds.
    const c = counts(db);
    expect(c.days).toBe(m.days.length);
    expect(c.punches).toBe(m.days.reduce((n, d) => n + d.punches.length, 0));
    expect(c.priorities).toBe(m.days.reduce((n, d) => n + d.priorities.length, 0));
    expect(c.sessions).toBe(m.days.reduce((n, d) => n + d.sessions.length, 0));
    expect(c.breaks).toBe(m.days.reduce((n, d) => n + d.breaks.length, 0));
    db.close();
  });

  it('writes nothing the API would refuse to take back', async () => {
    const app = await startTestApp({ seed: { running: true } });
    try {
      for (const day of app.seeded!.days) {
        // What the inserts wrote reads back as the manifest has it, every field of every row.
        expect((await app.api.get<Day>(`/api/days/${day.date}`)).body.priorities).toEqual(day.priorities);
        const punches = await app.api.put(`/api/days/${day.date}/punches`, { punches: day.punches.map((p) => ({ at: p.at })) });
        expect(punches).toMatchObject({ status: 200, body: { punches: day.punches } });
        const priorities = await app.api.put(`/api/days/${day.date}/priorities`, { priorities: day.priorities });
        expect(priorities).toMatchObject({ status: 200, body: { priorities: day.priorities } });
        const target = await app.api.put(`/api/days/${day.date}/target`, { workMinutes: day.workMinutes });
        expect(target).toMatchObject({ status: 200, body: { workMinutes: day.workMinutes } });
      }
      // The log's time for the paused session leaves the pause out; it is the unplanned Inbox
      // session, with its category.
      const today = (await app.api.get<Day>(`/api/days/${SEED_TODAY}`)).body;
      const paused = today.sessions.find((s) => s.pausedSeconds > 0)!;
      expect(paused).toMatchObject({
        label: 'Inbox',
        durationSeconds: 22 * 60,
        plannedSeconds: 25 * 60,
        priorityUid: null,
        title: null,
        categoryUid: 'cat000000001',
      });
      expect(today.sessions).toEqual(
        app
          .seeded!.days.at(-1)!
          .sessions.map((s) => expect.objectContaining({ id: s.id, priorityUid: s.priorityUid, title: s.title, categoryUid: s.categoryUid })),
      );
    } finally {
      await app.close();
    }
  });

  it('writes a board the API would take back, and reads it back at the seed time', async () => {
    // Only Date: the board's Done lane is read against the clock, and HTTP keeps its real timers.
    vi.useFakeTimers({ now: SEED_NOW, toFake: ['Date'] });
    const app = await startTestApp({ authMode: 'local' });
    try {
      const { admin, a, b } = await app.twoUsers();
      const m = seedDatabase(app.db, { userId: admin.id, today: SEED_TODAY, now: SEED_NOW });
      expect((await a.get('/api/board')).body).toEqual(m.board);
      // As another user: every category, recurring priority and task in a lane posts as it is, and
      // lands in the same order.
      for (const c of m.board.categories) expect((await b.post('/api/board/categories', { uid: c.uid, name: c.name, color: c.color })).status).toBe(201);
      for (const r of m.board.recurring) expect((await b.post('/api/items', r)).status).toBe(201);
      const laned = m.board.cards.filter((c) => c.lane != null);
      for (const c of laned) {
        expect((await b.post('/api/items', { uid: c.uid, title: c.title, categoryUid: c.categoryUid, lane: c.lane, before: null })).status).toBe(201);
      }
      const theirs = (await b.get('/api/board')).body as Board;
      expect(theirs.categories).toEqual(m.board.categories);
      expect(theirs.recurring).toEqual(m.board.recurring);
      const fields = (c: BoardCard) => [c.uid, c.title, c.categoryUid, c.lane, c.position];
      expect(theirs.cards.map(fields)).toEqual(laned.map(fields));
      // Today's list saved back: every row keeps its task, and the board stays as it was.
      const today = m.days.at(-1)!;
      const saved = await a.put(`/api/days/${SEED_TODAY}/priorities`, { priorities: today.priorities, base: today.priorities });
      expect(saved).toMatchObject({ status: 200, body: { priorities: today.priorities } });
      expect((await a.get('/api/board')).body).toEqual(m.board);
    } finally {
      await app.close();
      vi.useRealTimers();
    }
  });

  it('writes notes that agree with the day they are on', () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    const m = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW, days: 60 });
    // The notes speak of the day's one-off rows: its routines come after them on the list.
    const oneOffs = (d: SeededDay) => d.priorities.filter((p) => !p.recurring);
    const done = (d: SeededDay) => oneOffs(d).filter((p) => p.done).length;
    const claims: [RegExp, (d: SeededDay) => boolean][] = [
      [/^One done/, (d) => done(d) === 1],
      [/^Two of three done/, (d) => done(d) === 2 && oneOffs(d).length === 3],
      [/^(Finished everything|All three done)/, (d) => done(d) === oneOffs(d).length && d.overtimeApproved],
      [/^Half day/, (d) => d.workMinutes != null && d.punches[1]!.at == null],
      [/one of the two done/, (d) => done(d) === 1 && oneOffs(d).length === 2],
      [/recruiter/, (d) => d.priorities.some((p) => p.text === 'Reply to the recruiter')],
      [/Out for twenty minutes at three/, (d) => workedSpans(d, 0).some(([, to]) => new Date(to).getHours() === 15)],
    ];
    for (const [re, holds] of claims) {
      const days = m.days.filter((d) => re.test(d.retroNote));
      // Sixty days are enough for every claim to turn up.
      expect(days.length, String(re)).toBeGreaterThan(0);
      for (const day of days) expect(holds(day), `${day.date}: ${day.retroNote}`).toBe(true);
    }
    db.close();
  });

  it("is repeatable and replaces only the user's days unless fresh", () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    db.prepare(`INSERT INTO settings (user_id, json) VALUES (?, '{"workMinutes":1}')`).run(user.id);
    db.prepare(`INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, 'h', 1, 2, 1)`).run(user.id);
    const first = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW });
    const before = counts(db);
    // A sample task deleted in the browser leaves its tombstone under its fixed uid: a run clears it.
    db.prepare(`UPDATE items SET deleted_at = 1, lane = NULL WHERE uid = ?`).run(first.days.at(-1)!.priorities[0]!.uid);
    const second = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW });
    expect(counts(db)).toEqual(before);
    expect(before.settings).toBe(1);
    expect(before.auth_sessions).toBe(1);
    expect(second).toEqual(first);

    seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW, fresh: true });
    expect(counts(db)).toEqual({ ...before, settings: 0, auth_sessions: 0 });
    db.close();
  });

  it('seeds one user without touching another', async () => {
    const db = openDatabase(':memory:');
    const { admin, member } = await ensureLocalUsers(db);
    expect(await ensureLocalUsers(db)).toEqual({ admin, member });
    seedDatabase(db, { userId: admin.id, today: SEED_TODAY, now: SEED_NOW, days: 2 });
    seedDatabase(db, { userId: member.id, today: SEED_TODAY, now: SEED_NOW, days: 1 });
    seedDatabase(db, { userId: admin.id, today: SEED_TODAY, now: SEED_NOW, days: 3 });
    const perUser = db.prepare(`SELECT user_id, COUNT(*) AS n FROM days GROUP BY user_id ORDER BY user_id`).all();
    expect(perUser).toEqual([
      { user_id: admin.id, n: 4 },
      { user_id: member.id, n: 2 },
    ]);
    db.close();
  });

  it('reuses a local account whose name differs only in case', async () => {
    const db = openDatabase(':memory:');
    const info = db
      .prepare(`INSERT INTO users (kind, username, password_hash, display_name, is_admin, created_at) VALUES ('local', 'Sam', 'x', 'Sam', 0, 0)`)
      .run();
    const { admin, member } = await ensureLocalUsers(db);
    expect(member).toMatchObject({ id: Number(info.lastInsertRowid), username: 'Sam' });
    expect(admin.username).toBe(LOCAL_USERS.admin);
    expect(countRows(db, 'users', `kind = 'local'`)).toBe(2);
    db.close();
  });

  it('keeps a seed soon after midnight on the right date, with nothing overlapping the running timer', () => {
    for (const [hour, minute] of [
      [0, 1],
      [1, 0],
      [2, 0],
    ] as const) {
      const db = openDatabase(':memory:');
      const user = ensureDefaultUser(db);
      const now = atTime(SEED_TODAY, hour, minute);
      const m = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now, running: true });
      expectConsistent(m, now);
      expectTasksInStep(db, m);
      expect(m.board.cards.every((c) => c.createdAt <= now)).toBe(true);
      expect(m.days.at(-1)!.sessions.filter((s) => s.status === 'running')).toHaveLength(1);
      db.close();
    }
  });

  it('plans today on arrival when there is no history to carry over', () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    const m = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW, days: 0 });
    expect(m.days).toHaveLength(1);
    expectConsistent(m, SEED_NOW);
    expectTasksInStep(db, m);
    const today = m.days[0]!;
    expect(today.priorities.every((p) => p.addedAt === today.createdAt && p.addedAt < today.punches[0]!.at!)).toBe(true);
    db.close();
  });
});

describe('calendar helpers', () => {
  it('walks back over weekdays only', () => {
    // 2026-09-16 is a Wednesday.
    expect(weekdaysBefore('2026-09-16', 3)).toEqual(['2026-09-11', '2026-09-14', '2026-09-15']);
    expect(weekdaysBefore('2026-09-14', 1)).toEqual(['2026-09-11']);
    expect(weekdaysBefore('2026-09-16', 0)).toEqual([]);
  });

  it('counts the weekdays since a date', () => {
    expect(weekdaysSince('2026-09-14', '2026-09-16')).toBe(2);
    expect(weekdaysSince('2026-09-11', '2026-09-14')).toBe(1);
    // Last quarter and this one so far start on April 1, a weekday.
    const n = weekdaysSince(addMonths(startOfQuarter('2026-09-16'), -3), '2026-09-16');
    expect(weekdaysBefore('2026-09-16', n)[0]).toBe('2026-04-01');
  });

  it('spreads the templates out over a long history', () => {
    expect([0, 1, 2, 3, 4].map(kindForDistance)).toEqual(['extraPair', 'normal', 'overtime', 'unreviewed', 'noLunch']);
    const kinds = new Set(Array.from({ length: 60 }, (_, i) => kindForDistance(i + 5)));
    expect(kinds).toEqual(new Set(['normal', 'extraPair', 'overtime', 'unreviewed', 'noLunch']));
  });
});

describe('--sessions', () => {
  // What a browser check does with the printed line: send the cookie, be that user.
  const me = (app: TestApp, token: string) =>
    fetch(`${app.url}/api/auth/me`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }).then((r) => r.json() as Promise<{ user: unknown }>);

  it('signs a seeded local user in without the password', async () => {
    const app = await startTestApp({ authMode: 'local' });
    try {
      const { member } = await ensureLocalUsers(app.db);
      expect((await me(app, insertSession(app.db, app.config, member.id))).user).toMatchObject({ username: LOCAL_USERS.member, isAdmin: false });
    } finally {
      await app.close();
    }
  });

  it('makes one OIDC dev user, stored like a real sign-in, and signs it in the same way', async () => {
    const app = await startTestApp({ authMode: 'oidc' });
    try {
      const user = ensureOidcDevUser(app.db, app.config);
      expect(ensureOidcDevUser(app.db, app.config).id).toBe(user.id);
      expect(user).toMatchObject({ kind: 'oidc' });
      expect(user.oidc_sub).toBe(`${app.config.oidc!.issuer}|${OIDC_DEV_USER.sub}`);
      expect((await me(app, insertSession(app.db, app.config, user.id))).user).toMatchObject({ name: OIDC_DEV_USER.name });
    } finally {
      await app.close();
    }
  });
});
