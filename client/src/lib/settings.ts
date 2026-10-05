import { ALARM_IDS } from '../../../shared/settings.js';
import type { SettingsPatch } from '../api';
import type { Settings } from '../types';

/**
 * The settings with a change laid on the way `mergeSettings` lays it on the stored copy: each
 * alarm field by field, the sounds by event, the retention by field, anything else whole. No
 * validation, since the server's answer replaces this copy.
 */
export function applySettingsPatch(s: Settings, { alarms, sounds, retention, ...flat }: SettingsPatch): Settings {
  const merged = { ...s.alarms };
  for (const id of ALARM_IDS) merged[id] = { ...s.alarms[id], ...alarms?.[id] };
  return {
    ...s,
    ...flat,
    alarms: merged,
    sounds: { ...s.sounds, ...sounds },
    retention: { ...s.retention, ...retention },
  };
}
