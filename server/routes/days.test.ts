import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { ensureDefaultUser } from '../db.js';
import { seedDatabase } from '../dev/seed.js';
import { ensureDay } from './shared.js';
import { MAX_PRIORITIES } from '../../shared/settings.js';
import { MAX_PUNCHES } from '../../shared/punches.js';
import { HOUR_MS, punchWindow } from '../../shared/dates.js';
import { LIMITS } from '../../shared/api.js';

/** An instant on 2026-09-01 in any zone: its UTC midnight plus a few hours. */
const T0 = Date.UTC(2026, 8, 1);

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
    expect(r.body).toEqual({
      date: '2020-01-01',
      punches: [],
      priorities: [],
      overtimeApproved: false,
      retroNote: '',
      retroAt: null,
      workMinutes: null,
      sessions: [],
      breaks: [],
    });
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
  });

  it('answers priorities in position order, here and in a range, whatever order the rows went in', async () => {
    const dayId = ensureDay(app.db, ensureDefaultUser(app.db).id, '2026-09-01');
    const insert = app.db.prepare(`INSERT INTO priorities (day_id, position, text) VALUES (?, ?, ?)`);
    insert.run(dayId, 2, 'Second');
    insert.run(dayId, 1, 'First');
    const positions = (priorities: { position: number }[]) => priorities.map((p) => p.position);
    expect(positions((await app.api.get('/api/days/2026-09-01')).body.priorities)).toEqual([1, 2]);
    expect(positions((await app.api.get('/api/days/range?from=2026-09-01&to=2026-09-01')).body.days[0].priorities)).toEqual([1, 2]);
  });
});

describe('PUT /api/days/:date/punches', () => {
  it('replaces the rows and derives kind from position parity', async () => {
    const r = await app.api.put('/api/days/2026-09-01/punches', {
      punches: [{ at: T0 + 8 * HOUR_MS + 0.4 }, { at: null }, { at: null }, { at: T0 + 17 * HOUR_MS }],
    });
    expect(r.status).toBe(200);
    expect(r.body.punches).toEqual([
      { position: 0, kind: 'in', at: T0 + 8 * HOUR_MS },
      { position: 1, kind: 'out', at: null },
      { position: 2, kind: 'in', at: null },
      { position: 3, kind: 'out', at: T0 + 17 * HOUR_MS },
    ]);
    const again = await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: T0 + 9 * HOUR_MS }, { at: null }] });
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
    const tooMany = await app.api.put('/api/days/2026-09-01/punches', { punches: Array(MAX_PUNCHES + 1).fill({ at: null }) });
    expect([tooMany.status, tooMany.body.error]).toEqual([400, `punches is limited to ${MAX_PUNCHES} rows.`]);
    expect((await app.api.put('/api/days/2026-09-01/punches', { punches: Array(MAX_PUNCHES).fill({ at: null }) })).status).toBe(200);
  });

  it('refuses a row that is not an object, and stores nothing', async () => {
    // A number or true used to be stored as an empty punch; 'x' and [1] were refused only because strings and arrays have an `at` method.
    for (const row of [5, true, 'x', [1], [{ at: T0 + 8 * HOUR_MS }]]) {
      const r = await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: T0 + 8 * HOUR_MS }, row] });
      expect([r.status, r.body.error], JSON.stringify(row)).toEqual([400, 'Punch 1 must be an object or null.']);
    }
    expect((await app.api.get('/api/days/2026-09-01')).body.punches).toEqual([]);
  });

  it("takes the web app's rows, and a null row as an empty one", async () => {
    // The client sends `{ at }` for every row, `at: null` for an empty one (putPunches in client/src/api.ts); a null row reads the same.
    const r = await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: T0 + 8 * HOUR_MS }, { at: null }, null, { at: T0 + 17 * HOUR_MS }] });
    expect(r.status).toBe(200);
    expect(r.body.punches.map((p: { at: number | null }) => p.at)).toEqual([T0 + 8 * HOUR_MS, null, null, T0 + 17 * HOUR_MS]);
  });
});

describe('PUT /api/days/:date/priorities', () => {
  it('renumbers, keeps client ids, and mints ids only for text rows without one', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', {
      priorities: [{ text: 'Kept', done: true, uid: 'ABCDEF123456', addedAt: 100 }, { text: '', done: true }, { text: 'Minted' }],
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

  it('cuts text at the shared limit', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'p'.repeat(LIMITS.priorityText + 50) }] });
    expect(r.body.priorities[0].text).toHaveLength(LIMITS.priorityText);
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
    const dup = await app.api.put('/api/days/2026-09-01/priorities', {
      priorities: [
        { text: 'a', uid: 'aaaaaaaaaaaa' },
        { text: 'b', uid: 'AAAAAAAAAAAA' },
      ],
    });
    expect(dup.status).toBe(400);
    const big = await app.api.put('/api/days/2026-09-01/priorities', { priorities: Array(MAX_PRIORITIES + 1).fill({ text: 'x' }) });
    expect(big.status).toBe(400);
    expect((await app.api.put('/api/days/2026-09-01/priorities', { priorities: null })).status).toBe(400);
  });

  it('takes done only as true or false', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'a', done: 'false' }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Priority 1 has an invalid done flag.');
    expect((await app.api.get('/api/days/2026-09-01')).body.priorities).toEqual([]);
    const ok = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'a', done: false }, { text: 'b', done: true }, { text: 'c' }] });
    expect(ok.body.priorities.map((p: { done: boolean }) => p.done)).toEqual([false, true, false]);
  });

  it('refuses a malformed uid and text that is not a string, and stores nothing', async () => {
    const put = (row: Record<string, unknown>) => app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'ok' }, row] });
    for (const uid of ['not-a-uid!', 'ab', 12345678]) {
      const r = await put({ text: 'x', uid });
      expect([r.status, r.body.error], String(uid)).toEqual([400, 'Priority 2 has an invalid uid.']);
    }
    for (const text of [42, ['x'], { t: 'x' }]) {
      const r = await put({ text });
      expect([r.status, r.body.error], JSON.stringify(text)).toEqual([400, 'Priority 2 has invalid text.']);
    }
    expect((await app.api.get('/api/days/2026-09-01')).body.priorities).toEqual([]);
    // Absent or null is an empty row, as before.
    expect((await put({ text: null, uid: null })).status).toBe(200);
  });

  it('reads a null row as an empty one', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [null, { text: 'b' }] });
    expect(r.status).toBe(200);
    expect(r.body.priorities[0]).toEqual({ position: 1, text: '', done: false, uid: null, addedAt: null });
    expect(r.body.priorities[1]).toMatchObject({ position: 2, text: 'b' });
  });

  it('refuses a row that is not an object, and stores nothing', async () => {
    // Each of these used to be stored as an empty row.
    for (const row of ['x', 5, true, [1], [{ text: 'a' }]]) {
      const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'ok' }, row] });
      expect([r.status, r.body.error], JSON.stringify(row)).toEqual([400, 'Priority 2 must be an object or null.']);
    }
    expect((await app.api.get('/api/days/2026-09-01')).body.priorities).toEqual([]);
  });

  it('reads done: null as absent, like the other fields', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', {
      priorities: [
        { text: 'a', done: null },
        { text: '', done: null, uid: null, addedAt: null },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.priorities.map((p: { done: boolean }) => p.done)).toEqual([false, false]);
  });

  it("takes the web app's rows as it pads and sends them", async () => {
    // padPriorities (client/src/lib/priorities.ts) sends every field of every row, empty rows included.
    const priorities = [
      { position: 1, text: 'Write the report', done: true, uid: 'abcdef123456', addedAt: T0 },
      { position: 2, text: '', done: false, uid: null, addedAt: null },
      { position: 3, text: '', done: false, uid: '0123456789ab', addedAt: T0 + HOUR_MS },
    ];
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities });
    expect(r.status).toBe(200);
    expect(r.body.priorities).toEqual(priorities);
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

describe('PUT /api/days/:date/target', () => {
  it("sets the day's own work-day length and clears it back to the usual one", async () => {
    expect((await app.api.put('/api/days/2026-09-01/target', { workMinutes: 240 })).body).toEqual({ workMinutes: 240 });
    expect((await app.api.get('/api/days/2026-09-01')).body.workMinutes).toBe(240);
    expect((await app.api.get('/api/days/range?from=2026-09-01&to=2026-09-01')).body.days[0].workMinutes).toBe(240);
    expect((await app.api.put('/api/days/2026-09-01/target', { workMinutes: null })).body).toEqual({ workMinutes: null });
    expect((await app.api.get('/api/days/2026-09-01')).body.workMinutes).toBeNull();
  });

  it("takes only a whole number within the setting's bounds, or null", async () => {
    for (const workMinutes of [0, 24 * 60 + 1, 90.5, '240', undefined]) {
      expect((await app.api.put('/api/days/2026-09-01/target', { workMinutes })).status).toBe(400);
    }
    expect((await app.api.put('/api/days/2026-09-01/target', { workMinutes: 1 })).status).toBe(200);
    expect((await app.api.put('/api/days/2026-09-01/target', { workMinutes: 24 * 60 })).status).toBe(200);
  });
});

describe('PUT /api/days/:date/retro', () => {
  it('stores the note, keeps the first reviewed-at, and clears it on undo', async () => {
    const note = await app.api.put('/api/days/2026-09-01/retro', { note: 'x'.repeat(LIMITS.retroNote + 1000) });
    expect(note.body.retroNote).toHaveLength(LIMITS.retroNote);
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

  it('treats no body at all as an empty patch, and stores no day for it', async () => {
    const r = await app.api.put('/api/days/2026-09-01/retro');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ retroNote: '', retroAt: null });
    expect(app.count('days', 'date = ?', '2026-09-01')).toBe(0);
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
    app = await startTestApp({ env: { RETENTION_DAYS: '90' } });
    expect((await app.api.get('/api/days/prune?before=2020-01-01')).body.serverMaxDays).toBe(90);
  });

  it('deletes the days before the cutoff with everything hanging off them', async () => {
    const dates = seededDates();
    const before = dates[3]!;
    const doomed = app.seeded!.days.slice(0, 3);
    const ids = (app.db.prepare(`SELECT id FROM days WHERE date < ?`).all(before) as { id: number }[]).map((d) => d.id);
    const count = (table: string) => app.count(table, `day_id IN (${ids.join(',')})`);
    expect(count('punches')).toBe(doomed.reduce((n, d) => n + d.punches.length, 0));
    expect(count('sessions')).toBe(doomed.reduce((n, d) => n + d.sessions.length, 0));
    expect(count('breaks')).toBe(doomed.reduce((n, d) => n + d.breaks.length, 0));
    expect(count('breaks')).toBeGreaterThan(0);

    const r = await app.api.post('/api/days/prune', { before });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: 3 });
    expect(storedDates()).toEqual(dates.slice(3));
    expect(count('punches')).toBe(0);
    expect(count('priorities')).toBe(0);
    expect(count('sessions')).toBe(0);
    expect(count('breaks')).toBe(0);
    expect((await app.api.post('/api/days/prune', { before })).body).toEqual({ deleted: 0 });
    expect((await app.api.post('/api/days/prune', { before: 'soon' })).status).toBe(400);
    expect((await app.api.post('/api/days/prune', {})).status).toBe(400);
  });

  it('never deletes a day with a running timer, and the preview does not count it', async () => {
    await app.close();
    app = await startTestApp({ seed: { running: true } });
    const preview = (await app.api.get('/api/days/prune?before=2099-01-01')).body;
    expect(preview).toMatchObject({ matching: app.seeded!.days.length - 1, total: app.seeded!.days.length });
    const r = await app.api.post('/api/days/prune', { before: '2099-01-01' });
    expect(r.body).toEqual({ deleted: preview.matching });
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

  it("keeps every read and write on the caller's own rows", async () => {
    const { admin, member, a, b } = await app.twoUsers();
    // A has a seeded history; B starts empty.
    const seeded = seedDatabase(app.db, { userId: admin.id, today: SEED_TODAY, now: SEED_NOW, days: 3 });
    const date = seeded.days[0]!.date;
    expect((await a.get(`/api/days/${date}`)).body.punches.length).toBeGreaterThan(0);

    // Reads: B sees nothing of A's.
    expect((await b.get(`/api/days/${date}`)).body).toMatchObject({ date, punches: [], priorities: [], sessions: [], breaks: [] });
    expect((await b.get(`/api/days/range?from=${date}&to=${SEED_TODAY}`)).body.days).toEqual([]);
    expect((await b.get(`/api/days/prune?before=2099-01-01`)).body).toMatchObject({ matching: 0, total: 0, oldest: null });

    // Writes on the same date land on B's own day and leave A's untouched.
    const before = (await a.get(`/api/days/${date}`)).body;
    expect(
      (await b.put(`/api/days/${date}/punches`, { punches: [{ at: Date.parse(date) + 8 * HOUR_MS }, { at: null }, { at: null }, { at: null }] })).status,
    ).toBe(200);
    expect((await b.put(`/api/days/${date}/priorities`, { priorities: [{ text: 'Mine' }] })).status).toBe(200);
    expect((await b.put(`/api/days/${date}/overtime`, { approved: true })).status).toBe(200);
    expect((await b.put(`/api/days/${date}/retro`, { note: 'b', done: true })).status).toBe(200);
    expect((await b.put(`/api/days/${date}/target`, { workMinutes: 240 })).status).toBe(200);
    expect((await a.get(`/api/days/${date}`)).body).toEqual(before);
    const bDay = (await b.get(`/api/days/${date}`)).body;
    expect(bDay.priorities.map((p: { text: string }) => p.text)).toEqual(['Mine']);
    expect(bDay.overtimeApproved).toBe(true);
    expect(bDay.retroNote).toBe('b');
    expect(bDay.workMinutes).toBe(240);
    expect(app.db.prepare(`SELECT user_id FROM days WHERE date = ? ORDER BY user_id`).all(date)).toEqual([{ user_id: admin.id }, { user_id: member.id }]);

    // A prune by B deletes only B's days.
    expect((await b.post('/api/days/prune', { before: '2099-01-01' })).body).toEqual({ deleted: 1 });
    expect((await a.get(`/api/days/range?from=${date}&to=${SEED_TODAY}`)).body.days).toHaveLength(seeded.days.length);
    expect((await a.get(`/api/days/${date}`)).body).toEqual(before);
  });
});

// The days router's param handler refuses a bad key on every /:date route; the table pins each one.
describe('the date check on every /:date route', () => {
  it('refuses an impossible date and stores no day for it', async () => {
    // Each write's body would pass on a real date, so a write without the guard would store the day.
    const day = '/api/days/2026-02-30';
    const routes: [method: 'get' | 'put' | 'post', path: string, body?: unknown][] = [
      ['get', day],
      ['put', `${day}/punches`, { punches: [] }],
      ['put', `${day}/priorities`, { priorities: [{ text: 'x' }] }],
      ['put', `${day}/overtime`, { approved: true }],
      ['put', `${day}/target`, { workMinutes: 240 }],
      ['put', `${day}/retro`, { note: 'x' }],
      ['post', `${day}/sessions`, { plannedSeconds: 1500 }],
      ['post', `${day}/breaks`, { plannedSeconds: 300 }],
    ];
    for (const [method, path, body] of routes) {
      const r = method === 'get' ? await app.api.get(path) : await app.api[method](path, body);
      expect([path, r.status, r.body]).toEqual([path, 400, { error: 'Invalid date.' }]);
    }
    expect(app.count('days', 'date = ?', '2026-02-30')).toBe(0);
  });
});
