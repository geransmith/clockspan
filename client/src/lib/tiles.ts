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
  /** This day's "Overtime approved" switch as it counts (`overtimeOn`): set, and the Overtime setting on. */
  overtimeApproved: boolean;
  formatTime: (ms: number) => string;
}

/** A tile turns amber once its alarm's first (largest) warning is reached; 15 min when the alarm is off or has no warnings. */
function warnFromSeconds(alarm: AlarmSettings): number {
  return alarm.enabled && alarm.leadMinutes.length ? Math.max(...alarm.leadMinutes) * 60 : 15 * 60;
}

/** The Lunch by, Worked and Clock out at tiles for a day's timeclock. */
export function timeclockTiles(tc: TimeclockResult, o: TileOptions): { lunch: TileView; worked: TileView; clockOut: TileView } {
  const lunch: TileView = { value: '—', sub: 'Clock in to see your deadline', tone: '' };
  if (tc.lunchBy != null) {
    const secs = (tc.lunchBy - o.now) / 1000;
    lunch.value = o.formatTime(tc.lunchBy);
    if (tc.lunchStatus === 'taken') {
      lunch.tone = 'tile--ok';
      lunch.sub = `Taken at ${o.formatTime(tc.lunchOut!)}`;
    } else if (tc.lunchStatus === 'not-needed') {
      lunch.sub = 'Not needed today';
    } else if (tc.state === 'done' || !o.isToday) {
      // A past day is judged at its end: a lunch not punched by then wasn't taken.
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
  if (!o.isToday && tc.state === 'working') {
    // A past day is judged at its end, so one still working there was never clocked out.
    clockOut.sub = 'No clock-out recorded';
    clockOut.tone = 'tile--warn';
  } else if (tc.clockOutAt != null) {
    const secs = (tc.clockOutAt - o.now) / 1000;
    clockOut.value = o.formatTime(tc.clockOutAt);
    if (tc.clockOutStatus === 'done') {
      clockOut.tone = 'tile--accent';
      clockOut.sub = 'Day complete';
    } else if (tc.clockOutStatus === 'over') {
      // With overtime off (exempt, salaried work) there's no approval, and time past the day is just later.
      clockOut.tone = o.overtimeApproved || !o.overtimeApproval ? 'tile--accent' : 'tile--danger';
      clockOut.sub = o.overtimeApproval
        ? `Over by ${formatDurationCeil(tc.overSeconds)}${o.overtimeApproved ? ' · OT approved' : ''}`
        : `${formatDurationCeil(tc.overSeconds)} past your day`;
    } else {
      clockOut.tone = !o.overtimeApproved && secs <= warnFromSeconds(o.alarms.clockOut) ? 'tile--warn' : '';
      clockOut.sub = tc.state === 'working' ? `In ${formatDurationCeil(secs)}` : 'If you return now';
    }
  }

  const worked: TileView = {
    value: formatDuration(tc.workedSeconds),
    // Punches are whole minutes, so a day can end exactly on target; and under a minute past
    // it, "over" would read "0m over target".
    sub:
      tc.clockIn == null
        ? `${formatDuration(o.workMinutes * 60)} day`
        : tc.overSeconds >= 60
          ? `${formatDuration(tc.overSeconds)} over target`
          : tc.remainingSeconds === 0
            ? 'On target'
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
