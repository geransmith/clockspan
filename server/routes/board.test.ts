import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { ensureDefaultUser } from '../db.js';
import { addDays, DAY_MS } from '../../shared/dates.js';
import { BOARD_LIMITS, LIMITS, type BoardCard, type Category, type Recurring } from '../../shared/api.js';

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
    expect((await app.api.get('/api/board')).body).toEqual({ cards: [], categories: [], recurring: [] });
    const first = await capture('CARD0000000A', '  Write the KB  ', 'later');
    expect(first.status).toBe(201);
    expect(first.body.cards).toEqual([
      {
        uid: 'card0000000a',
        title: 'Write the KB',
        categoryUid: null,
        lane: 'later',
        position: 1,
        createdAt: SEED_NOW,
        doneAt: null,
        listDate: null,
        held: false,
      },
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
      [{ categoryUid: 'not a uid' }, "categoryUid must be a category's id or null."],
      [{ categoryUid: 7 }, "categoryUid must be a category's id or null."],
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

  it('takes a category with a new card, and a placed one takes the one sent or keeps its own', async () => {
    const made = await app.api.post('/api/board/cards', { uid: 'card00000001', title: 'Report', categoryUid: 'CAT000000001', lane: 'later', before: null });
    expect(made.body.cards[0]).toMatchObject({ uid: 'card00000001', categoryUid: 'cat000000001' });
    // Moved to Next with the category left out: the card keeps its own.
    await capture('card00000001', 'Report', 'next');
    expect(await cardOf('card00000001')).toMatchObject({ lane: 'next', categoryUid: 'cat000000001' });
    // A park sends the row's category, or none.
    await app.api.post('/api/board/cards', { uid: 'card00000001', title: 'Report', categoryUid: 'cat000000002', lane: 'later', before: null });
    expect((await cardOf('card00000001'))!.categoryUid).toBe('cat000000002');
    await app.api.post('/api/board/cards', { uid: 'card00000001', title: 'Report', categoryUid: null, lane: 'later', before: null });
    expect((await cardOf('card00000001'))!.categoryUid).toBeNull();
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

  it('sets and clears the category, and keeps it when the field is left out', async () => {
    expect((await patch('card00000001', { categoryUid: 'CAT000000001' })).status).toBe(200);
    expect((await cardOf('card00000001'))!.categoryUid).toBe('cat000000001');
    await patch('card00000001', { title: 'Write the KB article' });
    expect(await cardOf('card00000001')).toMatchObject({ title: 'Write the KB article', categoryUid: 'cat000000001' });
    await patch('card00000001', { categoryUid: null });
    expect((await cardOf('card00000001'))!.categoryUid).toBeNull();
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
      [{ categoryUid: 'x' }, "categoryUid must be a category's id or null."],
      [{ categoryUid: true }, "categoryUid must be a category's id or null."],
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

describe('/api/board/categories', () => {
  const categories = async () => (await app.api.get('/api/board')).body.categories as Category[];
  const add = (uid: string, name: unknown, color: unknown = 'blue') => app.api.post('/api/board/categories', { uid, name, color });
  const edit = (uid: string, body: Record<string, unknown>) => app.api.patch(`/api/board/categories/${uid}`, body);
  const remove = (uid: string) => app.api.del(`/api/board/categories/${uid}`);
  const userId = () => ensureDefaultUser(app.db).id;
  /** `n` categories stored straight in the table, named Bulk 1..n, removed when `archived`. */
  const fill = (n: number, archived = false) => {
    const insert = app.db.prepare(`INSERT INTO categories (user_id, uid, name, color, archived_at) VALUES (?, ?, ?, 'grey', ?)`);
    const from = app.count('categories');
    for (let i = from + 1; i <= from + n; i++) insert.run(userId(), `bulk${String(i).padStart(8, '0')}`, `Bulk ${i}`, archived ? 1 : null);
  };

  it('makes categories in the order sent, with the name tidied, and answers the board', async () => {
    const r = await add('CAT000000001', '  Support   tickets ', 'teal');
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ cards: [], categories: [{ uid: 'cat000000001', name: 'Support tickets', color: 'teal', archived: false }], recurring: [] });
    await add('cat000000002', 'Admin', 'grey');
    // A long name is cut, and a space the cut leaves at the end goes.
    await add('cat000000003', `${'k'.repeat(LIMITS.categoryName - 1)} more`);
    expect((await categories()).map((c) => c.name)).toEqual(['Support tickets', 'Admin', 'k'.repeat(LIMITS.categoryName - 1)]);
  });

  it('answers the board as it is when the uid is in use already, whatever else is sent', async () => {
    await add('cat000000001', 'Tickets');
    const again = await add('cat000000001', 'Something else', 'pink');
    expect(again.status).toBe(200);
    expect(again.body.categories).toEqual([{ uid: 'cat000000001', name: 'Tickets', color: 'blue', archived: false }]);
  });

  it('refuses a category it could not store, and stores nothing', async () => {
    const ok = { uid: 'cat000000001', name: 'Tickets', color: 'blue' };
    const colors = 'color must be one of blue, teal, green, gold, orange, pink, purple, grey.';
    const refusals: [Record<string, unknown>, string][] = [
      [{ uid: undefined }, 'uid must be a category id.'],
      [{ uid: 'cat' }, 'uid must be a category id.'],
      [{ uid: 'not-a-uid!' }, 'uid must be a category id.'],
      [{ name: undefined }, 'A category needs a name.'],
      [{ name: '   ' }, 'A category needs a name.'],
      [{ name: 5 }, 'A category needs a name.'],
      [{ color: undefined }, colors],
      [{ color: 'red' }, colors],
      [{ color: 'Blue' }, colors],
    ];
    for (const [change, error] of refusals) {
      const r = await app.api.post('/api/board/categories', { ...ok, ...change });
      expect([r.status, r.body.error], JSON.stringify(change)).toEqual([400, error]);
    }
    expect(app.count('categories')).toBe(0);
  });

  it("refuses a new category with another one's name, in use or removed, whatever its case or spacing", async () => {
    await add('cat000000001', 'Follow-ups');
    await add('cat000000002', 'Knowledge base');
    await remove('cat000000002');
    const taken = await add('cat000000003', ' FOLLOW-UPS ');
    expect([taken.status, taken.body.error]).toEqual([400, 'There is already a category with that name.']);
    const removed = await add('cat000000003', 'knowledge  base');
    expect([removed.status, removed.body.error]).toEqual([400, 'A removed category has that name. Restore it by its id.']);
    expect(app.count('categories')).toBe(2);
  });

  it('removes a category by archiving it, and brings it back under its uid with the name and colour sent', async () => {
    await add('cat000000001', 'Tickets');
    const removed = await remove('CAT000000001');
    expect(removed.status).toBe(200);
    expect(removed.body.categories).toEqual([{ uid: 'cat000000001', name: 'Tickets', color: 'blue', archived: true }]);
    const at = (app.db.prepare(`SELECT archived_at FROM categories`).get() as { archived_at: number }).archived_at;
    expect(at).toBe(SEED_NOW);
    // Removing it again keeps the first time.
    vi.setSystemTime(SEED_NOW + DAY_MS);
    await remove('cat000000001');
    expect(app.db.prepare(`SELECT archived_at FROM categories`).get()).toEqual({ archived_at: SEED_NOW });
    const back = await add('cat000000001', 'Support tickets', 'teal');
    expect(back.status).toBe(200);
    expect(back.body.categories).toEqual([{ uid: 'cat000000001', name: 'Support tickets', color: 'teal', archived: false }]);
    expect(app.count('categories')).toBe(1);
  });

  it('brings a removed category back past a removed one of the same name, but not past one in use', async () => {
    await add('cat000000001', 'Tickets');
    await remove('cat000000001');
    // Renamed while removed, so a second Tickets could be made, then removed too.
    await edit('cat000000001', { name: 'Old tickets' });
    await add('cat000000002', 'Tickets');
    await remove('cat000000002');
    expect((await add('cat000000001', 'Tickets')).status).toBe(200);
    await add('cat000000003', 'Admin');
    await remove('cat000000003');
    await add('cat000000004', 'Admin, again');
    await edit('cat000000004', { name: 'admin' });
    const refused = await add('cat000000003', 'Admin');
    expect([refused.status, refused.body.error]).toEqual([400, 'There is already a category with that name.']);
    expect((await categories()).find((c) => c.uid === 'cat000000003')!.archived).toBe(true);
  });

  it('renames and recolours, a field left out keeping its value, against the other categories in use', async () => {
    await add('cat000000001', 'Tickets');
    await add('cat000000002', 'Admin', 'grey');
    await add('cat000000003', 'Old', 'gold');
    await remove('cat000000003');
    expect((await edit('CAT000000001', { name: '  Support  tickets' })).status).toBe(200);
    await edit('cat000000002', { color: 'pink' });
    // Its own name in another case, and a removed category's name, are free.
    await edit('cat000000002', { name: 'ADMIN' });
    await edit('cat000000001', { name: 'old' });
    expect(await categories()).toEqual([
      { uid: 'cat000000001', name: 'old', color: 'blue', archived: false },
      { uid: 'cat000000002', name: 'ADMIN', color: 'pink', archived: false },
      { uid: 'cat000000003', name: 'Old', color: 'gold', archived: true },
    ]);
    const before = await categories();
    const refusals: [Record<string, unknown>, string][] = [
      [{ name: 'admin' }, 'There is already a category with that name.'],
      [{ name: '' }, 'A category needs a name.'],
      [{ name: null }, 'A category needs a name.'],
      [{ color: 'red' }, 'color must be one of blue, teal, green, gold, orange, pink, purple, grey.'],
      [{ color: null }, 'color must be one of blue, teal, green, gold, orange, pink, purple, grey.'],
    ];
    for (const [change, error] of refusals) {
      const r = await edit('cat000000001', change);
      expect([r.status, r.body.error], JSON.stringify(change)).toEqual([400, error]);
    }
    expect(await categories()).toEqual(before);
    // An empty patch changes nothing.
    expect((await edit('cat000000001', {})).body.categories).toEqual(before);
    expect((await edit('cat000000009', { name: 'x' })).body).toEqual({ error: 'Category not found.' });
    expect((await remove('cat000000009')).status).toBe(404);
  });

  it('keeps at most 100 in use, a removed one brought back included, and 1000 stored', async () => {
    fill(BOARD_LIMITS.categories - 1);
    await add('cat000000001', 'Tickets');
    const full = [400, `The board keeps at most ${BOARD_LIMITS.categories} categories.`];
    const over = await add('cat000000002', 'One more');
    expect([over.status, over.body.error]).toEqual(full);
    // A removed one doesn't count, and can't come back while 100 are in use.
    await remove('cat000000001');
    expect((await add('cat000000002', 'One more')).status).toBe(201);
    const back = await add('cat000000001', 'Tickets');
    expect([back.status, back.body.error]).toEqual(full);
    await remove('cat000000002');
    expect((await add('cat000000001', 'Tickets')).status).toBe(200);

    // Removed ones fill the table up to 1000 stored: no new one, but one brought back is fine.
    fill(BOARD_LIMITS.categoriesStored - app.count('categories'), true);
    await remove('cat000000001');
    expect(app.count('categories')).toBe(BOARD_LIMITS.categoriesStored);
    const stored = await add('cat000000003', 'Brand new');
    expect([stored.status, stored.body.error]).toEqual([400, `The board keeps at most ${BOARD_LIMITS.categoriesStored} categories, removed ones included.`]);
    expect((await add('cat000000001', 'Tickets')).status).toBe(200);
    expect(app.count('categories')).toBe(BOARD_LIMITS.categoriesStored);
  });
});

describe('/api/board/recurring', () => {
  const QUEUE: Recurring = { uid: 'rcur00000001', title: 'Monitor the queue', categoryUid: 'cat000000001', weekdays: [1, 2, 3, 4, 5] };
  const FOLLOW_UPS: Recurring = { uid: 'rcur00000002', title: 'Follow-ups', categoryUid: null, weekdays: [1, 3, 5] };
  const items = async () => (await app.api.get('/api/board')).body.recurring as Recurring[];
  const add = (item: object) => app.api.post('/api/board/recurring', item);
  const edit = (uid: string, body: Record<string, unknown>) => app.api.patch(`/api/board/recurring/${uid}`, body);
  const remove = (uid: string) => app.api.del(`/api/board/recurring/${uid}`);
  /** Each item's weekdays as the table holds them: a mask, bit 0 for Monday. */
  const masks = () => app.db.prepare(`SELECT uid, weekdays FROM recurring ORDER BY id`).all();
  const WEEKDAYS = 'weekdays must be one or more days from 1 to 7.';

  it('makes recurring priorities in the order sent, with the title tidied and the weekdays in order, and answers the board', async () => {
    const r = await add({ ...QUEUE, uid: 'RCUR00000001', title: '  Monitor the queue ', categoryUid: 'CAT000000001' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ cards: [], categories: [], recurring: [QUEUE] });
    // Weekdays in any order come back in order; a category left out is none.
    await add({ ...FOLLOW_UPS, weekdays: [5, 1, 3], categoryUid: undefined });
    // A long title is cut like a priority's text: it becomes one when the offer adds it.
    await add({ uid: 'rcur00000003', title: 'k'.repeat(LIMITS.priorityText + 20), categoryUid: null, weekdays: [7, 6] });
    expect(await items()).toEqual([QUEUE, FOLLOW_UPS, { uid: 'rcur00000003', title: 'k'.repeat(LIMITS.priorityText), categoryUid: null, weekdays: [6, 7] }]);
    expect(masks()).toEqual([
      { uid: 'rcur00000001', weekdays: 0b0011111 },
      { uid: 'rcur00000002', weekdays: 0b0010101 },
      { uid: 'rcur00000003', weekdays: 0b1100000 },
    ]);
  });

  it('answers the board as it is when the uid is in use already, whatever else is sent', async () => {
    await add(QUEUE);
    const again = await add({ ...QUEUE, title: 'Something else', categoryUid: null, weekdays: [6] });
    expect(again.status).toBe(200);
    expect(again.body.recurring).toEqual([QUEUE]);
    expect(app.count('recurring')).toBe(1);
  });

  it('refuses an item it could not store, and stores nothing', async () => {
    const refusals: [Record<string, unknown>, string][] = [
      [{ uid: undefined }, 'uid must be a recurring priority id.'],
      [{ uid: 'rcur' }, 'uid must be a recurring priority id.'],
      [{ uid: 'not-a-uid!' }, 'uid must be a recurring priority id.'],
      [{ uid: 12345678 }, 'uid must be a recurring priority id.'],
      [{ title: undefined }, 'A recurring priority needs a title.'],
      [{ title: '   ' }, 'A recurring priority needs a title.'],
      [{ title: 5 }, 'A recurring priority needs a title.'],
      [{ categoryUid: 'not a uid' }, "categoryUid must be a category's id or null."],
      [{ categoryUid: 7 }, "categoryUid must be a category's id or null."],
      [{ weekdays: undefined }, WEEKDAYS],
      [{ weekdays: null }, WEEKDAYS],
      [{ weekdays: 31 }, WEEKDAYS],
      [{ weekdays: [] }, WEEKDAYS],
      [{ weekdays: [0] }, WEEKDAYS],
      [{ weekdays: [1, 8] }, WEEKDAYS],
      [{ weekdays: [1.5] }, WEEKDAYS],
      [{ weekdays: ['1'] }, WEEKDAYS],
      [{ weekdays: [1, 3, 1] }, WEEKDAYS],
      [{ weekdays: [1, 2, 3, 4, 5, 6, 7, 1] }, WEEKDAYS],
    ];
    for (const [change, error] of refusals) {
      const r = await add({ ...QUEUE, ...change });
      expect([r.status, r.body.error], JSON.stringify(change)).toEqual([400, error]);
    }
    expect(app.count('recurring')).toBe(0);
  });

  it('changes the title, the category and the weekdays, a field left out keeping its value', async () => {
    await add(QUEUE);
    await add(FOLLOW_UPS);
    const renamed = await edit('RCUR00000001', { title: '  Watch the queue ' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.recurring).toEqual([{ ...QUEUE, title: 'Watch the queue' }, FOLLOW_UPS]);
    await edit('rcur00000001', { categoryUid: null });
    await edit('rcur00000002', { categoryUid: 'CAT000000002', weekdays: [3, 1] });
    expect(await items()).toEqual([
      { ...QUEUE, title: 'Watch the queue', categoryUid: null },
      { ...FOLLOW_UPS, categoryUid: 'cat000000002', weekdays: [1, 3] },
    ]);
    expect(masks()).toEqual([
      { uid: 'rcur00000001', weekdays: 0b0011111 },
      { uid: 'rcur00000002', weekdays: 0b0000101 },
    ]);
    // An empty patch changes nothing.
    const before = await items();
    expect((await edit('rcur00000001', {})).body.recurring).toEqual(before);
  });

  it('refuses an edit it could not store, and changes nothing', async () => {
    await add(QUEUE);
    const refusals: [Record<string, unknown>, string][] = [
      [{ title: '' }, 'A recurring priority needs a title.'],
      [{ title: null }, 'A recurring priority needs a title.'],
      [{ categoryUid: 'not a uid' }, "categoryUid must be a category's id or null."],
      [{ weekdays: null }, WEEKDAYS],
      [{ weekdays: [] }, WEEKDAYS],
      [{ weekdays: [7, 7] }, WEEKDAYS],
      // One bad field refuses the others sent with it.
      [{ title: 'Watch the queue', weekdays: [9] }, WEEKDAYS],
    ];
    for (const [change, error] of refusals) {
      const r = await edit('rcur00000001', change);
      expect([r.status, r.body.error], JSON.stringify(change)).toEqual([400, error]);
    }
    expect(await items()).toEqual([QUEUE]);
    for (const r of [await edit('rcur00000009', { title: 'x' }), await remove('rcur00000009'), await edit('rcur', { title: 'x' })]) {
      expect([r.status, r.body]).toEqual([404, { error: 'Recurring priority not found.' }]);
    }
  });

  it('deletes an item for good; the rows added from it keep their link and their own category', async () => {
    await add(QUEUE);
    await add(FOLLOW_UPS);
    const row = { text: 'Monitor the queue', recurringUid: QUEUE.uid, categoryUid: 'cat000000003' };
    const uid = (await save(TODAY, [row])).body.priorities[0].uid as string;
    const r = await remove('RCUR00000001');
    expect(r.status).toBe(200);
    expect(r.body.recurring).toEqual([FOLLOW_UPS]);
    expect(app.count('recurring')).toBe(1);
    expect((await app.api.get(`/api/days/${TODAY}`)).body.priorities[0]).toMatchObject({ ...row, uid, cardUid: null });
    expect((await remove('rcur00000001')).status).toBe(404);
    // Its uid is free again: a POST makes a new item, listed after the older one, as it was made last.
    expect((await add(QUEUE)).status).toBe(201);
    expect(await items()).toEqual([FOLLOW_UPS, QUEUE]);
  });

  it('keeps at most 100, and answers a retry of one of them at the cap', async () => {
    const userId = ensureDefaultUser(app.db).id;
    const insert = app.db.prepare(`INSERT INTO recurring (user_id, uid, title, weekdays) VALUES (?, ?, ?, 31)`);
    for (let i = 1; i < BOARD_LIMITS.recurring; i++) insert.run(userId, `bulk${String(i).padStart(8, '0')}`, `Routine ${i}`);
    expect((await add(QUEUE)).status).toBe(201);
    const over = await add(FOLLOW_UPS);
    expect([over.status, over.body.error]).toEqual([400, `The board keeps at most ${BOARD_LIMITS.recurring} recurring priorities.`]);
    expect((await add(QUEUE)).status).toBe(200);
    expect(app.count('recurring')).toBe(BOARD_LIMITS.recurring);
    // A deleted one makes room.
    await remove(QUEUE.uid);
    expect((await add(FOLLOW_UPS)).status).toBe(201);
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

    expect((await b.get('/api/board')).body).toEqual({ cards: [], categories: [], recurring: [] });
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

  it("never shows or changes another user's categories, and checks names against the caller's own", async () => {
    const { a, b } = await app.twoUsers();
    await a.post('/api/board/categories', { uid: 'cat000000001', name: 'Tickets', color: 'blue' });
    await a.post('/api/board/categories', { uid: 'cat000000002', name: 'Admin', color: 'grey' });
    await a.del('/api/board/categories/cat000000002');
    const mine = (await a.get('/api/board')).body.categories as Category[];

    expect((await b.get('/api/board')).body.categories).toEqual([]);
    for (const r of [
      await b.patch('/api/board/categories/cat000000001', { name: 'Mine' }),
      await b.del('/api/board/categories/cat000000001'),
      await b.patch('/api/board/categories/cat000000002', { color: 'pink' }),
      await b.del('/api/board/categories/cat000000002'),
    ]) {
      expect([r.status, r.body]).toEqual([404, { error: 'Category not found.' }]);
    }
    // A's names are free for B, in use or removed, and A's uids are B's own: B's POST of A's
    // removed one makes B a category rather than bringing A's back.
    expect((await b.post('/api/board/categories', { uid: 'cat000000003', name: 'Tickets', color: 'teal' })).status).toBe(201);
    expect((await b.post('/api/board/categories', { uid: 'cat000000002', name: 'Admin', color: 'gold' })).status).toBe(201);
    expect((await b.patch('/api/board/categories/cat000000003', { name: 'Ticket queue' })).status).toBe(200);
    expect((await a.get('/api/board')).body.categories).toEqual(mine);
    expect((await b.get('/api/board')).body.categories).toEqual([
      { uid: 'cat000000003', name: 'Ticket queue', color: 'teal', archived: false },
      { uid: 'cat000000002', name: 'Admin', color: 'gold', archived: false },
    ]);
  });

  it("never shows or changes another user's recurring priorities, and caps each user's own", async () => {
    const { admin, a, b } = await app.twoUsers();
    const queue = { uid: 'rcur00000001', title: 'Monitor the queue', categoryUid: null, weekdays: [1, 2, 3, 4, 5] };
    await a.post('/api/board/recurring', queue);
    expect((await b.get('/api/board')).body.recurring).toEqual([]);
    for (const r of [
      await b.patch('/api/board/recurring/rcur00000001', { title: 'Mine' }),
      await b.patch('/api/board/recurring/rcur00000001', { weekdays: [6] }),
      await b.del('/api/board/recurring/rcur00000001'),
    ]) {
      expect([r.status, r.body]).toEqual([404, { error: 'Recurring priority not found.' }]);
    }
    // A's uid is B's own: B's POST of it makes B an item rather than answering A's.
    const theirs = await b.post('/api/board/recurring', { ...queue, title: 'Watch my queue', weekdays: [6, 7] });
    expect([theirs.status, theirs.body.recurring]).toEqual([201, [{ ...queue, title: 'Watch my queue', weekdays: [6, 7] }]]);
    expect((await b.del('/api/board/recurring/rcur00000001')).status).toBe(200);
    expect((await a.get('/api/board')).body.recurring).toEqual([queue]);

    // A's items count toward A's cap only.
    const insert = app.db.prepare(`INSERT INTO recurring (user_id, uid, title, weekdays) VALUES (?, ?, 'Routine', 1)`);
    for (let i = 2; i <= BOARD_LIMITS.recurring; i++) insert.run(admin.id, `bulk${String(i).padStart(8, '0')}`);
    expect((await a.post('/api/board/recurring', { ...queue, uid: 'rcur00000002' })).status).toBe(400);
    expect((await b.post('/api/board/recurring', { ...queue, uid: 'rcur00000002' })).status).toBe(201);
  });
});
