// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alert, dismissByTag } from '../lib/alerts';
import { computeTimeclock, emptyPunches, type TimeclockResult } from '../lib/timeclock';
import { makeSettings, MIN, T0, TODAY } from '../test/hooks';
import type { Settings } from '../types';
import { useAlarms, type AlarmDayState } from './useAlarms';

vi.mock('../lib/alerts');

const settings = makeSettings();
const tcAt = (now: number, ...at: (number | null)[]) =>
  computeTimeclock(
    emptyPunches().map((p, i) => ({ ...p, at: at[i] ?? null })),
    settings,
    now,
  );

interface Props {
  date: string;
  tc: TimeclockResult | null;
  now: number;
  day: AlarmDayState;
  settings: Settings;
}
const NO_DAY: AlarmDayState = { overtimeApproved: false, retroDone: false, openRetro: vi.fn() };

function renderAlarms(props: Partial<Props> = {}) {
  const initialProps: Props = { date: TODAY, tc: null, now: T0, day: NO_DAY, settings, ...props };
  return renderHook((p: Props) => useAlarms(p.date, p.tc, p.settings, p.now, p.day), { initialProps });
}

const tags = () => vi.mocked(alert).mock.calls.map(([a]) => a.tag);

// Lunch is due 5 h after clock-in by default: clocked in 4 h 46 m ago, it is due in 14 min.
const lunchSoon = tcAt(T0, T0 - 286 * MIN);
// Clocked in 8 h 35 m ago with a 30 min lunch: 5 min past the 8 h day.
const overDay = tcAt(T0, T0 - 515 * MIN, T0 - 300 * MIN, T0 - 270 * MIN);

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('firing', () => {
  it('stays quiet before clock-in', () => {
    renderAlarms({ tc: null });
    renderAlarms({ tc: tcAt(T0) });
    expect(alert).not.toHaveBeenCalled();
  });

  it('raises the crossed warning once, sticky, with the event sound, and the next one when it comes', () => {
    const { rerender } = renderAlarms({ tc: lunchSoon });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: 'alarm:lunchBy',
        sticky: true,
        chime: settings.sounds.lead,
        sound: settings.sound,
        notifications: settings.notifications,
        action: undefined,
      }),
    );
    expect(vi.mocked(alert).mock.calls[0]![0].kicker).toMatch(/15 min/);
    rerender({ date: TODAY, tc: lunchSoon, now: T0 + 1000, day: NO_DAY, settings });
    expect(alert).toHaveBeenCalledTimes(1);

    const later = T0 + 10 * MIN;
    rerender({ date: TODAY, tc: tcAt(later, T0 - 286 * MIN), now: later, day: NO_DAY, settings });
    expect(alert).toHaveBeenCalledTimes(2);
    expect(vi.mocked(alert).mock.calls[1]![0].kicker).toMatch(/5 min/);
  });

  it('remembers what fired across a reload, and forgets other days', () => {
    localStorage.setItem('focus:alarms:2026-09-25', '["old"]');
    renderAlarms({ tc: lunchSoon }).unmount();
    expect(localStorage.getItem('focus:alarms:2026-09-25')).toBeNull();
    expect(JSON.parse(localStorage.getItem(`focus:alarms:${TODAY}`)!)).toHaveLength(1);
    renderAlarms({ tc: lunchSoon });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('ignores a stored value that is not a list of keys', () => {
    localStorage.setItem(`focus:alarms:${TODAY}`, '{"not":"a list"}');
    renderAlarms({ tc: lunchSoon }).unmount();
    expect(alert).toHaveBeenCalledTimes(1);
    localStorage.setItem(`focus:alarms:${TODAY}`, '[7, null]');
    renderAlarms({ tc: lunchSoon });
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('starts a new fired set when the date changes', () => {
    const { rerender } = renderAlarms({ tc: lunchSoon });
    rerender({ date: '2026-09-29', tc: lunchSoon, now: T0, day: NO_DAY, settings });
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('rings once for two tabs open on one device', () => {
    // Both tabs were opened before the warning, so each holds its own copy of what fired.
    const early = tcAt(T0 - 5 * MIN, T0 - 286 * MIN);
    const a = renderAlarms({ tc: early, now: T0 - 5 * MIN });
    const b = renderAlarms({ tc: early, now: T0 - 5 * MIN });
    expect(alert).not.toHaveBeenCalled();
    a.rerender({ date: TODAY, tc: lunchSoon, now: T0, day: NO_DAY, settings });
    b.rerender({ date: TODAY, tc: lunchSoon, now: T0, day: NO_DAY, settings });
    expect(tags()).toEqual(['alarm:lunchBy']);
  });
});

describe('clock-out and retro', () => {
  it('offers the banner buttons it was given', () => {
    const approveOvertime = vi.fn();
    const openRetro = vi.fn();
    renderAlarms({ tc: overDay, day: { ...NO_DAY, approveOvertime, openRetro } });
    expect(tags()).toEqual(['alarm:clockOut', 'alarm:retro']);
    const [clockOut, retro] = vi.mocked(alert).mock.calls.map(([a]) => a);
    expect(clockOut!.action).toEqual({ label: 'Overtime approved', run: approveOvertime });
    expect(retro!.action).toEqual({ label: 'Open retrospective', run: openRetro });
  });

  it('approving overtime while the clock-out banner is up clears that banner and no other', () => {
    const { rerender } = renderAlarms({ tc: overDay });
    expect(tags()).toEqual(['alarm:clockOut', 'alarm:retro']);
    vi.mocked(dismissByTag).mockClear();
    // Approved from the card's switch (the banner's own button closes its banner itself).
    rerender({ date: TODAY, tc: overDay, now: T0, day: { ...NO_DAY, overtimeApproved: true }, settings });
    expect(vi.mocked(dismissByTag).mock.calls).toEqual([['alarm:clockOut']]);
  });

  it("takes the banners down when the clock-in is cleared or the day changes, and not while today's punches settle", () => {
    const { rerender } = renderAlarms({ tc: overDay });
    expect(tags()).toEqual(['alarm:clockOut', 'alarm:retro']);
    vi.mocked(dismissByTag).mockClear();
    // Punches still settling (the app hands over no timeclock): the banners stay.
    rerender({ date: TODAY, tc: null, now: T0, day: NO_DAY, settings });
    expect(dismissByTag).not.toHaveBeenCalled();
    rerender({ date: TODAY, tc: tcAt(T0), now: T0, day: NO_DAY, settings });
    expect(vi.mocked(dismissByTag).mock.calls.flat().sort()).toEqual(['alarm:clockOut', 'alarm:lunchBy', 'alarm:retro', 'alarm:secondMeal']);

    // Past midnight, yesterday's banner (and its Overtime approved button) goes with the day.
    const next = renderAlarms({ tc: overDay });
    vi.mocked(dismissByTag).mockClear();
    next.rerender({ date: '2026-09-29', tc: overDay, now: T0, day: NO_DAY, settings });
    expect(dismissByTag).toHaveBeenCalledWith('alarm:clockOut');
  });

  it('a reviewed day disarms the retro alarm, and a moved target clears its banner', () => {
    const { rerender } = renderAlarms({ tc: overDay, day: { ...NO_DAY, retroDone: true } });
    expect(tags()).toEqual(['alarm:clockOut']);
    // The Clock out punch moved 10 min later: the clock-out banner is stale.
    const moved = { ...overDay, clockOutAt: overDay.clockOutAt! + 10 * MIN };
    rerender({ date: TODAY, tc: moved, now: T0, day: { ...NO_DAY, retroDone: true }, settings });
    expect(dismissByTag).toHaveBeenCalledWith('alarm:clockOut');
  });
});
