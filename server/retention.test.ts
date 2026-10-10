import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from './dev/harness.js';
import { seedDatabase } from './dev/seed.js';
import { effectiveKeepDays, runRetention } from './retention.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
import { cutoffKey, DAY_MS } from '../shared/dates.js';
import { ensureDefaultUser, readRevision, type UserRow } from './db.js';
import type { Board } from '../shared/api.js';

describe('effectiveKeepDays', () => {
  const config = loadConfig({});
  it('is null unless the user or the server asks for a limit, and takes the smaller of the two', () => {
    expect(effectiveKeepDays(DEFAULT_SETTINGS, config)).toBeNull();
    const on = { ...DEFAULT_SETTINGS, retention: { enabled: true, days: 60 } };
    expect(effectiveKeepDays(on, config)).toBe(60);
    expect(effectiveKeepDays(on, { ...config, retentionDays: 30 })).toBe(30);
    expect(effectiveKeepDays(on, { ...config, retentionDays: 90 })).toBe(60);
    expect(effectiveKeepDays(DEFAULT_SETTINGS, { ...config, retentionDays: 90 })).toBe(90);
  });
});

describe('runRetention', () => {
  let app: TestApp;
  afterEach(() => app.close());

  const dates = () => (app.db.prepare(`SELECT date FROM days ORDER BY date`).all() as { date: string }[]).map((d) => d.date);

  it('does nothing while the setting is off and no server cap is set', async () => {
    app = await startTestApp({ seed: { days: 60 } });
    const before = dates();
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(0);
    expect(dates()).toEqual(before);
  });

  it('deletes the days older than the user setting and keeps the rest', async () => {
    app = await startTestApp({ seed: { days: 60 } });
    expect((await app.api.put('/api/settings', { retention: { enabled: true, days: 30 } })).status).toBe(200);
    const cutoff = cutoffKey(SEED_NOW, 30);
    const seeded = app.seeded!.days.map((d) => d.date);
    const expectedGone = seeded.filter((d) => d < cutoff);
    expect(expectedGone.length).toBeGreaterThan(0);
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(expectedGone.length);
    expect(dates()).toEqual(seeded.filter((d) => d >= cutoff));
    // Cascade: nothing of those days is left behind.
    expect(app.count('punches', 'day_id NOT IN (SELECT id FROM days)')).toBe(0);
    expect(app.count('sessions', 'day_id NOT IN (SELECT id FROM days)')).toBe(0);
    // A second pass finds nothing.
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(0);
  });

  it("holds each user to their own setting, and the server cap to everyone's", async () => {
    app = await startTestApp({ authMode: 'local' });
    const { admin, member, a } = await app.twoUsers();
    const seed = (user: UserRow) => seedDatabase(app.db, { userId: user.id, today: SEED_TODAY, now: SEED_NOW, days: 60 }).days.map((d) => d.date);
    const seeded = seed(admin);
    expect(seed(member)).toEqual(seeded);
    const datesOf = (user: UserRow) =>
      (app.db.prepare(`SELECT date FROM days WHERE user_id = ? ORDER BY date`).all(user.id) as { date: string }[]).map((d) => d.date);
    const keptAfter = (days: number) => seeded.filter((d) => d >= cutoffKey(SEED_NOW, days));
    // Sixty weekdays reach past both cutoffs, and the 30-day one takes more.
    expect(seeded.length).toBeGreaterThan(keptAfter(60).length);
    expect(keptAfter(60).length).toBeGreaterThan(keptAfter(30).length);

    // Each has the tombstone of a task deleted before both cutoffs, and an archived one nothing names.
    const insert = app.db.prepare(`INSERT INTO items (user_id, uid, title, created_at, archived_at, deleted_at) VALUES (?, ?, ?, 0, ?, ?)`);
    for (const user of [admin, member]) {
      insert.run(user.id, 'card000000aa', 'Old', null, SEED_NOW - 90 * DAY_MS);
      insert.run(user.id, 'card000000bb', 'Loose', 0, null);
    }
    const tasksOf = (user: UserRow) => app.db.prepare(`SELECT * FROM items WHERE user_id = ? ORDER BY id`).all(user.id) as { uid: string }[];
    const memberTasks = tasksOf(member);
    // A pass moves on the revision of each user it deleted something for, and no one else's.
    const revisions = () => [admin, member].map((u) => readRevision(app.db, u.id));

    // The admin keeps 30 days; sam's setting is off and there is no cap, so they keep everything.
    expect((await a.put('/api/settings', { retention: { enabled: true, days: 30 } })).status).toBe(200);
    expect(revisions()).toEqual([1, 0]);
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(seeded.length - keptAfter(30).length);
    expect(datesOf(admin)).toEqual(keptAfter(30));
    expect(datesOf(member)).toEqual(seeded);
    const adminUids = tasksOf(admin).map((c) => c.uid);
    expect(adminUids).not.toContain('card000000aa');
    expect(adminUids).not.toContain('card000000bb');
    expect(tasksOf(member)).toEqual(memberTasks);
    expect(revisions()).toEqual([2, 0]);

    // A 60-day cap reaches sam too; the admin's own 30 is already the tighter limit.
    expect(runRetention(app.db, { ...app.config, retentionDays: 60 }, SEED_NOW)).toBe(seeded.length - keptAfter(60).length);
    expect(datesOf(member)).toEqual(keptAfter(60));
    expect(datesOf(admin)).toEqual(keptAfter(30));
    expect(revisions()).toEqual([2, 1]);
  });
});

// A prune also takes tasks: those done before the cutoff, the tombstones of those deleted before
// it, and any task nothing names.
describe('pruning tasks', () => {
  let app: TestApp;
  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
  });

  const OLD = '2026-01-12';
  const KEPT = '2026-02-02';
  const save = (date: string, priorities: Record<string, unknown>[]) => app.api.put(`/api/days/${date}/priorities`, { priorities });
  const row = (uid: string, done = false) => ({ text: `Task ${uid}`, uid, done });
  const dates = () => (app.db.prepare(`SELECT date FROM days`).all() as { date: string }[]).map((d) => d.date);
  const uids = () => (app.db.prepare(`SELECT uid FROM items ORDER BY uid`).all() as { uid: string }[]).map((i) => i.uid);
  const prune = async () => (await app.api.post('/api/days/prune', { before: '2026-02-01' })).body as unknown;
  /** Deletes the task everywhere at `at`, which its tombstone keeps. */
  const deleteAt = async (uid: string, at: number) => {
    vi.useFakeTimers({ now: at, toFake: ['Date'] });
    await app.api.del(`/api/items/${uid}`);
    vi.useRealTimers();
  };

  it('deletes the tasks done before the cutoff whatever their lane, and those left on no list in no lane, and keeps the rest', async () => {
    app = await startTestApp();
    for (const [uid, lane] of [
      ['aaaaaaaaaaa2', 'next'],
      ['aaaaaaaaaaa5', 'later'],
      ['aaaaaaaaaaa7', 'next'],
    ]) {
      await app.api.post('/api/items', { uid, title: `Task ${uid}`, lane });
    }
    await app.api.post('/api/items', { uid: 'rcur00000001', title: 'Monitor the queue', weekdays: [1] });
    await app.api.post('/api/items', { uid: 'rcur00000002', title: 'Removed routine', weekdays: [1] });
    await save(OLD, [
      // Done before the cutoff: one with no lane, one in Next.
      row('aaaaaaaaaaa1', true),
      row('aaaaaaaaaaa2', true),
      // Done, then carried to a day the prune keeps and left open there.
      row('aaaaaaaaaaa3', true),
      // Left open on a day the prune takes, with no lane, and from Later, which its save lined up at the top of Next.
      row('aaaaaaaaaaa4'),
      row('aaaaaaaaaaa5'),
      // Done, with a session on a later day that listed it then.
      row('aaaaaaaaaaa6', true),
      // A recurring priority done before the cutoff, in use and removed before it.
      { text: 'Monitor the queue', uid: 'rcur00000001', done: true },
      { text: 'Removed routine', uid: 'rcur00000002', done: true },
    ]);
    await deleteAt('rcur00000002', Date.parse('2026-01-20T00:00:00Z'));
    await save(KEPT, [row('aaaaaaaaaaa3'), row('aaaaaaaaaaa6')]);
    const { id } = (await app.api.post(`/api/days/${KEPT}/sessions`, { plannedSeconds: 600, priorityUid: 'aaaaaaaaaaa6' })).body.session as { id: number };
    await app.api.post(`/api/sessions/${id}/finish`);
    await save(KEPT, [row('aaaaaaaaaaa3')]);
    expect(app.count('items')).toBe(9);

    expect(await prune()).toEqual({ deleted: 1 });
    expect(uids()).toEqual(['aaaaaaaaaaa3', 'aaaaaaaaaaa5', 'aaaaaaaaaaa6', 'aaaaaaaaaaa7', 'rcur00000001']);
    // Next closed up; the routine still repeats.
    const board = (await app.api.get('/api/board')).body as Board;
    expect(board.cards.filter((c) => c.lane != null).map((c) => [c.uid, c.lane, c.position])).toEqual([
      ['aaaaaaaaaaa5', 'next', 1],
      ['aaaaaaaaaaa7', 'next', 2],
    ]);
    expect(board.recurring.map((r) => r.uid)).toEqual(['rcur00000001']);
  });

  it('takes a done task kept for a session on a later day out of its lane, which closes up', async () => {
    app = await startTestApp();
    for (const uid of ['aaaaaaaaaaa1', 'aaaaaaaaaaa2']) await app.api.post('/api/items', { uid, title: `Task ${uid}`, lane: 'later' });
    await save(OLD, [row('aaaaaaaaaaa1', true)]);
    // Back on a later day, where time is logged on it, then taken off that day's list.
    await save(KEPT, [row('aaaaaaaaaaa1')]);
    const { id } = (await app.api.post(`/api/days/${KEPT}/sessions`, { plannedSeconds: 600, priorityUid: 'aaaaaaaaaaa1' })).body.session as { id: number };
    await app.api.post(`/api/sessions/${id}/finish`);
    await save(KEPT, []);
    expect(await prune()).toEqual({ deleted: 1 });
    expect(uids()).toEqual(['aaaaaaaaaaa1', 'aaaaaaaaaaa2']);
    const board = (await app.api.get('/api/board')).body as Board;
    expect(board.cards.map((c) => [c.uid, c.lane, c.position])).toEqual([['aaaaaaaaaaa2', 'later', 1]]);
  });

  it('keeps a done task a day kept for its running timer still lists', async () => {
    app = await startTestApp();
    await save(OLD, [row('aaaaaaaaaaa1', true), row('aaaaaaaaaaa2')]);
    await app.api.post(`/api/days/${OLD}/sessions`, { plannedSeconds: 600, priorityUid: 'aaaaaaaaaaa2' });
    expect(await prune()).toEqual({ deleted: 0 });
    expect(uids()).toEqual(['aaaaaaaaaaa1', 'aaaaaaaaaaa2']);
  });

  it('deletes the tombstones of tasks deleted before the cutoff, keeps the later ones, and compacts the file when only tasks went', async () => {
    app = await startTestApp();
    await app.api.post('/api/items', { uid: 'card00000001', title: 'Task text only the prune knew', lane: 'later' });
    await app.api.post('/api/items', { uid: 'card00000002', title: 'Deleted at the cutoff', lane: 'later' });
    await deleteAt('card00000001', Date.parse('2026-01-31T23:59:59Z'));
    await deleteAt('card00000002', Date.parse('2026-02-01T00:00:00Z'));
    expect(await prune()).toEqual({ deleted: 0 });
    expect(uids()).toEqual(['card00000002']);
    expect(app.db.serialize().includes('Task text only the prune knew')).toBe(false);
  });

  it('keeps a tombstone 30 days, however recent the cutoff', async () => {
    app = await startTestApp();
    for (const uid of ['card00000001', 'card00000002']) await app.api.post('/api/items', { uid, title: `Task ${uid}`, lane: 'later' });
    await deleteAt('card00000001', SEED_NOW - 30 * DAY_MS - 1);
    await deleteAt('card00000002', SEED_NOW - DAY_MS);
    vi.useFakeTimers({ now: SEED_NOW, toFake: ['Date'] });
    expect((await app.api.post('/api/days/prune', { before: SEED_TODAY })).status).toBe(200);
    expect(uids()).toEqual(['card00000002']);
  });

  it('answers a prune whose compaction fails, and logs the failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    app = await startTestApp();
    await save(OLD, [row('aaaaaaaaaaa1')]);
    vi.spyOn(app.db, 'exec').mockImplementation(() => {
      throw new Error('database or disk is full');
    });
    expect(await prune()).toEqual({ deleted: 1 });
    expect(error).toHaveBeenCalledWith('[db] compaction failed', expect.any(Error));
    expect(dates()).toEqual([]);
  });

  it('keeps an archived task nothing names until it was archived, or its old card done, before the cutoff', async () => {
    app = await startTestApp();
    const insert = app.db.prepare(`INSERT INTO items (user_id, uid, title, created_at, archived_at, legacy_done_at) VALUES (?, ?, ?, 0, ?, ?)`);
    const user = ensureDefaultUser(app.db).id;
    const before = Date.parse('2026-01-31T23:59:59Z');
    const at = Date.parse('2026-02-01T00:00:00Z');
    insert.run(user, 'card00000001', 'Archived before', before, null);
    insert.run(user, 'card00000002', 'Archived at the cutoff', at, null);
    insert.run(user, 'card00000003', 'Done before, archived after', at, before);
    insert.run(user, 'card00000004', 'Done at the cutoff, archived before', before, at);
    expect(await prune()).toEqual({ deleted: 0 });
    expect(uids()).toEqual(['card00000002', 'card00000004']);
  });

  it('logs the tasks each scheduled pass deleted, tombstones included, and leaves them while retention is off', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await startTestApp();
    await app.api.post('/api/items', { uid: 'card00000001', title: 'Deleted long ago', lane: 'later' });
    await deleteAt('card00000001', SEED_NOW - 40 * DAY_MS);
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(0);
    expect(uids()).toEqual(['card00000001']);
    expect(log).not.toHaveBeenCalled();

    expect((await app.api.put('/api/settings', { retention: { enabled: true, days: 30 } })).status).toBe(200);
    const revision = () => readRevision(app.db, ensureDefaultUser(app.db).id);
    const before = revision();
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(0);
    expect(log).toHaveBeenCalledWith('[retention] deleted 1 task');
    // A pass that deleted only a tombstone still moves the revision on.
    expect(revision()).toBe(before + 1);
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/ day/));
    expect(app.db.serialize().includes('Deleted long ago')).toBe(false);
    await save('2025-12-01', [row('aaaaaaaaaaa1', true), row('aaaaaaaaaaa2', true)]);
    runRetention(app.db, app.config, SEED_NOW);
    expect(log).toHaveBeenLastCalledWith('[retention] deleted 2 tasks');
  });
});
