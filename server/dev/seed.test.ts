import { describe, expect, it, vi } from 'vitest';
import { ensureDefaultUser, openDatabase } from '../db.js';
import { insertSession, SESSION_COOKIE } from '../auth/session.js';
import { countRows, SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from './harness.js';
import { addMonths, DAY_MS, MINUTE_MS, parseDateKey, punchWindow, startOfQuarter, todayKey } from '../../shared/dates.js';
import { LIMITS } from '../../shared/api.js';
import { DEFAULT_SETTINGS, SETTING_LIMITS } from '../../shared/settings.js';
import { BREAK_SECONDS, MIN_BREAK_MS, PLANNED_SECONDS } from '../../shared/timer.js';
import {
  DEFAULT_HISTORY_DAYS,
  ensureLocalUsers,
  ensureOidcDevUser,
  kindForDistance,
  LOCAL_USERS,
  OIDC_DEV_USER,
  seedDatabase,
  weekdaysBefore,
  weekdaysSince,
  type SeededDay,
  type SeedManifest,
} from './seed.js';

const counts = (db: ReturnType<typeof openDatabase>) =>
  Object.fromEntries(['days', 'punches', 'priorities', 'sessions', 'breaks', 'settings', 'auth_sessions'].map((t) => [t, countRows(db, t)]));

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
      expect([0, 6]).not.toContain(parseDateKey(day.date).getDay());

      // Punches: positions 0..n, parity kinds, the last row is a Clock out.
      expect(day.punches.map((p) => p.position)).toEqual(day.punches.map((_, i) => i));
      expect(day.punches.every((p) => p.kind === (p.position % 2 === 0 ? 'in' : 'out'))).toBe(true);
      expect(day.punches.length % 2).toBe(0);
      expect(day.punches.length).toBeGreaterThanOrEqual(4);
      const set = day.punches.filter((p) => p.at != null).map((p) => p.at!);
      expect(set).toEqual([...set].sort((a, b) => a - b));

      // Priorities: positions 1..n, an id and a time on every (text) row, unique ids.
      expect(day.priorities.map((p) => p.position)).toEqual(day.priorities.map((_, i) => i + 1));
      for (const p of day.priorities) {
        expect(p.text).not.toBe('');
        expect(p.uid).toMatch(/^[a-z0-9]{12}$/);
        expect(p.addedAt).toBeGreaterThan(0);
      }
      expect(new Set(day.priorities.map((p) => p.uid)).size).toBe(day.priorities.length);

      // Sessions: links resolve on the same day.
      const uids = new Set(day.priorities.map((p) => p.uid));
      const clockIn = day.punches[0]!.at!;
      for (const s of day.sessions) {
        if (s.priorityUid !== null) expect(uids.has(s.priorityUid)).toBe(true);
        if (s.status === 'running') expect(s.endedAt).toBeNull();
        else expect(s.endedAt).toBeGreaterThan(s.startedAt);
      }
      expect(day.createdAt).toBeLessThan(clockIn);
    }

    expectConsistent(m, SEED_NOW);

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
    const extra = m.days.at(-2)!;
    expect(extra.kind).toBe('extraPair');
    expect(extra.punches).toHaveLength(6);
    const firstStart = Math.min(...extra.sessions.filter((s) => s.status === 'completed').map((s) => s.startedAt));
    expect(extra.priorities.filter((p) => p.addedAt > firstStart)).toHaveLength(1);

    // Today's list was planned at the end of that day's retrospective, carrying its open row.
    const today = m.days.at(-1)!;
    expect(today.priorities.every((p) => p.addedAt > extra.retroAt! && p.addedAt < today.punches[0]!.at!)).toBe(true);
    expect(today.priorities[0]!.text).toBe(extra.priorities.find((p) => !p.done)!.text);
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
        const punches = await app.api.put(`/api/days/${day.date}/punches`, { punches: day.punches.map((p) => ({ at: p.at })) });
        expect(punches).toMatchObject({ status: 200, body: { punches: day.punches } });
        const priorities = await app.api.put(`/api/days/${day.date}/priorities`, { priorities: day.priorities });
        expect(priorities).toMatchObject({ status: 200, body: { priorities: day.priorities } });
        const target = await app.api.put(`/api/days/${day.date}/target`, { workMinutes: day.workMinutes });
        expect(target).toMatchObject({ status: 200, body: { workMinutes: day.workMinutes } });
      }
      // The log's time for the paused session leaves the pause out.
      const today = (await app.api.get(`/api/days/${SEED_TODAY}`)).body as {
        sessions: { pausedSeconds: number; durationSeconds: number; plannedSeconds: number }[];
      };
      const paused = today.sessions.find((s) => s.pausedSeconds > 0)!;
      expect(paused).toMatchObject({ durationSeconds: 22 * 60, plannedSeconds: 25 * 60 });
    } finally {
      await app.close();
    }
  });

  it('writes notes that agree with the day they are on', () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    const m = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW, days: 60 });
    const done = (d: SeededDay) => d.priorities.filter((p) => p.done).length;
    const claims: [RegExp, (d: SeededDay) => boolean][] = [
      [/^One done/, (d) => done(d) === 1],
      [/^Two of three done/, (d) => done(d) === 2 && d.priorities.length === 3],
      [/^(Finished everything|All three done)/, (d) => done(d) === d.priorities.length && d.overtimeApproved],
      [/^Half day/, (d) => d.workMinutes != null && d.punches[1]!.at == null],
      [/one of the two done/, (d) => done(d) === 1 && d.priorities.length === 2],
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
      const now = new Date(2026, 8, 16, hour, minute).getTime();
      const m = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now, running: true });
      expectConsistent(m, now);
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
    // Two full quarters back to April land at the quarter start on the first weekday.
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
    // No provider listens at the issuer, and nothing here needs one: keep any logged attempt to reach it out of the output.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await startTestApp({ authMode: 'oidc' });
    try {
      const user = ensureOidcDevUser(app.db, app.config);
      expect(ensureOidcDevUser(app.db, app.config).id).toBe(user.id);
      expect(user.oidc_sub).toBe(`${app.config.oidc!.issuer}|${OIDC_DEV_USER.sub}`);
      expect((await me(app, insertSession(app.db, app.config, user.id))).user).toMatchObject({ name: OIDC_DEV_USER.name, kind: 'oidc' });
    } finally {
      await app.close();
      quiet.mockRestore();
    }
  });
});
