// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert, dismissByTag, offerNotifications, unlockAudio, warnQuietly } from '../lib/alerts';
import { LOAD_FAILED } from '../lib/copy';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import {
  answered,
  deferred,
  deferredAnswer,
  echoPunches,
  makeBreak,
  makeDay,
  makeSession,
  makeSettings,
  punchesAt,
  setVisibility,
  settle,
  SettingsAndDays,
  T0,
  TODAY,
} from '../test/hooks';
import type { Day, Settings } from '../types';
import { useDayStore } from './useDay';
import { useTodayAlarms } from './useTodayAlarms';

vi.mock('../api');
vi.mock('../lib/alerts');

// Clocked in 8 h 35 m ago with a 30 min lunch: 5 min past an 8 h day.
const overDay = (patch: Partial<Day> = {}) =>
  makeDay(TODAY, { punches: punchesAt(T0 - 515 * MINUTE_MS, T0 - 300 * MINUTE_MS, T0 - 270 * MINUTE_MS), ...patch });

/** Lets the loads land, then waits out the three seconds the punches take to settle. */
async function judged(): Promise<void> {
  await settle();
  await settle(5_000);
}

const alerted = () => vi.mocked(alert).mock.calls.map(([a]) => a);
/** The break alarm's Start Break and whether a timer start is out, which Shell hands in. */
const TIMER = { startBreak: vi.fn(), timerStarting: false };
const tags = () => alerted().map((a) => a.tag);

function render(settings: Settings | Promise<Settings>, day: Day) {
  vi.mocked(api.getSettings).mockReturnValue(Promise.resolve(settings).then(answered));
  vi.mocked(api.getDay).mockResolvedValue(answered(day));
  return renderHook(() => ({ alarms: useTodayAlarms(TODAY, Date.now(), vi.fn(), true, TIMER), store: useDayStore() }), { wrapper: SettingsAndDays });
}

/** Another device, from scratch: the alarms already fired here are remembered in storage. */
function freshDevice() {
  cleanup();
  localStorage.clear();
  vi.mocked(alert).mockClear();
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  localStorage.clear();
});

describe('useTodayAlarms', () => {
  it("raises a banner for today's failed load only while the page doesn't show today, and takes it down once today loads", async () => {
    vi.mocked(api.getDay).mockRejectedValue(new Error('offline'));
    const { result, rerender } = renderHook(
      (p: { shown: boolean }) => ({ alarms: useTodayAlarms(TODAY, Date.now(), vi.fn(), p.shown, TIMER), store: useDayStore() }),
      {
        initialProps: { shown: true },
        wrapper: SettingsAndDays,
      },
    );
    await settle();
    // The sheet on today or the board says it in place.
    expect(warnQuietly).not.toHaveBeenCalled();
    const takenDown = () => vi.mocked(dismissByTag).mock.calls.filter(([tag]) => tag === 'load-failed').length;

    rerender({ shown: false });
    expect(warnQuietly).toHaveBeenCalledWith({ title: LOAD_FAILED.today, body: LOAD_FAILED.body, tag: 'load-failed' });
    rerender({ shown: true });
    expect(takenDown()).toBe(1);

    rerender({ shown: false });
    expect(warnQuietly).toHaveBeenCalledTimes(2);
    vi.mocked(api.getDay).mockResolvedValue(answered(overDay()));
    await act(() => result.current.store.refresh(TODAY));
    expect(takenDown()).toBe(2);
    expect(warnQuietly).toHaveBeenCalledTimes(2);
  });

  it('waits for the settings, and judges the day by them rather than the defaults', async () => {
    const settings = deferred<Settings>();
    render(settings.promise, overDay());
    // The day and its punches are in: 8 h 5 m worked, so an 8 h 20 m day has 15 min left, where
    // the defaults' 8 h would ring overdue now.
    await judged();
    expect(alert).not.toHaveBeenCalled();
    settings.resolve(makeSettings({ workMinutes: 500 }));
    await judged();
    expect(alerted().find((a) => a.tag === 'alarm:clockOut')?.title).toBe('Clock Out in 15 min');
  });

  it("goes by today's own work-day length", async () => {
    // A half day, clocked in 4 h 10 m ago: over by 10 min, where the usual 8 h is hours away.
    render(makeSettings(), makeDay(TODAY, { punches: punchesAt(T0 - 250 * MINUTE_MS), workMinutes: 240 }));
    await judged();
    expect(alerted().find((a) => a.tag === 'alarm:clockOut')?.title).toBe('Clock-Out Is 10 min Overdue');
  });

  it('keeps an approved day quiet only while Overtime is on, and offers the button only then', async () => {
    render(makeSettings(), overDay({ overtimeApproved: true }));
    await judged();
    expect(tags()).toEqual(['alarm:retro']);

    freshDevice();
    render(makeSettings({ overtimeApproval: false }), overDay({ overtimeApproved: true }));
    await judged();
    const clockOut = alerted().find((a) => a.tag === 'alarm:clockOut');
    expect(clockOut).toBeDefined();
    expect(clockOut!.actions!.map((a) => a.label)).toEqual(['Snooze 15 min']);

    freshDevice();
    render(makeSettings(), overDay());
    await judged();
    const action = alerted().find((a) => a.tag === 'alarm:clockOut')!.actions![0]!;
    expect(action.label).toBe('Overtime Approved');
    // The button approves today, where the switch on the card would.
    vi.mocked(api.putOvertime).mockResolvedValue(answered({ overtimeApproved: true }));
    await act(async () => action.run());
    expect(api.putOvertime).toHaveBeenCalledWith(TODAY, true);
  });

  it("snoozes the clock-out alarm on today's day from its banner, for 15 min from the press", async () => {
    render(makeSettings(), overDay());
    await judged();
    const snooze = alerted().find((a) => a.tag === 'alarm:clockOut')!.actions![1]!;
    expect(snooze.label).toBe('Snooze 15 min');
    const until = Date.now() + 15 * MINUTE_MS;
    vi.mocked(api.putSnooze).mockResolvedValue(answered({ snoozedUntil: { clockOut: until } }));
    await act(async () => snooze.run());
    expect(api.putSnooze).toHaveBeenCalledWith(TODAY, 'clockOut', until);
    expect(api.putOvertime).not.toHaveBeenCalled();
  });

  it("waits for a come-back's refresh rather than ring on a copy from before the tab was hidden", async () => {
    // Clocked in 4 h 50 m ago with no lunch: lunch is due in 10 min.
    const clockIn = T0 - 290 * MINUTE_MS;
    render(makeSettings(), makeDay(TODAY, { punches: punchesAt(clockIn) }));
    await judged();
    setVisibility('hidden');
    vi.setSystemTime(T0 + 30 * MINUTE_MS);
    vi.mocked(alert).mockClear();
    const refreshed = deferredAnswer<Day>();
    vi.mocked(api.getDay).mockReturnValue(refreshed.promise);
    // Back half an hour later, with lunch 20 min overdue on the copy this tab holds.
    setVisibility('visible');
    await settle();
    expect(tags()).not.toContain('alarm:lunchBy');
    // Lunch was taken on the phone meanwhile.
    refreshed.resolve(makeDay(TODAY, { punches: punchesAt(clockIn, T0) }));
    await judged();
    expect(tags()).not.toContain('alarm:lunchBy');
  });

  it('holds while a punch is being typed, and judges the punches three seconds after', async () => {
    vi.mocked(api.putPunches).mockImplementation(echoPunches);
    const { result } = render(makeSettings(), makeDay());
    await judged();
    act(() => result.current.alarms.setEditingPunches(true));
    await act(() => result.current.store.setPunches(TODAY, overDay().punches));
    await judged();
    expect(alert).not.toHaveBeenCalled();
    act(() => result.current.alarms.setEditingPunches(false));
    await settle(2_900);
    expect(alert).not.toHaveBeenCalled();
    await settle(200);
    expect(tags()).toContain('alarm:clockOut');
  });

  it('lets a hold go five minutes after the last change, though focus stays and a refresh brings the same times in a new list', async () => {
    vi.mocked(api.putPunches).mockImplementation(echoPunches);
    const { result } = render(makeSettings(), makeDay());
    await judged();
    act(() => result.current.alarms.setEditingPunches(true));
    // The server has the edit, and a note written on another device makes the next refresh a new
    // list with the same times.
    vi.mocked(api.getDay).mockResolvedValue(answered(overDay({ retroNote: 'From the phone' })));
    await act(() => result.current.store.setPunches(TODAY, overDay().punches));
    await settle(5 * MINUTE_MS - 1000);
    expect(vi.mocked(api.getDay).mock.calls.length).toBeGreaterThan(1);
    expect(tags()).not.toContain('alarm:clockOut');
    await settle(1000);
    expect(tags()).toContain('alarm:clockOut');
  });

  it('keeps judging while a field has focus and nothing was typed, though a refresh brings the same times in a new list', async () => {
    // Clocked in 8 h 29 m ago with a 30 min lunch: the day ends a minute from now.
    const day = makeDay(TODAY, { punches: punchesAt(T0 - 509 * MINUTE_MS, T0 - 300 * MINUTE_MS, T0 - 270 * MINUTE_MS) });
    const { result } = render(makeSettings(), day);
    await judged();
    act(() => result.current.alarms.setEditingPunches(true));
    vi.mocked(api.getDay).mockResolvedValue(answered({ ...day, retroNote: 'From the phone' }));
    vi.mocked(alert).mockClear();
    // The minute's refresh lands as the day ends, with a note from another device: the same times
    // in a new list.
    await settle(MINUTE_MS);
    expect(api.getDay).toHaveBeenCalledTimes(2);
    expect(alerted().find((a) => a.tag === 'alarm:clockOut')?.title).toBe('Time to Clock Out');
  });

  describe('break alarm', () => {
    const on = makeSettings({ alarms: { ...makeSettings().alarms, noBreak: { ...makeSettings().alarms.noBreak, enabled: true } } });
    // Clocked in 95 min ago.
    const working = (patch: Partial<Day> = {}) => makeDay(TODAY, { punches: punchesAt(T0 - 95 * MINUTE_MS), ...patch });

    it('rings 90 min after the clock-in with no break', async () => {
      render(on, working());
      await judged();
      expect(tags()).toContain('alarm:noBreak');
    });

    it("stays quiet after a break that ended 30 min ago, or while a session runs on today's sheet", async () => {
      render(on, working({ breaks: [makeBreak({ startedAt: T0 - 40 * MINUTE_MS, endedAt: T0 - 30 * MINUTE_MS })] }));
      await judged();
      expect(tags()).not.toContain('alarm:noBreak');
      freshDevice();
      render(on, working({ sessions: [makeSession({ startedAt: T0 - 20 * MINUTE_MS })] }));
      await judged();
      expect(tags()).not.toContain('alarm:noBreak');
    });

    it("waits through a meeting on today's day, typed or weekly, and rings once it ends", async () => {
      const { rerender } = render(on, working({ meetings: { call0000: { title: 'Call', startsAt: T0 - 10 * MINUTE_MS, endsAt: T0 + 2 * MINUTE_MS } } }));
      await judged();
      expect(tags()).not.toContain('alarm:noBreak');
      // Shell hands in the clock each second; here a render reads it.
      await settle(2 * MINUTE_MS);
      rerender();
      expect(tags()).toContain('alarm:noBreak');
      // TODAY, 2026-09-28, is a Monday; T0 is 9:00.
      freshDevice();
      const standup = { uid: 'stand000', title: 'Standup', weekdays: [1], start: 8 * 60 + 50, end: 9 * 60 + 15, since: '2026-09-01', until: null };
      render({ ...on, meetings: [standup] }, working());
      await judged();
      expect(tags()).not.toContain('alarm:noBreak');
    });
  });

  it('warns to take lunch before a meeting that covers the deadline, when lunch must start to be back for it', async () => {
    // Clocked in at 5:00, so lunch is due by 10:00; the call runs 9:30-10:30 and lunch is 30 min, so 9:00 is the time.
    const day = makeDay(TODAY, {
      punches: punchesAt(T0 - 4 * HOUR_MS),
      meetings: { call0000: { title: 'Call', startsAt: T0 + 30 * MINUTE_MS, endsAt: T0 + 90 * MINUTE_MS } },
    });
    render(makeSettings(), day);
    await judged();
    const lunch = alerted().find((a) => a.tag === 'alarm:lunchBy');
    expect([lunch?.title, lunch?.body]).toEqual([
      'Take Lunch Now',
      'Call runs 9:30 AM–10:30 AM, over your 10:00 AM lunch deadline. Lunch out now to be back for it.',
    ]);
  });

  describe('missed clock-in', () => {
    // A session started at 8:47:20 on a day with no punch.
    const loggedDay = () => makeDay(TODAY, { sessions: [makeSession({ startedAt: T0 - 13 * MINUTE_MS + 20_000 })] });
    const banner = () => alerted().find((a) => a.tag === 'clock-in');

    it('offers it once the day is judged, and its button fills Clock in at the floored minute', async () => {
      vi.mocked(api.putPunches).mockImplementation(echoPunches);
      render(makeSettings(), loggedDay());
      await judged();
      expect(banner()?.title).toBe('Not Clocked In');
      act(() => banner()!.actions![0]!.run());
      expect(unlockAudio).toHaveBeenCalledOnce();
      expect(offerNotifications).toHaveBeenCalledExactlyOnceWith(true);
      await settle();
      expect(api.putPunches).toHaveBeenCalledWith(TODAY, punchesAt(T0 - 13 * MINUTE_MS), punchesAt());
      const offered = vi.mocked(offerNotifications).mock.invocationCallOrder[0]!;
      expect(vi.mocked(unlockAudio).mock.invocationCallOrder[0]).toBeLessThan(offered);
      expect(offered).toBeLessThan(vi.mocked(api.putPunches).mock.invocationCallOrder[0]!);
    });

    it('sends nothing when a Clock in reached the page before the press', async () => {
      const { result } = render(makeSettings(), loggedDay());
      await judged();
      // The phone clocked in meanwhile, and a refresh brought it before the press.
      vi.mocked(api.getDay).mockResolvedValue(answered({ ...loggedDay(), punches: punchesAt(T0 - 20 * MINUTE_MS) }));
      await act(() => result.current.store.refresh(TODAY));
      act(() => banner()!.actions![0]!.run());
      await settle();
      expect(api.putPunches).not.toHaveBeenCalled();
    });
  });

  describe('Lunch In Now', () => {
    // Clocked in at 5:00, Lunch out at 8:30: the 30 min lunch ended at T0.
    const atLunch = (lunchIn: number | null = null) => makeDay(TODAY, { punches: punchesAt(T0 - 240 * MINUTE_MS, T0 - 30 * MINUTE_MS, lunchIn) });
    const banner = () => alerted().find((a) => a.tag === 'alarm:lunchEnd');

    it('fills Lunch in with the minute of the press, not the one the banner was raised at, and the banner goes', async () => {
      vi.mocked(api.putPunches).mockImplementation(echoPunches);
      render(makeSettings(), atLunch());
      await judged();
      const action = banner()!.actions![0]!;
      expect(action.label).toBe('Lunch In Now');
      // Pressed 7 min after the banner went up, short of the first repeat.
      vi.setSystemTime(T0 + 7 * MINUTE_MS);
      vi.mocked(dismissByTag).mockClear();
      await act(async () => action.run());
      expect(api.putPunches).toHaveBeenCalledExactlyOnceWith(TODAY, atLunch(T0 + 7 * MINUTE_MS).punches, atLunch().punches);
      expect(vi.mocked(unlockAudio).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.putPunches).mock.invocationCallOrder[0]!);
      await judged();
      expect(dismissByTag).toHaveBeenCalledWith('alarm:lunchEnd');
    });

    it("takes the banner down and sends nothing when another device's Lunch in reached the page first", async () => {
      render(makeSettings(), atLunch());
      await judged();
      const action = banner()!.actions![0]!;
      vi.mocked(dismissByTag).mockClear();
      setVisibility('hidden');
      vi.setSystemTime(T0 + MINUTE_MS);
      // Back a minute later: the phone punched Lunch in as lunch ended.
      vi.mocked(api.getDay).mockResolvedValue(answered(atLunch(T0)));
      setVisibility('visible');
      await judged();
      expect(dismissByTag).toHaveBeenCalledWith('alarm:lunchEnd');
      await act(async () => action.run());
      expect(api.putPunches).not.toHaveBeenCalled();
    });
  });
});
