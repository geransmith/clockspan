import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { SEED_NOW, SEED_TODAY, startTestApp, type TestApp } from './dev/harness.js';
import type { UserRow } from './db.js';
import { seedDatabase } from './dev/seed.js';
import { cutoffKey, effectiveKeepDays, runRetention } from './retention.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

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

    // The admin keeps 30 days; sam's setting is off and there is no cap, so they keep everything.
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
