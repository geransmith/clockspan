import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_NOW, startTestApp, type TestApp } from '../dev/harness.js';
import type { ItemRow } from './shared.js';
import { MAX_PRIORITIES } from '../../shared/settings.js';
import { DAY_MS, MINUTE_MS } from '../../shared/dates.js';
import { LIMITS, type Day, type Priority } from '../../shared/api.js';

/** 2026-09-01's UTC midnight, the addedAt of the rows below. */
const T0 = Date.UTC(2026, 8, 1);

let app: TestApp;
beforeEach(async () => {
  app = await startTestApp({ seed: true });
});
afterEach(() => app.close());

/** A row as the web app sends it: a written row carries its uid and addedAt, and every row the fields the server works out, which it ignores. */
const row = (text: string, uid: string | null = null, patch: Record<string, unknown> = {}) => ({
  position: 0,
  text,
  done: false,
  uid,
  addedAt: uid ? T0 : null,
  categoryUid: null,
  note: '',
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
  note: '',
  recurring: false,
  archived: false,
  listed: 1,
  earlier: 0,
  logged: 0,
  ...patch,
});

const texts = (priorities: { text: string }[]) => priorities.map((p) => p.text);

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
    expect(c.uid).toMatch(/^[a-f0-9]{32}$/);
    expect(typeof c.addedAt).toBe('number');
    expect((await app.api.get('/api/days/2026-09-01')).body.priorities).toEqual(r.body.priorities);
  });

  it('cuts text at the shared limit', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: [{ text: 'p'.repeat(LIMITS.priorityText + 50) }] });
    expect(r.body.priorities[0].text).toHaveLength(LIMITS.priorityText);
  });

  it('stores a note as taskNote gives it: line breaks and outer spaces kept, other control characters dropped, cut at the limit', async () => {
    const r = await app.api.put('/api/days/2026-09-01/priorities', {
      priorities: [
        { text: 'Report', note: ' Acme:\u0000 logs\r\nGlobex \n' },
        { text: 'Email', note: 'n'.repeat(LIMITS.itemNote + 5) },
      ],
    });
    expect(r.body.priorities.map((p: Priority) => p.note)).toEqual([' Acme: logs\nGlobex \n', 'n'.repeat(LIMITS.itemNote)]);
  });

  it('takes a full list and its base with every name and note at the limit in the widest characters they keep', async () => {
    // A name keeps control characters, which JSON writes as six bytes; a note drops them, and keeps three-byte ones at most.
    const full = Array.from({ length: MAX_PRIORITIES }, (_, i) =>
      row('\u0001'.repeat(LIMITS.priorityText), `aaaaaaaaaa${String(i).padStart(2, '0')}`, { note: '語'.repeat(LIMITS.itemNote) }),
    );
    expect((await app.saveList('2026-09-01', full)).status).toBe(200);
    const body = { priorities: full.map((p) => ({ ...p, done: true })), base: full };
    // Within express.json's 256 KB, with little to spare.
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(240_000);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(256 * 1024);
    const r = await app.api.put('/api/days/2026-09-01/priorities', body);
    expect(r.status).toBe(200);
    expect(r.body.priorities.map((p: Priority) => [p.done, p.note.length])).toEqual(full.map(() => [true, LIMITS.itemNote]));
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

  it('refuses a malformed uid or category and text or a note that is not a string, and stores nothing', async () => {
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
    for (const note of [42, ['x'], true]) {
      const r = await put({ text: 'x', note });
      expect([r.status, r.body.error], JSON.stringify(note)).toEqual([400, 'Priority 2 has an invalid note.']);
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
    const mine = { done: true, categoryUid: 'cafe00000001', note: 'Numbers from Kim.' };
    const sent = [row('Write the report', 'abcdef123456', mine), row(''), row('Email the team', '0123456789ab')];
    const r = await app.api.put('/api/days/2026-09-01/priorities', { priorities: sent });
    expect(r.status).toBe(200);
    const expected = [stored(1, 'Write the report', 'abcdef123456', mine), stored(3, 'Email the team', '0123456789ab')];
    expect(r.body.priorities).toEqual(expected);
    const claims = { recurring: true, archived: true, listed: 9, earlier: 4, logged: 3600 };
    const again = await app.api.put('/api/days/2026-09-01/priorities', { priorities: sent.map((p) => ({ ...p, ...claims })), base: expected });
    expect(again.body.priorities).toEqual(expected);
    expect(app.item('abcdef123456')).toMatchObject({ weekdays: null, archived_at: null });
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
    expect(app.item('cccccccccccc')).toBeUndefined();
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
  const rowsOn = async (date: string) => (await app.api.get(`/api/days/${date}`)).body.priorities as Priority[];

  beforeEach(async () => {
    // Only Date, so createdAt can be compared: HTTP keeps its real timers.
    vi.useFakeTimers({ now: SEED_NOW, toFake: ['Date'] });
  });

  it('makes a task for a uid new to the user, with its trimmed name, its category and its note, in no lane', async () => {
    const r = await app.saveList(MON, [row('  Write the report  ', 'aaaaaaaaaaa1', { categoryUid: 'cat000000001', note: 'Steps:\n' })]);
    expect(r.body.priorities).toEqual([stored(1, 'Write the report', 'aaaaaaaaaaa1', { categoryUid: 'cat000000001', note: 'Steps:\n' })]);
    expect(app.item('aaaaaaaaaaa1')).toMatchObject({
      title: 'Write the report',
      category_uid: 'cat000000001',
      note: 'Steps:\n',
      weekdays: null,
      lane: null,
      position: 0,
      created_at: SEED_NOW,
      archived_at: null,
      deleted_at: null,
    });
  });

  it('writes a rename, a category and a note this device made since its base to the task, which every day shows', async () => {
    const report = row('Report', 'aaaaaaaaaaa1');
    await app.saveList(MON, [report]);
    await app.saveList(TUE, [report], []);
    const r = await app.saveList(TUE, [{ ...report, text: 'Quarterly report ', categoryUid: 'cat000000002', note: 'Kim has the numbers.' }], [report]);
    const changed = { text: 'Quarterly report', categoryUid: 'cat000000002', note: 'Kim has the numbers.' };
    expect(r.body.priorities[0]).toMatchObject(changed);
    expect((await rowsOn(MON))[0]).toMatchObject(changed);
    const range = (await app.api.get(`/api/days/range?from=${MON}&to=${TUE}`)).body.days as Day[];
    expect(range.map((d) => [d.priorities[0]!.text, d.priorities[0]!.note])).toEqual([
      ['Quarterly report', 'Kim has the numbers.'],
      ['Quarterly report', 'Kim has the numbers.'],
    ]);
  });

  it('leaves a rename, a category or a note another device made alone when this save changed only the tick', async () => {
    const report = row('Report', 'aaaaaaaaaaa1');
    await app.saveList(MON, [report]);
    await app.saveList(MON, [{ ...report, text: 'Quarterly report', categoryUid: 'cat000000001', note: 'From Kim' }], [report]);
    const r = await app.saveList(MON, [{ ...report, done: true }], [report]);
    expect(r.body.priorities[0]).toMatchObject({ text: 'Quarterly report', categoryUid: 'cat000000001', note: 'From Kim', done: true });
    // The same note changed on both: this save's wins.
    const both = await app.saveList(MON, [{ ...report, note: 'From Sam' }], [report]);
    expect(both.body.priorities[0]).toMatchObject({ text: 'Quarterly report', note: 'From Sam' });
  });

  it('writes nothing to a task a save puts on another list, whatever name, category and note it carries', async () => {
    await app.saveList(MON, [row('Report', 'aaaaaaaaaaa1', { categoryUid: 'cat000000001', note: 'From Kim' })]);
    // A carry from a copy older than a rename.
    const r = await app.saveList(TUE, [row('Old name', 'aaaaaaaaaaa1', { categoryUid: null, note: '' })], []);
    expect(r.body.priorities[0]).toMatchObject({ text: 'Report', categoryUid: 'cat000000001', note: 'From Kim' });
    expect(app.item('aaaaaaaaaaa1')).toMatchObject({ title: 'Report', category_uid: 'cat000000001', note: 'From Kim' });
  });

  it('reads the stored list as the base with none sent', async () => {
    await app.saveList(MON, [row('Report', 'aaaaaaaaaaa1')]);
    await app.saveList(MON, [row('Report v2', 'aaaaaaaaaaa1', { categoryUid: 'cat000000003' })]);
    expect(app.item('aaaaaaaaaaa1')).toMatchObject({ title: 'Report v2', category_uid: 'cat000000003' });
  });

  it('reads a row sent with no categoryUid, note or addedAt as keeping them, with a base or without', async () => {
    const kept = { categoryUid: 'cat000000001', note: 'From Kim', addedAt: T0 };
    await app.saveList(MON, [row('Report', 'aaaaaaaaaaa1', kept)]);
    await app.saveList(TUE, [row('Report', 'aaaaaaaaaaa1')], []);
    // curl, with no base: the task keeps its category and note on every day.
    const bare = await app.saveList(MON, [{ text: 'Report v2', uid: 'aaaaaaaaaaa1', done: true }]);
    expect(bare.body.priorities[0]).toMatchObject({ text: 'Report v2', ...kept, done: true });
    // A base that carries them, and a row that leaves them out (null reads as left out, for the note).
    const based = await app.saveList(MON, [{ text: 'Report v3', uid: 'aaaaaaaaaaa1', note: null }], bare.body.priorities);
    expect(based.body.priorities[0]).toMatchObject({ text: 'Report v3', ...kept });
    expect((await rowsOn(TUE))[0]).toMatchObject({ text: 'Report v3', ...kept });
    // A page from before notes sends rows and a base with none: the note stands.
    const old = ({ note: _, ...p }: Priority) => p;
    await app.saveList(MON, [{ ...old(based.body.priorities[0]), text: 'Report v4' }], based.body.priorities.map(old));
    expect(app.item('aaaaaaaaaaa1')).toMatchObject({ title: 'Report v4', category_uid: 'cat000000001', note: 'From Kim' });
    // A new task sent without them has none, and is stamped now.
    const email = await app.saveList(WED, [{ text: 'Email', uid: 'aaaaaaaaaaa2' }]);
    expect(email.body.priorities[0].addedAt).toBe(SEED_NOW);
    expect(app.item('aaaaaaaaaaa2')).toMatchObject({ category_uid: null, note: '' });
  });

  it('stores a name trimmed and cut, with no space left at the cut, and writes no rename for a change of spacing alone', async () => {
    const long = `  ${'k'.repeat(LIMITS.priorityText - 1)} tail`;
    const r = await app.saveList(MON, [row(long, 'aaaaaaaaaaa1')]);
    expect(r.body.priorities[0].text).toBe('k'.repeat(LIMITS.priorityText - 1));
    await app.saveList(MON, [row('Report', 'aaaaaaaaaaa2')]);
    await app.saveList(MON, [row('Report v2', 'aaaaaaaaaaa2')], [row('Report', 'aaaaaaaaaaa2')]);
    // A device whose copy is from before the rename sends the old name with a space added.
    await app.saveList(MON, [row('Report ', 'aaaaaaaaaaa2')], [row(' Report', 'aaaaaaaaaaa2')]);
    expect(app.item('aaaaaaaaaaa2')!.title).toBe('Report v2');
  });

  it('makes the task again from the row when another device took it off its only list and this one changed it', async () => {
    const report = row('Report', 'aaaaaaaaaaa1');
    await app.saveList(MON, [report]);
    await app.saveList(MON, [], [report]);
    expect(app.item('aaaaaaaaaaa1')).toBeUndefined();
    const r = await app.saveList(MON, [{ ...report, text: 'Report v2', done: true }], [report]);
    expect(r.body.priorities).toEqual([stored(1, 'Report v2', 'aaaaaaaaaaa1', { done: true })]);
  });

  it("answers each row with how many days list its task, how many of them come before the row's, and the focus done on it on other days", async () => {
    const report = row('Report', 'aaaaaaaaaaa1');
    for (const date of [MON, TUE, WED]) await app.saveList(date, [report], []);
    const { id } = (await app.api.post(`/api/days/${TUE}/sessions`, { plannedSeconds: 600, priorityUid: 'aaaaaaaaaaa1' })).body.session as { id: number };
    vi.setSystemTime(SEED_NOW + 5 * MINUTE_MS);
    await app.api.post(`/api/sessions/${id}/finish`);
    // A running one isn't logged yet.
    await app.api.post(`/api/days/${WED}/sessions`, { plannedSeconds: 600, priorityUid: 'aaaaaaaaaaa1' });
    const days = (await app.api.get(`/api/days/range?from=${MON}&to=${WED}`)).body.days as Day[];
    // Tuesday's own five minutes are in its log, which the client adds.
    expect(days.map((d) => [d.priorities[0]!.listed, d.priorities[0]!.earlier, d.priorities[0]!.logged])).toEqual([
      [3, 0, 300],
      [3, 1, 0],
      [3, 2, 300],
    ]);
    expect((await rowsOn(TUE))[0]).toMatchObject({ listed: 3, earlier: 1, logged: 0 });
    // A save answers the same counts.
    expect((await app.saveList(TUE, [report], [report])).body.priorities[0]).toMatchObject({ listed: 3, earlier: 1, logged: 0 });
    expect((await app.saveList(WED, [report], [report])).body.priorities[0]).toMatchObject({ listed: 3, earlier: 2, logged: 300 });
  });

  it("answers a recurring priority's row as recurring, and one that stopped repeating as archived", async () => {
    await app.api.post('/api/items', { uid: 'rcur0000000a', title: 'Check the queue', categoryUid: 'cat000000001', weekdays: [1, 2, 3, 4, 5] });
    const r = await app.saveList(MON, [row('Check the queue', 'rcur0000000a')], []);
    expect(r.body.priorities).toEqual([stored(1, 'Check the queue', 'rcur0000000a', { categoryUid: 'cat000000001', recurring: true })]);
    await app.api.del('/api/items/rcur0000000a');
    expect((await rowsOn(MON))[0]).toMatchObject({ recurring: true, archived: true });
    // A rename from its row reaches it still.
    await app.saveList(MON, [row('Watch the queue', 'rcur0000000a')], [row('Check the queue', 'rcur0000000a')]);
    expect(app.item('rcur0000000a')).toMatchObject({ title: 'Watch the queue', weekdays: 0b11111 });
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

  beforeEach(async () => {
    await app.close();
    app = await startTestApp();
    await app.capture('card00000001', 'Write the KB', 'later');
    await app.capture('card00000002', 'Update the macros', 'later');
    await app.capture('card00000003', 'Follow up', 'next');
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
    expect(app.item('aaaaaaaaaaa1')).toMatchObject({ lane: null, position: 0 });
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
    expect([app.item('card0000000a'), app.item('aaaaaaaaaaa2'), app.item('aaaaaaaaaaa3')].map((i) => i?.title)).toEqual(['Write the KB', undefined, 'Call']);
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

  it('drops its row from a stale save, stores the rest, and leaves the tombstone as it was', async () => {
    const r = await app.api.put(`/api/days/${MON}/priorities`, {
      priorities: [
        { ...report, text: 'Report v2', done: true },
        { ...email, done: true },
      ],
      base: [report, email],
    });
    expect(r.status).toBe(200);
    expect(r.body.priorities).toEqual([stored(1, 'Email', email.uid!, { done: true })]);
    expect(app.item(report.uid!)).toMatchObject({ title: report.uid, category_uid: null, deleted_at: expect.any(Number) });
    // The session the delete took off it stays off it.
    expect(app.count('sessions', 'item_id = ?', app.item(report.uid!)!.id)).toBe(0);
    expect(app.count('sessions', 'label = ? AND item_id IS NULL', 'Report')).toBe(1);
  });

  it('makes no task and no row from a save that puts it on another list', async () => {
    const r = await app.api.put(`/api/days/${TUE}/priorities`, { priorities: [{ ...report, text: 'Carried' }, row('')], base: [row(''), row('')] });
    expect(r.body.priorities).toEqual([]);
    expect(app.count('items', 'uid = ?', report.uid)).toBe(1);
    expect(app.count('priorities', 'item_id = ?', app.item(report.uid!)!.id)).toBe(0);
  });
});
