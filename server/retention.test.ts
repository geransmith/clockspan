import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from './dev/harness.js';
import { seedDatabase } from './dev/seed.js';
import { cutoffKey, effectiveKeepDays, runRetention } from './retention.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';
import { DAY_MS } from '../shared/dates.js';
import { ensureDefaultUser, type UserRow } from './db.js';
import type { BoardCard } from '../shared/api.js';

describe('cutoffKey', () => {
  it('is the UTC date `keepDays` before now', () => {
    expect(cutoffKey(Date.UTC(2026, 8, 16, 12), 30)).toBe('2026-08-17');
    expect(cutoffKey(Date.UTC(2026, 0, 1, 0, 0, 1), 365)).toBe('2025-01-01');
  });
});

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

    // Each has a card done before both cutoffs and an untouched one no row links to.
    const insert = app.db.prepare(
      `INSERT INTO board_cards (user_id, uid, title, lane, position, created_at, done_at, untouched) VALUES (?, ?, ?, ?, ?, 0, ?, 1)`,
    );
    for (const user of [admin, member]) {
      insert.run(user.id, 'card000000aa', 'Old', 'done', 0, SEED_NOW - 90 * DAY_MS);
      insert.run(user.id, 'card000000bb', 'Loose', 'next', 99, null);
    }
    const cardsOf = (user: UserRow) => app.db.prepare(`SELECT * FROM board_cards WHERE user_id = ? ORDER BY id`).all(user.id) as { uid: string }[];
    const memberCards = cardsOf(member);

    // The admin keeps 30 days; sam's setting is off and there is no cap, so they keep everything.
    expect((await a.put('/api/settings', { retention: { enabled: true, days: 30 } })).status).toBe(200);
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(seeded.length - keptAfter(30).length);
    expect(datesOf(admin)).toEqual(keptAfter(30));
    expect(datesOf(member)).toEqual(seeded);
    const adminUids = cardsOf(admin).map((c) => c.uid);
    expect(adminUids).not.toContain('card000000aa');
    expect(adminUids).not.toContain('card000000bb');
    expect(cardsOf(member)).toEqual(memberCards);

    // A 60-day cap reaches sam too; the admin's own 30 is already the tighter limit.
    expect(runRetention(app.db, { ...app.config, retentionDays: 60 }, SEED_NOW)).toBe(seeded.length - keptAfter(60).length);
    expect(datesOf(member)).toEqual(keptAfter(60));
    expect(datesOf(admin)).toEqual(keptAfter(30));
  });
});

// A prune also takes board cards: those done before the cutoff, and those a priorities save made
// that were never handled on the board, once no row is linked to them.
describe('pruning board cards', () => {
  let app: TestApp;
  afterEach(() => app.close());

  const cards = async () => (await app.api.get('/api/board')).body.cards as BoardCard[];
  const saveOn = (date: string, priorities: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    app.api.put(`/api/days/${date}/priorities`, { priorities, cards: true, ...extra });
  const madeOn = async (date: string, text: string) => (await saveOn(date, [{ text }])).body.priorities[0].cardUid as string;
  /** A card in Done since `doneAt`, which the board's window would no longer send. */
  const doneCard = (uid: string, title: string, doneAt: number) =>
    app.db
      .prepare(`INSERT INTO board_cards (user_id, uid, title, lane, position, created_at, done_at) VALUES (?, ?, ?, 'done', 0, 0, ?)`)
      .run(ensureDefaultUser(app.db).id, uid, title, doneAt);

  it('deletes the cards done before the cutoff and the untouched ones whose rows all went, and keeps the rest', async () => {
    app = await startTestApp();
    const cutoff = Date.parse('2026-02-01T00:00:00Z');
    doneCard('done00000001', 'Done before the cutoff', cutoff - 1);
    doneCard('done00000002', 'Done at the cutoff', cutoff);
    const old = await saveOn('2026-01-12', [{ text: 'Only on an old day' }, { text: 'Carried to February' }]);
    const [gone, carried] = old.body.priorities.map((p: { cardUid: string }) => p.cardUid);
    await saveOn('2026-02-02', [{ text: 'Carried to February', cardUid: carried }]);
    const handled = await madeOn('2026-01-13', 'Handled on the board');
    await saveOn('2026-01-13', [{ text: 'Handled on the board', cardUid: handled }], { touched: [handled] });
    await app.api.post('/api/board/cards', { uid: 'card00000001', title: 'Captured', lane: 'next', before: null });
    expect((await cards()).filter((c) => c.lane === 'next').map((c) => c.title)).toEqual([
      'Handled on the board',
      'Only on an old day',
      'Carried to February',
      'Captured',
    ]);

    expect((await app.api.post('/api/days/prune', { before: '2026-02-01' })).body).toEqual({ deleted: 2 });
    const left = await cards();
    expect(left.map((c) => c.uid)).not.toContain(gone);
    // Next is numbered again, and the rest are as they were, the handled card now on no list.
    expect(left.map((c) => [c.lane, c.position, c.title, c.listDate])).toEqual([
      ['next', 1, 'Handled on the board', null],
      ['next', 2, 'Carried to February', '2026-02-02'],
      ['next', 3, 'Captured', null],
    ]);
    // The done one past the board's window is still stored.
    expect(app.count('board_cards', 'uid = ?', 'done00000002')).toBe(1);
    expect(app.count('board_cards', 'uid = ?', 'done00000001')).toBe(0);
  });

  it('compacts the file when only cards went', async () => {
    app = await startTestApp();
    doneCard('done00000001', 'Card text only the prune knew', Date.parse('2026-01-15T12:00:00Z'));
    expect((await app.api.post('/api/days/prune', { before: '2026-02-01' })).body).toEqual({ deleted: 0 });
    expect(app.count('board_cards')).toBe(0);
    expect(app.db.serialize().includes('Card text only the prune knew')).toBe(false);
  });

  it('logs the cards each scheduled pass deleted, and compacts the file for them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await startTestApp();
    expect((await app.api.put('/api/settings', { retention: { enabled: true, days: 30 } })).status).toBe(200);
    doneCard('done00000001', 'Finished long ago', SEED_NOW - 40 * DAY_MS);
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(0);
    expect(log).toHaveBeenCalledWith('[retention] deleted 1 board card');
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/ day/));
    expect(app.db.serialize().includes('Finished long ago')).toBe(false);
    doneCard('done00000002', 'Old', SEED_NOW - 40 * DAY_MS);
    doneCard('done00000003', 'Older', SEED_NOW - 50 * DAY_MS);
    runRetention(app.db, app.config, SEED_NOW);
    expect(log).toHaveBeenLastCalledWith('[retention] deleted 2 board cards');
  });
});
