import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from '../dev/harness.js';
import { ensureDefaultUser } from '../db.js';
import { addDays, MINUTE_MS } from '../../shared/dates.js';
import { BOARD_LIMITS, LIMITS, type BoardCard, type Day, type Recurring, type Session } from '../../shared/api.js';

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
/** Each task in a lane as [lane, position, title], in the board's order. */
const lanes = async () => (await board()).filter((c) => c.lane != null).map((c) => [c.lane, c.position, c.title]);
const cardOf = async (uid: string) => (await board()).find((c) => c.uid === uid);
const patch = (uid: string, body: Record<string, unknown>) => app.api.patch(`/api/items/${uid}`, body);
const remove = (uid: string) => app.api.del(`/api/items/${uid}`);
const NOT_FOUND = [404, { error: 'Task not found.' }];

describe('POST /api/items: a task made on the board', () => {
  it('starts empty, and keeps each new task where it was put', async () => {
    expect((await app.api.get('/api/board')).body).toEqual({ cards: [], categories: [], recurring: [] });
    const first = await app.capture('CARD0000000A', '  Write the KB  ', 'later');
    expect(first.status).toBe(201);
    expect(first.body.cards).toEqual([
      {
        uid: 'card0000000a',
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
    // Before the first task, at the end (null, or a task of another lane or none), and in Next.
    await app.capture('card0000000b', 'Review canned replies', 'later', 'CARD0000000A');
    await app.capture('card0000000c', 'Follow up on the SLA', 'next');
    await app.capture('card0000000d', 'Look into the timeout', 'later', 'card0000000c');
    await app.capture('card0000000e', 'Update the macros', 'later', 'card000000ff');
    expect(await lanes()).toEqual([
      ['later', 1, 'Review canned replies'],
      ['later', 2, 'Write the KB'],
      ['later', 3, 'Look into the timeout'],
      ['later', 4, 'Update the macros'],
      ['next', 1, 'Follow up on the SLA'],
    ]);
    // A long title is cut like a priority's text; left out, before is the end.
    const long = await app.api.post('/api/items', { uid: 'card0000000f', title: 'k'.repeat(LIMITS.priorityText + 20), lane: 'next' });
    expect(long.body.cards.find((c: BoardCard) => c.uid === 'card0000000f')).toMatchObject({ lane: 'next', position: 2 });
    expect(app.item('card0000000f')!.title).toHaveLength(LIMITS.priorityText);
  });

  it('takes a category, or none', async () => {
    await app.api.post('/api/items', { uid: 'card00000001', title: 'Report', categoryUid: 'CAT000000001', lane: 'later' });
    await app.api.post('/api/items', { uid: 'card00000002', title: 'Email', categoryUid: null, lane: 'later' });
    expect((await board()).map((c) => c.categoryUid)).toEqual(['cat000000001', null]);
  });

  it('refuses a task it could not store, and stores nothing', async () => {
    const ok = { uid: 'card00000001', title: 'Report', lane: 'later', before: null };
    const refusals: [Record<string, unknown>, string][] = [
      [{ uid: undefined }, 'uid must be a task id.'],
      [{ uid: 'not-a-uid!' }, 'uid must be a task id.'],
      [{ uid: 'ab' }, 'uid must be a task id.'],
      [{ uid: 12345678 }, 'uid must be a task id.'],
      [{ title: undefined }, 'A task needs a title.'],
      [{ title: '   ' }, 'A task needs a title.'],
      [{ title: 5 }, 'A task needs a title.'],
      [{ lane: undefined }, 'A task needs a lane or weekdays.'],
      // Done is a ticked entry, and In progress today's list.
      [{ lane: 'done' }, 'lane must be later or next.'],
      [{ lane: 'progress' }, 'lane must be later or next.'],
      [{ lane: null }, 'lane must be later or next.'],
      [{ weekdays: [1] }, 'A recurring priority stays off the board.'],
      [{ before: 'x' }, 'before must be a task id or null.'],
      [{ before: 5 }, 'before must be a task id or null.'],
      [{ categoryUid: 'not a uid' }, "categoryUid must be a category's id or null."],
      [{ categoryUid: 7 }, "categoryUid must be a category's id or null."],
    ];
    for (const [change, error] of refusals) {
      const r = await app.api.post('/api/items', { ...ok, ...change });
      expect([r.status, r.body.error], JSON.stringify(change)).toEqual([400, error]);
    }
    expect(app.count('items')).toBe(0);
  });

  it('answers the board as it is for a uid in use, and 404 for a deleted or archived task, whose uid stays taken', async () => {
    await app.capture('card00000001', 'Write the KB', 'later');
    const again = await app.capture('card00000001', 'Something else', 'next');
    expect(again.status).toBe(200);
    expect(await lanes()).toEqual([['later', 1, 'Write the KB']]);

    await remove('card00000001');
    const tombstone = app.item('card00000001');
    const retry = await app.capture('card00000001', 'Write the KB', 'later');
    expect([retry.status, retry.body]).toEqual(NOT_FOUND);
    expect(app.item('card00000001')).toEqual(tombstone);

    // A recurring priority removed in Settings while a day lists it is archived.
    await app.api.post('/api/items', { uid: 'rcur00000001', title: 'Monitor the queue', weekdays: [1] });
    await app.saveList(TODAY, [{ text: 'Monitor the queue', uid: 'rcur00000001' }]);
    await remove('rcur00000001');
    const archived = await app.api.post('/api/items', { uid: 'rcur00000001', title: 'Monitor the queue', weekdays: [1] });
    expect([archived.status, archived.body]).toEqual(NOT_FOUND);
  });

  it('caps Later and Next, counting only the tasks there that are not done', async () => {
    const userId = ensureDefaultUser(app.db).id;
    const insert = app.db.prepare(`INSERT INTO items (user_id, uid, title, lane, position, created_at) VALUES (?, ?, 'Task', ?, ?, 0)`);
    for (let i = 1; i <= BOARD_LIMITS.openCards; i++) insert.run(userId, `card${String(i).padStart(8, '0')}`, i % 2 ? 'later' : 'next', i);
    const full = [400, `The board holds at most ${BOARD_LIMITS.openCards} tasks in Later and Next.`];
    const fresh = await app.capture('card99999999', 'One more', 'later');
    expect([fresh.status, fresh.body.error]).toEqual(full);
    // Ticked on its latest list, a task in a lane is done and leaves room.
    await app.saveList(YESTERDAY, [{ text: 'Task', uid: 'card00000001', done: true }]);
    expect((await app.capture('card99999999', 'One more', 'later')).status).toBe(201);
    // A recurring priority isn't held to it.
    expect((await app.api.post('/api/items', { uid: 'rcur00000001', title: 'Queue', weekdays: [1] })).status).toBe(201);
  });
});

describe('POST /api/items: a recurring priority', () => {
  const QUEUE: Recurring = { uid: 'rcur00000001', title: 'Monitor the queue', categoryUid: 'cat000000001', weekdays: [1, 2, 3, 4, 5] };
  const FOLLOW_UPS: Recurring = { uid: 'rcur00000002', title: 'Follow-ups', categoryUid: null, weekdays: [1, 3, 5] };
  const routines = async () => (await app.api.get('/api/board')).body.recurring as Recurring[];
  const add = (item: object) => app.api.post('/api/items', item);
  /** Each routine's weekdays as the table holds them: a mask, bit 0 for Monday. */
  const masks = () => app.db.prepare(`SELECT uid, weekdays FROM items WHERE weekdays IS NOT NULL ORDER BY id`).all();
  const WEEKDAYS = 'weekdays must be one or more days from 1 to 7.';

  it('makes recurring priorities in the order sent, with the title tidied and the weekdays in order, off the board', async () => {
    const r = await add({ ...QUEUE, uid: 'RCUR00000001', title: '  Monitor the queue ', categoryUid: 'CAT000000001' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ cards: [], categories: [], recurring: [QUEUE] });
    // Weekdays in any order come back in order; a category left out is none.
    await add({ ...FOLLOW_UPS, weekdays: [5, 1, 3], categoryUid: undefined });
    await add({ uid: 'rcur00000003', title: 'k'.repeat(LIMITS.priorityText + 20), categoryUid: null, weekdays: [7, 6] });
    expect(await routines()).toEqual([QUEUE, FOLLOW_UPS, { uid: 'rcur00000003', title: 'k'.repeat(LIMITS.priorityText), categoryUid: null, weekdays: [6, 7] }]);
    expect(masks()).toEqual([
      { uid: 'rcur00000001', weekdays: 0b0011111 },
      { uid: 'rcur00000002', weekdays: 0b0010101 },
      { uid: 'rcur00000003', weekdays: 0b1100000 },
    ]);
    expect(app.item('rcur00000001')).toMatchObject({ lane: null, position: 0, created_at: SEED_NOW });
  });

  it('refuses weekdays it could not store, and stores nothing', async () => {
    for (const weekdays of [null, 31, [], [0], [1, 8], [1.5], ['1'], [1, 3, 1], [1, 2, 3, 4, 5, 6, 7, 1]]) {
      const r = await add({ ...QUEUE, weekdays });
      expect([r.status, r.body.error], JSON.stringify(weekdays)).toEqual([400, WEEKDAYS]);
    }
    expect(app.count('items')).toBe(0);
  });

  it('keeps at most 100 not removed, and answers a retry of one of them at the cap', async () => {
    const userId = ensureDefaultUser(app.db).id;
    const insert = app.db.prepare(`INSERT INTO items (user_id, uid, title, weekdays, created_at, archived_at) VALUES (?, ?, ?, 31, 0, ?)`);
    for (let i = 1; i < BOARD_LIMITS.recurring; i++) insert.run(userId, `bulk${String(i).padStart(8, '0')}`, `Routine ${i}`, null);
    // A removed one doesn't count.
    insert.run(userId, 'gone00000001', 'Removed', 1);
    expect((await add(QUEUE)).status).toBe(201);
    const over = await add(FOLLOW_UPS);
    expect([over.status, over.body.error]).toEqual([400, `The board keeps at most ${BOARD_LIMITS.recurring} recurring priorities.`]);
    expect((await add(QUEUE)).status).toBe(200);
    // Removing one makes room.
    await remove(QUEUE.uid);
    expect((await add(FOLLOW_UPS)).status).toBe(201);
  });
});

describe('PATCH /api/items/:uid', () => {
  beforeEach(async () => {
    await app.capture('card00000001', 'Write the KB', 'later');
    await app.capture('card00000002', 'Review canned replies', 'later');
    await app.capture('card00000003', 'Follow up on the SLA', 'next');
  });

  it('sets and clears the category, and keeps it when the field is left out', async () => {
    expect((await patch('card00000001', { categoryUid: 'CAT000000001' })).status).toBe(200);
    expect((await cardOf('card00000001'))!.categoryUid).toBe('cat000000001');
    await patch('card00000001', { title: 'Write the KB article' });
    expect(await cardOf('card00000001')).toMatchObject({ title: 'Write the KB article', categoryUid: 'cat000000001' });
    await patch('card00000001', { categoryUid: null });
    expect((await cardOf('card00000001'))!.categoryUid).toBeNull();
  });

  it('renames, reorders, and moves a task between Later and Next', async () => {
    expect((await patch('card00000002', { title: '  Review the canned replies ' })).status).toBe(200);
    // `before` alone reorders the task's own lane.
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

  it("applies an edit to a task on today's list and a later one", async () => {
    await app.saveList(TODAY, [{ text: 'Write the KB', uid: 'card00000001' }]);
    await app.saveList(addDays(TODAY, 1), [{ text: 'Write the KB', uid: 'card00000001' }]);
    expect((await patch('card00000001', { title: 'Renamed', lane: 'next' })).status).toBe(200);
    expect((await app.api.get(`/api/days/${TODAY}`)).body.priorities[0].text).toBe('Renamed');
    expect((await cardOf('card00000001'))!.lane).toBe('next');
  });

  it('gives a task with no lane a place, checked against the cap, which a done one takes no room under', async () => {
    // Typed on a day's list: no lane, and left open it shows in Next until one is given.
    await app.saveList(YESTERDAY, [{ text: 'Left open', uid: 'aaaaaaaaaaa1' }]);
    expect((await patch('aaaaaaaaaaa1', { before: 'card00000003' })).body.cards.find((c: BoardCard) => c.uid === 'aaaaaaaaaaa1').lane).toBeNull();
    await patch('aaaaaaaaaaa1', { lane: 'next', before: 'card00000003' });
    expect((await lanes()).filter(([lane]) => lane === 'next')).toEqual([
      ['next', 1, 'Left open'],
      ['next', 2, 'Follow up on the SLA'],
    ]);

    const userId = ensureDefaultUser(app.db).id;
    const insert = app.db.prepare(`INSERT INTO items (user_id, uid, title, lane, position, created_at) VALUES (?, ?, 'Task', 'later', ?, 0)`);
    // With the four in Later and Next, one past the cap, until one of them is ticked.
    for (let i = 1; i <= BOARD_LIMITS.openCards - 3; i++) insert.run(userId, `bulk${String(i).padStart(8, '0')}`, 100 + i);
    await app.saveList(YESTERDAY, [
      { text: 'Left open', uid: 'aaaaaaaaaaa1' },
      { text: 'Typed', uid: 'aaaaaaaaaaa2' },
      { text: 'Done', uid: 'card00000002', done: true },
    ]);
    const r = await patch('aaaaaaaaaaa2', { lane: 'later' });
    expect([r.status, r.body.error]).toEqual([400, `The board holds at most ${BOARD_LIMITS.openCards} tasks in Later and Next.`]);
    expect(app.item('aaaaaaaaaaa2')!.lane).toBeNull();
    // One already open in a lane moves at the cap, and so does a done one: neither adds to what it counts.
    expect((await patch('card00000001', { lane: 'next' })).status).toBe(200);
    expect((await patch('card00000002', { lane: 'next' })).status).toBe(200);
  });

  it('edits a recurring priority, never into a lane, and no one-off gets weekdays', async () => {
    await app.api.post('/api/items', { uid: 'rcur00000001', title: 'Monitor the queue', weekdays: [1, 2] });
    await patch('RCUR00000001', { title: '  Watch the queue ', categoryUid: 'cat000000002', weekday: { day: 3, on: true } });
    expect((await app.api.get('/api/board')).body.recurring).toEqual([
      { uid: 'rcur00000001', title: 'Watch the queue', categoryUid: 'cat000000002', weekdays: [1, 2, 3] },
    ]);
    const WEEKDAY = 'weekday must be a day from 1 to 7 with on true or false.';
    for (const [uid, change, error] of [
      ['rcur00000001', { lane: 'next' }, 'A recurring priority stays off the board.'],
      ['rcur00000001', { weekday: null }, WEEKDAY],
      ['rcur00000001', { weekday: 3 }, WEEKDAY],
      ['rcur00000001', { weekday: { day: 0, on: true } }, WEEKDAY],
      ['rcur00000001', { weekday: { day: 8, on: false } }, WEEKDAY],
      ['rcur00000001', { weekday: { day: 2, on: 'yes' } }, WEEKDAY],
      ['rcur00000001', { weekday: { on: false } }, WEEKDAY],
      // The whole list, as a tab from before the upgrade sends it, would put back another device's days.
      ['rcur00000001', { weekdays: [1, 2, 4] }, 'Send one day as weekday: { day, on }.'],
      ['card00000001', { weekday: { day: 1, on: true } }, 'Only a recurring priority has weekdays.'],
    ] as const) {
      const r = await patch(uid, change);
      expect([r.status, r.body.error], JSON.stringify(change)).toEqual([400, error]);
    }
    expect(app.item('rcur00000001')).toMatchObject({ lane: null, weekdays: 0b111 });
  });

  it("sets or clears one weekday, so two devices' changes to different days both land, and never clears the last", async () => {
    await app.api.post('/api/items', { uid: 'rcur00000001', title: 'Monitor the queue', weekdays: [1, 2, 3, 4, 5] });
    // The laptop adds Saturday; the phone, on its copy from before, takes Monday off.
    await patch('rcur00000001', { weekday: { day: 6, on: true } });
    await patch('rcur00000001', { weekday: { day: 1, on: false } });
    // A day set again, or cleared again, stays as it is.
    await patch('rcur00000001', { weekday: { day: 6, on: true } });
    await patch('rcur00000001', { weekday: { day: 7, on: false } });
    expect((await app.api.get('/api/board')).body.recurring[0].weekdays).toEqual([2, 3, 4, 5, 6]);

    await app.api.post('/api/items', { uid: 'rcur00000002', title: 'Follow-ups', weekdays: [3] });
    const last = await patch('rcur00000002', { weekday: { day: 3, on: false } });
    expect([last.status, last.body.error]).toEqual([400, 'A recurring priority keeps at least one weekday.']);
    expect(app.item('rcur00000002')!.weekdays).toBe(0b100);
  });

  it('refuses an edit it could not store, and changes nothing', async () => {
    const refusals: [Record<string, unknown>, string][] = [
      [{ title: '' }, 'A task needs a title.'],
      [{ title: null }, 'A task needs a title.'],
      [{ lane: 'done' }, 'lane must be later or next.'],
      [{ lane: null }, 'lane must be later or next.'],
      [{ before: ['card00000001'] }, 'before must be a task id or null.'],
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

  it('answers 404 for a task deleted, archived or never made', async () => {
    await remove('card00000001');
    await app.api.post('/api/items', { uid: 'rcur00000001', title: 'Monitor the queue', weekdays: [1] });
    await app.saveList(TODAY, [{ text: 'Monitor the queue', uid: 'rcur00000001' }]);
    await remove('rcur00000001');
    for (const uid of ['card00000001', 'rcur00000001', 'card00000009']) {
      const r = await patch(uid, { title: 'Back' });
      expect([r.status, r.body], uid).toEqual(NOT_FOUND);
    }
    expect([app.item('card00000001')!.title, app.item('rcur00000001')!.title]).toEqual(['card00000001', 'Monitor the queue']);
  });
});

describe('DELETE /api/items/:uid: a one-off task', () => {
  const MON = '2026-09-07';
  const TUE = '2026-09-08';

  it('takes it off every day and keeps its sessions there as unplanned time under its name and category, leaving a tombstone', async () => {
    await app.capture('card00000001', 'Write the KB', 'next');
    await app.capture('card00000002', 'Review canned replies', 'next');
    await patch('card00000002', { categoryUid: 'cat000000001' });
    const task = { text: 'Review canned replies', uid: 'card00000002' };
    await app.saveList(MON, [
      { ...task, done: true },
      { text: 'Email', uid: 'aaaaaaaaaaa1' },
    ]);
    await app.saveList(TUE, [task]);
    await app.saveList(TODAY, [task]);
    const log = async (date: string, end: 'finish' | 'cancel' | null) => {
      const { id } = (await app.api.post(`/api/days/${date}/sessions`, { plannedSeconds: 1500, label: 'Started as', priorityUid: task.uid })).body
        .session as Session;
      vi.setSystemTime(Date.now() + 10 * MINUTE_MS);
      if (end) await app.api.post(`/api/sessions/${id}/${end}`);
      return id;
    };
    await log(MON, 'finish');
    await log(TUE, 'cancel');
    const running = await log(TODAY, null);
    const range = async () => (await app.api.get(`/api/days/range?from=${MON}&to=${TODAY}`)).body.days as Day[];
    const sessions = async () => (await range()).flatMap((d) => d.sessions);
    const before = await sessions();
    expect(before.map((s) => [s.priorityUid, s.title, s.label, s.categoryUid])).toEqual([
      [task.uid, task.text, 'Started as', 'cat000000001'],
      [task.uid, task.text, 'Started as', 'cat000000001'],
    ]);

    const r = await remove(task.uid);
    expect(r.status).toBe(200);
    expect(r.body.cards.map((c: BoardCard) => c.uid)).toEqual(['card00000001', 'aaaaaaaaaaa1']);
    expect((await range()).map((d) => d.priorities.map((p) => p.uid))).toEqual([['aaaaaaaaaaa1'], [], []]);
    const after = await sessions();
    expect(after.map((s) => [s.priorityUid, s.title, s.label, s.categoryUid, s.durationSeconds])).toEqual(
      before.map((s) => [null, null, task.text, 'cat000000001', s.durationSeconds]),
    );
    // Still running, and still the one running timer.
    expect((await app.api.get('/api/sessions/running')).body.session).toMatchObject({ id: running, status: 'running', priorityUid: null });
    // The cancelled one had let go of it already.
    expect(app.count('sessions', `status = 'cancelled' AND item_id IS NULL AND label = 'Started as'`)).toBe(1);
    // The tombstone keeps only the uid: the deleted name and category stay on the sessions alone.
    expect(app.item(task.uid)).toMatchObject({ title: task.uid, category_uid: null, lane: null, position: 0, deleted_at: Date.now() });
    expect(await lanes()).toEqual([['next', 1, 'Write the KB']]);
  });

  it("cuts a long name to a session label's length, and deletes an archived one-off the same way", async () => {
    await app.saveList(MON, [{ text: 'k'.repeat(LIMITS.priorityText), uid: 'aaaaaaaaaaa1' }]);
    const { id } = (await app.api.post(`/api/days/${MON}/sessions`, { plannedSeconds: 600, priorityUid: 'aaaaaaaaaaa1' })).body.session as Session;
    app.db.prepare(`UPDATE items SET archived_at = 1 WHERE uid = 'aaaaaaaaaaa1'`).run();
    expect((await remove('aaaaaaaaaaa1')).status).toBe(200);
    const session = (await app.api.get(`/api/days/${MON}`)).body.sessions.find((s: Session) => s.id === id) as Session;
    expect(session.label).toBe('k'.repeat(LIMITS.sessionLabel));
    expect(app.item('aaaaaaaaaaa1')!.deleted_at).toBe(SEED_NOW);
  });

  it('answers 404 for a second delete, and for a task never made', async () => {
    await app.capture('card00000001', 'Write the KB', 'later');
    await remove('card00000001');
    for (const uid of ['card00000001', 'card00000009']) {
      const r = await remove(uid);
      expect([r.status, r.body], uid).toEqual(NOT_FOUND);
    }
  });
});

describe('DELETE /api/items/:uid: a recurring priority', () => {
  const add = (uid: string, title: string) => app.api.post('/api/items', { uid, title, categoryUid: null, weekdays: [1, 2, 3, 4, 5] });

  it('archives it, listed or not, so it stops repeating, stays on the days that list it, and stays stored until the prune', async () => {
    await add('rcur00000001', 'Monitor the queue');
    await add('rcur00000002', 'Follow-ups');
    await app.saveList(TODAY, [{ text: 'Monitor the queue', uid: 'rcur00000001' }]);
    const r = await remove('RCUR00000002');
    expect(r.body.recurring.map((x: Recurring) => x.uid)).toEqual(['rcur00000001']);
    expect(app.item('rcur00000002')).toMatchObject({ archived_at: SEED_NOW, deleted_at: null });
    const archived = await remove('rcur00000001');
    expect(archived.body.recurring).toEqual([]);
    expect(app.item('rcur00000001')).toMatchObject({ archived_at: SEED_NOW, deleted_at: null, weekdays: 0b11111 });
    expect((await app.api.get(`/api/days/${TODAY}`)).body.priorities[0]).toMatchObject({ text: 'Monitor the queue', recurring: true, archived: true });
    // Removed already: nothing brings it back.
    const again = await remove('rcur00000001');
    expect([again.status, again.body]).toEqual(NOT_FOUND);
  });

  it('keeps one a stale offer adds as the archived routine, never a one-off, and after its last list drops it', async () => {
    await add('rcur00000001', 'Monitor the queue');
    await remove('rcur00000001');
    // The phone's board copy still offered it, and Add to today sends it.
    const stale = await app.saveList(TODAY, [{ text: 'Monitor the queue', uid: 'rcur00000001' }]);
    expect(stale.body.priorities).toEqual([expect.objectContaining({ uid: 'rcur00000001', recurring: true, archived: true })]);
    expect((await board()).map((c) => c.uid)).toEqual([]);
    await app.saveList(TODAY, [], stale.body.priorities);
    expect(app.item('rcur00000001')).toMatchObject({ archived_at: SEED_NOW, weekdays: 0b11111 });
    expect(app.count('items')).toBe(1);
  });

  it('archives one a session names after its day dropped it', async () => {
    await add('rcur00000001', 'Monitor the queue');
    await app.saveList(TODAY, [{ text: 'Monitor the queue', uid: 'rcur00000001' }]);
    await app.api.post(`/api/days/${TODAY}/sessions`, { plannedSeconds: 600, priorityUid: 'rcur00000001' });
    await app.saveList(TODAY, []);
    await remove('rcur00000001');
    expect(app.item('rcur00000001')!.archived_at).toBe(SEED_NOW);
  });
});

describe('tasks are scoped to the signed-in user', () => {
  beforeEach(async () => {
    await app.close();
    app = await startTestApp({ authMode: 'local' });
  });

  it("never shows or changes another user's tasks, and caps each user's own", async () => {
    const { admin, a, b } = await app.twoUsers();
    await a.post('/api/items', { uid: 'card00000001', title: 'Write the KB', lane: 'later' });
    await a.post('/api/items', { uid: 'rcur00000001', title: 'Monitor the queue', weekdays: [1] });
    await a.put(`/api/days/${TODAY}/priorities`, { priorities: [{ text: 'Report', uid: 'aaaaaaaaaaa1' }] });
    await a.del('/api/items/aaaaaaaaaaa1');
    const mine = (await a.get('/api/board')).body;
    expect(mine.cards.map((c: BoardCard) => c.uid)).toEqual(['card00000001']);

    expect((await b.get('/api/board')).body).toEqual({ cards: [], categories: [], recurring: [] });
    for (const uid of ['card00000001', 'rcur00000001', 'aaaaaaaaaaa1']) {
      for (const r of [await b.patch(`/api/items/${uid}`, { title: 'Mine' }), await b.del(`/api/items/${uid}`)])
        expect([r.status, r.body], uid).toEqual(NOT_FOUND);
    }
    // A's uids are B's own, A's deleted one included: B's POST of one makes B a task.
    expect((await b.post('/api/items', { uid: 'card00000001', title: 'Mine', lane: 'next' })).status).toBe(201);
    expect((await b.post('/api/items', { uid: 'aaaaaaaaaaa1', title: 'Mine too', lane: 'next' })).status).toBe(201);
    expect((await b.post('/api/items', { uid: 'rcur00000001', title: 'My queue', weekdays: [6] })).status).toBe(201);
    expect((await b.del('/api/items/rcur00000001')).status).toBe(200);
    await b.patch('/api/items/card00000001', { lane: 'later', title: 'Mine, renamed' });
    expect((await a.get('/api/board')).body).toEqual(mine);

    // A's tasks count toward A's caps only.
    const insert = app.db.prepare(`INSERT INTO items (user_id, uid, title, weekdays, lane, position, created_at) VALUES (?, ?, 'Task', ?, ?, ?, 0)`);
    for (let i = 1; i <= BOARD_LIMITS.openCards; i++) insert.run(admin.id, `bulk${String(i).padStart(8, '0')}`, null, 'next', i);
    for (let i = 1; i < BOARD_LIMITS.recurring; i++) insert.run(admin.id, `rout${String(i).padStart(8, '0')}`, 1, null, 0);
    expect((await a.post('/api/items', { uid: 'card00000002', title: 'One more', lane: 'later' })).status).toBe(400);
    expect((await a.post('/api/items', { uid: 'rcur00000002', title: 'One more', weekdays: [1] })).status).toBe(400);
    expect((await b.post('/api/items', { uid: 'card00000002', title: 'One more', lane: 'later' })).status).toBe(201);
    expect((await b.post('/api/items', { uid: 'rcur00000002', title: 'One more', weekdays: [1] })).status).toBe(201);
  });
});
