import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../dev/harness.js';
import { ensureLocalUsers, LOCAL_USERS } from '../dev/seed.js';
import { CARD_DEFAULT_VISIBLE, CARD_IDS, DEFAULT_SETTINGS } from '../../shared/settings.js';
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

  it('takes booleans for the switches and ignores anything else', async () => {
    expect((await app.api.put('/api/settings', { celebrations: false })).body.celebrations).toBe(false);
    expect((await app.api.put('/api/settings', { celebrations: 'no' })).body.celebrations).toBe(false);
    expect((await app.api.put('/api/settings', { celebrations: true })).body.celebrations).toBe(true);
  });

  it('accepts a known time format and falls back for anything else', async () => {
    expect((await app.api.put('/api/settings', { timeFormat: '24h' })).body.timeFormat).toBe('24h');
    expect((await app.api.put('/api/settings', { timeFormat: '25h' })).body.timeFormat).toBe('24h');
    expect((await app.api.put('/api/settings', { timeFormat: 12 })).body.timeFormat).toBe('24h');
    expect((await app.api.put('/api/settings', { timeFormat: 'auto' })).body.timeFormat).toBe('auto');
  });

  it('keeps layout order, drops unknown cards and appends missing ones with their default', async () => {
    const r = await app.api.put('/api/settings', {
      layout: [{ id: 'timer', visible: false }, { id: 'nope' }, { id: 'timer', visible: true }, { id: 'log' }],
    });
    expect(r.body.layout).toEqual([
      { id: 'timer', visible: false },
      { id: 'log', visible: true },
      ...CARD_IDS.filter((id) => id !== 'timer' && id !== 'log').map((id) => ({ id, visible: CARD_DEFAULT_VISIBLE[id] })),
    ]);
  });

  it('carries a 0.2 layout with the sticker card shown over to the stickers setting', async () => {
    // A row saved by 0.2: the card id is no longer a layout entry, but the choice it recorded survives.
    const userId = (app.db.prepare(`SELECT id FROM users WHERE kind = 'default'`).get() as { id: number }).id;
    app.db.prepare(`INSERT INTO settings (user_id, json) VALUES (?, ?)`).run(
      userId,
      JSON.stringify({
        layout: [
          { id: 'stickers', visible: true },
          { id: 'retro', visible: false },
        ],
      }),
    );
    const stored = await app.api.get('/api/settings');
    expect(stored.body.stickers).toBe(true);
    expect(stored.body.layout.map((l: { id: string }) => l.id)).not.toContain('stickers');
    const shown = await app.api.put('/api/settings', { workMinutes: 420 });
    expect(shown.body.stickers).toBe(true);
    // The first save wrote the setting itself, so the layout stops mattering.
    expect((await app.api.get('/api/settings')).body.stickers).toBe(true);
    expect((await app.api.put('/api/settings', { stickers: false })).body.stickers).toBe(false);
    expect((await app.api.get('/api/settings')).body.stickers).toBe(false);
    // An explicit value wins over the layout, and a hidden card changes nothing.
    expect((await app.api.put('/api/settings', { stickers: false, layout: [{ id: 'stickers', visible: true }] })).body.stickers).toBe(false);
    expect((await app.api.put('/api/settings', { layout: [{ id: 'stickers', visible: false }] })).body.stickers).toBe(false);
    expect((await app.api.put('/api/settings', { stickers: 'yes' })).body.stickers).toBe(false);
  });

  it('takes the weekends switch as a boolean only', async () => {
    expect((await app.api.put('/api/settings', { showWeekends: false })).body.showWeekends).toBe(false);
    expect((await app.api.put('/api/settings', { showWeekends: 'no' })).body.showWeekends).toBe(false);
    expect((await app.api.put('/api/settings', { showWeekends: true })).body.showWeekends).toBe(true);
  });

  it('resets on DELETE', async () => {
    await app.api.put('/api/settings', { workMinutes: 1 });
    const r = await app.api.del('/api/settings');
    expect(r.body).toEqual(DEFAULT_SETTINGS);
    expect((await app.api.get('/api/settings')).body).toEqual(DEFAULT_SETTINGS);
    expect(app.db.prepare(`SELECT COUNT(*) AS n FROM settings`).get()).toEqual({ n: 0 });
  });
});

describe('settings are scoped to the signed-in user', () => {
  it("saves, reads and resets one user's row without touching another's", async () => {
    const app = await startTestApp({ authMode: 'local' });
    try {
      await ensureLocalUsers(app.db);
      const a = app.client();
      const b = app.client();
      expect((await a.post('/api/auth/login', { username: LOCAL_USERS.admin, password: LOCAL_USERS.password })).status).toBe(200);
      expect((await b.post('/api/auth/login', { username: LOCAL_USERS.member, password: LOCAL_USERS.password })).status).toBe(200);

      expect((await a.put('/api/settings', { workMinutes: 420 })).body.workMinutes).toBe(420);
      expect((await b.get('/api/settings')).body).toEqual(DEFAULT_SETTINGS);
      expect((await b.put('/api/settings', { workMinutes: 300 })).body.workMinutes).toBe(300);
      expect((await a.get('/api/settings')).body.workMinutes).toBe(420);

      expect((await b.del('/api/settings')).body).toEqual(DEFAULT_SETTINGS);
      expect((await a.get('/api/settings')).body.workMinutes).toBe(420);
      expect(app.db.prepare(`SELECT COUNT(*) AS n FROM settings`).get()).toEqual({ n: 1 });
    } finally {
      await app.close();
    }
  });
});

describe('mergeSettings', () => {
  it('ignores non-object patches', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toBe(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, 'x')).toBe(DEFAULT_SETTINGS);
  });

  it('hands out defaults nobody can change in place', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.alarms.lunchBy)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.alarms.lunchBy.leadMinutes)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.layout[0])).toBe(true);
    expect(() => (DEFAULT_SETTINGS.alarms.lunchBy.leadMinutes as number[]).push(1)).toThrow();
    // A merge that keeps an untouched alarm returns the frozen default; a patched one is a fresh object.
    const out = mergeSettings(DEFAULT_SETTINGS, { alarms: { lunchBy: { onDue: false } } });
    expect(Object.isFrozen(out.alarms.clockOut)).toBe(true);
    expect(Object.isFrozen(out.alarms.lunchBy)).toBe(false);
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
