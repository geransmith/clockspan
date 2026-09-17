import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../dev/harness.js';
import { CARD_IDS, DEFAULT_SETTINGS } from '../../shared/settings.js';
import { mergeSettings } from './settings.js';

describe('/api/settings', () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await startTestApp();
  });
  afterEach(() => app.close());

  it('serves the defaults for a new user', async () => {
    const r = await app.api.get('/api/settings');
    expect(r.status).toBe(200);
    expect(r.body).toEqual(DEFAULT_SETTINGS);
  });

  it('merges a sparse patch and drops what it cannot use', async () => {
    const r = await app.api.put('/api/settings', {
      workMinutes: 420,
      lunchMinutes: 'long',
      priorityCount: 11,
      bogus: true,
      alarms: { lunchBy: { leadMinutes: [5, 15, 5, 0, 300], onDue: false }, clockOut: 'off' },
    });
    expect(r.status).toBe(200);
    expect(r.body.workMinutes).toBe(420);
    expect(r.body.lunchMinutes).toBe(DEFAULT_SETTINGS.lunchMinutes);
    expect(r.body.priorityCount).toBe(DEFAULT_SETTINGS.priorityCount);
    expect(r.body).not.toHaveProperty('bogus');
    expect(r.body.alarms.lunchBy).toEqual({ ...DEFAULT_SETTINGS.alarms.lunchBy, leadMinutes: [15, 5], onDue: false });
    expect(r.body.alarms.clockOut).toEqual(DEFAULT_SETTINGS.alarms.clockOut);
    // The next PUT builds on what was stored, not on the defaults.
    const next = await app.api.put('/api/settings', { sound: false });
    expect(next.body.workMinutes).toBe(420);
    expect(next.body.sound).toBe(false);
    expect((await app.api.get('/api/settings')).body).toEqual(next.body);
  });

  it('keeps layout order, drops unknown cards and appends missing ones visible', async () => {
    const r = await app.api.put('/api/settings', {
      layout: [{ id: 'timer', visible: false }, { id: 'nope' }, { id: 'timer', visible: true }, { id: 'log' }],
    });
    expect(r.body.layout).toEqual([
      { id: 'timer', visible: false },
      { id: 'log', visible: true },
      ...CARD_IDS.filter((id) => id !== 'timer' && id !== 'log').map((id) => ({ id, visible: true })),
    ]);
  });

  it('resets on DELETE', async () => {
    await app.api.put('/api/settings', { workMinutes: 1 });
    const r = await app.api.del('/api/settings');
    expect(r.body).toEqual(DEFAULT_SETTINGS);
    expect((await app.api.get('/api/settings')).body).toEqual(DEFAULT_SETTINGS);
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM settings`).get()).toEqual({ n: 0 });
  });
});

describe('mergeSettings', () => {
  it('ignores non-object patches', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toBe(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, 'x')).toBe(DEFAULT_SETTINGS);
  });

  it('keeps retention within bounds, field by field', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: true, days: 90 } }).retention).toEqual({ enabled: true, days: 90 });
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: 'yes', days: 7 } }).retention).toEqual(DEFAULT_SETTINGS.retention);
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: { enabled: true, days: 4000 } }).retention).toEqual({ enabled: true, days: 365 });
    expect(mergeSettings(DEFAULT_SETTINGS, { retention: 'forever' }).retention).toEqual(DEFAULT_SETTINGS.retention);
  });

  it('bounds every numeric field', () => {
    const out = mergeSettings(DEFAULT_SETTINGS, {
      workMinutes: 0,
      lunchDeadlineMinutes: 24 * 60 + 1,
      secondMealAfterMinutes: 1.5,
      adjustStepMinutes: 61,
      alarms: { retro: { overdueEveryMinutes: 121 } },
    });
    expect(out).toEqual(DEFAULT_SETTINGS);
  });
});
