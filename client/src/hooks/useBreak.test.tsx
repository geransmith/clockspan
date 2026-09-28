// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert, dismissByTag, unlockAudio, type AlertOptions } from '../lib/alerts';
import { BREAK_SUGGESTION } from '../lib/copy';
import { AllProviders, deferred, makeBreak, makeDay, makeSession, makeSettings, MIN, settle, T0, TODAY } from '../test/hooks';
import type { Day, Session } from '../types';
import { useBreak } from './useBreak';
import { useDay } from './useDay';
import { useTimer } from './useTimer';

vi.mock('../api');
vi.mock('../lib/alerts');

const settings = makeSettings({ breakMinutes: 5 });
const render = () => renderHook(() => ({ ...useBreak(), timer: useTimer(), day: useDay(TODAY).day }), { wrapper: AllProviders });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  localStorage.clear();
  vi.mocked(api.getSettings).mockResolvedValue(settings);
  vi.mocked(api.getRunning).mockResolvedValue({ session: null });
  vi.mocked(api.getDay).mockResolvedValue(makeDay());
  // The server starts a break now and ends one early now.
  vi.mocked(api.startBreak).mockImplementation((date, plannedSeconds) =>
    Promise.resolve({ break: makeBreak({ id: 5, date, plannedSeconds, startedAt: Date.now(), endedAt: Date.now() + plannedSeconds * 1000 }) }),
  );
  vi.mocked(api.endBreak).mockImplementation((id) => Promise.resolve({ break: makeBreak({ id, startedAt: T0, endedAt: Date.now() }) }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("starts a break on today's sheet, counts it down and announces its end once, with the Break over sound", async () => {
  const { result } = render();
  await settle();
  expect(result.current.endsAt).toBeNull();
  act(() => result.current.start(5));
  expect(dismissByTag).toHaveBeenCalledWith('break');
  await settle();
  expect(api.startBreak).toHaveBeenCalledWith(TODAY, 300);
  expect(result.current.day?.breaks.map((b) => b.id)).toEqual([5]);
  expect(result.current.endsAt).toBe(T0 + 5 * MIN);
  expect(result.current.remainingSeconds).toBe(300);
  await settle(2 * MIN);
  expect(result.current.remainingSeconds).toBe(180);
  expect(alert).not.toHaveBeenCalled();
  await settle(3 * MIN);
  expect(result.current.endsAt).toBeNull();
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledWith(
    expect.objectContaining({ tag: 'break', chime: settings.sounds.breakDone, sound: settings.sound, notifications: settings.notifications }),
  );
  await settle(MIN);
  expect(alert).toHaveBeenCalledTimes(1);
});

it('starts one break for a second tap while the first is out', async () => {
  const { result } = render();
  await settle();
  act(() => result.current.start(5));
  act(() => result.current.start(5));
  await settle();
  expect(api.startBreak).toHaveBeenCalledTimes(1);
  act(() => result.current.start(10));
  await settle();
  expect(api.startBreak).toHaveBeenCalledTimes(2);
});

it('follows a break from the server across a reload, and a reload after the end does not announce it again', async () => {
  vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [makeBreak({ startedAt: T0 - MIN, endedAt: T0 + 4 * MIN })] }));
  const first = render();
  await settle();
  expect(first.result.current.endsAt).toBe(T0 + 4 * MIN);
  first.unmount();
  const second = render();
  await settle();
  expect(second.result.current.endsAt).toBe(T0 + 4 * MIN);
  await settle(4 * MIN);
  expect(alert).toHaveBeenCalledTimes(1);
  second.unmount();
  render();
  await settle(MIN);
  expect(alert).toHaveBeenCalledTimes(1);
});

it('ends early on the server without an alert, and takes a suggestion still up with it', async () => {
  const { result } = render();
  await settle();
  act(() => result.current.start(5));
  await settle(MIN);
  vi.mocked(dismissByTag).mockClear();
  act(() => result.current.end());
  expect(dismissByTag).toHaveBeenCalledWith('break');
  // At once on screen, then on the server.
  expect(result.current.endsAt).toBeNull();
  await settle();
  expect(api.endBreak).toHaveBeenCalledWith(5);
  expect(result.current.day?.breaks[0]?.endedAt).toBe(T0 + MIN);
  await settle(10 * MIN);
  expect(alert).not.toHaveBeenCalled();
});

it('sends nothing to end when no break is running (a timer started without one)', async () => {
  const { result } = render();
  await settle();
  act(() => result.current.end());
  await settle();
  expect(dismissByTag).toHaveBeenCalledWith('break');
  expect(api.endBreak).not.toHaveBeenCalled();
});

it('says nothing for a break that ended early or long before the page opened', async () => {
  const early = makeBreak({ id: 1, startedAt: T0 - 20 * MIN, endedAt: T0 - 18 * MIN });
  vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [early] }));
  const { unmount } = render();
  await settle();
  expect(alert).not.toHaveBeenCalled();
  expect(localStorage.getItem('focus:break-over')).toBe('1');
  unmount();
  vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [makeBreak({ id: 2, startedAt: T0 - 35 * MIN, endedAt: T0 - 30 * MIN })] }));
  const { result } = render();
  await settle();
  expect(result.current.endsAt).toBeNull();
  expect(alert).not.toHaveBeenCalled();
  expect(localStorage.getItem('focus:break-over')).toBe('2');
});

it('waits for the settings before announcing, so the chosen sound plays', async () => {
  vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [makeBreak({ startedAt: T0 - 6 * MIN, endedAt: T0 - MIN })] }));
  let answer!: (s: typeof settings) => void;
  vi.mocked(api.getSettings).mockReturnValue(new Promise((r) => (answer = r)));
  render();
  await settle();
  expect(alert).not.toHaveBeenCalled();
  answer({ ...settings, sounds: { ...settings.sounds, breakDone: 'bell' } });
  await settle();
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ chime: 'bell' }));
});

it('is only there inside its provider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderHook(() => useBreak())).toThrow('useBreak outside BreakProvider');
});

describe('suggestions', () => {
  /** A session of `minutes` that ended `gap` minutes before the next one started, `at` minutes before T0. */
  const done = (id: number, at: number, minutes = 25): Session =>
    makeSession({ id, startedAt: T0 - at * MIN, endedAt: T0 - (at - minutes) * MIN, status: 'completed', durationSeconds: minutes * 60 });

  /** Today with `earlier` logged and a timer running since `startedAt`, finished by hand after `minutes` of focus. */
  async function finishByHand(minutes: number, earlier: Session[] = [], patch: Partial<typeof settings> = {}) {
    vi.mocked(api.getSettings).mockResolvedValue({ ...settings, suggestBreaks: true, ...patch });
    const running = makeSession({ id: 9, startedAt: T0 - minutes * MIN, plannedSeconds: (minutes + 5) * 60 });
    vi.mocked(api.getRunning).mockResolvedValue({ session: running });
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { sessions: [...earlier, running] }));
    const r = render();
    await settle();
    vi.mocked(api.finishSession).mockResolvedValue({ session: { ...running, status: 'completed', endedAt: T0, durationSeconds: minutes * 60 } });
    vi.mocked(api.getRunning).mockResolvedValue({ session: null });
    await act(() => r.result.current.timer.finish());
    return r;
  }

  const suggested = (): AlertOptions | undefined => vi.mocked(alert).mock.calls.find(([o]) => o.title.startsWith('Take a'))?.[0];

  it('offers a break a fifth as long as a session finished by hand, quietly, and starts it from the banner', async () => {
    const { result } = await finishByHand(20);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(suggested()).toMatchObject({
      kicker: BREAK_SUGGESTION.kicker(1, 4),
      title: BREAK_SUGGESTION.title(4, false),
      body: BREAK_SUGGESTION.body('20m', false, 4),
      tag: 'break',
      sticky: true,
      sound: false,
      notifications: false,
      action: { label: BREAK_SUGGESTION.start },
    });
    // The card's Break button offers the same length.
    expect(result.current.next).toMatchObject({ minutes: 4, long: false });
    act(() => suggested()!.action!.run());
    expect(unlockAudio).toHaveBeenCalled();
    await settle();
    expect(api.startBreak).toHaveBeenCalledWith(TODAY, 4 * 60);
    expect(result.current.endsAt).toBe(T0 + 4 * MIN);
  });

  it('offers the fourth session in a row a long break, a fifth of all four', async () => {
    const { result } = await finishByHand(25, [done(1, 115), done(2, 85), done(3, 55)]);
    expect(suggested()).toMatchObject({
      kicker: BREAK_SUGGESTION.kicker(4, 4),
      title: BREAK_SUGGESTION.title(20, true),
      body: BREAK_SUGGESTION.body('1h 40m', true, 4),
    });
    expect(result.current.next).toMatchObject({ minutes: 20, long: true });
  });

  it('counts the set over after a long gap', async () => {
    await finishByHand(25, [done(1, 115), done(2, 85), done(3, 70)]);
    expect(suggested()).toMatchObject({ kicker: BREAK_SUGGESTION.kicker(1, 4), title: BREAK_SUGGESTION.title(5, false) });
  });

  it('offers nothing with the setting off, and the Break button keeps its own length', async () => {
    const { result } = await finishByHand(50, [], { suggestBreaks: false });
    expect(alert).not.toHaveBeenCalled();
    expect(result.current.next).toEqual({ minutes: 5, long: false });
  });

  it('offers nothing after a false start, and the Break button keeps the break of the last real one', async () => {
    const { result } = await finishByHand(0.5, [done(1, 40)]);
    expect(alert).not.toHaveBeenCalled();
    expect(result.current.next).toMatchObject({ minutes: 5, long: false });
  });

  it('offers nothing for a session the server says was cancelled elsewhere', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...settings, suggestBreaks: true });
    const running = makeSession({ startedAt: T0 - 20 * MIN });
    vi.mocked(api.getRunning).mockResolvedValue({ session: running });
    const { result } = render();
    await settle();
    vi.mocked(api.finishSession).mockResolvedValue({ session: { ...running, status: 'cancelled', endedAt: T0 } });
    await act(() => result.current.timer.finish());
    expect(alert).not.toHaveBeenCalled();
  });

  it('offers nothing for a session that ran past midnight, which belongs to the day before', async () => {
    const midnight = new Date(2026, 8, 28).getTime();
    vi.setSystemTime(midnight + 5 * MIN);
    vi.mocked(api.getSettings).mockResolvedValue({ ...settings, suggestBreaks: true });
    const running = makeSession({ date: '2026-09-27', startedAt: midnight - 20 * MIN, plannedSeconds: 30 * 60 });
    vi.mocked(api.getRunning).mockResolvedValue({ session: running });
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, { sessions: date === TODAY ? [] : [running] })));
    const { result } = render();
    await settle();
    vi.mocked(api.finishSession).mockResolvedValue({ session: { ...running, status: 'completed', endedAt: Date.now(), durationSeconds: 25 * 60 } });
    await act(() => result.current.timer.finish());
    expect(result.current.timer.finished).not.toBeNull();
    expect(alert).not.toHaveBeenCalled();
  });

  it('has the Break button keep its own length until today has a completed session', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...settings, suggestBreaks: true, breakMinutes: 7 });
    const today = deferred<Day>();
    vi.mocked(api.getDay).mockReturnValue(today.promise);
    const { result } = render();
    await settle();
    // The settings are in; today's sessions are not.
    expect(result.current.next).toEqual({ minutes: 7, long: false });
    today.resolve(makeDay(TODAY, { sessions: [makeSession({ status: 'cancelled', endedAt: T0 })] }));
    await settle();
    expect(result.current.next).toEqual({ minutes: 7, long: false });
  });
});
