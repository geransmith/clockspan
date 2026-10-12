import { TAB_TITLE } from './copy';
import { formatCountdown, formatDurationCeil } from './format';
import { timeclockTiles, type TileOptions } from './tiles';
import type { TimeclockResult } from './timeclock';

/**
 * The tab's title, about today whatever the page shows: the running session's count, else a
 * running break's, else while working today's lunch deadline until a Lunch out (even past the end
 * of the day, as the lunch alarm stays armed), then Clock Out At's time and, past it, the tile's
 * own line. Anything else (not clocked in, at lunch, out on a break, punches out of order, the day
 * done, today or the settings not loaded: `today` null) is the app's name. The times come from the
 * tiles, so they follow the time format and a Clock out typed ahead.
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
