import { describe, expect, it } from 'vitest';
import { TEST_SETTINGS } from '../test/fixtures';
import { applySettingsPatch } from './settings';

describe('applySettingsPatch', () => {
  it('replaces a flat value and a list whole', () => {
    expect(applySettingsPatch(TEST_SETTINGS, { workMinutes: 540, timerMinutes: [10] })).toEqual({ ...TEST_SETTINGS, workMinutes: 540, timerMinutes: [10] });
  });

  it("changes one alarm's field and keeps its other fields and the other alarms", () => {
    const { alarms } = applySettingsPatch(TEST_SETTINGS, { alarms: { clockOut: { leadMinutes: [30] } } });
    expect(alarms).toEqual({ ...TEST_SETTINGS.alarms, clockOut: { ...TEST_SETTINGS.alarms.clockOut, leadMinutes: [30] } });
  });

  it('changes one sound and keeps the rest', () => {
    expect(applySettingsPatch(TEST_SETTINGS, { sounds: { timer: 'bell' } })).toEqual({ ...TEST_SETTINGS, sounds: { ...TEST_SETTINGS.sounds, timer: 'bell' } });
  });

  it('changes one retention field and keeps the other', () => {
    expect(applySettingsPatch(TEST_SETTINGS, { retention: { days: 90 } }).retention).toEqual({ ...TEST_SETTINGS.retention, days: 90 });
  });
});
