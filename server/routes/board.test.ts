import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { ensureDefaultUser } from '../db.js';
import { addDays, DAY_MS, MINUTE_MS } from '../../shared/dates.js';
import { BOARD_LIMITS, LIMITS, type BoardCard, type Category } from '../../shared/api.js';

const TODAY = SEED_TODAY;
const YESTERDAY = addDays(TODAY, -1);

let app: TestApp;
beforeEach(async () => {
  // Only Date, so createdAt and the board's window are known: HTTP keeps its real timers.
  vi.useFakeTimers({ now: SEED_NOW, toFake: ['Date'] });
  app = await startTestApp();
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

const board = async () => (await app.api.get('/api/board')).body.cards as BoardCard[];
const capture = (uid: string, title: string, lane: string) => app.api.post('/api/items', { uid, title, lane, before: null });
/** Saves a day's list as the web app does. */
const save = (date: string, priorities: Record<string, unknown>[]) => app.api.put(`/api/days/${date}/priorities`, { priorities });

describe('GET /api/board', () => {
  it('sends the tasks in Later and Next in order, then the others a list holds, latest list first', async () => {
    await capture('card00000001', 'Write the KB', 'later');
    await capture('card00000002', 'Follow up', 'next');
    await save(YESTERDAY, [
      { text: 'Report', uid: 'aaaaaaaaaaa1', done: true },
      { text: 'Left open', uid: 'aaaaaaaaaaa2' },
    ]);
    await save(TODAY, [{ text: 'Email', uid: 'aaaaaaaaaaa3' }]);
    expect((await board()).map((c) => [c.uid, c.lane, c.position, c.listDate, c.listDone])).toEqual([
      ['card00000001', 'later', 1, null, false],
      ['card00000002', 'next', 1, null, false],
      ['aaaaaaaaaaa3', null, 0, TODAY, false],
      ['aaaaaaaaaaa1', null, 0, YESTERDAY, true],
      ['aaaaaaaaaaa2', null, 0, YESTERDAY, false],
    ]);
  });

  it("reads each task's latest list, its tick there, how many lists hold it and the focus done on it", async () => {
    const report = { text: 'Report', uid: 'aaaaaaaaaaa1' };
    await save(addDays(TODAY, -2), [report]);
    await save(YESTERDAY, [{ ...report, done: true }]);
    const { id } = (await app.api.post(`/api/days/${YESTERDAY}/sessions`, { plannedSeconds: 1500, priorityUid: report.uid })).body.session as { id: number };
    vi.setSystemTime(SEED_NOW + 20 * MINUTE_MS);
    await app.api.post(`/api/sessions/${id}/finish`);
    expect(await board()).toEqual([
      {
        uid: report.uid,
        title: 'Report',
        categoryUid: null,
        lane: null,
        position: 0,
        createdAt: SEED_NOW,
        listDate: YESTERDAY,
        listDone: true,
        listed: 2,
        logged: 1200,
      },
    ]);
    // Taken off its latest list, it is open again on the one before.
    await save(YESTERDAY, []);
    expect((await board())[0]).toMatchObject({ listDate: addDays(TODAY, -2), listDone: false, listed: 1, logged: 1200 });
  });

  it('sends a task a list holds while its latest entry is in the last 15 days or later, whatever its lane, and leaves the rest out', async () => {
    vi.setSystemTime(SEED_NOW + 3 * DAY_MS);
    // SEED_NOW + 3 days is 2026-09-19 in UTC, so the window starts on 2026-09-04.
    const open = (date: string, uid: string, done = false) => save(date, [{ text: uid, uid, done }]);
    await open('2026-10-09', 'aaaaaaaaaaa1');
    await open('2026-09-04', 'aaaaaaaaaaa2');
    await open('2026-09-03', 'aaaaaaaaaaa3');
    await capture('card00000001', 'In Next, old', 'next');
    await open('2026-08-01', 'card00000001');
    await capture('card00000002', 'Done long ago', 'next');
    await open('2026-08-02', 'card00000002', true);
    expect((await board()).map((c) => [c.uid, c.listDate, c.listDone])).toEqual([
      ['card00000001', '2026-08-01', false],
      ['aaaaaaaaaaa1', '2026-10-09', false],
      ['aaaaaaaaaaa2', '2026-09-04', false],
    ]);
  });

  it('leaves out recurring priorities, archived tasks and deleted ones, and a done task in a lane past the window', async () => {
    await app.api.post('/api/items', { uid: 'rcur00000001', title: 'Monitor the queue', weekdays: [1] });
    await save(YESTERDAY, [
      { text: 'Monitor the queue', uid: 'rcur00000001' },
      { text: 'Archived', uid: 'aaaaaaaaaaa1' },
    ]);
    app.db.prepare(`UPDATE items SET archived_at = 1 WHERE uid = 'aaaaaaaaaaa1'`).run();
    await capture('card00000001', 'Deleted from Next', 'next');
    await app.api.del('/api/items/card00000001');
    await capture('card00000002', 'Done in Later', 'later');
    await save('2026-08-01', [{ text: 'Done in Later', uid: 'card00000002', done: true }]);
    expect(await board()).toEqual([]);
  });

  it('caps nothing it sends', async () => {
    const userId = ensureDefaultUser(app.db).id;
    const insert = app.db.prepare(`INSERT INTO items (user_id, uid, title, lane, position, created_at) VALUES (?, ?, 'Task', 'later', ?, 0)`);
    for (let i = 1; i <= BOARD_LIMITS.openCards + 1; i++) insert.run(userId, `card${String(i).padStart(8, '0')}`, i);
    expect(await board()).toHaveLength(BOARD_LIMITS.openCards + 1);
  });

  it('tells a page from before tasks were stored once to reload on any card or recurring-priority route', async () => {
    const stale = [409, { error: 'Clockspan was updated. Reload the page.' }];
    for (const r of [
      await app.api.post('/api/board/cards', { uid: 'card00000001', title: 'Report', lane: 'later', before: null }),
      await app.api.patch('/api/board/cards/card00000001', { today: TODAY, title: 'x' }),
      await app.api.del('/api/board/cards/card00000001'),
      await app.api.post('/api/board/recurring', { uid: 'rcur00000001', title: 'Queue', categoryUid: null, weekdays: [1] }),
      await app.api.del('/api/board/recurring/rcur00000001'),
    ]) {
      expect([r.status, r.body]).toEqual(stale);
    }
    expect(app.count('items')).toBe(0);
  });
});

describe('the seeded board', () => {
  it('reads back at the seed time as the manifest has it, and keeps only the open tasks in a lane once their lists are past the window', async () => {
    await app.close();
    app = await startTestApp({ seed: true });
    const seeded = app.seeded!.board.cards;
    expect(await board()).toEqual(seeded);
    expect(seeded.filter((c) => c.lane == null).length).toBeGreaterThan(0);
    vi.setSystemTime(SEED_NOW + (BOARD_LIMITS.listWindowDays + 1) * DAY_MS);
    expect(await board()).toEqual(seeded.filter((c) => c.lane != null && !c.listDone));
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

describe('the board is scoped to the signed-in user', () => {
  beforeEach(async () => {
    await app.close();
    app = await startTestApp({ authMode: 'local' });
  });

  it("never shows another user's tasks, or counts another user's lists and sessions for them", async () => {
    const { a, b } = await app.twoUsers();
    await a.post('/api/items', { uid: 'card00000001', title: 'Write the KB', lane: 'later' });
    // The same uid is B's own task, on B's lists, with B's time.
    await b.post('/api/items', { uid: 'card00000001', title: 'Mine', lane: 'next' });
    await b.put(`/api/days/${YESTERDAY}/priorities`, { priorities: [{ text: 'Mine', uid: 'card00000001', done: true }] });
    const { id } = (await b.post(`/api/days/${YESTERDAY}/sessions`, { plannedSeconds: 600, priorityUid: 'card00000001' })).body.session as { id: number };
    await b.post(`/api/sessions/${id}/finish`);
    expect((await a.get('/api/board')).body.cards).toEqual([
      {
        uid: 'card00000001',
        title: 'Write the KB',
        categoryUid: null,
        lane: 'later',
        position: 1,
        createdAt: SEED_NOW,
        listDate: null,
        listDone: false,
        listed: 0,
        logged: 0,
      },
    ]);
    expect((await b.get('/api/board')).body.cards).toMatchObject([{ title: 'Mine', listDate: YESTERDAY, listDone: true, listed: 1 }]);
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
});
