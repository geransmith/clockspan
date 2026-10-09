import { useSettings } from '../../hooks/useSettings';
import { useTimeFormat } from '../../hooks/useTimeFormat';
import { CARD_TITLES } from '../../lib/layout';
import { clockBarItems, type ClockBarItem } from '../../lib/tiles';
import { dayTimeclock, overtimeOn } from '../../lib/timeclock';
import type { Day } from '../../types';

const LABELS: Record<ClockBarItem['id'], string> = { clockIn: 'Clock in', lunch: 'Lunch by', clockOut: 'Clock out at' };

/**
 * Today's times in a row above the board's columns, read only, worded as the timeclock's tiles.
 * `now` is Board's minute, the one the sheet gets, so the two agree. No live region: the minute
 * turning isn't announced.
 */
export function ClockBar({ day, today, now }: { day: Day; today: string; now: number }) {
  const { settings } = useSettings();
  const { formatTime } = useTimeFormat();
  const items = clockBarItems(dayTimeclock(day, settings, today, now), {
    now,
    isToday: true,
    alarms: settings.alarms,
    overtimeApproval: settings.overtimeApproval,
    overtimeApproved: overtimeOn(settings, day.overtimeApproved),
    formatTime,
    mealRules: settings.mealRules,
  });
  return (
    <section className="clock-bar" aria-label={CARD_TITLES.timeclock}>
      <dl>
        {items.map(({ id, value, sub, tone }) => (
          <div key={id} className={tone || undefined}>
            <dt>{LABELS[id]}</dt>
            <dd className="clock-bar-value">{value}</dd>
            {sub && <dd className="clock-bar-line">{sub}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
