import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { ensureDefaultUser } from '../db.js';
import { seedDatabase, type DayKind } from '../dev/seed.js';
import { ensureDay } from './shared.js';
import { SETTING_LIMITS } from '../../shared/settings.js';
import { MAX_PUNCHES } from '../../shared/punches.js';
import { HOUR_MS, MINUTE_MS, punchWindow } from '../../shared/dates.js';
import { LIMITS, MEETINGS_PER_DAY, type Day, type Priority } from '../../shared/api.js';

/** 2026-09-01's UTC midnight; the tests add hours to it, which keeps each time inside punchWindow('2026-09-01'). */
const T0 = Date.UTC(2026, 8, 1);

let app: TestApp;
beforeEach(async () => {
  app = await startTestApp({ seed: true });
});
afterEach(() => app.close());

const seededDay = (kind: DayKind) => app.seeded!.days.find((d) => d.kind === kind)!;

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
      snoozedUntil: {},
      offerAnsweredAt: null,
      meetings: {},
      sessions: [],
      breaks: [],
    });
  });

  it('returns a seeded day without its cancelled sessions', async () => {
    const day = seededDay('unreviewed');
    const r = await app.api.get(`/api/days/${day.date}`);
    expect(r.status).toBe(200);
    expect(r.body.punches).toEqual(day.punches);
    // Three one-offs, then the routines due on its weekday (a Wednesday: both).
    expect(r.body.priorities.map((p: Priority) => [p.position, p.recurring])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, true],
      [5, true],
    ]);
    expect(r.body.priorities).toEqual(day.priorities);
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
    const userId = ensureDefaultUser(app.db).id;
    const dayId = ensureDay(app.db, userId, '2026-09-01');
    const task = app.db.prepare(`INSERT INTO items (user_id, uid, title, created_at) VALUES (?, ?, ?, 0) RETURNING id`);
    const insert = app.db.prepare(`INSERT INTO priorities (day_id, item_id, position, added_at) VALUES (?, ?, ?, 0)`);
    insert.run(dayId, (task.get(userId, 'aaaaaaaaaaa2', 'Second') as { id: number }).id, 2);
    insert.run(dayId, (task.get(userId, 'aaaaaaaaaaa1', 'First') as { id: number }).id, 1);
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

  it('keeps a punch another device saved since the base, and replaces the list with no base', async () => {
    const at = (...hours: (number | null)[]) => hours.map((h) => ({ at: h == null ? null : T0 + h * HOUR_MS }));
    const times = (punches: { at: number | null }[]) => punches.map((p) => p.at);
    await app.api.put('/api/days/2026-09-01/punches', { punches: at(8, 12, null, null) });
    // The phone clocks out.
    await app.api.put('/api/days/2026-09-01/punches', { punches: at(8, 12, null, 17), base: at(8, 12, null, null) });
    // The laptop, on the copy from before, sets lunch in.
    const r = await app.api.put('/api/days/2026-09-01/punches', { punches: at(8, 12, 12.5, null), base: at(8, 12, null, null) });
    expect([r.status, times(r.body.punches)]).toEqual([200, times(at(8, 12, 12.5, 17))]);
    expect(times((await app.api.get('/api/days/2026-09-01')).body.punches)).toEqual(times(at(8, 12, 12.5, 17)));
    // A pair added on one side leaves the list as sent, and so does a save with no base.
    const added = await app.api.put('/api/days/2026-09-01/punches', { punches: at(9, 12, 12.5, 17, null, null), base: at(8, 12, 12.5, 17) });
    expect(times(added.body.punches)).toEqual(times(at(9, 12, 12.5, 17, null, null)));
    const replaced = await app.api.put('/api/days/2026-09-01/punches', { punches: at(8, null, null, null) });
    expect(times(replaced.body.punches)).toEqual(times(at(8, null, null, null)));
  });

  it('validates the base as it does the list', async () => {
    const punches = [{ at: T0 + 8 * HOUR_MS }];
    for (const [base, error] of [
      ['x', 'base must be an array.'],
      [Array(MAX_PUNCHES + 1).fill({ at: null }), `base is limited to ${MAX_PUNCHES} rows.`],
      [[5], 'Base punch 0 must be an object.'],
      [[{ at: null }, { at: 'noon' }], 'Base punch 1 has an invalid time.'],
    ] as const) {
      const r = await app.api.put('/api/days/2026-09-01/punches', { punches, base });
      expect([r.status, r.body.error]).toEqual([400, error]);
    }
    expect((await app.api.get('/api/days/2026-09-01')).body.punches).toEqual([]);
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
    // Every row must be an object, whatever a string's or an array's `at` would read as.
    for (const row of [null, 5, true, 'x', [1], [{ at: T0 + 8 * HOUR_MS }]]) {
      const r = await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: T0 + 8 * HOUR_MS }, row] });
      expect([r.status, r.body.error], JSON.stringify(row)).toEqual([400, 'Punch 1 must be an object.']);
    }
    expect((await app.api.get('/api/days/2026-09-01')).body.punches).toEqual([]);
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

describe('PUT /api/days/:date/snooze', () => {
  const snooze = (body?: unknown) => app.api.put('/api/days/2026-09-01/snooze', body);

  it("stores one alarm's time, keeps another alarm's, and replaces its own on a second press", async () => {
    expect((await snooze({ alarm: 'lunchBy', until: T0 + 12 * HOUR_MS })).body).toEqual({ snoozedUntil: { lunchBy: T0 + 12 * HOUR_MS } });
    expect((await snooze({ alarm: 'clockOut', until: T0 + 17 * HOUR_MS })).body).toEqual({
      snoozedUntil: { lunchBy: T0 + 12 * HOUR_MS, clockOut: T0 + 17 * HOUR_MS },
    });
    const both = { lunchBy: T0 + 13 * HOUR_MS, clockOut: T0 + 17 * HOUR_MS };
    expect((await snooze({ alarm: 'lunchBy', until: T0 + 13 * HOUR_MS })).body).toEqual({ snoozedUntil: both });
    expect((await app.api.get('/api/days/2026-09-01')).body.snoozedUntil).toEqual(both);
    expect((await app.api.get('/api/days/range?from=2026-09-01&to=2026-09-01')).body.days[0].snoozedUntil).toEqual(both);
  });

  it('refuses an alarm it has no id for, and a time that is missing, not a number, or off the day', async () => {
    const until = T0 + 12 * HOUR_MS;
    const ids = 'lunchBy, lunchEnd, clockOut, secondMeal, retro, noBreak';
    for (const body of [{ alarm: 'nap', until }, { until }]) {
      const r = await snooze(body);
      expect([r.status, r.body]).toEqual([400, { error: `alarm must be one of ${ids}.` }]);
    }
    const { to } = punchWindow('2026-09-01');
    for (const body of [{ alarm: 'lunchBy', until: 'soon' }, { alarm: 'lunchBy' }, { alarm: 'lunchBy', until: to + 1 }]) {
      const r = await snooze(body);
      expect([r.status, r.body]).toEqual([400, { error: 'until must be a time on that day.' }]);
    }
    expect(app.count('days', 'date = ?', '2026-09-01')).toBe(0);
  });
});

describe('PUT /api/days/:date/meetings', () => {
  const put = (body?: unknown) => app.api.put('/api/days/2026-09-01/meetings', body);
  const standup = { title: 'Standup', startsAt: T0 + 16 * HOUR_MS, endsAt: T0 + 16 * HOUR_MS + 15 * MINUTE_MS };

  it('stores one meeting by its uid, keeps the others, and takes one off the day with null', async () => {
    expect((await put({ uid: 'AAAA1111', meeting: { ...standup, title: '  Standup ' } })).body).toEqual({ meetings: { aaaa1111: standup } });
    const call = { title: '', startsAt: T0 + 20 * HOUR_MS, endsAt: T0 + 21 * HOUR_MS };
    expect((await put({ uid: 'bbbb2222', meeting: call })).body).toEqual({ meetings: { aaaa1111: standup, bbbb2222: call } });
    const both = { aaaa1111: null, bbbb2222: call };
    expect((await put({ uid: 'aaaa1111', meeting: null })).body).toEqual({ meetings: both });
    expect((await app.api.get('/api/days/2026-09-01')).body.meetings).toEqual(both);
    expect((await app.api.get('/api/days/range?from=2026-09-01&to=2026-09-01')).body.days[0].meetings).toEqual(both);
  });

  it('cuts a long title', async () => {
    const title = 'x'.repeat(LIMITS.meetingTitle + 5);
    expect((await put({ uid: 'aaaa1111', meeting: { ...standup, title } })).body.meetings.aaaa1111.title).toBe('x'.repeat(LIMITS.meetingTitle));
  });

  it('refuses a bad uid, a meeting that is neither an object nor null, a title that is not text, and times off the day or out of order', async () => {
    for (const uid of [undefined, 'x', 5, 'not-a-uid!']) {
      const r = await put({ uid, meeting: standup });
      expect([r.status, r.body]).toEqual([400, { error: "uid must be a meeting's id." }]);
    }
    for (const meeting of [undefined, 'Standup', [standup]]) {
      const r = await put({ uid: 'aaaa1111', meeting });
      expect([r.status, r.body]).toEqual([400, { error: 'meeting must be { title, startsAt, endsAt } or null.' }]);
    }
    for (const title of [undefined, 5]) {
      const r = await put({ uid: 'aaaa1111', meeting: { ...standup, title } });
      expect([r.status, r.body]).toEqual([400, { error: 'title must be text.' }]);
    }
    const { to } = punchWindow('2026-09-01');
    for (const times of [{ startsAt: 'soon' }, { endsAt: to + 1 }, { endsAt: standup.startsAt }, { endsAt: standup.startsAt - 1 }]) {
      const r = await put({ uid: 'aaaa1111', meeting: { ...standup, ...times } });
      expect([r.status, r.body]).toEqual([400, { error: 'startsAt and endsAt must be times on that day, the end after the start.' }]);
    }
    expect(app.count('days', 'date = ?', '2026-09-01')).toBe(0);
  });

  it(`holds at most ${MEETINGS_PER_DAY} meetings, ones taken off included, and still changes one it holds`, async () => {
    await put({ uid: 'aaaa1111', meeting: standup });
    const full = Object.fromEntries(Array.from({ length: MEETINGS_PER_DAY }, (_, i) => [`m${String(i).padStart(7, '0')}`, null]));
    app.db.prepare(`UPDATE days SET meetings = ? WHERE date = ?`).run(JSON.stringify(full), '2026-09-01');
    const r = await put({ uid: 'aaaa1111', meeting: standup });
    expect([r.status, r.body]).toEqual([400, { error: `A day holds at most ${MEETINGS_PER_DAY} meetings.` }]);
    expect((await put({ uid: 'm0000000', meeting: standup })).body.meetings.m0000000).toEqual(standup);
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
    const { min, max } = SETTING_LIMITS.workMinutes;
    for (const workMinutes of [min - 1, max + 1, 90.5, '240', undefined]) {
      expect((await app.api.put('/api/days/2026-09-01/target', { workMinutes })).status).toBe(400);
    }
    expect((await app.api.put('/api/days/2026-09-01/target', { workMinutes: min })).status).toBe(200);
    expect((await app.api.put('/api/days/2026-09-01/target', { workMinutes: max })).status).toBe(200);
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

describe('PUT /api/days/:date/offer', () => {
  it("stamps the day's morning offer answered, keeps the first stamp, and every read carries it", async () => {
    vi.useFakeTimers({ now: T0 + 9 * HOUR_MS, toFake: ['Date'] });
    const first = await app.api.put('/api/days/2026-09-01/offer');
    expect([first.status, first.body]).toEqual([200, { offerAnsweredAt: T0 + 9 * HOUR_MS }]);
    // Another device answering later changes nothing.
    vi.setSystemTime(T0 + 10 * HOUR_MS);
    expect((await app.api.put('/api/days/2026-09-01/offer')).body).toEqual({ offerAnsweredAt: T0 + 9 * HOUR_MS });
    expect((await app.api.get('/api/days/2026-09-01')).body.offerAnsweredAt).toBe(T0 + 9 * HOUR_MS);
    expect((await app.api.get('/api/days/range?from=2026-09-01&to=2026-09-01')).body.days[0].offerAnsweredAt).toBe(T0 + 9 * HOUR_MS);
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
    // Categories and recurring priorities are never pruned: the days left still name them.
    expect(app.count('categories')).toBe(app.seeded!.board.categories.length);
    expect(app.count('items', 'weekdays IS NOT NULL')).toBe(app.seeded!.board.recurring.length);
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
    // Both ends count: 400 days is the limit, 401 is refused.
    expect((await app.api.get('/api/days/range?from=2025-01-01&to=2026-02-04')).status).toBe(200);
    const over = await app.api.get('/api/days/range?from=2025-01-01&to=2026-02-05');
    expect([over.status, over.body.error]).toEqual([400, 'Range is limited to 400 days.']);
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
    // With a base, the save is merged onto B's own stored rows: none of A's come in as another device's.
    expect((await b.put(`/api/days/${date}/priorities`, { priorities: [{ text: 'Mine' }], base: [] })).status).toBe(200);
    expect((await b.put(`/api/days/${date}/overtime`, { approved: true })).status).toBe(200);
    expect((await b.put(`/api/days/${date}/retro`, { note: 'b', done: true })).status).toBe(200);
    expect((await b.put(`/api/days/${date}/target`, { workMinutes: 240 })).status).toBe(200);
    const until = Date.parse(date) + 12 * HOUR_MS;
    expect((await b.put(`/api/days/${date}/snooze`, { alarm: 'lunchBy', until })).status).toBe(200);
    expect((await b.put(`/api/days/${date}/offer`)).status).toBe(200);
    const meeting = { title: 'Mine', startsAt: until, endsAt: until + HOUR_MS };
    expect((await b.put(`/api/days/${date}/meetings`, { uid: 'aaaa1111', meeting })).status).toBe(200);
    expect((await a.get(`/api/days/${date}`)).body).toEqual(before);
    const bDay = (await b.get(`/api/days/${date}`)).body;
    expect(bDay.priorities.map((p: { text: string }) => p.text)).toEqual(['Mine']);
    expect(bDay.overtimeApproved).toBe(true);
    expect(bDay.retroNote).toBe('b');
    expect(bDay.workMinutes).toBe(240);
    expect(bDay.snoozedUntil).toEqual({ lunchBy: until });
    expect(bDay.offerAnsweredAt).toEqual(expect.any(Number));
    expect(bDay.meetings).toEqual({ aaaa1111: meeting });
    expect(app.db.prepare(`SELECT user_id FROM days WHERE date = ? ORDER BY user_id`).all(date)).toEqual([{ user_id: admin.id }, { user_id: member.id }]);
    // B naming the uid of a task of A's renames, ticks and removes B's own task of that uid,
    // whose sessions are B's: A's task, its rows and its time are as they were.
    const logged = (before as Day).sessions.find((s) => s.priorityUid != null)!.priorityUid!;
    const theirs = { text: 'Mine', uid: logged, categoryUid: 'cat000000004' };
    await b.put(`/api/days/${date}/priorities`, { priorities: [theirs] });
    await b.put(`/api/days/${date}/priorities`, { priorities: [{ ...theirs, text: 'Mine, renamed', done: true }] });
    expect((await b.put(`/api/days/${date}/priorities`, { priorities: [] })).status).toBe(200);
    expect((await a.get(`/api/days/${date}`)).body).toEqual(before);

    // A deletes a task everywhere; B's save naming the same uid is B's own task, not dropped,
    // and A's tombstone stays as it was.
    const aTask = (before as Day).priorities.find((p) => !p.recurring)!;
    expect((await a.del(`/api/items/${aTask.uid}`)).status).toBe(200);
    const tombstone = app.db.prepare(`SELECT * FROM items WHERE user_id = ? AND uid = ?`).get(admin.id, aTask.uid);
    const kept = await b.put(`/api/days/${date}/priorities`, { priorities: [{ text: 'Mine again', uid: aTask.uid }] });
    expect(kept.body.priorities.map((p: Priority) => [p.uid, p.text])).toEqual([[aTask.uid, 'Mine again']]);
    expect(app.db.prepare(`SELECT * FROM items WHERE user_id = ? AND uid = ?`).get(admin.id, aTask.uid)).toEqual(tombstone);

    // A prune by B deletes only B's days, and none of A's tasks: not the ones done before the
    // cutoff, nor a tombstone, nor one nothing names, which a prune of A's own would take.
    app.db.prepare(`INSERT INTO items (user_id, uid, title, created_at, archived_at) VALUES (?, 'card000000aa', 'Loose', 0, 0)`).run(admin.id);
    const tasksOf = (userId: number) => app.db.prepare(`SELECT * FROM items WHERE user_id = ? ORDER BY id`).all(userId);
    const aTasks = tasksOf(admin.id);
    expect((await b.post('/api/days/prune', { before: '2099-01-01' })).body).toEqual({ deleted: 1 });
    expect((await a.get(`/api/days/range?from=${date}&to=${SEED_TODAY}`)).body.days).toHaveLength(seeded.days.length);
    expect(tasksOf(admin.id)).toEqual(aTasks);
  });
});

/** Every /:date write, the two checks below both take: each body would pass on a real date, so a write let through would store the day. */
const writes = (day: string): [method: 'put' | 'post', path: string, body: unknown][] => [
  ['put', `${day}/punches`, { punches: [] }],
  ['put', `${day}/priorities`, { priorities: [{ text: 'x' }] }],
  ['put', `${day}/overtime`, { approved: true }],
  // Noon UTC on the day itself: a constant would fall outside the far date's window, and a 400 from the body would prove nothing.
  ['put', `${day}/snooze`, { alarm: 'lunchBy', until: Date.parse(day.slice(-10)) + 12 * HOUR_MS }],
  [
    'put',
    `${day}/meetings`,
    { uid: 'aaaa1111', meeting: { title: 'x', startsAt: Date.parse(day.slice(-10)) + 12 * HOUR_MS, endsAt: Date.parse(day.slice(-10)) + 13 * HOUR_MS } },
  ],
  ['put', `${day}/target`, { workMinutes: 240 }],
  ['put', `${day}/retro`, { note: 'x' }],
  ['put', `${day}/offer`, {}],
  ['post', `${day}/sessions`, { plannedSeconds: 1500 }],
  ['post', `${day}/breaks`, { plannedSeconds: 300 }],
];

// The days router's param handler refuses a bad key on every /:date route; the table pins each one.
describe('the date check on every /:date route', () => {
  it('refuses an impossible date and stores no day for it', async () => {
    const day = '/api/days/2026-02-30';
    const get = await app.api.get(day);
    expect([get.status, get.body]).toEqual([400, { error: 'Invalid date.' }]);
    for (const [method, path, body] of writes(day)) {
      const r = await app.api[method](path, body);
      expect([path, r.status, r.body]).toEqual([path, 400, { error: 'Invalid date.' }]);
    }
    expect(app.count('days', 'date = ?', '2026-02-30')).toBe(0);
  });
});

// A year and a month past the server's UTC date, a write stores nothing: lists there would only grow the tables.
describe('the distance check on every /:date write', () => {
  it('refuses a write more than 400 days past the server date, and reads it', async () => {
    vi.useFakeTimers({ now: SEED_NOW, toFake: ['Date'] });
    const far = '2027-10-22';
    const day = `/api/days/${far}`;
    for (const [method, path, body] of writes(day)) {
      const r = await app.api[method](path, body);
      expect([path, r.status, r.body]).toEqual([path, 400, { error: 'That date is too far ahead.' }]);
    }
    expect(app.count('days', 'date = ?', far)).toBe(0);
    expect((await app.api.get(day)).status).toBe(200);
    expect((await app.api.put('/api/days/2027-10-21/overtime', { approved: true })).status).toBe(200);
  });
});
