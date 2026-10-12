// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api';
import { HOUR_MS, MINUTE_MS } from '../../../shared/dates.js';
import { formatCountdown } from '../lib/format';
import {
  answered,
  AppProviders,
  deferredAnswer,
  echoPriorities,
  endSession,
  makeBreak,
  makeDay,
  makePriority,
  makeSession,
  makeSettings,
  punchesAt,
  settle,
  T0,
  TODAY,
} from '../test/hooks';
import type { Day, Punch, PunchesResponse, Settings } from '../types';
import { useClock } from './useClock';
import { useDay } from './useDay';
import { useTabTitle } from './useTabTitle';
import { useTimer } from './useTimer';

vi.mock('../api');
vi.mock('../lib/alerts');

/** The server's today: these punches, and the rest of `patch`. */
const serve = (punches: Punch[], patch: Partial<Day> = {}) => vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { punches, ...patch })));

// The hook loads nothing (in the app, Shell's useTodayAlarms loads today), so today is loaded beside it.
const render = () =>
  renderHook(
    () => {
      useTabTitle(TODAY, useClock());
      return { timer: useTimer(), store: useDay(TODAY).store };
    },
    { wrapper: AppProviders },
  );

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  localStorage.clear();
  vi.mocked(api.getSettings).mockResolvedValue(answered(makeSettings({ timeFormat: '12h' })));
  // Clocked in at 8:30 AM, so lunch is due by 1:30 PM.
  serve(punchesAt(T0 - 30 * MINUTE_MS));
});
afterEach(() => {
  cleanup();
  document.title = '';
});

it('waits for the settings before it shows a deadline', async () => {
  const settings = deferredAnswer<Settings>();
  vi.mocked(api.getSettings).mockReturnValue(settings.promise);
  render();
  await settle();
  expect(document.title).toBe('Clockspan');
  settings.resolve(makeSettings({ timeFormat: '12h' }));
  await settle();
  expect(document.title).toBe('1:30 PM Lunch — Clockspan');
});

it('shows a punch at once, with no plain title while it saves and settles', async () => {
  const { result } = render();
  await settle();
  expect(document.title).toBe('1:30 PM Lunch — Clockspan');
  const writes = vi.spyOn(document, 'title', 'set');
  const save = deferredAnswer<PunchesResponse>();
  vi.mocked(api.putPunches).mockReturnValueOnce(save.promise);
  const punches = punchesAt(T0 - HOUR_MS);
  serve(punches);
  act(() => void result.current.store.setPunches(TODAY, punches));
  expect(document.title).toBe('1:00 PM Lunch — Clockspan');
  save.resolve({ punches });
  await settle(5000);
  expect(writes.mock.calls.flat()).toEqual(['1:00 PM Lunch — Clockspan']);
});

it('changes at most once a minute while nothing counts down', async () => {
  // Clocked in at 4:00 AM: lunch was due at 9:00, which is now.
  serve(punchesAt(T0 - 300 * MINUTE_MS));
  render();
  await settle();
  expect(document.title).toBe('Lunch overdue 0m — Clockspan');
  const writes = vi.spyOn(document, 'title', 'set');
  await settle(59_000);
  expect(writes).not.toHaveBeenCalled();
  await settle(1000);
  expect(writes.mock.calls.flat()).toEqual(['Lunch overdue 1m — Clockspan']);
});

it('counts a running break down each second, then goes back to the deadline', async () => {
  serve(punchesAt(T0 - 30 * MINUTE_MS), { breaks: [makeBreak({ startedAt: T0 - MINUTE_MS, endedAt: T0 + 4 * MINUTE_MS })] });
  render();
  await settle();
  expect(document.title).toBe('Break 4:00 — Clockspan');
  const writes = vi.spyOn(document, 'title', 'set');
  for (let tick = 0; tick < 3; tick++) await settle(1000);
  expect(writes.mock.calls.flat()).toEqual(['Break 3:59 — Clockspan', 'Break 3:58 — Clockspan', 'Break 3:57 — Clockspan']);
  await settle(4 * MINUTE_MS);
  expect(document.title).toBe('1:30 PM Lunch — Clockspan');
});

it("writes each of the session's counts once, with no plain title between two ticks, before the end and past it, and the plain title on unmount", async () => {
  // Two seconds left on the 25 min plan, so the ticks run on into the overrun.
  vi.mocked(api.getRunning).mockResolvedValue(answered({ session: makeSession({ startedAt: T0 - 25 * MINUTE_MS + 2000 }) }));
  const { result, unmount } = render();
  await settle();
  const titleAt = (seconds: number) => `${formatCountdown(seconds)} · Write the report — Clockspan`;
  expect(document.title).toBe(titleAt(2));
  // No plain title between two counts: a host that paints every title change (the desktop
  // app's browser pane) would flash "Clockspan" once a second.
  const writes = vi.spyOn(document, 'title', 'set');
  // One settle per tick: ticks inside one act render once.
  for (let tick = 0; tick < 4; tick++) await settle(1000);
  expect(result.current.timer).toMatchObject({ due: true, countdownSeconds: -2 });
  // The error card unmounts the app without a page load.
  unmount();
  expect(writes.mock.calls.flat()).toEqual([...[1, 0, -1, -2].map(titleAt), 'Clockspan']);
});

it('falls back to the plain title when the session finishes', async () => {
  serve(punchesAt());
  const session = makeSession({ startedAt: T0 - 5 * MINUTE_MS });
  vi.mocked(api.getRunning).mockResolvedValue(answered({ session }));
  vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(session, { durationSeconds: 300 }) }));
  const { result } = render();
  await settle();
  expect(document.title).toBe('20:00 · Write the report — Clockspan');
  await act(() => result.current.timer.finish(true));
  expect(document.title).toBe('Clockspan');
});

it("shows a rename of the running session's row at once", async () => {
  const row = makePriority(1, 'Ship the fix', { uid: 'u1' });
  serve(punchesAt(), { priorities: [row] });
  vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
  vi.mocked(api.getRunning).mockResolvedValue(answered({ session: makeSession({ startedAt: T0 - 5 * MINUTE_MS, priorityUid: 'u1', title: 'Ship the fix' }) }));
  const { result } = render();
  await settle();
  expect(document.title).toBe('20:00 · Ship the fix — Clockspan');
  act(() => void result.current.store.setPriorities(TODAY, [{ ...row, text: 'Ship the hotfix' }], [row]));
  expect(document.title).toBe('20:00 · Ship the hotfix — Clockspan');
  await settle();
});
