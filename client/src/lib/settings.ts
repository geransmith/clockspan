import type { SettingsPatch } from '../api';
import type { Settings } from '../types';

/**
 * The settings with a change laid on the way `mergeSettings` lays it on the stored copy: each
 * alarm field by field, the sounds by event, the retention by field, anything else whole. No
 * validation, since the server's answer replaces this copy.
 */
export function applySettingsPatch(s: Settings, { alarms, sounds, retention, ...flat }: SettingsPatch): Settings {
  return {
    ...s,
    ...flat,
    alarms: {
      lunchBy: { ...s.alarms.lunchBy, ...alarms?.lunchBy },
      clockOut: { ...s.alarms.clockOut, ...alarms?.clockOut },
      secondMeal: { ...s.alarms.secondMeal, ...alarms?.secondMeal },
      retro: { ...s.alarms.retro, ...alarms?.retro },
    },
    sounds: { ...s.sounds, ...sounds },
    retention: { ...s.retention, ...retention },
  };
}
