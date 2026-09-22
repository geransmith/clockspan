import { describe, expect, it, vi } from 'vitest';
import { ensureDefaultUser, openDatabase } from '../db.js';
import { insertSession, SESSION_COOKIE } from '../auth/session.js';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from './harness.js';
import {
  DEFAULT_HISTORY_DAYS,
  ensureLocalUsers,
  ensureOidcDevUser,
  kindForDistance,
  LOCAL_USERS,
  OIDC_DEV_USER,
  quarterStart,
  seedDatabase,
  weekdaysBefore,
  weekdaysSince,
} from './seed.js';

const counts = (db: ReturnType<typeof openDatabase>) =>
  Object.fromEntries(
    ['days', 'punches', 'priorities', 'sessions', 'settings', 'auth_sessions'].map((t) => [
      t,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );

describe('seedDatabase', () => {
  it('writes rows that satisfy the same rules the routes enforce', () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    const m = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW, running: true });

    expect(m.days).toHaveLength(DEFAULT_HISTORY_DAYS + 1);
    expect(m.days.at(-1)!.date).toBe(SEED_TODAY);
    expect(m.days.map((d) => d.date)).toEqual(m.days.map((d) => d.date).sort());
    for (const day of m.days) {
      const [y, mo, d] = day.date.split('-').map(Number) as [number, number, number];
      expect([0, 6]).not.toContain(new Date(y, mo - 1, d).getDay());

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

      // Sessions: links resolve on the same day, times sit inside the punched day.
      const uids = new Set(day.priorities.map((p) => p.uid));
      const clockIn = day.punches[0]!.at!;
      const clockOut = day.punches.at(-1)!.at;
      for (const s of day.sessions) {
        if (s.priorityUid !== null) expect(uids.has(s.priorityUid)).toBe(true);
        expect(s.startedAt).toBeGreaterThanOrEqual(clockIn);
        if (s.status === 'running') expect(s.endedAt).toBeNull();
        else {
          expect(s.endedAt).toBeGreaterThan(s.startedAt);
          if (clockOut != null) expect(s.endedAt!).toBeLessThanOrEqual(clockOut);
        }
      }
      expect(day.createdAt).toBeLessThan(clockIn);
    }

    // Every template shows up in the last week, and today has the one running timer.
    expect(new Set(m.days.map((d) => d.kind))).toEqual(new Set(['normal', 'extraPair', 'overtime', 'unreviewed', 'noLunch', 'today']));
    const running = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status = 'running'`).get() as { n: number };
    expect(running.n).toBe(1);
    expect(m.days.at(-1)!.sessions.filter((s) => s.status === 'running')).toHaveLength(1);
    expect(m.days.find((d) => d.kind === 'unreviewed')!.retroAt).toBeNull();
    expect(m.days.find((d) => d.kind === 'overtime')!.overtimeApproved).toBe(true);
    expect(m.days.find((d) => d.kind === 'noLunch')!.punches.map((p) => p.at == null)).toEqual([false, true, true, false]);
    const extra = m.days.find((d) => d.kind === 'extraPair')!;
    expect(extra.punches).toHaveLength(6);
    const firstStart = Math.min(...extra.sessions.filter((s) => s.status === 'completed').map((s) => s.startedAt));
    expect(extra.priorities.filter((p) => p.addedAt > firstStart)).toHaveLength(1);

    // What the manifest says is what the DB holds.
    const c = counts(db);
    expect(c.days).toBe(m.days.length);
    expect(c.punches).toBe(m.days.reduce((n, d) => n + d.punches.length, 0));
    expect(c.priorities).toBe(m.days.reduce((n, d) => n + d.priorities.length, 0));
    expect(c.sessions).toBe(m.days.reduce((n, d) => n + d.sessions.length, 0));
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
    const strip = (m: typeof first) => m.days.map((d) => ({ ...d, sessions: d.sessions.map(({ id: _id, ...s }) => s) }));
    expect(strip(second)).toEqual(strip(first));

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

  it('keeps a 01:00 seed on the right date', () => {
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    const m = seedDatabase(db, { userId: user.id, today: SEED_TODAY, now: new Date(2026, 8, 16, 1, 0).getTime(), days: 0 });
    expect(m.days).toHaveLength(1);
    expect(new Date(m.days[0]!.punches[0]!.at!).getDate()).toBe(16);
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

  it('finds quarter starts and counts the weekdays since', () => {
    expect(quarterStart('2026-09-16')).toBe('2026-07-01');
    expect(quarterStart('2026-09-16', 1)).toBe('2026-04-01');
    expect(quarterStart('2026-01-15', 1)).toBe('2025-10-01');
    expect(weekdaysSince('2026-09-14', '2026-09-16')).toBe(2);
    expect(weekdaysSince('2026-09-11', '2026-09-14')).toBe(1);
    // Two full quarters back to April land at the quarter start on the first weekday.
    const n = weekdaysSince(quarterStart('2026-09-16', 1), '2026-09-16');
    expect(weekdaysBefore('2026-09-16', n)[0]).toBe('2026-04-01');
  });

  it('spreads the templates out over a long history', () => {
    expect([0, 1, 2, 3, 4].map(kindForDistance)).toEqual(['normal', 'extraPair', 'overtime', 'unreviewed', 'noLunch']);
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
    // Discovery retries against a port nothing listens on and logs each failure.
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
