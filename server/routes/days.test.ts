import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { ensureLocalUsers, LOCAL_USERS, seedDatabase } from '../dev/seed.js';
import { MAX_PRIORITIES } from '../../shared/settings.js';
import { punchWindow } from '../../shared/dates.js';

/** An instant on 2026-09-01 in any zone: its UTC midnight plus a few hours. */
const T0 = Date.UTC(2026, 8, 1);
const HOUR = 3_600_000;

let app: TestApp;
beforeEach(async () => {
  app = await startTestApp({ seed: true });
});
afterEach(() => app.close());

const seededDay = (kind: string) => app.seeded!.days.find((d) => d.kind === kind)!;

describe('GET /api/days/:date', () => {
  it('returns an empty day for a date with no rows', async () => {
    const r = await app.api.get('/api/days/2020-01-01');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ date: '2020-01-01', punches: [], priorities: [], overtimeApproved: false, retroNote: '', retroAt: null, sessions: [] });
  });

  it('rejects an invalid date', async () => {
    expect((await app.api.get('/api/days/2026-02-30')).status).toBe(400);
    expect((await app.api.get('/api/days/today')).status).toBe(400);
  });

  it('returns a seeded day without its cancelled sessions', async () => {
    const day = seededDay('unreviewed');
    const r = await app.api.get(`/api/days/${day.date}`);
    expect(r.status).toBe(200);
    expect(r.body.punches).toEqual(day.punches);
    expect(r.body.priorities.map((p: { position: number }) => p.position)).toEqual([1, 2, 3]);
    expect(r.body.retroAt).toBeNull();
    expect(r.body.sessions.map((s: { status: string }) => s.status)).toEqual(['completed', 'completed']);
    expect(day.sessions.some((s) => s.status === 'cancelled')).toBe(true);
  });

  it('carries the per-day flags and the retro note', async () => {
    const day = seededDay('overtime');
    const r = await app.api.get(`/api/days/${day.date}`);
    expect(r.body.overtimeApproved).toBe(true);
    expect(r.body.retroNote).toBe(day.retroNote);
    expect(r.body.retroAt).toBe(day.retroAt);
    const linked = r.body.sessions.find((s: { priorityUid: string | null }) => s.priorityUid);
    expect(linked.durationSeconds).toBe(linked.plannedSeconds);
  });
});

describe('PUT /api/days/:date/punches', () => {
  it('replaces the rows and derives kind from position parity', async () => {
    const r = await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: T0 + 8 * HOUR + 0.4 }, { at: null }, { at: null }, { at: T0 + 17 * HOUR }] });
    expect(r.status).toBe(200);
    expect(r.body.punches).toEqual([
      { position: 0, kind: 'in', at: T0 + 8 * HOUR },
      { position: 1, kind: 'out', at: null },
      { position: 2, kind: 'in', at: null },
      { position: 3, kind: 'out', at: T0 + 17 * HOUR },
    ]);
    const again = await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: T0 + 9 * HOUR }, { at: null }] });
    expect(again.body.punches).toHaveLength(2);
    expect((await app.api.get('/api/days/2026-09-01')).body.punches).toHaveLength(2);
  });

  it('validates the body', async () => {
    expect((await app.api.put('/api/days/2026-09-01/punches', { punches: 'x' })).status).toBe(400);
    expect((await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: 'noon' }] })).status).toBe(400);
    // A time the client could never format would break every render of that day.
    for (const at of [1e308, -1e308, 2 ** 53, Number.MAX_SAFE_INTEGER]) {
      const r = await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at }] });
      expect(r.status, String(at)).toBe(400);
      expect(r.body.error).toBe('Punch 0 has an invalid time.');
    }
    // A punch belongs to its day, with a day of slack for the zone that wrote it.
    const { from, to } = punchWindow('2026-09-01');
    expect((await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: from }, { at: to }] })).status).toBe(200);
    expect((await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: from - 1 }] })).status).toBe(400);
    expect((await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: null }, { at: to + 1 }] })).body.error).toBe('Punch 1 has an invalid time.');
    expect((await app.api.get('/api/days/2026-09-01')).body.punches.map((p: { at: number }) => p.at)).toEqual([from, to]);
    const tooMany = await app.api.put('/api/days/2026-09-01/punches', { punches: Array(41).fill({ at: null }) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatch(/limited to 40/);
    expect((await app.api.put('/api/days/bad/punches', { punches: [] })).status).toBe(400);
  });
});

describe('PUT /api/days/:date/priorities', () => {
  it('renumbers, keeps client ids, and mints ids only for text rows without one', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', {
      priorities: [
        { text: 'Kept', done: true, uid: 'ABCDEF123456', addedAt: 100 },
        { text: '', done: true },
        { text: 'Minted' },
      ],
    });
    expect(r.status).toBe(200);
    const [a, b, c] = r.body.priorities;
    expect(a).toEqual({ position: 1, text: 'Kept', done: true, uid: 'abcdef123456', addedAt: 100 });
    // An empty row is never done and never gets an id.
    expect(b).toEqual({ position: 2, text: '', done: false, uid: null, addedAt: null });
    expect(c.position).toBe(3);
    expect(c.uid).toMatch(/^[a-f0-9]{12}$/);
    expect(typeof c.addedAt).toBe('number');
  });

  it('is a full replace: omitting a row removes it', async () => {
    await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] });
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'Three' }] });
    expect(r.body.priorities).toHaveLength(1);
    const day = await app.api.get('/api/days/2026-09-01');
    expect(day.body.priorities.map((p: { text: string; position: number }) => [p.position, p.text])).toEqual([[1, 'Three']]);
  });

  it('rejects an addedAt it could not have stamped', async () => {
    const bad = async (addedAt: unknown) => {
      const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'x', addedAt }] });
      expect(r.status, String(addedAt)).toBe(400);
      expect(r.body.error).toBe('Priority 1 has an invalid addedAt.');
    };
    await bad(1e308);
    await bad(-1);
    await bad(Date.now() + 2 * 86_400_000);
    await bad('yesterday');
    // Absent or null is fine: the server stamps a text row itself.
    const ok = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'x', addedAt: null }, { text: 'y' }] });
    expect(ok.status).toBe(200);
    for (const p of ok.body.priorities) expect(typeof p.addedAt).toBe('number');
  });

  it('rejects duplicate ids and oversized lists', async () => {
    const dup = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'a', uid: 'aaaaaaaaaaaa' }, { text: 'b', uid: 'AAAAAAAAAAAA' }] });
    expect(dup.status).toBe(400);
    const big = await app.api.put('/api/days/2026-09-01/priorities', { priorities: Array(MAX_PRIORITIES + 1).fill({ text: 'x' }) });
    expect(big.status).toBe(400);
    expect((await app.api.put('/api/days/2026-09-01/priorities', { priorities: null })).status).toBe(400);
  });
});

describe('PUT /api/days/:date/overtime', () => {
  it('sets and clears the flag', async () => {
    expect((await app.api.put('/api/days/2026-09-01/overtime', { approved: true })).body).toEqual({ overtimeApproved: true });
    expect((await app.api.get('/api/days/2026-09-01')).body.overtimeApproved).toBe(true);
    expect((await app.api.put('/api/days/2026-09-01/overtime', { approved: false })).body).toEqual({ overtimeApproved: false });
    expect((await app.api.put('/api/days/2026-09-01/overtime', { approved: 'yes' })).status).toBe(400);
  });
});

describe('PUT /api/days/:date/retro', () => {
  it('stores the note, keeps the first reviewed-at, and clears it on undo', async () => {
    const note = await app.api.put('/api/days/2026-09-01/retro', { note: 'x'.repeat(5000) });
    expect(note.body.retroNote).toHaveLength(4000);
    expect(note.body.retroAt).toBeNull();
    const first = await app.api.put('/api/days/2026-09-01/retro', { done: true });
    expect(typeof first.body.retroAt).toBe('number');
    const second = await app.api.put('/api/days/2026-09-01/retro', { done: true, note: 'kept' });
    expect(second.body.retroAt).toBe(first.body.retroAt);
    expect(second.body.retroNote).toBe('kept');
    expect((await app.api.put('/api/days/2026-09-01/retro', { done: false })).body.retroAt).toBeNull();
  });

  it('validates types', async () => {
    expect((await app.api.put('/api/days/2026-09-01/retro', { note: 1 })).status).toBe(400);
    expect((await app.api.put('/api/days/2026-09-01/retro', { done: 'yes' })).status).toBe(400);
  });
});

describe('GET /api/days', () => {
  it('summarises each day from completed sessions and text rows only', async () => {
    const r = await app.api.get('/api/days');
    expect(r.status).toBe(200);
    expect(r.body.days.map((d: { date: string }) => d.date)).toEqual([...app.seeded!.days].reverse().map((d) => d.date));
    for (const summary of r.body.days) {
      const day = app.seeded!.days.find((d) => d.date === summary.date)!;
      const focus = day.sessions.filter((s) => s.status === 'completed').reduce((n, s) => n + (s.endedAt! - s.startedAt), 0);
      expect(summary.focusSeconds).toBe(Math.round(focus / 1000));
      expect(summary.prioritiesTotal).toBe(day.priorities.filter((p) => p.text).length);
      expect(summary.prioritiesDone).toBe(day.priorities.filter((p) => p.text && p.done).length);
      expect(summary.retroAt).toBe(day.retroAt);
      expect(summary.punches).toEqual(day.punches);
    }
  });

  it('honours and clamps limit', async () => {
    expect((await app.api.get('/api/days?limit=2')).body.days).toHaveLength(2);
    expect((await app.api.get('/api/days?limit=0')).body.days).toHaveLength(app.seeded!.days.length);
    expect((await app.api.get('/api/days?limit=abc')).body.days).toHaveLength(app.seeded!.days.length);
  });
});

describe('/api/days/prune', () => {
  const seededDates = () => app.seeded!.days.map((d) => d.date);
  const storedDates = () => (app.db.prepare(`SELECT date FROM days ORDER BY date`).all() as { date: string }[]).map((d) => d.date);

  it('previews what a cutoff would delete', async () => {
    const dates = seededDates();
    const before = dates[3]!;
    const r = await app.api.get(`/api/days/prune?before=${before}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ before, matching: 3, total: dates.length, oldest: dates[0], serverMaxDays: null });
    expect((await app.api.get(`/api/days/prune?before=${dates[0]}`)).body.matching).toBe(0);
    expect((await app.api.get('/api/days/prune?before=x')).status).toBe(400);
    expect((await app.api.get('/api/days/prune')).status).toBe(400);
  });

  it('reports the server cap when one is set', async () => {
    await app.close();
    app = await startTestApp({ seed: true, env: { RETENTION_DAYS: '90' } });
    expect((await app.api.get('/api/days/prune?before=2020-01-01')).body.serverMaxDays).toBe(90);
  });

  it('deletes the days before the cutoff with everything hanging off them, for this user only', async () => {
    const dates = seededDates();
    const before = dates[3]!;
    const doomed = app.seeded!.days.slice(0, 3);
    const ids = (app.db.prepare(`SELECT id FROM days WHERE date < ?`).all(before) as { id: number }[]).map((d) => d.id);
    const count = (table: string) =>
      (app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE day_id IN (${ids.join(',')})`).get() as { n: number }).n;
    expect(count('punches')).toBe(doomed.reduce((n, d) => n + d.punches.length, 0));
    expect(count('sessions')).toBe(doomed.reduce((n, d) => n + d.sessions.length, 0));

    // Another user's day on the same date must survive.
    const other = Number(app.db.prepare(`INSERT INTO users (kind, display_name, created_at) VALUES ('local', 'Other', 0)`).run().lastInsertRowid);
    app.db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, ?, 0)`).run(other, dates[0]);

    const r = await app.api.post('/api/days/prune', { before });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: 3 });
    expect(storedDates()).toEqual([dates[0], ...dates.slice(3)]);
    expect(app.db.prepare(`SELECT user_id FROM days WHERE date = ?`).all(dates[0])).toEqual([{ user_id: other }]);
    expect(count('punches')).toBe(0);
    expect(count('priorities')).toBe(0);
    expect(count('sessions')).toBe(0);
    expect((await app.api.post('/api/days/prune', { before })).body).toEqual({ deleted: 0 });
    expect((await app.api.post('/api/days/prune', { before: 'soon' })).status).toBe(400);
    expect((await app.api.post('/api/days/prune', {})).status).toBe(400);
  });

  it('never deletes a day with a running timer', async () => {
    await app.close();
    app = await startTestApp({ seed: { running: true } });
    const r = await app.api.post('/api/days/prune', { before: '2099-01-01' });
    expect(r.body).toEqual({ deleted: app.seeded!.days.length - 1 });
    expect(storedDates()).toEqual([SEED_TODAY]);
    expect((await app.api.get('/api/sessions/running')).body.session).not.toBeNull();
  });
});

describe('GET /api/days/range', () => {
  it('returns full days that exist, in order', async () => {
    const r = await app.api.get(`/api/days/range?from=2026-09-14&to=${SEED_TODAY}`);
    expect(r.status).toBe(200);
    expect(r.body.days.map((d: { date: string }) => d.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(r.body.days[0].sessions.length).toBeGreaterThan(0);
    expect((await app.api.get('/api/days/range?from=2020-01-01&to=2020-01-31')).body.days).toEqual([]);
  });

  it('validates the range', async () => {
    expect((await app.api.get('/api/days/range?from=2026-09-16&to=2026-09-15')).status).toBe(400);
    expect((await app.api.get('/api/days/range?from=2025-01-01&to=2026-09-16')).status).toBe(400);
    expect((await app.api.get('/api/days/range?from=x&to=2026-09-16')).status).toBe(400);
    expect((await app.api.get('/api/days/range')).status).toBe(400);
  });
});

describe('days are scoped to the signed-in user', () => {
  // The file-level hooks give every test a seeded AUTH_MODE=none app; this block swaps it for
  // a local-auth one with two users (the outer afterEach still closes it).
  beforeEach(async () => {
    await app.close();
    app = await startTestApp({ authMode: 'local' });
  });

  it('keeps every read and write on the caller\'s own rows', async () => {
    const { admin, member } = await ensureLocalUsers(app.db);
    const a = app.client();
    const b = app.client();
    expect((await a.post('/api/auth/login', { username: LOCAL_USERS.admin, password: LOCAL_USERS.password })).status).toBe(200);
    expect((await b.post('/api/auth/login', { username: LOCAL_USERS.member, password: LOCAL_USERS.password })).status).toBe(200);
    // A has a seeded history; B starts empty.
    const seeded = seedDatabase(app.db, { userId: admin.id, today: SEED_TODAY, now: SEED_NOW, days: 3 });
    const date = seeded.days[0]!.date;
    expect((await a.get(`/api/days/${date}`)).body.punches.length).toBeGreaterThan(0);

    // Reads: B sees nothing of A's.
    expect((await b.get(`/api/days/${date}`)).body).toMatchObject({ date, punches: [], priorities: [], sessions: [] });
    expect((await b.get('/api/days')).body.days).toEqual([]);
    expect((await b.get(`/api/days/range?from=${date}&to=${SEED_TODAY}`)).body.days).toEqual([]);
    expect((await b.get(`/api/days/prune?before=2099-01-01`)).body).toMatchObject({ matching: 0, total: 0, oldest: null });

    // Writes on the same date land on B's own day and leave A's untouched.
    const before = (await a.get(`/api/days/${date}`)).body;
    expect((await b.put(`/api/days/${date}/punches`, { punches: [{ at: punchWindow(date).from + 44 * HOUR }, { at: null }, { at: null }, { at: null }] })).status).toBe(200);
    expect((await b.put(`/api/days/${date}/priorities`, { priorities: [{ text: 'Mine' }] })).status).toBe(200);
    expect((await b.put(`/api/days/${date}/overtime`, { approved: true })).status).toBe(200);
    expect((await b.put(`/api/days/${date}/retro`, { note: 'b', done: true })).status).toBe(200);
    expect((await a.get(`/api/days/${date}`)).body).toEqual(before);
    const bDay = (await b.get(`/api/days/${date}`)).body;
    expect(bDay.priorities.map((p: { text: string }) => p.text)).toEqual(['Mine']);
    expect(bDay.overtimeApproved).toBe(true);
    expect(bDay.retroNote).toBe('b');
    expect(app.db.prepare(`SELECT user_id FROM days WHERE date = ? ORDER BY user_id`).all(date)).toEqual([{ user_id: admin.id }, { user_id: member.id }]);

    // A prune by B deletes only B's days.
    expect((await b.post('/api/days/prune', { before: '2099-01-01' })).body).toEqual({ deleted: 1 });
    expect((await a.get('/api/days')).body.days).toHaveLength(seeded.days.length);
    expect((await a.get(`/api/days/${date}`)).body).toEqual(before);
  });
});
