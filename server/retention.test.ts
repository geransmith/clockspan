import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from './dev/harness.js';
import { ensureDefaultUser, openDatabase, type UserRow } from './db.js';
import { seedDatabase } from './dev/seed.js';
import { cutoffKey, effectiveKeepDays, runRetention, scheduleRetention } from './retention.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

describe('cutoffKey', () => {
  it('is the UTC date `keepDays` before now', () => {
    expect(cutoffKey(Date.UTC(2026, 8, 16, 12), 30)).toBe('2026-08-17');
    expect(cutoffKey(Date.UTC(2026, 0, 1, 0, 0, 1), 365)).toBe('2025-01-01');
  });
});

describe('RETENTION_DAYS', () => {
  it('is optional, bounded, and a whole number', () => {
    expect(loadConfig({}).retentionDays).toBeNull();
    expect(loadConfig({ RETENTION_DAYS: '' }).retentionDays).toBeNull();
    expect(loadConfig({ RETENTION_DAYS: '90' }).retentionDays).toBe(90);
    expect(() => loadConfig({ RETENTION_DAYS: '10' })).toThrow(/RETENTION_DAYS/);
    expect(() => loadConfig({ RETENTION_DAYS: '4000' })).toThrow(/RETENTION_DAYS/);
    expect(() => loadConfig({ RETENTION_DAYS: 'abc' })).toThrow(/RETENTION_DAYS/);
    expect(() => loadConfig({ RETENTION_DAYS: '1.5' })).toThrow(/RETENTION_DAYS/);
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
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM punches WHERE day_id NOT IN (SELECT id FROM days)`).get()).toEqual({ n: 0 });
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE day_id NOT IN (SELECT id FROM days)`).get()).toEqual({ n: 0 });
    // A second pass finds nothing.
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(0);
  });

  it('applies the server cap to a user whose own setting is off, and as a ceiling when it is on', async () => {
    app = await startTestApp({ seed: { days: 60 }, env: { RETENTION_DAYS: '30' } });
    const seeded = app.seeded!.days.map((d) => d.date);
    const cutoff = cutoffKey(SEED_NOW, 30);
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(seeded.filter((d) => d < cutoff).length);
    expect(dates()).toEqual(seeded.filter((d) => d >= cutoff));
    await app.close();

    app = await startTestApp({ seed: { days: 60 }, env: { RETENTION_DAYS: '30' } });
    await app.api.put('/api/settings', { retention: { enabled: true, days: 3650 } });
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(seeded.filter((d) => d < cutoff).length);
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

    // The admin keeps 30 days; sam's setting is off and there is no cap, so he keeps everything.
    expect((await a.put('/api/settings', { retention: { enabled: true, days: 30 } })).status).toBe(200);
    expect(runRetention(app.db, app.config, SEED_NOW)).toBe(seeded.length - keptAfter(30).length);
    expect(datesOf(admin)).toEqual(keptAfter(30));
    expect(datesOf(member)).toEqual(seeded);

    // A 60-day cap reaches sam too; the admin's own 30 is already the tighter limit.
    expect(runRetention(app.db, { ...app.config, retentionDays: 60 }, SEED_NOW)).toBe(seeded.length - keptAfter(60).length);
    expect(datesOf(member)).toEqual(keptAfter(60));
    expect(datesOf(admin)).toEqual(keptAfter(30));
  });
});

describe('scheduleRetention', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs shortly after boot, then every few hours, and logs a failure instead of throwing', () => {
    vi.useFakeTimers({ now: SEED_NOW });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openDatabase(':memory:');
    const user = ensureDefaultUser(db);
    // One day past the cutoff and one inside it.
    const insert = db.prepare(`INSERT INTO days (user_id, date, created_at) VALUES (?, ?, ?)`);
    insert.run(user.id, cutoffKey(SEED_NOW, 31), SEED_NOW);
    insert.run(user.id, SEED_TODAY, SEED_NOW);
    const dates = () => (db.prepare(`SELECT date FROM days`).all() as { date: string }[]).map((d) => d.date);

    scheduleRetention(db, loadConfig({ RETENTION_DAYS: '30' }));
    vi.advanceTimersByTime(29_999);
    expect(dates()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(dates()).toEqual([SEED_TODAY]);
    expect(log).toHaveBeenCalledWith('[retention] deleted 1 day');

    // The periodic run finds the database gone: reported, not fatal.
    db.close();
    vi.advanceTimersByTime(6 * 3_600_000);
    expect(error).toHaveBeenCalledWith('[retention]', expect.objectContaining({ message: expect.stringMatching(/not open/) }));
  });
});
