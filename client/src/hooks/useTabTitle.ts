import { useEffect } from 'react';
import { TAB_TITLE } from '../lib/copy';
import { floorToMinute } from '../lib/format';
import { dayTimeclock, overtimeOn } from '../lib/timeclock';
import { tabTitle } from '../lib/title';
import { useBreak } from './useBreak';
import { useDays } from './useDay';
import { useSettings } from './useSettings';
import { useTimeFormat } from './useTimeFormat';
import { useTimer } from './useTimer';

/**
 * Writes the tab's title (`tabTitle`): the running session, a running break, or today's next
 * deadline. Called in `Shell`, inside every provider, since the timer's provider sits outside the
 * break's and can't read a running break. Today's timeclock is worked out here rather than taken
 * from `useTodayAlarms`, whose `tc` is null for 3 s after every punch and while a come-back refresh
 * is out, so the title would fall back to "Clockspan" then; the store's shown copy has a punch from
 * the tap on. Today is read, never loaded: `useTodayAlarms` loads and refreshes it. The deadlines
 * wait for the settings, as the alarms do, since the defaults would show a wrong end, and are judged
 * on the minute, so with no count running the title changes at most once a minute.
 */
export function useTabTitle(today: string, now: number): void {
  const { running, paused, countdownSeconds, name } = useTimer();
  const { endsAt, remainingSeconds } = useBreak();
  const { settings, loaded } = useSettings();
  const day = useDays().days[today];
  const { formatTime } = useTimeFormat();
  const minute = floorToMinute(now);
  const title = tabTitle(
    running ? { paused, countdownSeconds, name } : null,
    endsAt == null ? null : remainingSeconds,
    loaded && day
      ? {
          tc: dayTimeclock(day, settings, today, minute),
          options: {
            now: minute,
            isToday: true,
            alarms: settings.alarms,
            overtimeApproval: settings.overtimeApproval,
            overtimeApproved: overtimeOn(settings, day.overtimeApproved),
            formatTime,
          },
        }
      : null,
  );
  // Written only when its text changes, never reset between ticks: a reset in this effect's
  // cleanup would put "Clockspan" up between every two ticks, which a host that shows each
  // title change (the desktop app's browser pane) paints as a flicker.
  useEffect(() => {
    document.title = title;
  }, [title]);
  // The error card unmounts the app without a page load; the tab shouldn't keep a
  // frozen countdown.
  useEffect(() => {
    return () => {
      document.title = TAB_TITLE.app;
    };
  }, []);
}
