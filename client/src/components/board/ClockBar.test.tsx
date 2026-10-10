// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atTime, MINUTE_MS } from '../../../../shared/dates.js';
import * as api from '../../api';
import { SettingsProvider } from '../../hooks/useSettings';
import { CHECK_PUNCHES } from '../../lib/copy';
import { formatTime } from '../../lib/format';
import { answered, makeDay, makeSettings, punchesAt, settle, T0, TODAY } from '../../test/hooks';
import type { Day } from '../../types';
import { ClockBar } from './ClockBar';

vi.mock('../../api');

const at = (h: number, m = 0) => atTime(TODAY, h, m);
const hhmm = (ms: number) => formatTime(ms, false);

/** Renders the bar at `now`, the minute Board hands it; the answer renders it again at another. */
async function renderBar(day: Day, now = T0) {
  const bar = (minute: number) => (
    <SettingsProvider>
      <ClockBar day={day} today={TODAY} now={minute} />
    </SettingsProvider>
  );
  const { rerender } = render(bar(now));
  await settle();
  return (minute: number) => rerender(bar(minute));
}

/** Each item as its label, value and line. */
const items = () => [...document.querySelectorAll('.clock-bar dl > div')].map((d) => [...d.children].map((c) => c.textContent));

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ timeFormat: '24h' })));
});

describe('ClockBar', () => {
  it("shows today's clock in, lunch deadline and clock out time with the time left", async () => {
    await renderBar(makeDay(TODAY, { punches: punchesAt(at(8)) }));
    expect(items()).toEqual([
      ['Clock In', hhmm(at(8))],
      ['Lunch By', hhmm(at(13)), 'In 4h 00m'],
      ['Clock Out At', hhmm(at(16, 30)), 'In 7h 30m'],
    ]);
  });

  it('moves the time left on with the minute it is handed', async () => {
    const again = await renderBar(makeDay(TODAY, { punches: punchesAt(at(8)) }));
    again(T0 + MINUTE_MS);
    expect(items()[2]).toEqual(['Clock Out At', hhmm(at(16, 30)), 'In 7h 29m']);
  });

  it("follows the day's own work length and its Overtime approved", async () => {
    // A 4 h day fits the lunch window: no Lunch by, and the day ends at 12:00.
    await renderBar(makeDay(TODAY, { punches: punchesAt(at(8)), workMinutes: 240, overtimeApproved: true }), at(12, 30));
    expect(items()).toEqual([
      ['Clock In', hhmm(at(8))],
      ['Clock Out At', hhmm(at(12)), 'Over by 30m · OT approved'],
    ]);
  });

  it('follows the Meal periods and Overtime settings', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ timeFormat: '24h', mealRules: false, overtimeApproval: false })));
    // A punched lunch still moves the clock out, with no Lunch by; time past the day isn't overtime.
    await renderBar(makeDay(TODAY, { punches: punchesAt(at(8), at(12), at(12, 30)) }), at(17));
    expect(items()).toEqual([
      ['Clock In', hhmm(at(8))],
      ['Clock Out At', hhmm(at(16, 30)), '30m past your day'],
    ]);
  });

  it('names its region Timeclock and holds no live region, timer or tab stop', async () => {
    await renderBar(makeDay());
    const region = screen.getByRole('region', { name: 'Timeclock' });
    expect(region.querySelector('[role="status"], [role="timer"], [aria-live], button, input, [tabindex]')).toBeNull();
    expect(items()).toEqual([
      ['Clock In', '—'],
      ['Clock Out At', '—', 'Clock in to see your end time'],
    ]);
  });

  it('reads Check punches for the clock out when the punches are out of order', async () => {
    // Lunch in typed as 11:00, before the 12:00 Lunch out.
    await renderBar(makeDay(TODAY, { punches: punchesAt(at(8), at(12), at(11)) }), at(13));
    expect(items()[0]).toEqual(['Clock In', hhmm(at(8))]);
    expect(items().at(-1)).toEqual(['Clock Out At', '—', CHECK_PUNCHES]);
  });
});
