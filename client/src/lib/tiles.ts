import type { AlarmSettings, Settings } from '../types';
import { formatDuration, formatDurationCeil, plural } from './format';
import type { TimeclockResult } from './timeclock';

/** One of the timeclock card's tiles: the number, the line under it, and its colour class. */
export interface TileView {
  value: string;
  sub: string;
  /** '' or a `tile--*` modifier. */
  tone: string;
}

export interface TileOptions {
  /** The day's clock (`clampToDay`): live today, the end of an earlier day. */
  now: number;
  isToday: boolean;
  /** The work-day length this day runs on (`daySettings`). */
  workMinutes: number;
  alarms: Pick<Settings['alarms'], 'lunchBy' | 'clockOut'>;
  /** Settings → Timeclock → Overtime: time past the day is overtime, and can be approved. */
  overtimeApproval: boolean;
  /** This day's "Overtime approved" switch. */
  overtimeApproved: boolean;
  formatTime: (ms: number) => string;
}

/** A tile turns amber once its alarm's first (largest) warning is reached; 15 min with the alarm off. */
function warnFromSeconds(alarm: AlarmSettings): number {
  return alarm.enabled && alarm.leadMinutes.length ? Math.max(...alarm.leadMinutes) * 60 : 15 * 60;
}

/** The Lunch by, Worked and Clock out at tiles for a day's timeclock. */
export function timeclockTiles(tc: TimeclockResult, o: TileOptions): { lunch: TileView; worked: TileView; clockOut: TileView } {
  // With overtime off (exempt, salaried work) there's no approval, and time past the day is just later.
  const otOn = o.overtimeApproval && o.overtimeApproved;

  const lunch: TileView = { value: '—', sub: 'Clock in to see your deadline', tone: '' };
  if (tc.lunchBy != null) {
    const secs = (tc.lunchBy - o.now) / 1000;
    lunch.value = o.formatTime(tc.lunchBy);
    if (tc.lunchStatus === 'taken') {
      lunch.tone = 'tile--ok';
      lunch.sub = `Taken at ${o.formatTime(tc.lunchOut!)}`;
    } else if (tc.lunchStatus === 'not-needed') {
      lunch.sub = 'Not needed today';
    } else if (tc.state === 'done') {
      lunch.sub = 'Not taken';
    } else if (tc.lunchStatus === 'overdue') {
      lunch.tone = 'tile--danger';
      lunch.sub = `Overdue by ${formatDurationCeil(-secs)}`;
    } else {
      lunch.tone = secs <= warnFromSeconds(o.alarms.lunchBy) ? 'tile--warn' : '';
      lunch.sub = `In ${formatDurationCeil(secs)}`;
    }
  }

  const clockOut: TileView = { value: '—', sub: 'Clock in to see your end time', tone: '' };
  if (tc.clockOutAt != null) {
    const secs = (tc.clockOutAt - o.now) / 1000;
    clockOut.value = o.formatTime(tc.clockOutAt);
    if (tc.clockOutStatus === 'done') {
      clockOut.tone = 'tile--accent';
      clockOut.sub = 'Day complete';
    } else if (tc.clockOutStatus === 'over') {
      clockOut.tone = otOn || !o.overtimeApproval ? 'tile--accent' : 'tile--danger';
      clockOut.sub = o.overtimeApproval
        ? `Over by ${formatDurationCeil(tc.overSeconds)}${otOn ? ' · OT approved' : ''}`
        : `${formatDurationCeil(tc.overSeconds)} past your day`;
    } else {
      clockOut.tone = !otOn && secs <= warnFromSeconds(o.alarms.clockOut) ? 'tile--warn' : '';
      clockOut.sub = !o.isToday ? 'No clock-out recorded' : tc.state === 'working' ? `In ${formatDurationCeil(secs)}` : 'If you return now';
    }
  }

  const worked: TileView = {
    value: formatDuration(tc.workedSeconds),
    sub:
      tc.clockIn == null
        ? `${formatDuration(o.workMinutes * 60)} day`
        : tc.overSeconds > 0
          ? `${formatDuration(tc.overSeconds)} over target`
          : tc.state === 'done'
            ? `${formatDurationCeil(tc.remainingSeconds)} under target`
            : `${formatDurationCeil(tc.remainingSeconds)} to go`,
    // A past day left clocked in is judged at its end: nothing about it is live.
    tone: o.isToday && tc.clockIn != null && tc.state === 'working' ? 'tile--live' : '',
  };

  return { lunch, worked, clockOut };
}

/** The Focused tile: the day's logged focus time and how many sessions it took. */
export function focusTile(focus: { seconds: number; count: number }, isToday: boolean): TileView {
  return {
    value: formatDuration(focus.seconds),
    sub: focus.count > 0 ? `${focus.count} ${plural(focus.count, 'session')}` : isToday ? 'No sessions yet' : 'No sessions',
    tone: '',
  };
}
