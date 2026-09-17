import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { SEED_NOW, startTestApp, type TestApp } from './dev/harness.js';
import { cutoffKey, effectiveKeepDays, runRetention } from './retention.js';
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
});
