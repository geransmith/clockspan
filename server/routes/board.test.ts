import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { ensureDefaultUser } from '../db.js';
import { addDays, DAY_MS } from '../../shared/dates.js';
import { BOARD_LIMITS, LIMITS, type BoardCard } from '../../shared/api.js';

const TODAY = SEED_TODAY;
const YESTERDAY = addDays(TODAY, -1);
const TOMORROW = addDays(TODAY, 1);

let app: TestApp;
beforeEach(async () => {
  // Only Date, so createdAt and doneAt are known: HTTP keeps its real timers.
  vi.useFakeTimers({ now: SEED_NOW, toFake: ['Date'] });
  app = await startTestApp();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const board = async () => (await app.api.get('/api/board')).body.cards as BoardCard[];
/** Each card as [lane, position, title], in the board's order. */
const lanes = async () => (await board()).map((c) => [c.lane, c.position, c.title]);
const cardOf = async (uid: string) => (await board()).find((c) => c.uid === uid);
const capture = (uid: string, title: string, lane: string, before: string | null = null) => app.api.post('/api/board/cards', { uid, title, lane, before });
const patch = (uid: string, body: Record<string, unknown>) => app.api.patch(`/api/board/cards/${uid}`, { today: TODAY, ...body });
/** Saves a day's list the way the web app does with the board on. */
const save = (date: string, priorities: Record<string, unknown>[], extra: Record<string, unknown> = { cards: true }) =>
  app.api.put(`/api/days/${date}/priorities`, { priorities, ...extra });
const untouched = (uid: string) => (app.db.prepare(`SELECT untouched FROM board_cards WHERE uid = ?`).get(uid) as { untouched: number }).untouched;

describe('GET /api/board and POST /api/board/cards', () => {
  it('starts empty, and keeps each new card where it was put', async () => {
    expect((await app.api.get('/api/board')).body).toEqual({ cards: [] });
    const first = await capture('CARD0000000A', '  Write the KB  ', 'later');
    expect(first.status).toBe(201);
    expect(first.body.cards).toEqual([
      { uid: 'card0000000a', title: 'Write the KB', lane: 'later', position: 1, createdAt: SEED_NOW, doneAt: null, listDate: null, held: false },
    ]);
    // Before the first card, at the end (null, or a card of another lane or none), and in Next.
    await capture('card0000000b', 'Review canned replies', 'later', 'CARD0000000A');
    await capture('card0000000c', 'Follow up on the SLA', 'next');
    await capture('card0000000d', 'Look into the timeout', 'later', 'card0000000c');
    await capture('card0000000e', 'Update the macros', 'later', 'card000000ff');
    expect(await lanes()).toEqual([
      ['later', 1, 'Review canned replies'],
      ['later', 2, 'Write the KB'],
      ['later', 3, 'Look into the timeout'],
      ['later', 4, 'Update the macros'],
      ['next', 1, 'Follow up on the SLA'],
    ]);
    // A long title is cut like a priority's text.
    const long = await capture('card0000000f', 'k'.repeat(LIMITS.priorityText + 20), 'next');
    expect(long.body.cards.at(-1).title).toHaveLength(LIMITS.priorityText);
  });

  it('refuses a card it could not store, and stores nothing', async () => {
    const ok = { uid: 'card00000001', title: 'Report', lane: 'later', before: null };
    const refusals: [Record<string, unknown>, string][] = [
      [{ uid: undefined }, 'uid must be a card id.'],
      [{ uid: 'not-a-uid!' }, 'uid must be a card id.'],
      [{ uid: 'ab' }, 'uid must be a card id.'],
      [{ uid: 12345678 }, 'uid must be a card id.'],
      [{ title: undefined }, 'A card needs a title.'],
      [{ title: '   ' }, 'A card needs a title.'],
      [{ title: 5 }, 'A card needs a title.'],
      [{ lane: undefined }, 'lane must be later or next.'],
      // Done is reached only through a ticked row, and In progress is today's list.
      [{ lane: 'done' }, 'lane must be later or next.'],
      [{ lane: 'progress' }, 'lane must be later or next.'],
      [{ before: 'x' }, 'before must be a card id or null.'],
      [{ before: 5 }, 'before must be a card id or null.'],
    ];
    for (const [change, error] of refusals) {
      const r = await app.api.post('/api/board/cards', { ...ok, ...change });
      expect([r.status, r.body.error], JSON.stringify(change)).toEqual([400, error]);
    }
    expect(await board()).toEqual([]);
    // Left out, before is the end.
    expect((await app.api.post('/api/board/cards', { uid: 'card00000001', title: 'Report', lane: 'next' })).status).toBe(201);
  });

  it('places a card that exists: out of Done with the new title, handled from then on, and its old lane closed up', async () => {
    // A ticked row made a Done card.
    const made = (await save(YESTERDAY, [{ text: 'Report', done: true }])).body.priorities[0].cardUid as string;
    expect(await cardOf(made)).toMatchObject({ lane: 'done', doneAt: SEED_NOW, listDate: YESTERDAY });
    expect(untouched(made)).toBe(1);
    await capture('card00000001', 'Email', 'later');
    vi.setSystemTime(SEED_NOW + DAY_MS);
    const placed = await capture(made, 'Report, part two', 'later', 'card00000001');
    expect(placed.status).toBe(200);
    expect(placed.body.cards.find((c: BoardCard) => c.uid === made)).toMatchObject({
      title: 'Report, part two',
      lane: 'later',
      position: 1,
      createdAt: SEED_NOW,
      doneAt: null,
    });
    expect(untouched(made)).toBe(0);
    // Later to Next: both lanes are numbered again.
    await capture('card00000002', 'Invoices', 'later');
    await capture('card00000001', 'Email', 'next');
    expect(await lanes()).toEqual([
      ['later', 1, 'Report, part two'],
      ['later', 2, 'Invoices'],
      ['next', 1, 'Email'],
    ]);
    // Within its lane: before another card, or before itself, which is the end.
    await capture('card00000002', 'Invoices', 'later', made);
    expect((await lanes()).slice(0, 2)).toEqual([
      ['later', 1, 'Invoices'],
      ['later', 2, 'Report, part two'],
    ]);
    await capture('card00000002', 'Invoices', 'later', 'card00000002');
    expect((await lanes()).slice(0, 2)).toEqual([
      ['later', 1, 'Report, part two'],
      ['later', 2, 'Invoices'],
    ]);
  });

  it('caps Later and Next, counting only a card new to them', async () => {
    const userId = ensureDefaultUser(app.db).id;
    const insert = app.db.prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at, done_at) VALUES (?, ?, 'Card', ?, ?, 0, ?)`);
    for (let i = 1; i <= BOARD_LIMITS.openCards; i++) insert.run(userId, `card${String(i).padStart(8, '0')}`, i % 2 ? 'later' : 'next', i, null);
    insert.run(userId, 'done00000001', 'done', 0, SEED_NOW);
    const full = [400, `The board holds at most ${BOARD_LIMITS.openCards} cards in Later and Next.`];
    const fresh = await capture('card99999999', 'One more', 'later');
    expect([fresh.status, fresh.body.error]).toEqual(full);
    // Moving a card already there adds none; taking one out of Done does.
    expect((await capture('card00000001', 'Card', 'next')).status).toBe(200);
    const fromDone = await capture('done00000001', 'Card', 'next');
    expect([fromDone.status, fromDone.body.error]).toEqual(full);
    const untick = await patch('done00000001', { lane: 'next' });
    expect([untick.status, untick.body.error]).toEqual(full);
    expect((await cardOf('done00000001'))!.lane).toBe('done');
    expect((await app.api.del('/api/board/cards/card00000002')).status).toBe(200);
    expect((await capture('card99999999', 'One more', 'later')).status).toBe(201);
  });
});

describe('PATCH /api/board/cards/:uid', () => {
  beforeEach(async () => {
    await capture('card00000001', 'Write the KB', 'later');
    await capture('card00000002', 'Review canned replies', 'later');
    await capture('card00000003', 'Follow up on the SLA', 'next');
  });

  it('renames, reorders, and moves a card between Later and Next', async () => {
    expect((await patch('card00000002', { title: '  Review the canned replies ' })).status).toBe(200);
    // `before` alone reorders the card's own lane.
    await patch('card00000002', { before: 'card00000001' });
    expect(await lanes()).toEqual([
      ['later', 1, 'Review the canned replies'],
      ['later', 2, 'Write the KB'],
      ['next', 1, 'Follow up on the SLA'],
    ]);
    // Naming its own lane with no place leaves it where it is.
    await patch('card00000002', { lane: 'later' });
    const moved = await patch('card00000002', { lane: 'next', before: 'card00000003' });
    expect(moved.body.cards.map((c: BoardCard) => [c.lane, c.position, c.title])).toEqual([
      ['later', 1, 'Write the KB'],
      ['next', 1, 'Review the canned replies'],
      ['next', 2, 'Follow up on the SLA'],
    ]);
    // A lane with no place is its end.
    await patch('card00000001', { lane: 'next' });
    expect((await cardOf('card00000001'))!).toMatchObject({ lane: 'next', position: 3 });
  });

  it('takes a card out of Done only when a lane is named, and marks it handled', async () => {
    const made = (await save(YESTERDAY, [{ text: 'Report', done: true }])).body.priorities[0].cardUid as string;
    // A tick that was a mistake, corrected on the board the day after.
    expect((await patch(made, { before: 'card00000003' })).status).toBe(200);
    expect((await cardOf(made))!).toMatchObject({ lane: 'done', doneAt: SEED_NOW });
    expect(untouched(made)).toBe(0);
    await patch(made, { lane: 'next', before: 'card00000003' });
    expect((await cardOf(made))!).toMatchObject({ lane: 'next', position: 1, doneAt: null });
  });

  it('refuses an edit it could not store, and changes nothing', async () => {
    const refusals: [Record<string, unknown>, string][] = [
      [{ today: undefined }, 'today must be a date (YYYY-MM-DD).'],
      [{ today: '2026-02-30' }, 'today must be a date (YYYY-MM-DD).'],
      [{ title: '' }, 'A card needs a title.'],
      [{ title: null }, 'A card needs a title.'],
      [{ lane: 'done' }, 'lane must be later or next.'],
      [{ lane: null }, 'lane must be later or next.'],
      [{ before: ['card00000001'] }, 'before must be a card id or null.'],
    ];
    const before = await board();
    for (const [change, error] of refusals) {
      const r = await patch('card00000002', change);
      expect([r.status, r.body.error], JSON.stringify(change)).toEqual([400, error]);
    }
    expect(await board()).toEqual(before);
  });

  it("refuses an edit while a row on the client's today or a later day is linked to the card, text or emptied", async () => {
    const row = { text: 'Write the KB', uid: 'aaaaaaaaaaa1', cardUid: 'card00000001' };
    await save(TODAY, [row], { touched: ['card00000001'] });
    const refused = [409, "That card is on today's list or a later one."];
    const r = await patch('card00000001', { title: 'Renamed' });
    expect([r.status, r.body.error]).toEqual(refused);
    // Emptied, the row still stands for the card on its day.
    await save(TODAY, [{ ...row, text: '' }]);
    expect((await patch('card00000001', { lane: 'next' })).status).toBe(409);
    // Planned for tomorrow: refused today, and by a device whose today is tomorrow.
    await save(TODAY, []);
    await save(TOMORROW, [row]);
    expect((await patch('card00000001', { lane: 'next' })).status).toBe(409);
    expect((await patch('card00000001', { lane: 'next', today: TOMORROW })).status).toBe(409);
    // Once that day has passed, the board decides again.
    const later = await patch('card00000001', { lane: 'next', today: addDays(TOMORROW, 1) });
    expect(later.status).toBe(200);
    expect((await cardOf('card00000001'))!).toMatchObject({ lane: 'next', title: 'Write the KB' });
  });
});

describe('DELETE /api/board/cards/:uid', () => {
  it('deletes the card and closes the gap in its lane; its rows keep the link to nothing', async () => {
    await capture('card00000001', 'Write the KB', 'later');
    await capture('card00000002', 'Review canned replies', 'later');
    await capture('card00000003', 'Look into the timeout', 'later');
    const made = (await save(YESTERDAY, [{ text: 'Report', done: true }])).body.priorities[0].cardUid as string;
    const r = await app.api.del('/api/board/cards/card00000002');
    expect(r.status).toBe(200);
    expect(r.body.cards.map((c: BoardCard) => [c.lane, c.position, c.title])).toEqual([
      ['later', 1, 'Write the KB'],
      ['later', 2, 'Look into the timeout'],
      ['done', 0, 'Report'],
    ]);
    expect((await app.api.del(`/api/board/cards/${made.toUpperCase()}`)).status).toBe(200);
    expect((await app.api.get(`/api/days/${YESTERDAY}`)).body.priorities[0].cardUid).toBe(made);
    const again = await app.api.del('/api/board/cards/card00000002');
    expect([again.status, again.body.error]).toEqual([404, 'Card not found.']);
  });
});

describe("a card's listDate and held", () => {
  it('reads listDate from the latest day a row is linked on, text or emptied, and null with none', async () => {
    const uid = (await save(YESTERDAY, [{ text: 'Report', uid: 'aaaaaaaaaaa1' }])).body.priorities[0].cardUid as string;
    expect((await cardOf(uid))!.listDate).toBe(YESTERDAY);
    // Carried to today, then emptied there.
    await save(TODAY, [{ text: 'Report', uid: 'aaaaaaaaaaa2', cardUid: uid }]);
    await save(TODAY, [{ text: '', uid: 'aaaaaaaaaaa2', cardUid: uid }]);
    // Held: the row on its latest day is empty, whatever an older day's row says.
    expect(await cardOf(uid)).toMatchObject({ listDate: TODAY, held: true });
    await capture('card00000001', 'Write the KB', 'later');
    expect((await cardOf('card00000001'))!.listDate).toBeNull();
  });

  it('holds a card a save made while its latest row is emptied, until the row has text again', async () => {
    const row = { text: 'Report', uid: 'aaaaaaaaaaa1' };
    const uid = (await save(TODAY, [row])).body.priorities[0].cardUid as string;
    expect((await cardOf(uid))!.held).toBe(false);
    await save(TODAY, [{ ...row, text: '', cardUid: uid }]);
    expect((await cardOf(uid))!).toMatchObject({ held: true, title: 'Report', lane: 'next' });
    await save(TODAY, [{ ...row, text: 'Report v2', cardUid: uid }]);
    expect((await cardOf(uid))!).toMatchObject({ held: false, title: 'Report v2' });
    // A card handled on the board shows in its lane once its day has passed, so it is never held.
    await save(TODAY, [{ ...row, text: '', cardUid: uid }], { touched: [uid] });
    expect((await cardOf(uid))!.held).toBe(false);
  });
});

describe('the Done lane', () => {
  it('sends the cards done in the last eight days, newest first', async () => {
    const userId = ensureDefaultUser(app.db).id;
    const insert = app.db.prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at, done_at) VALUES (?, ?, ?, 'done', 0, 0, ?)`);
    insert.run(userId, 'done00000001', 'Old', SEED_NOW - BOARD_LIMITS.doneWindowDays * DAY_MS - 1);
    insert.run(userId, 'done00000002', 'Last week', SEED_NOW - BOARD_LIMITS.doneWindowDays * DAY_MS);
    insert.run(userId, 'done00000003', 'Today', SEED_NOW);
    expect(await lanes()).toEqual([
      ['done', 0, 'Today'],
      ['done', 0, 'Last week'],
    ]);
  });
});

describe('the seeded board', () => {
  it('reads back at the seed time as the manifest has it', async () => {
    await app.close();
    app = await startTestApp({ seed: true });
    const seeded = app.seeded!.board.cards;
    expect(await board()).toEqual(seeded);
    expect(seeded.filter((c) => c.lane === 'done').length).toBeGreaterThan(0);
    // A week on, the last weekday's Done cards have left the lane; Later and Next stay.
    vi.setSystemTime(SEED_NOW + 9 * DAY_MS);
    expect(await board()).toEqual(seeded.filter((c) => c.lane !== 'done'));
  });
});

describe('the board is scoped to the signed-in user', () => {
  beforeEach(async () => {
    await app.close();
    app = await startTestApp({ authMode: 'local' });
  });

  it("never shows or changes another user's cards", async () => {
    const { a, b } = await app.twoUsers();
    await a.post('/api/board/cards', { uid: 'card00000001', title: 'Write the KB', lane: 'later', before: null });
    const made = (await a.put(`/api/days/${TODAY}/priorities`, { priorities: [{ text: 'Report' }], cards: true })).body.priorities[0].cardUid as string;
    const mine = (await a.get('/api/board')).body.cards as BoardCard[];
    expect(mine.map((c) => c.uid)).toEqual(['card00000001', made]);

    expect((await b.get('/api/board')).body).toEqual({ cards: [] });
    for (const r of [
      await b.patch('/api/board/cards/card00000001', { today: YESTERDAY, title: 'Mine' }),
      await b.del('/api/board/cards/card00000001'),
      await b.patch(`/api/board/cards/${made}`, { today: YESTERDAY, lane: 'later' }),
      await b.del(`/api/board/cards/${made}`),
    ]) {
      expect([r.status, r.body]).toEqual([404, { error: 'Card not found.' }]);
    }
    // The same uid is B's own card, on B's board.
    expect((await b.post('/api/board/cards', { uid: 'card00000001', title: 'Mine', lane: 'next', before: null })).status).toBe(201);
    // B's rows naming A's cards reach only B's: touched marks none of A's, and the 409 guard
    // and a removal read A's rows alone.
    const theirs = [
      { text: 'Theirs', cardUid: made },
      { text: 'Mine too', cardUid: 'card00000001' },
    ];
    await b.put(`/api/days/${TODAY}/priorities`, { priorities: theirs, touched: [made] });
    const moved = await a.patch('/api/board/cards/card00000001', { today: TODAY, lane: 'next' });
    expect(moved.status).toBe(200);
    // listDate and held read A's rows alone.
    expect((moved.body.cards as BoardCard[]).find((c) => c.uid === 'card00000001')).toMatchObject({ listDate: null, held: false });
    await b.put(`/api/days/${TODAY}/priorities`, { priorities: [] });
    const after = (await a.get('/api/board')).body.cards as BoardCard[];
    expect(after.find((c) => c.uid === made)).toEqual(mine[1]);
    expect(after.find((c) => c.uid === 'card00000001')).toMatchObject({ title: 'Write the KB', lane: 'next' });
    expect(app.count('board_cards', 'uid = ?', made)).toBe(1);
    expect(app.count('board_cards', 'uid = ? AND untouched = 1', made)).toBe(1);
    expect((await b.get('/api/board')).body.cards.map((c: BoardCard) => [c.uid, c.title, c.lane])).toEqual([['card00000001', 'Mine too', 'next']]);

    // B ticks its own card00000001 on an earlier day. A taking off its open row of A's card reads
    // only A's earlier rows for a tick, so A's card stays in Next.
    await b.put(`/api/days/${YESTERDAY}/priorities`, { priorities: [{ text: 'Mine too', cardUid: 'card00000001', done: true }] });
    const report = (await a.get(`/api/days/${TODAY}`)).body.priorities[0] as Record<string, unknown>;
    await a.put(`/api/days/${TODAY}/priorities`, { priorities: [report, { text: 'Write the KB', cardUid: 'card00000001' }] });
    await a.put(`/api/days/${TODAY}/priorities`, { priorities: [report] });
    expect(((await a.get('/api/board')).body.cards as BoardCard[]).find((c) => c.uid === 'card00000001')).toMatchObject({ lane: 'next' });
  });
});
