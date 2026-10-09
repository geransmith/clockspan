import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { ensureDefaultUser } from '../db.js';
import { seedDatabase, type DayKind } from '../dev/seed.js';
import { ensureDay, type ItemRow } from './shared.js';
import { MAX_PRIORITIES, SETTING_LIMITS } from '../../shared/settings.js';
import { MAX_PUNCHES } from '../../shared/punches.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, punchWindow } from '../../shared/dates.js';
import { LIMITS, type Day, type Priority } from '../../shared/api.js';

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

/** A row as the web app sends it: a written row carries its uid and addedAt, and every row the fields the server works out, which it ignores. */
const row = (text: string, uid: string | null = null, patch: Record<string, unknown> = {}) => ({
  position: 0,
  text,
  done: false,
  uid,
  addedAt: uid ? T0 : null,
  categoryUid: null,
  recurring: false,
  archived: false,
  listed: 0,
  earlier: 0,
  logged: 0,
  ...patch,
});

/** A row as the server answers it: a one-off task on one list, with no time logged on it, unless patched. */
const stored = (position: number, text: string, uid: string, patch: Partial<Priority> = {}): Priority => ({
  position,
  text,
  done: false,
  uid,
  addedAt: T0,
  categoryUid: null,
  recurring: false,
  archived: false,
  listed: 1,
  earlier: 0,
  logged: 0,
  ...patch,
});

const texts = (priorities: { text: string }[]) => priorities.map((p) => p.text);
/** The user's task with this uid as stored, tombstones included. */
const itemOf = (uid: string) => app.db.prepare(`SELECT * FROM items WHERE uid = ?`).get(uid) as ItemRow | undefined;

describe('PUT /api/days/:date/priorities', () => {
  it('stores each row with a task at its place, keeps client ids, and mints ids only for text rows without one', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', {
      priorities: [{ text: 'Kept', done: true, uid: 'ABCDEF123456', addedAt: 100 }, { text: '', done: true }, { text: 'Minted' }],
    });
    expect(r.status).toBe(200);
    const [a, c] = r.body.priorities;
    expect(r.body.priorities).toHaveLength(2);
    expect(a).toEqual({ ...stored(1, 'Kept', 'abcdef123456'), done: true, addedAt: 100 });
    // A free row is never stored, so the next row keeps its place: positions can have gaps.
    expect(c.position).toBe(3);
    expect(c.uid).toMatch(/^[a-f0-9]{12}$/);
    expect(typeof c.addedAt).toBe('number');
    expect((await app.api.get('/api/days/2026-09-01')).body.priorities).toEqual(r.body.priorities);
  });

  it('cuts text at the shared limit', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'p'.repeat(LIMITS.priorityText + 50) }] });
    expect(r.body.priorities[0].text).toHaveLength(LIMITS.priorityText);
  });

  it('is a full replace without a base: omitting a row removes it', async () => {
    await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] });
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'Three' }] });
    expect(r.body.priorities).toHaveLength(1);
    const day = await app.api.get('/api/days/2026-09-01');
    expect(day.body.priorities.map((p: { text: string; position: number }) => [p.position, p.text])).toEqual([[1, 'Three']]);
    // A null base is no base, like the rows' null fields.
    const again = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'Four' }], base: null });
    expect(texts(again.body.priorities)).toEqual(['Four']);
  });

  it('rejects an addedAt it could not have stamped', async () => {
    const bad = async (addedAt: unknown) => {
      const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'x', addedAt }] });
      expect(r.status, String(addedAt)).toBe(400);
      expect(r.body.error).toBe('Priority 1 has an invalid addedAt.');
    };
    await bad(1e308);
    await bad(-1);
    await bad(Date.now() + 2 * DAY_MS);
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
    expect([dup.status, dup.body.error]).toEqual([400, "Priority 2 repeats another row's uid."]);
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

  it('refuses a malformed uid or category and text that is not a string, and stores nothing', async () => {
    const put = (r: Record<string, unknown>) => app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'ok' }, r] });
    for (const uid of ['not-a-uid!', 'ab', 12345678]) {
      const r = await put({ text: 'x', uid });
      expect([r.status, r.body.error], String(uid)).toEqual([400, 'Priority 2 has an invalid uid.']);
    }
    for (const text of [42, ['x'], { t: 'x' }]) {
      const r = await put({ text });
      expect([r.status, r.body.error], JSON.stringify(text)).toEqual([400, 'Priority 2 has invalid text.']);
    }
    for (const categoryUid of ['not-a-uid!', 'ab', 12345678, true]) {
      const r = await put({ text: 'x', categoryUid });
      expect([r.status, r.body.error], String(categoryUid)).toEqual([400, 'Priority 2 has an invalid category.']);
    }
    expect((await app.api.get('/api/days/2026-09-01')).body.priorities).toEqual([]);
    // Absent or null is a free row, and a free row holds no category.
    expect((await put({ text: null, uid: null, categoryUid: 'cat000000001' })).body.priorities).toHaveLength(1);
  });

  it('refuses a row with a task and no name, and stores nothing', async () => {
    await app.api.put('/api/days/2026-09-01/priorities', { priorities: [row('Report', 'aaaaaaaaaaa1')] });
    const blank = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [row('Email'), row('  ', 'aaaaaaaaaaa1')] });
    expect([blank.status, blank.body.error]).toEqual([400, 'Priority 2 needs a name.']);
    const base = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [row('Report', 'aaaaaaaaaaa1')], base: [row('', 'aaaaaaaaaaa1')] });
    expect([base.status, base.body.error]).toEqual([400, 'Base row 1 needs a name.']);
    expect(texts((await app.api.get('/api/days/2026-09-01')).body.priorities)).toEqual(['Report']);
  });

  it('refuses a row that is not an object, and stores nothing', async () => {
    for (const bad of [null, 'x', 5, true, [1], [{ text: 'a' }]]) {
      const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'ok' }, bad] });
      expect([r.status, r.body.error], JSON.stringify(bad)).toEqual([400, 'Priority 2 must be an object.']);
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
    expect(r.body.priorities.map((p: { done: boolean }) => p.done)).toEqual([false]);
  });

  it("takes the web app's rows as it pads and sends them, and stores the same whatever the fields the server works out say", async () => {
    // padPriorities (client/src/lib/priorities.ts) sends every field of every row, free rows included.
    const sent = [row('Write the report', 'abcdef123456', { done: true, categoryUid: 'cafe00000001' }), row(''), row('Email the team', '0123456789ab')];
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: sent });
    expect(r.status).toBe(200);
    const expected = [stored(1, 'Write the report', 'abcdef123456', { done: true, categoryUid: 'cafe00000001' }), stored(3, 'Email the team', '0123456789ab')];
    expect(r.body.priorities).toEqual(expected);
    const claims = { recurring: true, archived: true, listed: 9, earlier: 4, logged: 3600 };
    const again = await app.api.put('/api/days/2026-09-01/priorities', { priorities: sent.map((p) => ({ ...p, ...claims })), base: expected });
    expect(again.body.priorities).toEqual(expected);
    expect(itemOf('abcdef123456')).toMatchObject({ weekdays: null, archived_at: null });
  });

  it('refuses the shape a page from before tasks were stored once sends, by its fields whatever their values, and stores nothing', async () => {
    const stale = [409, 'Clockspan was updated. Reload the page.'];
    for (const body of [
      { priorities: [row('Report')], cards: false },
      { priorities: [row('Report')], touched: [] },
      { priorities: [row('Report', null, { cardUid: null })] },
      { priorities: [row('Report', null, { recurringUid: null })] },
    ]) {
      const r = await app.api.put('/api/days/2026-09-01/priorities', body);
      expect([r.status, r.body.error], JSON.stringify(body)).toEqual(stale);
    }
    expect(app.count('days', 'date = ?', '2026-09-01')).toBe(0);
  });
});

// Two devices, each saving the list it built on its last copy of the day (`base`): the server
// lays each one's changes onto what it holds (`mergePriorities`, shared/priorities.ts).
describe('PUT /api/days/:date/priorities with a base', () => {
  const PATH = '/api/days/2026-09-01/priorities';
  const EMPTY = [row(''), row(''), row('')];

  it("keeps both devices' new rows when each saves on a copy from before the other's", async () => {
    expect((await app.api.put(PATH, { priorities: [row('Report', 'aaaaaaaaaaaa'), row(''), row('')], base: EMPTY })).status).toBe(200);
    const r = await app.api.put(PATH, { priorities: [row('Email', 'bbbbbbbbbbbb'), row(''), row('')], base: EMPTY });
    expect(r.status).toBe(200);
    expect(r.body.priorities.map((p: Priority) => [p.position, p.text])).toEqual([
      [1, 'Email'],
      [2, 'Report'],
    ]);
    expect((await app.api.get('/api/days/2026-09-01')).body.priorities).toEqual(r.body.priorities);
  });

  it('keeps a tick made on another device when this one renames another row', async () => {
    const base = [row('Report', 'aaaaaaaaaaaa'), row('Email', 'bbbbbbbbbbbb')];
    await app.api.put(PATH, { priorities: base });
    await app.api.put(PATH, { priorities: [row('Report', 'aaaaaaaaaaaa', { done: true }), base[1]], base });
    const r = await app.api.put(PATH, { priorities: [base[0], row('Email the team', 'bbbbbbbbbbbb')], base });
    expect(r.body.priorities.map((p: { text: string; done: boolean }) => [p.text, p.done])).toEqual([
      ['Report', true],
      ['Email the team', false],
    ]);
  });

  it('stores one row where two devices put the same task on the list, and two tasks for one text typed on each', async () => {
    await app.api.put('/api/days/2026-08-31/priorities', { priorities: [row('Invoices', 'aaaaaaaaaaa1')] });
    // Both took the left-open offer, which brings the same task, and each typed "Call the bank".
    await app.api.put(PATH, { priorities: [row('Invoices', 'aaaaaaaaaaa1'), row('Call the bank', 'bbbbbbbbbbb1'), row('')], base: EMPTY });
    const r = await app.api.put(PATH, { priorities: [row('Invoices', 'aaaaaaaaaaa1'), row('Call the bank', 'ccccccccccc1'), row('')], base: EMPTY });
    expect(r.body.priorities.map((p: Priority) => [p.position, p.text, p.uid])).toEqual([
      [1, 'Invoices', 'aaaaaaaaaaa1'],
      [2, 'Call the bank', 'ccccccccccc1'],
      [3, 'Call the bank', 'bbbbbbbbbbb1'],
    ]);
  });

  it('keeps the tick a device made on a task it carried when another device carries the same task on an older copy', async () => {
    await app.api.put('/api/days/2026-08-31/priorities', { priorities: [row('Invoices', 'aaaaaaaaaaa1')] });
    const carried = row('Invoices', 'aaaaaaaaaaa1', { addedAt: 1000 });
    await app.api.put(PATH, { priorities: [carried, row(''), row('')], base: EMPTY });
    await app.api.put(PATH, { priorities: [{ ...carried, done: true }, row(''), row('')], base: [carried, row(''), row('')] });
    const r = await app.api.put(PATH, { priorities: [row('Invoices', 'aaaaaaaaaaa1', { addedAt: 5000 }), row(''), row('')], base: EMPTY });
    expect(r.body.priorities.map((p: Priority) => [p.uid, p.done, p.addedAt])).toEqual([['aaaaaaaaaaa1', true, 1000]]);
  });

  it("refuses a save whose list would hold more than the limit with another device's rows, and stores nothing", async () => {
    const own = Array.from({ length: MAX_PRIORITIES - 1 }, (_, i) => row(`Row ${i}`, `aaaaaaaa${String(i).padStart(4, '0')}`));
    await app.api.put(PATH, { priorities: [...own, row('Theirs', 'bbbbbbbbbbbb')] });
    const r = await app.api.put(PATH, { priorities: [...own, row('Mine', 'cccccccccccc')], base: own });
    expect([r.status, r.body.error]).toEqual([409, `This day's list already has ${MAX_PRIORITIES} priorities with another device's. Remove one first.`]);
    expect(itemOf('cccccccccccc')).toBeUndefined();
    expect(texts((await app.api.get('/api/days/2026-09-01')).body.priorities).at(-1)).toBe('Theirs');
  });

  it('refuses a base that is not a list of rows like the ones sent, and stores nothing', async () => {
    const put = (base: unknown) => app.api.put(PATH, { priorities: [row('Kept out', 'aaaaaaaaaaaa')], base });
    const refusals: [unknown, string][] = [
      ['x', `base must be an array of at most ${MAX_PRIORITIES}.`],
      [Array(MAX_PRIORITIES + 1).fill(row('')), `base must be an array of at most ${MAX_PRIORITIES}.`],
      [[row('Report'), 5], 'Base row 2 must be an object.'],
      [[row('Report', 'not-a-uid!')], 'Base row 1 has an invalid uid.'],
      [[row('Report', 'aaaaaaaaaaaa'), row('Email', 'AAAAAAAAAAAA')], "Base row 2 repeats another row's uid."],
      [[row('Report', 'aaaaaaaaaaaa', { done: 'yes' })], 'Base row 1 has an invalid done flag.'],
      [[row('Report', 'aaaaaaaaaaaa', { categoryUid: 'x' })], 'Base row 1 has an invalid category.'],
    ];
    for (const [base, error] of refusals) {
      const r = await put(base);
      expect([r.status, r.body.error], JSON.stringify(base)).toEqual([400, error]);
    }
    expect((await app.api.get('/api/days/2026-09-01')).body.priorities).toEqual([]);
  });
});

// A day's list names tasks, each stored once: the save makes a task for a uid new to the user,
// and writes a rename or a category this device made to the task, which every day then shows.
describe('PUT /api/days/:date/priorities: the tasks', () => {
  const MON = '2026-08-03';
  const TUE = '2026-08-04';
  const WED = '2026-08-05';
  const save = (date: string, priorities: Record<string, unknown>[], base?: Record<string, unknown>[]) =>
    app.api.put(`/api/days/${date}/priorities`, base ? { priorities, base } : { priorities });
  const rowsOn = async (date: string) => (await app.api.get(`/api/days/${date}`)).body.priorities as Priority[];

  beforeEach(async () => {
    // Only Date, so createdAt can be compared: HTTP keeps its real timers.
    vi.useFakeTimers({ now: SEED_NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('makes a task for a uid new to the user, with its trimmed name and category, in no lane', async () => {
    const r = await save(MON, [row('  Write the report  ', 'aaaaaaaaaaa1', { categoryUid: 'cat000000001' })]);
    expect(r.body.priorities).toEqual([stored(1, 'Write the report', 'aaaaaaaaaaa1', { categoryUid: 'cat000000001' })]);
    expect(itemOf('aaaaaaaaaaa1')).toMatchObject({
      title: 'Write the report',
      category_uid: 'cat000000001',
      weekdays: null,
      lane: null,
      position: 0,
      created_at: SEED_NOW,
      archived_at: null,
      deleted_at: null,
    });
  });

  it('writes a rename and a category this device made since its base to the task, which every day shows', async () => {
    const report = row('Report', 'aaaaaaaaaaa1');
    await save(MON, [report]);
    await save(TUE, [report], []);
    const r = await save(TUE, [{ ...report, text: 'Quarterly report ', categoryUid: 'cat000000002' }], [report]);
    expect(r.body.priorities[0]).toMatchObject({ text: 'Quarterly report', categoryUid: 'cat000000002' });
    expect((await rowsOn(MON))[0]).toMatchObject({ text: 'Quarterly report', categoryUid: 'cat000000002' });
    const range = (await app.api.get(`/api/days/range?from=${MON}&to=${TUE}`)).body.days as Day[];
    expect(range.map((d) => d.priorities[0]!.text)).toEqual(['Quarterly report', 'Quarterly report']);
  });

  it('leaves a rename or a category another device made alone when this save changed only the tick', async () => {
    const report = row('Report', 'aaaaaaaaaaa1');
    await save(MON, [report]);
    await save(MON, [{ ...report, text: 'Quarterly report', categoryUid: 'cat000000001' }], [report]);
    const r = await save(MON, [{ ...report, done: true }], [report]);
    expect(r.body.priorities[0]).toMatchObject({ text: 'Quarterly report', categoryUid: 'cat000000001', done: true });
  });

  it('writes nothing to a task a save puts on another list, whatever name and category it carries', async () => {
    await save(MON, [row('Report', 'aaaaaaaaaaa1', { categoryUid: 'cat000000001' })]);
    // A carry from a copy older than a rename.
    const r = await save(TUE, [row('Old name', 'aaaaaaaaaaa1', { categoryUid: null })], []);
    expect(r.body.priorities[0]).toMatchObject({ text: 'Report', categoryUid: 'cat000000001' });
    expect(itemOf('aaaaaaaaaaa1')).toMatchObject({ title: 'Report', category_uid: 'cat000000001' });
  });

  it('reads the stored list as the base with none sent', async () => {
    await save(MON, [row('Report', 'aaaaaaaaaaa1')]);
    await save(MON, [row('Report v2', 'aaaaaaaaaaa1', { categoryUid: 'cat000000003' })]);
    expect(itemOf('aaaaaaaaaaa1')).toMatchObject({ title: 'Report v2', category_uid: 'cat000000003' });
  });

  it('makes the task again from the row when another device took it off its only list and this one changed it', async () => {
    const report = row('Report', 'aaaaaaaaaaa1');
    await save(MON, [report]);
    await save(MON, [], [report]);
    expect(itemOf('aaaaaaaaaaa1')).toBeUndefined();
    const r = await save(MON, [{ ...report, text: 'Report v2', done: true }], [report]);
    expect(r.body.priorities).toEqual([stored(1, 'Report v2', 'aaaaaaaaaaa1', { done: true })]);
  });

  it("answers each row with how many days list its task, how many of them come before the row's, and the focus done on it", async () => {
    const report = row('Report', 'aaaaaaaaaaa1');
    for (const date of [MON, TUE, WED]) await save(date, [report], []);
    const { id } = (await app.api.post(`/api/days/${TUE}/sessions`, { plannedSeconds: 600, priorityUid: 'aaaaaaaaaaa1' })).body.session as { id: number };
    vi.setSystemTime(SEED_NOW + 5 * MINUTE_MS);
    await app.api.post(`/api/sessions/${id}/finish`);
    // A running one isn't logged yet.
    await app.api.post(`/api/days/${WED}/sessions`, { plannedSeconds: 600, priorityUid: 'aaaaaaaaaaa1' });
    const days = (await app.api.get(`/api/days/range?from=${MON}&to=${WED}`)).body.days as Day[];
    expect(days.map((d) => [d.priorities[0]!.listed, d.priorities[0]!.earlier, d.priorities[0]!.logged])).toEqual([
      [3, 0, 300],
      [3, 1, 300],
      [3, 2, 300],
    ]);
    expect((await rowsOn(TUE))[0]).toMatchObject({ listed: 3, earlier: 1, logged: 300 });
  });

  it("answers a recurring priority's row as recurring, and one removed in Settings as archived", async () => {
    await app.api.post('/api/items', { uid: 'rcur0000000a', title: 'Check the queue', categoryUid: 'cat000000001', weekdays: [1, 2, 3, 4, 5] });
    const r = await save(MON, [row('Check the queue', 'rcur0000000a')], []);
    expect(r.body.priorities).toEqual([stored(1, 'Check the queue', 'rcur0000000a', { categoryUid: 'cat000000001', recurring: true })]);
    await app.api.del('/api/items/rcur0000000a');
    expect((await rowsOn(MON))[0]).toMatchObject({ recurring: true, archived: true });
    // A rename from its row reaches it still.
    await save(MON, [row('Watch the queue', 'rcur0000000a')], [row('Check the queue', 'rcur0000000a')]);
    expect(itemOf('rcur0000000a')).toMatchObject({ title: 'Watch the queue', weekdays: 0b11111 });
  });
});

// One lane rule follows a save: a task in Later added open to its latest list goes to the top of Next.
describe('PUT /api/days/:date/priorities: the lane rule', () => {
  const MON = '2026-08-03';
  const TUE = '2026-08-04';
  /** Each task in a lane as [lane, position, title], done ones included, which the board leaves out once their day is past its window. */
  const lanes = () =>
    (app.db.prepare(`SELECT lane, position, title FROM items WHERE lane IS NOT NULL ORDER BY lane, position`).all() as ItemRow[]).map((i) => [
      i.lane,
      i.position,
      i.title,
    ]);
  const capture = (uid: string, title: string, lane: string) => app.api.post('/api/items', { uid, title, lane, before: null });

  beforeEach(async () => {
    await app.close();
    app = await startTestApp();
    await capture('card00000001', 'Write the KB', 'later');
    await capture('card00000002', 'Update the macros', 'later');
    await capture('card00000003', 'Follow up', 'next');
  });

  it('brings a task in Later added open to its latest list to the top of Next, and closes up Later', async () => {
    await app.api.put(`/api/days/${TUE}/priorities`, { priorities: [row('Write the KB', 'card00000001')] });
    expect(lanes()).toEqual([
      ['later', 1, 'Update the macros'],
      ['next', 1, 'Write the KB'],
      ['next', 2, 'Follow up'],
    ]);
  });

  it('leaves a task in Later there when it is added ticked, or to a day before one whose list holds it', async () => {
    const ticked = row('Write the KB', 'card00000001', { done: true });
    await app.api.put(`/api/days/${TUE}/priorities`, { priorities: [ticked] });
    await app.api.put(`/api/days/${TUE}/priorities`, { priorities: [ticked, row('Update the macros', 'card00000002')] });
    await app.api.patch('/api/items/card00000002', { lane: 'later' });
    // Monday's list gains it after Tuesday's did: Tuesday's is its latest.
    await app.api.put(`/api/days/${MON}/priorities`, { priorities: [row('Update the macros', 'card00000002')] });
    expect(lanes()).toEqual([
      ['later', 1, 'Write the KB'],
      ['later', 2, 'Update the macros'],
      ['next', 1, 'Follow up'],
    ]);
  });

  it('keeps a task in Next where it is, and one with no lane without one', async () => {
    await app.api.put(`/api/days/${TUE}/priorities`, { priorities: [row('Follow up', 'card00000003'), row('Typed', 'aaaaaaaaaaa1')] });
    expect(lanes()).toEqual([
      ['later', 1, 'Write the KB'],
      ['later', 2, 'Update the macros'],
      ['next', 1, 'Follow up'],
    ]);
    expect(itemOf('aaaaaaaaaaa1')).toMatchObject({ lane: null, position: 0 });
  });
});

// A task nothing names goes with the save that took it off its last list (`collectItems`).
describe('PUT /api/days/:date/priorities: tasks taken off', () => {
  const MON = '2026-08-03';
  const TUE = '2026-08-04';

  it('deletes a task typed and taken off its only list, ticked or not', async () => {
    const before = app.count('items');
    const r = await app.api.put(`/api/days/${MON}/priorities`, { priorities: [row('Report', 'aaaaaaaaaaa1'), row('Email', 'aaaaaaaaaaa2', { done: true })] });
    await app.api.put(`/api/days/${MON}/priorities`, { priorities: [], base: r.body.priorities });
    expect(app.count('items')).toBe(before);
  });

  it('keeps a task in a lane, one another day lists, and one a session names', async () => {
    await app.api.post('/api/items', { uid: 'card0000000a', title: 'Write the KB', lane: 'later' });
    await app.api.put(`/api/days/${MON}/priorities`, {
      priorities: [row('Write the KB', 'card0000000a'), row('Email', 'aaaaaaaaaaa2'), row('Call', 'aaaaaaaaaaa3')],
    });
    await app.api.put(`/api/days/${TUE}/priorities`, { priorities: [row('Email', 'aaaaaaaaaaa2')] });
    await app.api.post(`/api/days/${MON}/sessions`, { plannedSeconds: 600, priorityUid: 'aaaaaaaaaaa3' });
    await app.api.put(`/api/days/${MON}/priorities`, { priorities: [] });
    await app.api.put(`/api/days/${TUE}/priorities`, { priorities: [] });
    expect([itemOf('card0000000a'), itemOf('aaaaaaaaaaa2'), itemOf('aaaaaaaaaaa3')].map((i) => i?.title)).toEqual(['Write the KB', undefined, 'Call']);
  });
});

// A task deleted everywhere stays as a tombstone: a save from a device that still has it drops its row.
describe('PUT /api/days/:date/priorities: a deleted task', () => {
  const MON = '2026-08-03';
  const TUE = '2026-08-04';
  const report = row('Report', 'aaaaaaaaaaa1');
  const email = row('Email', 'aaaaaaaaaaa2');

  beforeEach(async () => {
    await app.api.put(`/api/days/${MON}/priorities`, { priorities: [report, email] });
    await app.api.post(`/api/days/${MON}/sessions`, { plannedSeconds: 600, priorityUid: report.uid });
    expect((await app.api.del(`/api/items/${report.uid}`)).status).toBe(200);
  });

  it("drops its row from a stale save, stores the rest, and leaves the tombstone's name alone", async () => {
    const r = await app.api.put(`/api/days/${MON}/priorities`, {
      priorities: [
        { ...report, text: 'Report v2', done: true },
        { ...email, done: true },
      ],
      base: [report, email],
    });
    expect(r.status).toBe(200);
    expect(r.body.priorities).toEqual([stored(1, 'Email', email.uid!, { done: true })]);
    expect(itemOf(report.uid!)).toMatchObject({ title: 'Report', deleted_at: expect.any(Number) });
    // The session the delete took off it stays off it.
    expect(app.count('sessions', 'item_id = ?', itemOf(report.uid!)!.id)).toBe(0);
    expect(app.count('sessions', 'label = ? AND item_id IS NULL', 'Report')).toBe(1);
  });

  it('makes no task and no row from a save that puts it on another list', async () => {
    const r = await app.api.put(`/api/days/${TUE}/priorities`, { priorities: [{ ...report, text: 'Carried' }, row('')], base: [row(''), row('')] });
    expect(r.body.priorities).toEqual([]);
    expect(app.count('items', 'uid = ?', report.uid)).toBe(1);
    expect(app.count('priorities', 'item_id = ?', itemOf(report.uid!)!.id)).toBe(0);
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
    expect((await a.get(`/api/days/${date}`)).body).toEqual(before);
    const bDay = (await b.get(`/api/days/${date}`)).body;
    expect(bDay.priorities.map((p: { text: string }) => p.text)).toEqual(['Mine']);
    expect(bDay.overtimeApproved).toBe(true);
    expect(bDay.retroNote).toBe('b');
    expect(bDay.workMinutes).toBe(240);
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
