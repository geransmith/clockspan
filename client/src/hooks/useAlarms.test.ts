// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alert, dismissByTag } from '../lib/alerts';
import { formatTime, resolveHour12 } from '../lib/format';
import { computeTimeclock, type TimeclockResult } from '../lib/timeclock';
import { MINUTE_MS } from '../../../shared/dates.js';
import { makeSettings, punchesAt, setVisibility, T0, TODAY } from '../test/hooks';
import type { Settings } from '../types';
import { useAlarms, type AlarmDayState } from './useAlarms';

vi.mock('../lib/alerts');

const settings = makeSettings();
const tcAt = (now: number, ...at: (number | null)[]) => computeTimeclock(punchesAt(...at), settings, now);

interface Props {
  date: string;
  tc: TimeclockResult | null;
  now: number;
  day: AlarmDayState;
  settings: Settings;
}
const NO_DAY: AlarmDayState = { overtimeApproved: false, retroDone: false, openRetro: vi.fn(), missedClockIn: null, clockInAt: vi.fn() };

function renderAlarms(props: Partial<Props> = {}) {
  const initialProps: Props = { date: TODAY, tc: null, now: T0, day: NO_DAY, settings, ...props };
  return renderHook((p: Props) => useAlarms(p.date, p.tc, p.settings, p.now, p.day), { initialProps });
}

const tags = () => vi.mocked(alert).mock.calls.map(([a]) => a.tag);

// Lunch is due 5 h after clock-in by default: clocked in 4 h 46 m ago, it is due in 14 min.
const lunchSoon = tcAt(T0, T0 - 286 * MINUTE_MS);
// Clocked in 8 h 35 m ago with a 30 min lunch: 5 min past the 8 h day.
const overDay = tcAt(T0, T0 - 515 * MINUTE_MS, T0 - 300 * MINUTE_MS, T0 - 270 * MINUTE_MS);

beforeEach(() => {
  localStorage.clear();
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
    expect(vi.mocked(alert).mock.calls[0]![0].title).toBe('Lunch in 14 min');
    rerender({ date: TODAY, tc: lunchSoon, now: T0 + 1000, day: NO_DAY, settings });
    expect(alert).toHaveBeenCalledTimes(1);

    const later = T0 + 10 * MINUTE_MS;
    rerender({ date: TODAY, tc: tcAt(later, T0 - 286 * MINUTE_MS), now: later, day: NO_DAY, settings });
    expect(alert).toHaveBeenCalledTimes(2);
    expect(vi.mocked(alert).mock.calls[1]![0].title).toBe('Lunch in 4 min');
  });

  it("remembers what fired across a reload, under today's date", () => {
    renderAlarms({ tc: lunchSoon }).unmount();
    expect(localStorage.getItem('focus:alarms')).toMatch(new RegExp(`^${TODAY} lunchBy:lead:15:\\d+$`));
    renderAlarms({ tc: lunchSoon });
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('starts a new fired set when the date changes', () => {
    const { rerender } = renderAlarms({ tc: lunchSoon });
    rerender({ date: '2026-09-29', tc: lunchSoon, now: T0, day: NO_DAY, settings });
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it('rings once for two tabs open on one device', () => {
    // Both tabs were opened before the warning, so each holds its own copy of what fired.
    const early = tcAt(T0 - 5 * MINUTE_MS, T0 - 286 * MINUTE_MS);
    const a = renderAlarms({ tc: early, now: T0 - 5 * MINUTE_MS });
    const b = renderAlarms({ tc: early, now: T0 - 5 * MINUTE_MS });
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
    expect(clockOut!.action).toEqual({ label: 'Overtime Approved', run: approveOvertime });
    expect(retro!.action).toEqual({ label: 'Open Retrospective', run: openRetro });
  });

  it('leaves Overtime Approved off a warning for a Clock out typed ahead', () => {
    const approveOvertime = vi.fn();
    // Lunch taken, the planned end 2 h 30 m away, and the Clock out typed for 10 min from now.
    const typed = tcAt(T0, T0 - 360 * MINUTE_MS, T0 - 200 * MINUTE_MS, T0 - 170 * MINUTE_MS, T0 + 10 * MINUTE_MS);
    renderAlarms({ tc: typed, day: { ...NO_DAY, approveOvertime } });
    const clockOut = vi.mocked(alert).mock.calls.find(([a]) => a.tag === 'alarm:clockOut')![0];
    expect(clockOut.title).toBe('Clock Out in 10 min');
    expect(clockOut.body).toBe(`You set your Clock out for ${formatTime(T0 + 10 * MINUTE_MS, resolveHour12(settings.timeFormat))}. Start wrapping up.`);
    expect(clockOut.action).toBeUndefined();
  });

  it('keeps Overtime Approved on a warning for the planned end when the typed Clock out is later', () => {
    const approveOvertime = vi.fn();
    // The planned end 15 min away, and the Clock out typed for an hour from now.
    const later = tcAt(T0, T0 - 495 * MINUTE_MS, T0 - 300 * MINUTE_MS, T0 - 270 * MINUTE_MS, T0 + 60 * MINUTE_MS);
    renderAlarms({ tc: later, day: { ...NO_DAY, approveOvertime } });
    const planned = vi.mocked(alert).mock.calls.find(([a]) => a.tag === 'alarm:clockOut')![0];
    expect(planned.title).toBe('Clock Out in 15 min');
    expect(planned.action).toEqual({ label: 'Overtime Approved', run: approveOvertime });
  });

  it('approving overtime while the clock-out banner is up clears that banner and no other', () => {
    const { rerender } = renderAlarms({ tc: overDay });
    expect(tags()).toEqual(['alarm:clockOut', 'alarm:retro']);
    vi.mocked(dismissByTag).mockClear();
    // Approved from the card's switch (the banner's own button closes its banner itself).
    rerender({ date: TODAY, tc: overDay, now: T0, day: { ...NO_DAY, overtimeApproved: true }, settings });
    // A clocked-in day takes "Not Clocked In" down on every judged tick.
    expect(vi.mocked(dismissByTag).mock.calls).toEqual([['clock-in'], ['alarm:clockOut']]);
  });

  it("takes the banners down when the clock-in is cleared or the day changes, and not while today's punches settle", () => {
    const { rerender } = renderAlarms({ tc: overDay });
    expect(tags()).toEqual(['alarm:clockOut', 'alarm:retro']);
    vi.mocked(dismissByTag).mockClear();
    // Punches still settling (the app hands over no timeclock): the banners stay.
    rerender({ date: TODAY, tc: null, now: T0, day: NO_DAY, settings });
    expect(dismissByTag).not.toHaveBeenCalled();
    rerender({ date: TODAY, tc: tcAt(T0), now: T0, day: NO_DAY, settings });
    expect(vi.mocked(dismissByTag).mock.calls.flat().sort()).toEqual(['alarm:clockOut', 'alarm:lunchBy', 'alarm:retro', 'alarm:secondMeal', 'clock-in']);

    // Past midnight, yesterday's banners (and their buttons) go with the day, before the new
    // day's punches have been judged.
    const next = renderAlarms({ tc: overDay });
    vi.mocked(dismissByTag).mockClear();
    next.rerender({ date: '2026-09-29', tc: null, now: T0, day: NO_DAY, settings });
    expect(vi.mocked(dismissByTag).mock.calls.flat().sort()).toEqual(['alarm:clockOut', 'alarm:lunchBy', 'alarm:retro', 'alarm:secondMeal', 'clock-in']);
  });

  it('a reviewed day disarms the retro alarm, and a moved target clears its banner', () => {
    const { rerender } = renderAlarms({ tc: overDay, day: { ...NO_DAY, retroDone: true } });
    expect(tags()).toEqual(['alarm:clockOut']);
    // The Clock out punch moved 10 min later: the clock-out banner is stale.
    const moved = { ...overDay, clockOutAt: overDay.clockOutAt! + 10 * MINUTE_MS };
    rerender({ date: TODAY, tc: moved, now: T0, day: { ...NO_DAY, retroDone: true }, settings });
    expect(dismissByTag).toHaveBeenCalledWith('alarm:clockOut');
  });
});

describe('missed clock-in', () => {
  // The first session started at 8:47, and no punch is set.
  const at = T0 - 13 * MINUTE_MS;
  const time = formatTime(at, resolveHour12(settings.timeFormat));
  const missed = (patch: Partial<AlarmDayState> = {}): AlarmDayState => ({ ...NO_DAY, missedClockIn: at, ...patch });
  const notClockedIn = tcAt(T0);
  const props = (patch: Partial<Props> = {}): Props => ({ date: TODAY, tc: notClockedIn, now: T0, day: missed(), settings, ...patch });
  const takenDown = () => vi.mocked(dismissByTag).mock.calls.filter(([tag]) => tag === 'clock-in').length;

  afterEach(() => setVisibility('visible'));

  it('raises one quiet banner whose button clocks in at the minute it names', () => {
    const clockInAt = vi.fn();
    renderAlarms({ tc: notClockedIn, day: missed({ clockInAt }) });
    expect(alert).toHaveBeenCalledTimes(1);
    const banner = vi.mocked(alert).mock.calls[0]![0];
    expect(banner).toEqual({
      kicker: 'Timeclock',
      title: 'Not Clocked In',
      body: `Today's alarms count from your clock-in. Your first session today started at ${time}.`,
      tone: 'info',
      sticky: true,
      tag: 'clock-in',
      action: { label: `Clock In at ${time}`, run: expect.any(Function) },
      sound: false,
      notifications: false,
    });
    banner.action!.run();
    expect(clockInAt).toHaveBeenCalledWith(at);
  });

  it('raises it once a day on this device: not on the next tick, for a new first start, after a reload or in a second tab', () => {
    const { rerender, unmount } = renderAlarms(props());
    rerender(props({ now: T0 + 1000 }));
    rerender(props({ day: missed({ missedClockIn: at - 5 * MINUTE_MS }) }));
    unmount();
    expect(localStorage.getItem('focus:alarms')).toBe(`${TODAY} clockIn:missing`);
    renderAlarms(props());
    expect(alert).toHaveBeenCalledTimes(1);

    // Two tabs opened before the first session: the second reads what the first stored.
    localStorage.clear();
    vi.mocked(alert).mockClear();
    const a = renderAlarms(props({ day: NO_DAY }));
    const b = renderAlarms(props({ day: NO_DAY }));
    a.rerender(props());
    b.rerender(props());
    expect(tags()).toEqual(['clock-in']);
  });

  it('waits for a tab that is shown, and records nothing while hidden', () => {
    setVisibility('hidden');
    const { rerender } = renderAlarms(props());
    rerender(props({ now: T0 + 1000 }));
    expect(alert).not.toHaveBeenCalled();
    expect(localStorage.getItem('focus:alarms')).toBeNull();

    setVisibility('visible');
    rerender(props({ now: T0 + 2000 }));
    expect(tags()).toEqual(['clock-in']);
    expect(localStorage.getItem('focus:alarms')).toBe(`${TODAY} clockIn:missing`);
  });

  it('takes the banner down in a hidden tab once nothing is left to offer', () => {
    const { rerender } = renderAlarms(props());
    setVisibility('hidden');
    vi.mocked(dismissByTag).mockClear();
    rerender(props({ day: missed({ missedClockIn: null }) }));
    expect(takenDown()).toBe(1);
  });

  it('waits while the day is not judged', () => {
    const { rerender } = renderAlarms(props({ day: NO_DAY }));
    vi.mocked(dismissByTag).mockClear();
    rerender(props({ tc: null }));
    expect(alert).not.toHaveBeenCalled();
    expect(dismissByTag).not.toHaveBeenCalled();
  });

  it('takes the banner down once clocked in, once nothing is left to offer, and on a new day, and not while the punches settle', () => {
    const { rerender } = renderAlarms(props());
    vi.mocked(dismissByTag).mockClear();
    rerender(props({ tc: null }));
    expect(takenDown()).toBe(0);
    rerender(props({ tc: tcAt(T0, at) }));
    expect(takenDown()).toBe(1);
    // The session was deleted.
    rerender(props({ day: missed({ missedClockIn: null }) }));
    expect(takenDown()).toBe(2);
    rerender(props({ date: '2026-09-29', tc: null }));
    expect(takenDown()).toBe(3);
  });
});
