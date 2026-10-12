import { TAB_TITLE } from './copy';
import { formatCountdown, formatDurationCeil } from './format';
import { timeclockTiles, type TileOptions } from './tiles';
import type { TimeclockResult } from './timeclock';

/**
 * The tab's title, about today whatever the page shows. Lunch wins over Out until a Lunch out, even
 * past the end of the day, since the lunch alarm stays armed that long. The times come from the
 * tiles, so they follow the time format and a Clock out typed ahead. `today` is null until today
 * and the settings have loaded.
 */
export function tabTitle(
  session: { paused: boolean; countdownSeconds: number; name: string } | null,
  breakSeconds: number | null,
  today: { tc: TimeclockResult; options: TileOptions } | null,
): string {
  if (session) return TAB_TITLE.of(TAB_TITLE.session(formatCountdown(session.countdownSeconds), session.name, session.paused));
  if (breakSeconds != null) return TAB_TITLE.of(TAB_TITLE.break(formatCountdown(breakSeconds)));
  if (!today || today.tc.state !== 'working' || today.tc.outOfOrder) return TAB_TITLE.app;
  const { tc, options } = today;
  const { lunch, clockOut } = timeclockTiles(tc, options);
  if (tc.lunchStatus === 'upcoming') return TAB_TITLE.of(TAB_TITLE.lunch(lunch.value));
  if (tc.lunchStatus === 'overdue') return TAB_TITLE.of(TAB_TITLE.lunchOverdue(formatDurationCeil((options.now - tc.lunchBy!) / 1000)));
  return TAB_TITLE.of(tc.clockOutStatus === 'over' ? clockOut.sub : TAB_TITLE.out(clockOut.value));
}
