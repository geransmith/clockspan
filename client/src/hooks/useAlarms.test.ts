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
const NO_DAY: AlarmDayState = {
  overtimeApproved: false,
  retroDone: false,
  breaks: [],
  timerRunning: false,
  openRetro: vi.fn(),
  missedClockIn: null,
  clockInAt: vi.fn(),
  lunchInNow: vi.fn(),
  startBreak: vi.fn(),
  timerStarting: false,
  snoozedUntil: {},
  snooze: vi.fn(),
  inMeeting: false,
  lunchClash: null,
};
const SNOOZE = { label: 'Snooze 15 min', run: expect.any(Function) as () => void };

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
        actions: undefined,
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

describe('lunch end', () => {
  // Clocked in at 5:00, Lunch out at 8:30: the 30 min lunch ends at T0.
  const lunchAt = (now: number) => tcAt(now, T0 - 240 * MINUTE_MS, T0 - 30 * MINUTE_MS);

  it('rings when lunch is over, with Lunch In Now and Snooze, and replaces that banner with each repeat, which has Snooze alone', () => {
    const lunchInNow = vi.fn();
    const day = { ...NO_DAY, lunchInNow };
    const { rerender } = renderAlarms({ tc: lunchAt(T0), day });
    expect(tags()).toEqual(['alarm:lunchEnd']);
    expect(vi.mocked(alert).mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        title: 'Lunch Is Over',
        tone: 'warn',
        chime: settings.sounds.due,
        actions: [{ label: 'Lunch In Now', run: lunchInNow }, SNOOZE],
      }),
    );
    const later = T0 + 15 * MINUTE_MS;
    rerender({ date: TODAY, tc: lunchAt(later), now: later, day, settings });
    expect(tags()).toEqual(['alarm:lunchEnd', 'alarm:lunchEnd']);
    expect(vi.mocked(alert).mock.calls[1]![0]).toEqual(
      expect.objectContaining({ title: 'Lunch Ended 15 min Ago', tone: 'warn', chime: settings.sounds.overdue, actions: [SNOOZE] }),
    );
  });

  it('leaves Lunch In Now off a warning, which only a hand-made PUT gives it', () => {
    const leads = makeSettings({ alarms: { ...settings.alarms, lunchEnd: { ...settings.alarms.lunchEnd, leadMinutes: [5] } } });
    const before = T0 - 5 * MINUTE_MS;
    renderAlarms({ tc: lunchAt(before), now: before, settings: leads });
    expect(vi.mocked(alert).mock.calls[0]![0]).toEqual(expect.objectContaining({ tag: 'alarm:lunchEnd', title: 'Lunch Ends in 5 min', actions: undefined }));
  });
});

describe('clock-out and retro', () => {
  it('offers the banner buttons it was given', () => {
    const approveOvertime = vi.fn();
    const openRetro = vi.fn();
    renderAlarms({ tc: overDay, day: { ...NO_DAY, approveOvertime, openRetro } });
    expect(tags()).toEqual(['alarm:clockOut', 'alarm:retro']);
    const [clockOut, retro] = vi.mocked(alert).mock.calls.map(([a]) => a);
    expect(clockOut!.actions).toEqual([{ label: 'Overtime Approved', run: approveOvertime }, SNOOZE]);
    expect(retro!.actions).toEqual([{ label: 'Open Retrospective', run: openRetro }]);
  });

  it('leaves Overtime Approved off a warning for a Clock out typed ahead', () => {
    const approveOvertime = vi.fn();
    // Lunch taken, the planned end 2 h 30 m away, and the Clock out typed for 10 min from now.
    const typed = tcAt(T0, T0 - 360 * MINUTE_MS, T0 - 200 * MINUTE_MS, T0 - 170 * MINUTE_MS, T0 + 10 * MINUTE_MS);
    renderAlarms({ tc: typed, day: { ...NO_DAY, approveOvertime } });
    const clockOut = vi.mocked(alert).mock.calls.find(([a]) => a.tag === 'alarm:clockOut')![0];
    expect(clockOut.title).toBe('Clock Out in 10 min');
    expect(clockOut.body).toBe(`You set your Clock out for ${formatTime(T0 + 10 * MINUTE_MS, resolveHour12(settings.timeFormat))}. Start wrapping up.`);
    expect(clockOut.actions).toBeUndefined();
  });

  it('keeps Overtime Approved on a warning for the planned end when the typed Clock out is later', () => {
    const approveOvertime = vi.fn();
    // The planned end 15 min away, and the Clock out typed for an hour from now.
    const later = tcAt(T0, T0 - 495 * MINUTE_MS, T0 - 300 * MINUTE_MS, T0 - 270 * MINUTE_MS, T0 + 60 * MINUTE_MS);
    renderAlarms({ tc: later, day: { ...NO_DAY, approveOvertime } });
    const planned = vi.mocked(alert).mock.calls.find(([a]) => a.tag === 'alarm:clockOut')![0];
    expect(planned.title).toBe('Clock Out in 15 min');
    expect(planned.actions).toEqual([{ label: 'Overtime Approved', run: approveOvertime }]);
  });

  it("approving overtime while the clock-out banner is up clears that banner, and lifts the break alarm's hold", () => {
    const { rerender } = renderAlarms({ tc: overDay });
    expect(tags()).toEqual(['alarm:clockOut', 'alarm:retro']);
    vi.mocked(dismissByTag).mockClear();
    // Approved from the card's switch (the banner's own button closes its banner itself).
    rerender({ date: TODAY, tc: overDay, now: T0, day: { ...NO_DAY, overtimeApproved: true }, settings });
    // A clocked-in day takes "Not Clocked In" down on every judged tick.
    expect(vi.mocked(dismissByTag).mock.calls).toEqual([['clock-in'], ['alarm:clockOut'], ['alarm:noBreak']]);
  });

  it("takes the banners down when the clock-in is cleared or the day changes, and not while today's punches settle", () => {
    const { rerender } = renderAlarms({ tc: overDay });
    expect(tags()).toEqual(['alarm:clockOut', 'alarm:retro']);
    vi.mocked(dismissByTag).mockClear();
    // Punches still settling (the app hands over no timeclock): the banners stay.
    rerender({ date: TODAY, tc: null, now: T0, day: NO_DAY, settings });
    expect(dismissByTag).not.toHaveBeenCalled();
    rerender({ date: TODAY, tc: tcAt(T0), now: T0, day: NO_DAY, settings });
    expect(vi.mocked(dismissByTag).mock.calls.flat().sort()).toEqual([
      'alarm:clockOut',
      'alarm:lunchBy',
      'alarm:lunchEnd',
      'alarm:noBreak',
      'alarm:retro',
      'alarm:secondMeal',
      'clock-in',
    ]);

    // Past midnight, yesterday's banners (and their buttons) go with the day, before the new
    // day's punches have been judged.
    const next = renderAlarms({ tc: overDay });
    vi.mocked(dismissByTag).mockClear();
    next.rerender({ date: '2026-09-29', tc: null, now: T0, day: NO_DAY, settings });
    expect(vi.mocked(dismissByTag).mock.calls.flat().sort()).toEqual([
      'alarm:clockOut',
      'alarm:lunchBy',
      'alarm:lunchEnd',
      'alarm:noBreak',
      'alarm:retro',
      'alarm:secondMeal',
      'clock-in',
    ]);
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

describe('break alarm', () => {
  const on = makeSettings({ alarms: { ...settings.alarms, noBreak: { ...settings.alarms.noBreak, enabled: true } } });
  // Clocked in 95 min ago with no break: due 5 min ago.
  const due = tcAt(T0, T0 - 95 * MINUTE_MS);
  const props = (day: Partial<AlarmDayState> = {}, tc = due): Props => ({ date: TODAY, tc, now: T0, day: { ...NO_DAY, ...day }, settings: on });
  const banner = () => vi.mocked(alert).mock.calls.find(([a]) => a.tag === 'alarm:noBreak')![0];

  it('chimes the warning sound when due and on the hourly repeat', () => {
    const { rerender } = renderAlarms(props());
    expect(banner()).toMatchObject({ title: '1h 35m Without a Break', chime: on.sounds.lead, sticky: true });
    vi.mocked(alert).mockClear();
    // An hour on, with the same clock-in: the 60-min repeat.
    const later = T0 + 60 * MINUTE_MS;
    rerender({ ...props({}, tcAt(later, T0 - 95 * MINUTE_MS)), now: later });
    expect(banner()).toMatchObject({ title: '2h 35m Without a Break', chime: on.sounds.lead });
  });

  it('offers Start Break for the break length, which does nothing once a timer start is out, then Snooze', () => {
    const startBreak = vi.fn();
    const { rerender } = renderAlarms(props({ startBreak }));
    const [start, snooze] = banner().actions!;
    expect([start!.label, snooze!.label]).toEqual(['Start Break · 5 min', 'Snooze 15 min']);
    start!.run();
    expect(startBreak).toHaveBeenCalledExactlyOnceWith(5);
    rerender(props({ startBreak, timerStarting: true }));
    start!.run();
    expect(startBreak).toHaveBeenCalledOnce();
  });

  it('takes its banner down once a session runs', () => {
    const { rerender } = renderAlarms(props());
    vi.mocked(dismissByTag).mockClear();
    rerender(props({ timerRunning: true }));
    expect(dismissByTag).toHaveBeenCalledWith('alarm:noBreak');
  });
});

describe('snooze', () => {
  const hour12 = resolveHour12(settings.timeFormat);
  const at = (ms: number) => formatTime(ms, hour12);
  // Clocked in at 0:50 with no lunch: lunch was due at 5:50, and the 8 h day ended at 8:50.
  const both = (now: number) => tcAt(now, T0 - 490 * MINUTE_MS);
  const props = (now: number, day: Partial<AlarmDayState> = {}, s = settings, tc = both(now)): Props => ({
    date: TODAY,
    tc,
    now,
    day: { ...NO_DAY, ...day },
    settings: s,
  });
  const raised = (tag: string) =>
    vi
      .mocked(alert)
      .mock.calls.filter(([a]) => a.tag === tag)
      .map(([a]) => a);
  const quiet = (kicker: string, until: number, line: string) => ({
    kicker,
    title: `Snoozed Until ${at(until)}`,
    body: `${line} It rings again at ${at(until)}.`,
    tone: 'info',
    sticky: true,
    tag: kicker === 'Lunch alarm' ? 'alarm:lunchBy' : 'alarm:clockOut',
    sound: false,
    notifications: false,
  });
  const pressedAt = (ms: number) => ms + 15 * MINUTE_MS;

  it('offers Snooze after the deadline on a repeating alarm only, its own button first', () => {
    const snooze = vi.fn();
    renderAlarms(props(T0, { snooze }));
    // With the Overtime approval setting off (no `approveOvertime`), clock-out has Snooze alone, as lunch has.
    expect(raised('alarm:clockOut')[0]!.actions).toEqual([SNOOZE]);
    const lunch = raised('alarm:lunchBy')[0]!.actions!;
    expect(lunch).toEqual([SNOOZE]);
    lunch[0]!.run();
    expect(snooze).toHaveBeenCalledExactlyOnceWith('lunchBy');

    // A lunch warning seen after the deadline, with When reached off, still carries it.
    vi.mocked(alert).mockClear();
    localStorage.clear();
    const noDue = makeSettings({ alarms: { ...settings.alarms, lunchBy: { ...settings.alarms.lunchBy, onDue: false, overdueEveryMinutes: 60 } } });
    const late = tcAt(T0, T0 - 301 * MINUTE_MS);
    renderAlarms(props(T0, {}, noDue, late));
    expect(raised('alarm:lunchBy')[0]).toMatchObject({ title: 'Take Lunch Now', actions: [SNOOZE] });

    // The second meal's due banner; none with its Repeat off.
    vi.mocked(alert).mockClear();
    localStorage.clear();
    // 10 h worked by now, lunch taken.
    const meal = tcAt(T0, T0 - 630 * MINUTE_MS, T0 - 330 * MINUTE_MS, T0 - 300 * MINUTE_MS);
    renderAlarms(props(T0, {}, settings, meal));
    expect(raised('alarm:secondMeal')[0]).toMatchObject({ title: 'Take Your Second Meal Period', actions: [SNOOZE] });
    vi.mocked(alert).mockClear();
    localStorage.clear();
    const once = makeSettings({ alarms: { ...settings.alarms, secondMeal: { ...settings.alarms.secondMeal, overdueEveryMinutes: 0 } } });
    renderAlarms(props(T0, {}, once, meal));
    expect(raised('alarm:secondMeal')[0]!.actions).toBeUndefined();
  });

  it("swaps a snoozed alarm's banner for a quiet one, once per tab, and leaves another alarm ringing", () => {
    const { rerender } = renderAlarms(props(T0));
    expect(raised('alarm:lunchBy')).toHaveLength(1);
    vi.mocked(alert).mockClear();
    // Snoozed on another device, a minute later.
    const until = pressedAt(T0 + MINUTE_MS);
    const snoozed = { snoozedUntil: { lunchBy: until } };
    rerender(props(T0 + MINUTE_MS, snoozed));
    expect(vi.mocked(alert).mock.calls.map(([a]) => a)).toEqual([quiet('Lunch alarm', until, 'Lunch is 3h 11m overdue.')]);
    rerender(props(T0 + MINUTE_MS + 1000, snoozed));
    expect(alert).toHaveBeenCalledTimes(1);

    // Clock-out, due at 8:50, repeats at 9:05; lunch, due at 5:50, would have too.
    rerender(props(T0 + 5 * MINUTE_MS, snoozed));
    expect(tags()).toEqual(['alarm:lunchBy', 'alarm:clockOut']);
    expect(raised('alarm:clockOut')[0]).toMatchObject({ title: 'Clock-Out Is 15 min Overdue', chime: settings.sounds.overdue });

    // A reload, or another tab: the quiet banner again, with no chime.
    vi.mocked(alert).mockClear();
    renderAlarms(props(T0 + 6 * MINUTE_MS, snoozed));
    expect(vi.mocked(alert).mock.calls.map(([a]) => a)).toEqual([quiet('Lunch alarm', until, 'Lunch is 3h 16m overdue.')]);
  });

  it('rings once at the snooze time with the overdue sound, and a second press raises the quiet banner again', () => {
    const until = pressedAt(T0);
    const snoozed = { snoozedUntil: { lunchBy: until } };
    const { rerender } = renderAlarms(props(T0, snoozed));
    expect(raised('alarm:lunchBy')).toEqual([quiet('Lunch alarm', until, 'Lunch is 3h 10m overdue.')]);
    vi.mocked(alert).mockClear();
    for (const m of [5, 10, 14]) rerender(props(T0 + m * MINUTE_MS, snoozed));
    expect(raised('alarm:lunchBy')).toEqual([]);
    rerender(props(until, snoozed));
    expect(raised('alarm:lunchBy')).toEqual([
      expect.objectContaining({ title: 'Lunch Is 3h 25m Overdue', chime: settings.sounds.overdue, sound: settings.sound, actions: [SNOOZE] }),
    ]);

    // Pressed on that ring's banner, which Banners closed itself.
    vi.mocked(alert).mockClear();
    const again = pressedAt(until + 2 * MINUTE_MS);
    rerender(props(until + 2 * MINUTE_MS, { snoozedUntil: { lunchBy: again } }));
    expect(raised('alarm:lunchBy')).toEqual([quiet('Lunch alarm', again, 'Lunch is 3h 27m overdue.')]);
  });

  it('gives two alarms their own quiet banners and times, and a new time raises only its own again', () => {
    const lunchUntil = pressedAt(T0);
    const clockUntil = pressedAt(T0 + 2 * MINUTE_MS);
    const { rerender } = renderAlarms(props(T0 + 2 * MINUTE_MS, { snoozedUntil: { lunchBy: lunchUntil, clockOut: clockUntil } }));
    expect(raised('alarm:lunchBy')).toEqual([quiet('Lunch alarm', lunchUntil, 'Lunch is 3h 12m overdue.')]);
    expect(raised('alarm:clockOut')).toEqual([quiet('Clock-out alarm', clockUntil, 'Clock-out is 12 min overdue.')]);
    vi.mocked(alert).mockClear();
    const later = pressedAt(T0 + 3 * MINUTE_MS);
    rerender(props(T0 + 3 * MINUTE_MS, { snoozedUntil: { lunchBy: lunchUntil, clockOut: later } }));
    expect(tags()).toEqual(['alarm:clockOut']);
    expect(raised('alarm:clockOut')[0]!.title).toBe(`Snoozed Until ${at(later)}`);
  });

  it('raises the quiet banner again for a covered deadline that moves, or disarms and re-arms', () => {
    const until = pressedAt(T0);
    const snoozed = { snoozedUntil: { lunchBy: until } };
    const { rerender } = renderAlarms(props(T0, snoozed));
    vi.mocked(alert).mockClear();
    // The Clock in typed a minute earlier: lunch was due a minute earlier, still before the press.
    rerender(props(T0, snoozed, settings, tcAt(T0, T0 - 491 * MINUTE_MS)));
    expect(raised('alarm:lunchBy')).toEqual([quiet('Lunch alarm', until, 'Lunch is 3h 11m overdue.')]);

    // Lunch out punched, then taken back off.
    vi.mocked(alert).mockClear();
    rerender(props(T0, snoozed, settings, tcAt(T0, T0 - 490 * MINUTE_MS, T0 - MINUTE_MS)));
    expect(raised('alarm:lunchBy')).toEqual([]);
    rerender(props(T0, snoozed));
    expect(raised('alarm:lunchBy')).toEqual([quiet('Lunch alarm', until, 'Lunch is 3h 10m overdue.')]);
  });

  it('takes the quiet banner down when the snooze goes before its time, or Repeat is turned off', () => {
    const until = pressedAt(T0);
    const snoozed = { snoozedUntil: { lunchBy: until } };
    const { rerender } = renderAlarms(props(T0, snoozed));
    vi.mocked(dismissByTag).mockClear();
    // The save failed, and the server's copy has no snooze.
    rerender(props(T0 + MINUTE_MS));
    expect(vi.mocked(dismissByTag).mock.calls).toEqual([['clock-in'], ['alarm:lunchBy']]);

    rerender(props(T0 + 2 * MINUTE_MS, snoozed));
    vi.mocked(dismissByTag).mockClear();
    const off = makeSettings({ alarms: { ...settings.alarms, lunchBy: { ...settings.alarms.lunchBy, overdueEveryMinutes: 0 } } });
    rerender(props(T0 + 3 * MINUTE_MS, snoozed, off));
    expect(vi.mocked(dismissByTag).mock.calls).toEqual([['clock-in'], ['alarm:lunchBy']]);
  });

  it('takes the quiet banner down when its time passes in a meeting, and the ring comes once the meeting ends', () => {
    // Rung first, as a Snooze is pressed on a ring's banner.
    const { rerender } = renderAlarms(props(T0));
    const until = pressedAt(T0);
    const snoozed = { snoozedUntil: { lunchBy: until } };
    rerender(props(T0, snoozed));
    vi.mocked(dismissByTag).mockClear();
    vi.mocked(alert).mockClear();
    rerender(props(until, { ...snoozed, inMeeting: true }));
    expect(vi.mocked(dismissByTag).mock.calls).toEqual([['clock-in'], ['alarm:lunchBy']]);
    expect(raised('alarm:lunchBy')).toEqual([]);
    rerender(props(until + 20 * MINUTE_MS, snoozed));
    expect(raised('alarm:lunchBy')).toEqual([expect.objectContaining({ title: 'Lunch Is 3h 45m Overdue' })]);
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
      actions: [{ label: `Clock In at ${time}`, run: expect.any(Function) }],
      sound: false,
      notifications: false,
    });
    banner.actions![0]!.run();
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

  it('waits for a tab that is shown, records nothing while hidden, and still comes down there', () => {
    setVisibility('hidden');
    const { rerender } = renderAlarms(props());
    expect(alert).not.toHaveBeenCalled();
    expect(localStorage.getItem('focus:alarms')).toBeNull();

    setVisibility('visible');
    rerender(props({ now: T0 + 1000 }));
    expect(tags()).toEqual(['clock-in']);
    expect(localStorage.getItem('focus:alarms')).toBe(`${TODAY} clockIn:missing`);

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
