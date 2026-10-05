// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert, dismissByTag, unlockAudio, type AlertOptions } from '../lib/alerts';
import { MINUTE_MS, todayKey } from '../../../shared/dates.js';
import { BREAK, BREAK_SUGGESTION } from '../lib/copy';
import {
  AllProviders,
  completedSession,
  deferred,
  endSession,
  makeBreak,
  makeDay,
  makeSession,
  makeSettings,
  MIDNIGHT,
  settle,
  T0,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type { Day, Session, Settings } from '../types';
import { useBreak } from './useBreak';
import { useClock } from './useClock';
import { useDay, useDays } from './useDay';
import { useTimer } from './useTimer';

vi.mock('../api');
vi.mock('../lib/alerts');

const settings = makeSettings({ breakMinutes: 5 });
const render = () =>
  renderHook(
    () => {
      const { day, store } = useDay(TODAY);
      return { ...useBreak(), timer: useTimer(), day, store };
    },
    { wrapper: AllProviders },
  );

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
});

it("starts a break on today's sheet, counts it down and announces its end once, with the Break over sound", async () => {
  const { result } = render();
  await settle();
  expect(result.current.endsAt).toBeNull();
  act(() => result.current.start(5));
  expect(unlockAudio).toHaveBeenCalled();
  expect(dismissByTag).toHaveBeenCalledWith('break');
  await settle();
  expect(api.startBreak).toHaveBeenCalledWith(TODAY, 300);
  expect(result.current.day?.breaks.map((b) => b.id)).toEqual([5]);
  expect(result.current.endsAt).toBe(T0 + 5 * MINUTE_MS);
  expect(result.current.remainingSeconds).toBe(300);
  await settle(2 * MINUTE_MS);
  expect(result.current.remainingSeconds).toBe(180);
  expect(alert).not.toHaveBeenCalled();
  await settle(3 * MINUTE_MS);
  expect(result.current.endsAt).toBeNull();
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert).toHaveBeenCalledWith(
    expect.objectContaining({ tag: 'break', chime: settings.sounds.breakDone, sound: settings.sound, notifications: settings.notifications }),
  );
  await settle(MINUTE_MS);
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
  vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [makeBreak({ startedAt: T0 - MINUTE_MS, endedAt: T0 + 4 * MINUTE_MS })] }));
  const first = render();
  await settle();
  expect(first.result.current.endsAt).toBe(T0 + 4 * MINUTE_MS);
  first.unmount();
  const second = render();
  await settle();
  expect(second.result.current.endsAt).toBe(T0 + 4 * MINUTE_MS);
  await settle(4 * MINUTE_MS);
  expect(alert).toHaveBeenCalledTimes(1);
  second.unmount();
  render();
  await settle(MINUTE_MS);
  expect(alert).toHaveBeenCalledTimes(1);
});

it('ends early on the server without an alert, and takes a suggestion still up with it', async () => {
  const { result } = render();
  await settle();
  act(() => result.current.start(5));
  await settle(MINUTE_MS);
  vi.mocked(dismissByTag).mockClear();
  act(() => result.current.end());
  expect(dismissByTag).toHaveBeenCalledWith('break');
  // At once on screen, then on the server.
  expect(result.current.endsAt).toBeNull();
  await settle();
  expect(api.endBreak).toHaveBeenCalledWith(5);
  expect(result.current.day?.breaks[0]?.endedAt).toBe(T0 + MINUTE_MS);
  await settle(10 * MINUTE_MS);
  expect(alert).not.toHaveBeenCalled();
});

it('drops a break ended within a minute from the log', async () => {
  vi.mocked(api.endBreak).mockResolvedValue({ break: null });
  const { result } = render();
  await settle();
  act(() => result.current.start(5));
  await settle(30_000);
  act(() => result.current.end());
  expect(result.current.day?.breaks).toEqual([]);
  await settle();
  expect(api.endBreak).toHaveBeenCalledWith(5);
  expect(result.current.day?.breaks).toEqual([]);
  expect(result.current.endsAt).toBeNull();
});

it('takes the break banners down when a timer starts, and leaves the ending to the server', async () => {
  const { result } = render();
  await settle();
  act(() => result.current.start(5));
  await settle(2 * MINUTE_MS);
  vi.mocked(dismissByTag).mockClear();
  vi.mocked(api.startSession).mockResolvedValue({ session: makeSession({ id: 3, startedAt: Date.now() }) });
  await act(() => result.current.timer.start(TODAY, 1500, 'Next'));
  await settle();
  expect(dismissByTag).toHaveBeenCalledWith('break');
  expect(api.endBreak).not.toHaveBeenCalled();
  // The session's start ended it here as the server did: two minutes of rest.
  expect(result.current.day?.breaks[0]?.endedAt).toBe(T0 + 2 * MINUTE_MS);
  expect(result.current.endsAt).toBeNull();
  await settle(5 * MINUTE_MS);
  expect(alert).not.toHaveBeenCalled();
});

it('sends nothing to end when no break is running', async () => {
  const { result } = render();
  await settle();
  act(() => result.current.end());
  await settle();
  expect(dismissByTag).toHaveBeenCalledWith('break');
  expect(api.endBreak).not.toHaveBeenCalled();
});

it('says nothing for a break that ended early or long before the page opened', async () => {
  const early = makeBreak({ id: 1, startedAt: T0 - 40 * MINUTE_MS, endedAt: T0 - 38 * MINUTE_MS });
  vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [early] }));
  const { unmount } = render();
  await settle();
  expect(alert).not.toHaveBeenCalled();
  expect(localStorage.getItem('focus:break-over')).toBe(String(T0 - 40 * MINUTE_MS));
  unmount();
  vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [makeBreak({ id: 2, startedAt: T0 - 35 * MINUTE_MS, endedAt: T0 - 30 * MINUTE_MS })] }));
  const { result } = render();
  await settle();
  expect(result.current.endsAt).toBeNull();
  expect(alert).not.toHaveBeenCalled();
  expect(localStorage.getItem('focus:break-over')).toBe(String(T0 - 35 * MINUTE_MS));
});

it("rings for a new break that comes back with a deleted break's id", async () => {
  vi.mocked(api.deleteBreak).mockResolvedValue({ ok: true });
  const { result } = render();
  await settle();
  act(() => result.current.start(5));
  await settle(5 * MINUTE_MS);
  expect(alert).toHaveBeenCalledTimes(1);
  await act(() => result.current.store.removeBreak(TODAY, 5));
  // SQLite hands the next break the id of the deleted newest one: the start mock answers id 5 again.
  act(() => result.current.start(5));
  await settle(5 * MINUTE_MS);
  expect(alert).toHaveBeenCalledTimes(2);
});

it('does not ring an earlier break again when the later one is deleted', async () => {
  let id = 4;
  vi.mocked(api.startBreak).mockImplementation((date, plannedSeconds) =>
    Promise.resolve({ break: makeBreak({ id: ++id, date, plannedSeconds, startedAt: Date.now(), endedAt: Date.now() + plannedSeconds * 1000 }) }),
  );
  vi.mocked(api.deleteBreak).mockResolvedValue({ ok: true });
  const { result } = render();
  await settle();
  act(() => result.current.start(5));
  await settle(6 * MINUTE_MS);
  act(() => result.current.start(5));
  await settle(5 * MINUTE_MS);
  expect(alert).toHaveBeenCalledTimes(2);
  // The first break is the last in the list again, and ended six minutes ago.
  await act(() => result.current.store.removeBreak(TODAY, 6));
  await settle(MINUTE_MS);
  expect(alert).toHaveBeenCalledTimes(2);
});

it('waits for the settings before announcing, so the chosen sound plays', async () => {
  vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { breaks: [makeBreak({ startedAt: T0 - 6 * MINUTE_MS, endedAt: T0 - MINUTE_MS })] }));
  const answer = deferred<Settings>();
  vi.mocked(api.getSettings).mockReturnValue(answer.promise);
  render();
  await settle();
  expect(alert).not.toHaveBeenCalled();
  answer.resolve({ ...settings, sounds: { ...settings.sounds, breakDone: 'bell' } });
  await settle();
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ chime: 'bell' }));
});

describe('across midnight', () => {
  /** The sheet as App shows it: today's, moving to the new day at midnight, while the store keeps the old one. */
  const renderSheet = () =>
    renderHook(() => ({ ...useBreak(), timer: useTimer(), sheet: useDay(todayKey(useClock())).day, days: useDays().days }), { wrapper: AllProviders });

  /** A ten-minute break started at 23:55 on yesterday's sheet. */
  async function breakBeforeMidnight() {
    vi.setSystemTime(MIDNIGHT - 5 * MINUTE_MS);
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date)));
    const r = renderSheet();
    await settle();
    act(() => r.result.current.start(10));
    await settle();
    expect(api.startBreak).toHaveBeenCalledWith(YESTERDAY, 600);
    expect(r.result.current.endsAt).toBe(MIDNIGHT + 5 * MINUTE_MS);
    return r;
  }

  it('keeps counting it down on the new day, and announces its end once', async () => {
    const { result } = await breakBeforeMidnight();
    await settle(6 * MINUTE_MS);
    expect(result.current.sheet?.date).toBe(TODAY);
    expect(result.current.endsAt).toBe(MIDNIGHT + 5 * MINUTE_MS);
    expect(result.current.remainingSeconds).toBe(4 * 60);
    expect(alert).not.toHaveBeenCalled();
    await settle(4 * MINUTE_MS);
    expect(result.current.endsAt).toBeNull();
    expect(alert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: BREAK.over, tag: 'break' }));
    await settle(MINUTE_MS);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('ends it early on the day it started', async () => {
    vi.mocked(api.endBreak).mockImplementation((id) =>
      Promise.resolve({ break: makeBreak({ id, date: YESTERDAY, plannedSeconds: 600, startedAt: MIDNIGHT - 5 * MINUTE_MS, endedAt: Date.now() }) }),
    );
    const { result } = await breakBeforeMidnight();
    await settle(7 * MINUTE_MS);
    act(() => result.current.end());
    expect(result.current.endsAt).toBeNull();
    await settle();
    expect(api.endBreak).toHaveBeenCalledWith(5);
    expect(result.current.days[YESTERDAY]?.breaks.map((b) => b.endedAt)).toEqual([MIDNIGHT + 2 * MINUTE_MS]);
    await settle(10 * MINUTE_MS);
    expect(alert).not.toHaveBeenCalled();
  });

  it('lets a session started on the new day end it, as the server does', async () => {
    const { result } = await breakBeforeMidnight();
    await settle(7 * MINUTE_MS);
    const session = makeSession({ id: 3, startedAt: Date.now() });
    vi.mocked(api.startSession).mockResolvedValue({ session });
    vi.mocked(api.getRunning).mockResolvedValue({ session });
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, date === TODAY ? { sessions: [session] } : {})));
    await act(() => result.current.timer.start(TODAY, 1500, 'Next'));
    await settle();
    expect(result.current.endsAt).toBeNull();
    // Ended in the store too, not only hidden behind today's session.
    expect(result.current.days[YESTERDAY]?.breaks.map((b) => b.endedAt)).toEqual([MIDNIGHT + 2 * MINUTE_MS]);
    await settle(5 * MINUTE_MS);
    expect(alert).not.toHaveBeenCalled();
  });

  it('stays ended when that session is cancelled', async () => {
    const { result } = await breakBeforeMidnight();
    await settle(7 * MINUTE_MS);
    const session = makeSession({ id: 3, startedAt: Date.now() });
    vi.mocked(api.startSession).mockResolvedValue({ session });
    vi.mocked(api.getRunning).mockResolvedValue({ session });
    await act(() => result.current.timer.start(TODAY, 1500, 'Next'));
    vi.mocked(api.cancelSession).mockResolvedValue({ session: endSession(session, { status: 'cancelled', endedAt: Date.now() }) });
    vi.mocked(api.getRunning).mockResolvedValue({ session: null });
    await act(() => result.current.timer.cancel());
    // Today is empty again, so yesterday's break is the one shown: ended, not back on the bar.
    expect(result.current.endsAt).toBeNull();
    await settle(5 * MINUTE_MS);
    expect(alert).not.toHaveBeenCalled();
    expect(api.endBreak).not.toHaveBeenCalled();
  });
});

it('is only there inside its provider', () => {
  expect(() => renderHook(() => useBreak())).toThrow('useBreak outside BreakProvider');
});

describe('suggestions', () => {
  /** A completed 25-minute session that started `at` minutes before T0. */
  const done = (id: number, at: number): Session => completedSession(id, T0 - at * MINUTE_MS, 25 * 60);

  /** Today with `earlier` logged and a timer started `minutes` before T0, finished by hand at T0. */
  async function finishByHand(minutes: number, earlier: Session[] = [], patch: Partial<Settings> = {}) {
    vi.mocked(api.getSettings).mockResolvedValue({ ...settings, suggestBreaks: true, ...patch });
    const running = makeSession({ id: 9, startedAt: T0 - minutes * MINUTE_MS, plannedSeconds: (minutes + 5) * 60 });
    vi.mocked(api.getRunning).mockResolvedValue({ session: running });
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { sessions: [...earlier, running] }));
    const r = render();
    await settle();
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(running, { endedAt: T0, durationSeconds: minutes * 60 }) });
    vi.mocked(api.getRunning).mockResolvedValue({ session: null });
    await act(() => r.result.current.timer.finish());
    return r;
  }

  const suggested = (): AlertOptions | undefined => vi.mocked(alert).mock.calls.find(([o]) => o.action?.label === BREAK_SUGGESTION.start)?.[0];

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
    expect(result.current.endsAt).toBe(T0 + 4 * MINUTE_MS);
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
    expect(result.current.next).toMatchObject({ minutes: 5, long: false, sessionId: 1 });
  });

  it('offers nothing for a session that ran past midnight, which belongs to the day before', async () => {
    vi.setSystemTime(MIDNIGHT + 5 * MINUTE_MS);
    vi.mocked(api.getSettings).mockResolvedValue({ ...settings, suggestBreaks: true });
    const running = makeSession({ date: YESTERDAY, startedAt: MIDNIGHT - 20 * MINUTE_MS, plannedSeconds: 30 * 60 });
    // Today already earned a break of its own, so a suggestion exists: only the check that it
    // belongs to the session just finished keeps it off the screen.
    const todays = endSession(makeSession({ id: 9, startedAt: MIDNIGHT + MINUTE_MS }), { endedAt: MIDNIGHT + 4 * MINUTE_MS, durationSeconds: 3 * 60 });
    vi.mocked(api.getRunning).mockResolvedValue({ session: running });
    vi.mocked(api.getDay).mockImplementation((date) => Promise.resolve(makeDay(date, { sessions: date === TODAY ? [todays] : [running] })));
    const { result } = render();
    await settle();
    expect(result.current.next).toMatchObject({ minutes: 1, long: false, sessionId: 9 });
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(running, { endedAt: Date.now(), durationSeconds: 25 * 60 }) });
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
    today.resolve(makeDay(TODAY, { sessions: [endSession(makeSession(), { status: 'cancelled', endedAt: T0 })] }));
    await settle();
    expect(result.current.next).toEqual({ minutes: 7, long: false });
  });
});
