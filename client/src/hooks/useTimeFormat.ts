import { useMemo } from 'react';
import { formatTime, resolveHour12 } from '../lib/format';
import { useSettings } from './useSettings';

/** The user's clock (Settings → Timeclock → Time format) and a `formatTime` bound to it. */
export function useTimeFormat(): { hour12: boolean; formatTime: (ms: number) => string } {
  const { settings } = useSettings();
  return useMemo(() => {
    const hour12 = resolveHour12(settings.timeFormat);
    return { hour12, formatTime: (ms: number) => formatTime(ms, hour12) };
  }, [settings.timeFormat]);
}
