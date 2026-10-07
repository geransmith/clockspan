import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { ensureDefaultUser } from '../db.js';
import { seedDatabase, type DayKind } from '../dev/seed.js';
import { ensureDay } from './shared.js';
import { MAX_PRIORITIES } from '../../shared/settings.js';
import { MAX_PUNCHES } from '../../shared/punches.js';
import { HOUR_MS, punchWindow } from '../../shared/dates.js';
import { BOARD_LIMITS, LIMITS, type BoardCard, type Day, type Priority } from '../../shared/api.js';

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
    // Every row must be an object, whatever a string's or an array's `at` would read as.
    for (const row of [null, 5, true, 'x', [1], [{ at: T0 + 8 * HOUR_MS }]]) {
      const r = await app.api.put('/api/days/2026-09-01/punches', { punches: [{ at: T0 + 8 * HOUR_MS }, row] });
      expect([r.status, r.body.error], JSON.stringify(row)).toEqual([400, 'Punch 1 must be an object.']);
    }
    expect((await app.api.get('/api/days/2026-09-01')).body.punches).toEqual([]);
  });
});

describe('PUT /api/days/:date/priorities', () => {
  it('renumbers, keeps client ids, and mints ids only for text rows without one', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', {
      priorities: [{ text: 'Kept', done: true, uid: 'ABCDEF123456', addedAt: 100 }, { text: '', done: true }, { text: 'Minted' }],
    });
    expect(r.status).toBe(200);
    const [a, b, c] = r.body.priorities;
    const unlinked = { cardUid: null, recurringUid: null, categoryUid: null };
    expect(a).toEqual({ position: 1, text: 'Kept', done: true, uid: 'abcdef123456', addedAt: 100, ...unlinked });
    // An empty row is never done and never gets an id.
    expect(b).toEqual({ position: 2, text: '', done: false, uid: null, addedAt: null, ...unlinked });
    expect(c.position).toBe(3);
    expect(c.uid).toMatch(/^[a-f0-9]{12}$/);
    expect(typeof c.addedAt).toBe('number');
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
    expect(again.body.priorities.map((p: { text: string }) => p.text)).toEqual(['Four']);
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
    // Absent or null is an empty row.
    expect((await put({ text: null, uid: null })).status).toBe(200);
  });

  it('refuses a row that is not an object, and stores nothing', async () => {
    for (const row of [null, 'x', 5, true, [1], [{ text: 'a' }]]) {
      const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'ok' }, row] });
      expect([r.status, r.body.error], JSON.stringify(row)).toEqual([400, 'Priority 2 must be an object.']);
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
    // Row 3 was written in and cleared: it is still its item, card and category included.
    const priorities = [
      { position: 1, text: 'Write the report', done: true, uid: 'abcdef123456', addedAt: T0, cardUid: null, recurringUid: null, categoryUid: 'cafe00000001' },
      { position: 2, text: '', done: false, uid: null, addedAt: null, cardUid: null, recurringUid: null, categoryUid: null },
      {
        position: 3,
        text: '',
        done: false,
        uid: '0123456789ab',
        addedAt: T0 + HOUR_MS,
        cardUid: 'card00000001',
        recurringUid: null,
        categoryUid: 'cafe00000002',
      },
    ];
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities });
    expect(r.status).toBe(200);
    expect(r.body.priorities).toEqual(priorities);
  });
});

// Two devices, each saving the list it built on its last copy of the day (`base`): the server
// lays each one's changes onto what it holds (`mergePriorities`, shared/priorities.ts).
describe('PUT /api/days/:date/priorities with a base', () => {
  const PATH = '/api/days/2026-09-01/priorities';
  /** A row as the web app sends it: written rows carry their uid and addedAt. */
  const row = (text: string, uid: string | null = null, patch: Record<string, unknown> = {}) => ({
    position: 0,
    text,
    done: false,
    uid,
    addedAt: uid ? T0 : null,
    ...patch,
  });
  const EMPTY = [row(''), row(''), row('')];
  const texts = (priorities: { text: string }[]) => priorities.map((p) => p.text);

  it("keeps both devices' new rows when each saves on a copy from before the other's", async () => {
    expect((await app.api.put(PATH, { priorities: [row('Report', 'aaaaaaaaaaaa'), row(''), row('')], base: EMPTY })).status).toBe(200);
    const r = await app.api.put(PATH, { priorities: [row('Email', 'bbbbbbbbbbbb'), row(''), row('')], base: EMPTY });
    expect(r.status).toBe(200);
    expect(texts(r.body.priorities)).toEqual(['Email', 'Report', '']);
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

  it('stores one set when two devices take the same left-open rows, the first one saved', async () => {
    await app.api.put(PATH, { priorities: [row('Invoices', 'aaaaaaaaaaa1'), row('Call the bank', 'aaaaaaaaaaa2'), row('')], base: EMPTY });
    const r = await app.api.put(PATH, { priorities: [row('Invoices', 'bbbbbbbbbbb1'), row('Call the bank', 'bbbbbbbbbbb2'), row('')], base: EMPTY });
    expect(r.body.priorities.map((p: { text: string; uid: string | null }) => [p.text, p.uid])).toEqual([
      ['Invoices', 'aaaaaaaaaaa1'],
      ['Call the bank', 'aaaaaaaaaaa2'],
      ['', null],
    ]);
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
    ];
    for (const [base, error] of refusals) {
      const r = await put(base);
      expect([r.status, r.body.error], JSON.stringify(base)).toEqual([400, error]);
    }
    expect((await app.api.get('/api/days/2026-09-01')).body.priorities).toEqual([]);
  });
});

// Each row's soft links to its task: the board card, the recurring priority, the category.
describe('PUT /api/days/:date/priorities: links', () => {
  const PATH = '/api/days/2026-09-01/priorities';
  const CARD = 'card00000001';
  const ROUTINE = 'rcur00000001';
  const CAT = 'cafe00000001';
  /** A row as the web app sends it, linked to nothing unless patched. */
  const row = (text: string, uid: string | null = null, patch: Record<string, unknown> = {}) => ({
    position: 0,
    text,
    done: false,
    uid,
    addedAt: uid ? T0 : null,
    cardUid: null,
    recurringUid: null,
    categoryUid: null,
    ...patch,
  });
  const stored = async () => (await app.api.get('/api/days/2026-09-01')).body.priorities as Record<string, unknown>[];
  const links = (priorities: Record<string, unknown>[]) => priorities.map((p) => [p.uid, p.text, p.cardUid, p.recurringUid, p.categoryUid]);

  it('stores the links each row carries, lowercased, and answers them here, on a read and in a range', async () => {
    const sent = [
      row('Report', 'aaaaaaaaaaa1', { cardUid: 'CARD00000001', categoryUid: CAT }),
      row('Monitor the queue', 'aaaaaaaaaaa2', { recurringUid: ROUTINE }),
    ];
    const r = await app.api.put(PATH, { priorities: sent });
    expect(r.status).toBe(200);
    const expected = [
      ['aaaaaaaaaaa1', 'Report', CARD, null, CAT],
      ['aaaaaaaaaaa2', 'Monitor the queue', null, ROUTINE, null],
    ];
    expect(links(r.body.priorities)).toEqual(expected);
    expect(links(await stored())).toEqual(expected);
    expect(links((await app.api.get('/api/days/range?from=2026-09-01&to=2026-09-01')).body.days[0].priorities)).toEqual(expected);
  });

  it("keeps a row's category where a save leaves the field out: the base's, else the stored one", async () => {
    await app.api.put(PATH, { priorities: [row('Report', 'aaaaaaaaaaa1', { categoryUid: CAT })] });
    // Another device recategorised the row since this one's base; leaving the field out changes nothing.
    await app.api.put(PATH, { priorities: [row('Report', 'aaaaaaaaaaa1', { categoryUid: 'cafe00000002' })] });
    const { categoryUid: _left, ...noCategory } = row('Report v2', 'aaaaaaaaaaa1');
    const r = await app.api.put(PATH, { priorities: [noCategory], base: [row('Report', 'aaaaaaaaaaa1', { categoryUid: CAT })] });
    expect(links(r.body.priorities)).toEqual([['aaaaaaaaaaa1', 'Report v2', null, null, 'cafe00000002']]);
    // With no base, or a base that leaves it out too, the stored value stands.
    const again = await app.api.put(PATH, { priorities: [{ ...noCategory, text: 'Report v3' }] });
    expect(links(again.body.priorities)).toEqual([['aaaaaaaaaaa1', 'Report v3', null, null, 'cafe00000002']]);
    const fromStored = await app.api.put(PATH, { priorities: [noCategory], base: [{ ...noCategory, text: 'Report v3' }] });
    expect(links(fromStored.body.priorities)).toEqual([['aaaaaaaaaaa1', 'Report v2', null, null, 'cafe00000002']]);
    // A new row that leaves it out has none.
    const added = await app.api.put(PATH, { priorities: [noCategory, { text: 'Email' }] });
    expect(added.body.priorities[1].categoryUid).toBeNull();
  });

  it('reads a category left out from the stored row when the base lacks the row, and from the base when the server has lost it', async () => {
    await app.api.put(PATH, { priorities: [row('Report', 'aaaaaaaaaaa1', { categoryUid: CAT })] });
    const { categoryUid: _left, ...noCategory } = row('Report', 'aaaaaaaaaaa1');
    // A list built on an empty day: the server's row keeps its category.
    const kept = await app.api.put(PATH, { priorities: [noCategory], base: [] });
    expect(links(kept.body.priorities)).toEqual([['aaaaaaaaaaa1', 'Report', null, null, CAT]]);
    // Another device removed the row; this one sends it as its base had it, so it stays gone.
    const email = row('Email', 'aaaaaaaaaaa2');
    await app.api.put(PATH, { priorities: [email] });
    const gone = await app.api.put(PATH, { priorities: [noCategory, email], base: [row('Report', 'aaaaaaaaaaa1', { categoryUid: CAT }), email] });
    expect(links(gone.body.priorities)).toEqual([['aaaaaaaaaaa2', 'Email', null, null, null]]);
  });

  it("keeps a stored row's card and recurring priority whatever a save sends, with links left out or changed", async () => {
    await app.api.put(PATH, { priorities: [row('Report', 'aaaaaaaaaaa1', { cardUid: CARD }), row('Queue', 'aaaaaaaaaaa2', { recurringUid: ROUTINE })] });
    // A tab from before links sends none.
    const old = await app.api.put(PATH, {
      priorities: [
        { text: 'Report', uid: 'aaaaaaaaaaa1' },
        { text: 'Queue', uid: 'aaaaaaaaaaa2' },
      ],
    });
    expect(links(old.body.priorities)).toEqual([
      ['aaaaaaaaaaa1', 'Report', CARD, null, null],
      ['aaaaaaaaaaa2', 'Queue', null, ROUTINE, null],
    ]);
    const changed = await app.api.put(PATH, {
      priorities: [row('Report', 'aaaaaaaaaaa1', { cardUid: 'card00000002' }), row('Queue', 'aaaaaaaaaaa2', { recurringUid: null })],
    });
    expect(links(changed.body.priorities)).toEqual(links(old.body.priorities));
  });

  it('keeps the card and the category of an emptied row, which is still its item', async () => {
    const written = row('Report', 'aaaaaaaaaaa1', { cardUid: CARD, categoryUid: CAT });
    await app.api.put(PATH, { priorities: [written] });
    const r = await app.api.put(PATH, { priorities: [{ ...written, text: '', done: true }], base: [written] });
    expect(r.body.priorities).toEqual([{ ...written, position: 1, text: '', done: false }]);
  });

  it('drops the links a row never written in sends', async () => {
    const r = await app.api.put(PATH, { priorities: [row('', null, { cardUid: CARD, categoryUid: CAT }), row('', null, { recurringUid: ROUTINE })] });
    expect(links(r.body.priorities)).toEqual([
      [null, '', null, null, null],
      [null, '', null, null, null],
    ]);
  });

  it('takes the card off an emptied row whose card a text row holds', async () => {
    const first = row('Report', 'aaaaaaaaaaa1', { cardUid: CARD });
    await app.api.put(PATH, { priorities: [first] });
    const emptied = { ...first, text: '' };
    await app.api.put(PATH, { priorities: [emptied], base: [first] });
    const r = await app.api.put(PATH, { priorities: [emptied, row('Report again', 'aaaaaaaaaaa2', { cardUid: CARD })], base: [emptied] });
    expect(links(r.body.priorities)).toEqual([
      ['aaaaaaaaaaa1', '', null, null, null],
      ['aaaaaaaaaaa2', 'Report again', CARD, null, null],
    ]);
  });

  it('refuses a row that is both a card and a recurring priority, and stores nothing', async () => {
    const r = await app.api.put(PATH, { priorities: [row('Report'), row('Queue', null, { cardUid: CARD, recurringUid: ROUTINE })] });
    expect([r.status, r.body.error]).toEqual([400, "Priority 2 can't be both a card and a recurring priority."]);
    expect(app.count('days', 'date = ?', '2026-09-01')).toBe(0);
  });

  it('refuses a list that repeats a card or a recurring priority on a row new to the server, and stores nothing', async () => {
    const twoCards = await app.api.put(PATH, { priorities: [row('Report', null, { cardUid: CARD }), row('Report again', null, { cardUid: CARD })] });
    expect([twoCards.status, twoCards.body.error]).toEqual([400, "Priority 2 repeats another row's card."]);
    const twoRoutines = await app.api.put(PATH, {
      priorities: [row('Queue', null, { recurringUid: ROUTINE }), row('Email'), row('Queue', null, { recurringUid: ROUTINE })],
    });
    expect([twoRoutines.status, twoRoutines.body.error]).toEqual([400, "Priority 3 repeats another row's recurring priority."]);
    // A day the refusal would have made isn't stored either.
    expect(app.count('days', 'date = ?', '2026-09-01')).toBe(0);
    const first = row('Report', 'aaaaaaaaaaa1', { cardUid: CARD });
    await app.api.put(PATH, { priorities: [first] });
    const r = await app.api.put(PATH, { priorities: [first, row('Report again', 'aaaaaaaaaaa2', { cardUid: CARD })], base: [first] });
    expect([r.status, r.body.error]).toEqual([400, "Priority 2 repeats another row's card."]);
    expect(links(await stored())).toEqual([['aaaaaaaaaaa1', 'Report', CARD, null, null]]);
  });

  it('accepts a list it already holds that repeats a card, and stores one row for it', async () => {
    const dayId = ensureDay(app.db, ensureDefaultUser(app.db).id, '2026-09-01');
    const insert = app.db.prepare(`INSERT INTO priorities (day_id, position, text, uid, added_at, card_uid) VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run(dayId, 1, 'Report', 'aaaaaaaaaaa1', T0, CARD);
    insert.run(dayId, 2, 'Report again', 'aaaaaaaaaaa2', T0, CARD);
    const held = await stored();
    const r = await app.api.put(PATH, { priorities: held, base: held });
    expect(r.status).toBe(200);
    expect(links(r.body.priorities)).toEqual([['aaaaaaaaaaa1', 'Report', CARD, null, null]]);
  });

  it('stores one row where two devices placed the same card: the first one saved', async () => {
    const EMPTY = [row(''), row(''), row('')];
    expect((await app.api.put(PATH, { priorities: [row('Invoices', 'aaaaaaaaaaa1', { cardUid: CARD }), row(''), row('')], base: EMPTY })).status).toBe(200);
    const r = await app.api.put(PATH, { priorities: [row('Invoices', 'bbbbbbbbbbb1', { cardUid: CARD }), row(''), row('')], base: EMPTY });
    expect(r.status).toBe(200);
    expect(links(r.body.priorities.filter((p: { text: string }) => p.text))).toEqual([['aaaaaaaaaaa1', 'Invoices', CARD, null, null]]);
  });

  it("stores one row where a stale edit brings back a row another device removed and placed again: the stored one, in the edit's place", async () => {
    const base = [row('Report', 'aaaaaaaaaaa1', { cardUid: CARD }), row('Email', 'aaaaaaaaaaa2')];
    await app.api.put(PATH, { priorities: base });
    // The other device took the card off the list and placed it back as a new row.
    await app.api.put(PATH, { priorities: [base[1], row('Report', 'bbbbbbbbbbb1', { cardUid: CARD })], base });
    const r = await app.api.put(PATH, { priorities: [row('Report v2', 'aaaaaaaaaaa1', { cardUid: CARD }), base[1]], base });
    expect(links(r.body.priorities)).toEqual([
      ['bbbbbbbbbbb1', 'Report', CARD, null, null],
      ['aaaaaaaaaaa2', 'Email', null, null, null],
    ]);
  });

  it('stores one row where a draft still holds a row another device replaced', async () => {
    const base = [row('Report', 'aaaaaaaaaaa1', { cardUid: CARD }), row('Email', 'aaaaaaaaaaa2')];
    await app.api.put(PATH, { priorities: base });
    await app.api.put(PATH, { priorities: [base[1], row('Report', 'bbbbbbbbbbb1', { cardUid: CARD })], base });
    // The draft edited another row and still has the replaced one as it was.
    const r = await app.api.put(PATH, { priorities: [base[0], row('Email the team', 'aaaaaaaaaaa2')], base });
    expect(links(r.body.priorities)).toEqual([
      ['aaaaaaaaaaa2', 'Email the team', null, null, null],
      ['bbbbbbbbbbb1', 'Report', CARD, null, null],
    ]);
  });

  it('refuses a link that is not a uid, in the list or its base, and stores nothing', async () => {
    const fields: [string, string][] = [
      ['cardUid', 'card'],
      ['recurringUid', 'recurring priority'],
      ['categoryUid', 'category'],
    ];
    for (const [field, name] of fields) {
      for (const value of ['not-a-uid!', 'ab', 12345678, true, { uid: CARD }]) {
        const r = await app.api.put(PATH, { priorities: [row('Report'), row('Email', null, { [field]: value })] });
        expect([r.status, r.body.error], `${field} ${JSON.stringify(value)}`).toEqual([400, `Priority 2 has an invalid ${name}.`]);
      }
      const base = await app.api.put(PATH, { priorities: [row('Report')], base: [row('Report', null, { [field]: 'x' })] });
      expect([base.status, base.body.error]).toEqual([400, `Base row 1 has an invalid ${name}.`]);
    }
    expect(app.count('days', 'date = ?', '2026-09-01')).toBe(0);
  });
});

// A board card follows the rows linked to it, saved in the same transaction (`mirrorCards`,
// server/board.ts). `cards` is what the web app sends for today or a later day with the board on.
describe('PUT /api/days/:date/priorities: board cards', () => {
  const MON = '2026-08-03';
  const TUE = '2026-08-04';
  beforeEach(async () => {
    // Only Date, so doneAt can be compared: HTTP keeps its real timers.
    vi.useFakeTimers({ now: SEED_NOW, toFake: ['Date'] });
    await app.close();
    app = await startTestApp();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const save = (date: string, priorities: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    app.api.put(`/api/days/${date}/priorities`, { priorities, ...extra });
  /** A save of a list whose day is today or later, with the board on. */
  const saveOn = (date: string, priorities: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    save(date, priorities, { cards: true, ...extra });
  const cards = async () => (await app.api.get('/api/board')).body.cards as BoardCard[];
  const card = async (uid: string) => (await cards()).find((c) => c.uid === uid);
  /** Each card as [lane, position, title], in the board's order. */
  const lanes = async () => (await cards()).map((c) => [c.lane, c.position, c.title]);
  const untouched = (uid: string) => app.count('board_cards', 'uid = ? AND untouched = 1', uid) === 1;
  const capture = (uid: string, title: string, lane: string) => app.api.post('/api/board/cards', { uid, title, lane, before: null });
  const REPORT = { text: 'Report', uid: 'aaaaaaaaaaa1' };
  /** The card a save with the board on made for `row`, the list's one row. */
  const madeFor = async (date: string, row: Record<string, unknown> = REPORT) => (await saveOn(date, [row])).body.priorities[0].cardUid as string;
  const rowOn = async (date: string) => (await app.api.get(`/api/days/${date}`)).body.priorities[0] as Record<string, unknown>;

  it('makes a card for each text row without one and writes its uid onto the row, open ones at the top of Next', async () => {
    await capture('card00000001', 'Follow up on the SLA', 'next');
    const r = await saveOn(MON, [
      { text: 'Report' },
      { text: 'Email the team', done: true },
      { text: '' },
      { text: 'Invoices' },
      { text: 'Monitor the queue', recurringUid: 'rcur00000001' },
    ]);
    expect(r.status).toBe(200);
    const [report, email, empty, invoices, queue] = r.body.priorities;
    for (const p of [report, email, invoices]) expect(p.cardUid).toMatch(/^[0-9a-f]{12}$/);
    // A row never written in, and a recurring one, get none.
    expect([empty.cardUid, queue.cardUid]).toEqual([null, null]);
    expect((await app.api.get(`/api/days/${MON}`)).body.priorities).toEqual(r.body.priorities);
    expect(await lanes()).toEqual([
      ['next', 1, 'Report'],
      ['next', 2, 'Invoices'],
      ['next', 3, 'Follow up on the SLA'],
      ['done', 0, 'Email the team'],
    ]);
    expect(await card(report.cardUid)).toEqual({
      uid: report.cardUid,
      title: 'Report',
      categoryUid: null,
      lane: 'next',
      position: 1,
      createdAt: SEED_NOW,
      doneAt: null,
      listDate: MON,
      held: false,
    });
    expect(await card(email.cardUid)).toMatchObject({ doneAt: SEED_NOW, listDate: MON });
    expect(untouched(report.cardUid)).toBe(true);
    // Saved again, every row keeps its card and nothing changes.
    const board = await cards();
    const again = await saveOn(MON, r.body.priorities, { base: r.body.priorities });
    expect(again.body.priorities).toEqual(r.body.priorities);
    expect(await cards()).toEqual(board);
  });

  it('makes none without cards, nor once Later and Next are full, and tries again on the next save', async () => {
    expect((await save(MON, [{ text: 'Report' }])).body.priorities[0].cardUid).toBeNull();
    expect((await save(MON, [{ text: 'Report' }], { cards: false })).body.priorities[0].cardUid).toBeNull();
    const userId = ensureDefaultUser(app.db).id;
    const insert = app.db.prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at) VALUES (?, ?, 'Card', 'later', ?, 0)`);
    for (let i = 1; i <= BOARD_LIMITS.openCards; i++) insert.run(userId, `card${String(i).padStart(8, '0')}`, i);
    // The save itself never fails because of the board.
    const full = await saveOn(MON, [{ text: 'Report' }, { text: 'Email', done: true }]);
    expect(full.status).toBe(200);
    expect(full.body.priorities.map((p: Priority) => p.cardUid)).toEqual([null, null]);
    await app.api.del('/api/board/cards/card00000001');
    // The first row's card fills Later and Next again, so the second waits for another save.
    const next = await saveOn(MON, full.body.priorities);
    expect(next.body.priorities.map((p: Priority) => p.cardUid)).toEqual([expect.stringMatching(/^[0-9a-f]{12}$/), null]);
  });

  it('counts the cards a save takes out of Done or puts there before it makes another under the cap', async () => {
    const [report, email] = (
      await saveOn(MON, [
        { ...REPORT, done: true },
        { text: 'Email', uid: 'aaaaaaaaaaa2' },
      ])
    ).body.priorities;
    const userId = ensureDefaultUser(app.db).id;
    const insert = app.db.prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at) VALUES (?, ?, 'Card', 'later', ?, 0)`);
    // With Email's card in Next, Later and Next are one short of full.
    for (let i = 1; i <= BOARD_LIMITS.openCards - 2; i++) insert.run(userId, `card${String(i).padStart(8, '0')}`, i);
    const openCards = () => app.count('board_cards', "lane <> 'done'");
    const invoices = { text: 'Invoices', uid: 'aaaaaaaaaaa3' };
    // Unticked, Report's card takes the last place, so Invoices waits.
    const untick = await saveOn(MON, [{ ...report, done: false }, email, invoices]);
    expect(untick.body.priorities[2].cardUid).toBeNull();
    expect(openCards()).toBe(BOARD_LIMITS.openCards);
    // Ticking Email frees a place, which Invoices takes in the same save.
    const [kept, , waiting] = untick.body.priorities;
    const tick = await saveOn(MON, [kept, { ...email, done: true }, waiting]);
    expect(tick.body.priorities[2].cardUid).toMatch(/^[0-9a-f]{12}$/);
    expect(openCards()).toBe(BOARD_LIMITS.openCards);
  });

  it('stores one set, and a card for each row, when two devices take the same left-open rows', async () => {
    const first = await saveOn(
      TUE,
      [
        { text: 'Invoices', uid: 'aaaaaaaaaaa1' },
        { text: 'Call the bank', uid: 'aaaaaaaaaaa2' },
      ],
      { base: [] },
    );
    // The second device's rows are its own, with no card: the first save made the cards.
    const second = await saveOn(
      TUE,
      [
        { text: 'Invoices', uid: 'bbbbbbbbbbb1' },
        { text: 'Call the bank', uid: 'bbbbbbbbbbb2' },
      ],
      { base: [] },
    );
    expect(second.body.priorities).toEqual(first.body.priorities);
    expect(await lanes()).toEqual([
      ['next', 1, 'Invoices'],
      ['next', 2, 'Call the bank'],
    ]);
  });

  it('brings a card a list takes to Next with its title, at the top unless it was in Next, or to Done ticked', async () => {
    await capture('card00000001', 'Write the KB', 'later');
    await capture('card00000004', 'Update the macros', 'later');
    await capture('card00000002', 'Review canned replies', 'next');
    await capture('card00000003', 'Follow up', 'next');
    // A pull from Later: the board places a row linked to the card, and names it as handled.
    // Later closes the gap it left.
    const kb = { text: 'Write the KB article', uid: 'aaaaaaaaaaa1', cardUid: 'card00000001' };
    await saveOn(TUE, [kb], { touched: ['card00000001'] });
    expect(await lanes()).toEqual([
      ['later', 1, 'Update the macros'],
      ['next', 1, 'Write the KB article'],
      ['next', 2, 'Review canned replies'],
      ['next', 3, 'Follow up'],
    ]);
    // One in Next already stays where it is; a ticked one goes to Done.
    await saveOn(TUE, [kb, { text: 'Follow up', uid: 'aaaaaaaaaaa2', cardUid: 'card00000003' }]);
    await saveOn(TUE, [
      kb,
      { text: 'Follow up', uid: 'aaaaaaaaaaa2', cardUid: 'card00000003' },
      { text: 'Canned replies', done: true, cardUid: 'card00000002' },
    ]);
    expect(await lanes()).toEqual([
      ['later', 1, 'Update the macros'],
      ['next', 1, 'Write the KB article'],
      ['next', 2, 'Follow up'],
      ['done', 0, 'Canned replies'],
    ]);
    expect(await card('card00000002')).toMatchObject({ doneAt: SEED_NOW, listDate: TUE });
  });

  it("keeps a Done card's doneAt when its row arrives ticked on a later day", async () => {
    const uid = await madeFor(MON, { ...REPORT, done: true });
    vi.setSystemTime(SEED_NOW + HOUR_MS);
    await saveOn(TUE, [{ text: 'Report', done: true, cardUid: uid }]);
    expect(await card(uid)).toMatchObject({ lane: 'done', doneAt: SEED_NOW, listDate: TUE });
  });

  it('copies only what a save changed: new text renames the card, a tick moves it to Done and an untick to the top of Next', async () => {
    const uid = await madeFor(MON);
    await capture('card00000001', 'Follow up', 'next');
    // Moved to Later on the board the day after, which a rename leaves alone.
    await app.api.patch(`/api/board/cards/${uid}`, { today: TUE, lane: 'later' });
    await save(MON, [{ ...REPORT, text: 'Quarterly report' }]);
    expect(await card(uid)).toMatchObject({ title: 'Quarterly report', lane: 'later' });
    vi.setSystemTime(SEED_NOW + HOUR_MS);
    await save(MON, [{ ...REPORT, text: 'Quarterly report', done: true }]);
    expect(await card(uid)).toMatchObject({ lane: 'done', position: 0, doneAt: SEED_NOW + HOUR_MS });
    await save(MON, [{ ...REPORT, text: 'Quarterly report' }]);
    expect(await lanes()).toEqual([
      ['next', 1, 'Quarterly report'],
      ['next', 2, 'Follow up'],
    ]);
    expect((await card(uid))!.doneAt).toBeNull();
  });

  it('puts the card at the top of Next on an untick, even when the board had moved it back to Next', async () => {
    await capture('card00000001', 'Follow up', 'next');
    const uid = await madeFor(MON, { ...REPORT, done: true });
    await app.api.patch(`/api/board/cards/${uid}`, { today: TUE, lane: 'next' });
    expect(await card(uid)).toMatchObject({ lane: 'next', position: 2 });
    await save(MON, [REPORT]);
    expect(await lanes()).toEqual([
      ['next', 1, 'Report'],
      ['next', 2, 'Follow up'],
    ]);
  });

  it('holds a card a save made while its row is emptied, and deletes it when the row goes, text or emptied', async () => {
    const uid = await madeFor(TUE);
    await saveOn(TUE, [{ ...REPORT, text: '' }]);
    expect(await card(uid)).toMatchObject({ title: 'Report', lane: 'next', listDate: TUE, held: true });
    expect((await rowOn(TUE)).cardUid).toBe(uid);
    await saveOn(TUE, []);
    expect(await card(uid)).toBeUndefined();
    const email = await madeFor(TUE, { text: 'Email', uid: 'aaaaaaaaaaa2' });
    await saveOn(TUE, []);
    expect(await card(email)).toBeUndefined();
    expect(app.count('board_cards')).toBe(0);
  });

  it('renames the card when its emptied row is typed in again, on a past day and with the board off', async () => {
    // A past day's list is saved without cards.
    const past = await madeFor(MON);
    await save(MON, [{ ...REPORT, text: '' }]);
    await save(MON, [{ ...REPORT, text: 'Quarterly report' }]);
    expect(await card(past)).toMatchObject({ title: 'Quarterly report', lane: 'next', held: false });
    // Today's, with the board switched off since.
    const today = await madeFor(TUE);
    await save(TUE, [{ ...REPORT, text: '' }], { cards: false });
    await save(TUE, [{ ...REPORT, text: 'Invoices', done: true }], { cards: false });
    expect(await card(today)).toMatchObject({ title: 'Invoices', lane: 'done', held: false });
    expect((await rowOn(TUE)).cardUid).toBe(today);
  });

  it('keeps a card the save names as touched, and one a later day links, when its row goes', async () => {
    // A park: the save that takes the row off names the card the board placed.
    const parked = await madeFor(MON);
    await saveOn(MON, [], { touched: [parked] });
    expect(await card(parked)).toMatchObject({ lane: 'next', listDate: null, held: false });
    expect(untouched(parked)).toBe(false);
    // Carried to Tuesday: Monday's row is no longer the latest.
    const carried = await madeFor(MON, { text: 'Email', uid: 'aaaaaaaaaaa2' });
    await saveOn(TUE, [{ text: 'Email', cardUid: carried }]);
    await save(MON, []);
    expect(await card(carried)).toMatchObject({ listDate: TUE });
    expect(untouched(carried)).toBe(true);
  });

  it('deletes an untouched card carried to Tuesday and taken off there; Monday keeps its row', async () => {
    const uid = await madeFor(MON);
    await saveOn(TUE, [{ text: 'Report', uid: 'bbbbbbbbbbb1', cardUid: uid }]);
    await saveOn(TUE, []);
    expect(await card(uid)).toBeUndefined();
    expect(await rowOn(MON)).toMatchObject({ text: 'Report', cardUid: uid });
  });

  it('marks the cards touched names as handled, whatever the case of their uid', async () => {
    const uid = await madeFor(TUE);
    // A tick made on the board.
    await saveOn(TUE, [{ ...REPORT, done: true }], { touched: [uid.toUpperCase()] });
    expect(untouched(uid)).toBe(false);
    await saveOn(TUE, [{ ...REPORT, text: '' }]);
    expect(await card(uid)).toMatchObject({ lane: 'done', held: false });
    await saveOn(TUE, []);
    expect(await card(uid)).toMatchObject({ lane: 'done', listDate: null });
  });

  it('puts a handled card back in Done when the open row that took it out of Done goes, and leaves it otherwise', async () => {
    // Ticked on Monday, pulled out of Done into Tuesday's list, then taken off again.
    const done = await madeFor(MON, { ...REPORT, done: true });
    await saveOn(TUE, [{ text: 'Report', uid: 'bbbbbbbbbbb1', cardUid: done }], { touched: [done] });
    expect(await card(done)).toMatchObject({ lane: 'next', doneAt: null });
    vi.setSystemTime(SEED_NOW + HOUR_MS);
    await saveOn(TUE, []);
    expect(await card(done)).toMatchObject({ lane: 'done', doneAt: SEED_NOW + HOUR_MS, listDate: MON });

    // Left open on its first day: it stays in Next.
    const open = await madeFor('2026-08-10', { text: 'Email', uid: 'aaaaaaaaaaa2' });
    await saveOn('2026-08-11', [{ text: 'Email', uid: 'bbbbbbbbbbb2', cardUid: open }], { touched: [open] });
    await saveOn('2026-08-11', []);
    expect(await card(open)).toMatchObject({ lane: 'next' });
    // Ticked on the day it was taken off: it stays in Done, where the tick put it.
    await saveOn('2026-08-11', [{ text: 'Email', uid: 'bbbbbbbbbbb2', cardUid: open, done: true }], { touched: [open] });
    await saveOn('2026-08-11', []);
    expect(await card(open)).toMatchObject({ lane: 'done' });
    // In Later, where the board put it: it stays there.
    const later = await madeFor('2026-08-17', { text: 'Invoices', uid: 'aaaaaaaaaaa3' });
    await app.api.patch(`/api/board/cards/${later}`, { today: '2026-08-18', lane: 'later' });
    await save('2026-08-17', []);
    expect(await card(later)).toMatchObject({ lane: 'later' });
    // Captured on the board, on no list before: it stays in Next.
    await capture('card00000001', 'Write the KB', 'next');
    await saveOn('2026-08-24', [{ text: 'Write the KB', uid: 'bbbbbbbbbbb3', cardUid: 'card00000001' }]);
    await saveOn('2026-08-24', []);
    expect(await card('card00000001')).toMatchObject({ lane: 'next' });
  });

  it('leaves a handled card where it is when the row taken off was parked, emptied or ticked, and reads past an emptied row for the tick', async () => {
    /** A card ticked on `mon` and pulled out of Done into `tue`'s list as `row`, which the save returns. */
    const pulled = async (mon: string, tue: string, text: string, n: number) => {
      const uid = await madeFor(mon, { text, uid: `aaaaaaaaaaa${n}`, done: true });
      const row = { text, uid: `bbbbbbbbbbb${n}`, cardUid: uid };
      await saveOn(tue, [row], { touched: [uid] });
      return { uid, row };
    };
    // A park: the board put the card in Next, and the removal names it.
    const parked = await pulled('2026-08-03', '2026-08-04', 'Report', 1);
    await capture(parked.uid, 'Report', 'next');
    await saveOn('2026-08-04', [], { touched: [parked.uid] });
    expect(await card(parked.uid)).toMatchObject({ lane: 'next' });
    // Emptied before it went.
    const emptied = await pulled('2026-08-10', '2026-08-11', 'Email', 2);
    await saveOn('2026-08-11', [{ ...emptied.row, text: '' }]);
    await saveOn('2026-08-11', []);
    expect(await card(emptied.uid)).toMatchObject({ lane: 'next' });
    // Ticked, then moved back to Next on the board the day after, before it went.
    const ticked = await pulled('2026-08-17', '2026-08-18', 'Invoices', 3);
    await saveOn('2026-08-18', [{ ...ticked.row, done: true }]);
    await app.api.patch(`/api/board/cards/${ticked.uid}`, { today: '2026-08-19', lane: 'next' });
    await saveOn('2026-08-18', []);
    expect(await card(ticked.uid)).toMatchObject({ lane: 'next' });
    // Pulled again past a day whose row was emptied: the latest row with text is the ticked one.
    const skipped = await pulled('2026-08-24', '2026-08-25', 'Call the bank', 4);
    await saveOn('2026-08-25', [{ ...skipped.row, text: '' }]);
    await saveOn('2026-08-26', [{ text: 'Call the bank', uid: 'ccccccccccc4', cardUid: skipped.uid }], { touched: [skipped.uid] });
    await saveOn('2026-08-26', []);
    expect(await card(skipped.uid)).toMatchObject({ lane: 'done', listDate: '2026-08-25' });
  });

  it("leaves the card alone when an older day's list is saved", async () => {
    const uid = await madeFor(MON);
    await saveOn(TUE, [{ text: 'Report', uid: 'bbbbbbbbbbb1', cardUid: uid }]);
    const before = await card(uid);
    await save(MON, [{ ...REPORT, text: 'Report, old copy', done: true }]);
    await save(MON, []);
    expect(await card(uid)).toEqual(before);
  });

  it("gives a deleted card's row nothing, unless the row gains text in a save with cards", async () => {
    const uid = await madeFor(MON);
    expect((await app.api.del(`/api/board/cards/${uid}`)).status).toBe(200);
    await save(MON, [{ ...REPORT, text: 'Report v2', done: true }]);
    await save(MON, [{ ...REPORT, text: '' }]);
    await save(MON, [{ ...REPORT, text: 'Report v3' }]);
    await saveOn(MON, [{ ...REPORT, text: 'Report v4' }]);
    expect(await cards()).toEqual([]);
    expect((await rowOn(MON)).cardUid).toBe(uid);
    // Typed in again with the board on: the card comes back under the row's link, handled if the save says so.
    await saveOn(MON, [{ ...REPORT, text: '' }]);
    await saveOn(MON, [{ ...REPORT, text: 'Report v5' }], { touched: [uid] });
    expect(await card(uid)).toMatchObject({ title: 'Report v5', lane: 'next', held: false });
    expect(untouched(uid)).toBe(false);
    const email = await madeFor(TUE, { text: 'Email', uid: 'aaaaaaaaaaa2' });
    await app.api.del(`/api/board/cards/${email}`);
    // Removed with its card gone: nothing to delete.
    await saveOn(TUE, []);
    await saveOn(TUE, [{ text: 'Email', uid: 'aaaaaaaaaaa2', cardUid: email, done: true }]);
    expect(await card(email)).toMatchObject({ lane: 'done', doneAt: SEED_NOW });
    expect(untouched(email)).toBe(true);
  });

  it("brings a deleted card back only from its latest linked day's row", async () => {
    const uid = await madeFor(MON);
    await saveOn(TUE, [{ text: 'Report', uid: 'bbbbbbbbbbb1', cardUid: uid }]);
    await app.api.del(`/api/board/cards/${uid}`);
    // Monday's row is typed in again, but Tuesday's still links the card.
    await saveOn(MON, [{ ...REPORT, text: '' }]);
    await saveOn(MON, [{ ...REPORT, text: 'Report v2' }]);
    expect(await cards()).toEqual([]);
    expect((await rowOn(MON)).cardUid).toBe(uid);
  });

  it("gives a card its row's category when a save makes it, or makes it again", async () => {
    const r = await saveOn(MON, [
      { text: 'Report', categoryUid: 'cat000000001' },
      { text: 'Email', done: true },
    ]);
    const [report, email] = r.body.priorities;
    expect(await card(report.cardUid)).toMatchObject({ categoryUid: 'cat000000001' });
    expect(await card(email.cardUid)).toMatchObject({ categoryUid: null });
    // Deleted on another device while the row was emptied: typed in again, it comes back with the row's category.
    await saveOn(MON, [{ ...report, text: '' }, email]);
    await app.api.del(`/api/board/cards/${report.cardUid}`);
    await saveOn(MON, [{ ...report, text: 'Report v2', categoryUid: 'cat000000002' }, email]);
    expect(await card(report.cardUid)).toMatchObject({ title: 'Report v2', categoryUid: 'cat000000002' });
  });

  it("copies a row's new category onto its card from the card's latest linked day only, and nothing else's", async () => {
    const uid = await madeFor(MON, { ...REPORT, categoryUid: 'cat000000001' });
    await save(MON, [{ ...REPORT, categoryUid: 'cat000000002' }]);
    expect(await card(uid)).toMatchObject({ title: 'Report', categoryUid: 'cat000000002', lane: 'next' });
    await save(MON, [{ ...REPORT, categoryUid: null }]);
    expect((await card(uid))!.categoryUid).toBeNull();
    // Set on the board once the day has passed: a tick on that day copies the tick, not the category it didn't change.
    await app.api.patch(`/api/board/cards/${uid}`, { today: TUE, categoryUid: 'cat000000003' });
    await save(MON, [{ ...REPORT, categoryUid: null, done: true }]);
    expect(await card(uid)).toMatchObject({ lane: 'done', categoryUid: 'cat000000003' });
    // Emptied and typed in again: the row's category, whatever it was.
    await save(MON, [{ ...REPORT, text: '', categoryUid: null }]);
    expect((await card(uid))!.categoryUid).toBe('cat000000003');
    await save(MON, [{ ...REPORT, text: 'Report', categoryUid: null }]);
    expect((await card(uid))!.categoryUid).toBeNull();
    // Carried to Tuesday: Monday's row no longer speaks for the card.
    await save(TUE, [{ text: 'Report', uid: 'bbbbbbbbbbb1', cardUid: uid, categoryUid: 'cat000000001' }]);
    expect((await card(uid))!.categoryUid).toBe('cat000000001');
    await save(MON, [{ ...REPORT, categoryUid: 'cat000000004' }]);
    expect((await card(uid))!.categoryUid).toBe('cat000000001');
  });

  it('refuses a cards flag that is not a boolean and a touched that is not a short list of card ids, and stores nothing', async () => {
    const list = `touched must be a list of at most ${MAX_PRIORITIES} card ids.`;
    const refusals: [Record<string, unknown>, string][] = [
      [{ cards: 'yes' }, 'cards must be a boolean.'],
      [{ cards: null }, 'cards must be a boolean.'],
      [{ cards: 1 }, 'cards must be a boolean.'],
      [{ touched: 'card00000001' }, list],
      [{ touched: null }, list],
      [{ touched: [5] }, list],
      [{ touched: ['not-a-uid!'] }, list],
      [{ touched: Array(MAX_PRIORITIES + 1).fill('card00000001') }, list],
    ];
    for (const [extra, error] of refusals) {
      const r = await save(MON, [{ text: 'Report' }], extra);
      expect([r.status, r.body.error], JSON.stringify(extra)).toEqual([400, error]);
    }
    expect(app.count('days')).toBe(0);
    expect((await save(MON, [{ text: 'Report' }], { touched: Array(MAX_PRIORITIES).fill('CARD00000001') })).status).toBe(200);
  });
});

describe('PUT /api/days/:date/priorities: the categories of sessions', () => {
  // Before the seeded weeks, so the days hold only what the tests log.
  const DATE = '2026-08-03';
  const row = (uid: string, text: string, categoryUid: string | null = null) => ({ uid, text, categoryUid });
  const save = (priorities: Record<string, unknown>[]) => app.api.put(`/api/days/${DATE}/priorities`, { priorities });
  /** A finished session on the row with this uid, or unplanned. */
  const logged = async (priorityUid: string | null, date = DATE) => {
    const { id } = (await app.api.post(`/api/days/${date}/sessions`, { plannedSeconds: 600, priorityUid })).body.session as { id: number };
    await app.api.post(`/api/sessions/${id}/finish`);
    return id;
  };
  const categoryOf = async (id: number) => {
    const day = (await app.api.get(`/api/days/${DATE}`)).body as { sessions: { id: number; categoryUid: string | null }[] };
    return day.sessions.find((s) => s.id === id)!.categoryUid;
  };

  it("gives the sessions on a removed row the row's category, and not those on an emptied one, which keeps it", async () => {
    const report = row('aaaaaaaaaaa1', 'Report', 'cat000000001');
    const email = row('aaaaaaaaaaa2', 'Email', 'cat000000002');
    const plain = row('aaaaaaaaaaa3', 'Plain');
    await save([report, email, plain]);
    const onReport = await logged(report.uid);
    const onEmail = await logged(email.uid);
    const onPlain = await logged(plain.uid);
    const picked = await logged(email.uid);
    await app.api.patch(`/api/sessions/${picked}`, { categoryUid: 'cat000000009' });
    const unplanned = await logged(null);

    // Emptied: the row stays and keeps its category, which its sessions count under.
    await save([{ ...report, text: '' }, email, plain]);
    expect(await categoryOf(onReport)).toBeNull();
    // Removed: the sessions on it take its category, unless they have one of their own.
    await save([{ ...report, text: '' }]);
    expect([await categoryOf(onEmail), await categoryOf(picked), await categoryOf(onPlain), await categoryOf(unplanned)]).toEqual([
      'cat000000002',
      'cat000000009',
      null,
      null,
    ]);
    await save([]);
    expect(await categoryOf(onReport)).toBe('cat000000001');
    // The sessions still name the rows they were logged on.
    expect((await app.api.get(`/api/days/${DATE}`)).body.sessions.map((s: { priorityUid: string }) => s.priorityUid)).toEqual([
      report.uid,
      email.uid,
      plain.uid,
      email.uid,
      null,
    ]);
  });

  it("leaves another day's sessions alone, though a row there has the removed row's uid", async () => {
    const other = '2026-08-04';
    await app.api.put(`/api/days/${other}/priorities`, { priorities: [row('aaaaaaaaaaa1', 'Report')] });
    const there = await logged('aaaaaaaaaaa1', other);
    await save([row('aaaaaaaaaaa1', 'Report', 'cat000000001')]);
    await save([]);
    const day = (await app.api.get(`/api/days/${other}`)).body as { sessions: { id: number; categoryUid: string | null }[] };
    expect(day.sessions).toMatchObject([{ id: there, categoryUid: null }]);
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
    // Categories and recurring priorities are never pruned: the days left still name them.
    expect(app.count('categories')).toBe(app.seeded!.board.categories.length);
    expect(app.count('recurring')).toBe(app.seeded!.board.recurring.length);
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
    // B removing a row of the same uid as one A logged time on gives A's sessions no category.
    const logged = (before as Day).sessions.find((s) => s.priorityUid != null)!.priorityUid!;
    await b.put(`/api/days/${date}/priorities`, { priorities: [{ text: 'Mine', uid: logged, categoryUid: 'cat000000001' }] });
    expect((await b.put(`/api/days/${date}/priorities`, { priorities: [] })).status).toBe(200);
    expect((await a.get(`/api/days/${date}`)).body).toEqual(before);

    // A prune by B deletes only B's days, and none of A's cards: not the ones done before the
    // cutoff, nor an untouched one no row links to, which a prune of A's own would take.
    app.db
      .prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at, untouched) VALUES (?, 'card000000aa', 'Loose', 'next', 99, 0, 1)`)
      .run(admin.id);
    const cardsOf = (userId: number) => app.db.prepare(`SELECT * FROM board_cards WHERE user_id = ? ORDER BY id`).all(userId) as { lane: string }[];
    const aCards = cardsOf(admin.id);
    expect(aCards.some((c) => c.lane === 'done')).toBe(true);
    expect((await b.post('/api/days/prune', { before: '2099-01-01' })).body).toEqual({ deleted: 1 });
    expect((await a.get(`/api/days/range?from=${date}&to=${SEED_TODAY}`)).body.days).toHaveLength(seeded.days.length);
    expect((await a.get(`/api/days/${date}`)).body).toEqual(before);
    expect(cardsOf(admin.id)).toEqual(aCards);
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
