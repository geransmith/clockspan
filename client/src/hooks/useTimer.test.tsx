// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert, dismissByTag, warnSaveFailed } from '../lib/alerts';
import { TIMER_DONE, TIMER_DUE, TIMER_ELSEWHERE, TIMER_PAUSED_OUT } from '../lib/copy';
import { formatCountdown } from '../lib/format';
import { dueKey } from '../lib/timer';
import { MINUTE_MS } from '../../../shared/dates.js';
import {
  AppProviders,
  apiError,
  begin,
  deferred,
  endSession,
  makeDay,
  makePriority,
  makeSession,
  makeSettings,
  setVisibility,
  settle,
  T0,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type { Priority, RunningResponse, RunningSession, Session, SessionResponse, Settings } from '../types';
import { useDays, useDayStore } from './useDay';
import { useTimer } from './useTimer';

vi.mock('../api');
vi.mock('../lib/alerts');

function renderTimer() {
  return renderHook(() => ({ timer: useTimer(), store: { ...useDayStore(), ...useDays() } }), { wrapper: AppProviders });
}

/** Renders with `session` running on the server (every poll says so), and waits for the first sync. */
async function renderRunning(session: Session | null = makeSession()) {
  vi.mocked(api.getRunning).mockResolvedValue({ session });
  const r = renderTimer();
  await settle();
  // Today is held, as the app always holds it.
  await act(() => r.result.current.store.load(TODAY));
  return r;
}

/** A row just given text on today's list, whose save the tests hold back. */
const justTyped: Priority = makePriority(1, 'Just typed', { uid: 'u1' });

/** A session that started `minutes` ago with the default 25 min plan. */
const startedAgo = (minutes: number, patch: Partial<RunningSession> = {}) => makeSession({ startedAt: Date.now() - minutes * MINUTE_MS, ...patch });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getRunning).mockResolvedValue({ session: null });
  vi.mocked(api.getDay).mockResolvedValue(makeDay());
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  document.title = '';
});

describe('sync with the server', () => {
  it('follows the running session on load and counts down from its start', async () => {
    const { result } = await renderRunning(startedAgo(5));
    expect(result.current.timer.running?.id).toBe(1);
    expect(result.current.timer).toMatchObject({ elapsedSeconds: 300, countdownSeconds: 1200, paused: false, due: false });
    expect(result.current.timer.progress).toBeCloseTo(0.2);
    await settle(1000);
    expect(result.current.timer.countdownSeconds).toBe(1199);
    expect(document.title).toBe('19:59 · Write the report — Clockspan');
  });

  it('refreshes the held day of a session another device started or ended', async () => {
    const { result } = await renderRunning(null);
    await act(() => result.current.store.load(YESTERDAY));
    vi.mocked(api.getDay).mockClear();
    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: makeSession({ date: YESTERDAY }) });
    await settle(MINUTE_MS);
    expect(result.current.timer.running?.date).toBe(YESTERDAY);
    expect(vi.mocked(api.getDay).mock.calls).toEqual([[YESTERDAY]]);

    // The same session again: nothing to refresh.
    const before = result.current.timer.running;
    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: makeSession({ date: YESTERDAY }) });
    await settle(MINUTE_MS);
    expect(result.current.timer.running).toBe(before);
    expect(api.getDay).toHaveBeenCalledTimes(1);

    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: null });
    await settle(MINUTE_MS);
    expect(result.current.timer.running).toBeNull();
    expect(api.getDay).toHaveBeenCalledTimes(2);

    // A day the store doesn't hold loads with the row when it is opened: nothing to fetch now.
    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: makeSession({ id: 2, date: '2026-09-26' }) });
    await settle(MINUTE_MS);
    expect(result.current.timer.running?.date).toBe('2026-09-26');
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });

  it('drops an answer that a local change overtook, and a failed poll quietly', async () => {
    const poll = deferred<RunningResponse>();
    vi.mocked(api.getRunning).mockReturnValueOnce(poll.promise);
    vi.mocked(api.startSession).mockResolvedValue({ session: makeSession() });
    const { result } = renderTimer();
    await act(() => result.current.timer.start(TODAY, 1500, 'Write the report'));
    poll.resolve({ session: null });
    await settle();
    expect(result.current.timer.running?.id).toBe(1);

    vi.mocked(api.getRunning).mockRejectedValueOnce(new Error('offline'));
    await settle(MINUTE_MS);
    expect(result.current.timer.running?.id).toBe(1);
    expect(warnSaveFailed).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('puts the plain title back on unmount (the error card)', async () => {
    const { unmount } = await renderRunning(startedAgo(5));
    expect(document.title).toBe('20:00 · Write the report — Clockspan');
    unmount();
    expect(document.title).toBe('Clockspan');
  });

  it('writes each count to the tab once, with no plain title between two ticks, before the end and past it', async () => {
    // Two seconds left on the 25 min plan, so the ticks run on into the overrun.
    const { result, unmount } = await renderRunning(makeSession({ startedAt: T0 - 25 * MINUTE_MS + 2000 }));
    const titleAt = (seconds: number) => `${formatCountdown(seconds)} · Write the report — Clockspan`;
    expect(document.title).toBe(titleAt(2));
    // No plain title between two counts: a host that paints every title change (the desktop
    // app's browser pane) would flash "Clockspan" once a second.
    const writes = vi.spyOn(document, 'title', 'set');
    // One settle per tick: ticks inside one act render once.
    for (let tick = 0; tick < 4; tick++) await settle(1000);
    expect(result.current.timer).toMatchObject({ due: true, countdownSeconds: -2 });
    unmount();
    expect(writes.mock.calls.flat()).toEqual([...[1, 0, -1, -2].map(titleAt), 'Clockspan']);
  });
});

describe("the running session's name", () => {
  const row = makePriority(1, 'Ship the fix', { uid: 'u1' });
  const renamed = { ...row, text: 'Ship the hotfix' };

  /** Renders with `session` running and today's list holding `row`, whose saves the server takes as sent. */
  async function renderOnRow(session: Session | null) {
    vi.mocked(api.getDay).mockResolvedValue(makeDay(TODAY, { priorities: [row] }));
    vi.mocked(api.putPriorities).mockImplementation((_date, priorities) => Promise.resolve({ priorities }));
    return renderRunning(session);
  }

  it("is its row's current text while its day's list holds its task, in the tab title too, else the name the server gave", async () => {
    const { result } = await renderOnRow(startedAgo(5, { priorityUid: 'u1', title: 'Ship the fix' }));
    expect(result.current.timer.name).toBe('Ship the fix');
    expect(result.current.timer.linked).toBe(true);
    expect(document.title).toBe('20:00 · Ship the fix — Clockspan');

    // Renamed on the sheet: shown at once, before the save answers.
    act(() => void result.current.store.setPriorities(TODAY, [renamed], [row]));
    expect(result.current.timer.name).toBe('Ship the hotfix');
    expect(document.title).toBe('20:00 · Ship the hotfix — Clockspan');
    await settle();

    // Taken off the day's list, the task still names it, and it has no name of its own to edit.
    act(() => void result.current.store.setPriorities(TODAY, [], [renamed]));
    expect(result.current.timer.name).toBe('Ship the fix');
    expect(result.current.timer.linked).toBe(true);
    await settle();
  });

  it("is the task's name the server gave while its day is not read, its label with no task, and empty while nothing runs", async () => {
    const { result } = await renderOnRow(startedAgo(5, { priorityUid: 'u1', title: 'Ship the fix', date: YESTERDAY }));
    expect(result.current.timer.name).toBe('Ship the fix');
    expect(result.current.timer.linked).toBe(true);
    cleanup();
    const unplanned = await renderOnRow(startedAgo(5));
    expect(unplanned.result.current.timer.name).toBe('Write the report');
    expect(unplanned.result.current.timer.linked).toBe(false);
    cleanup();
    const idle = await renderOnRow(null);
    expect(idle.result.current.timer.name).toBe('');
    expect(idle.result.current.timer.linked).toBe(false);
  });

  it("names the time's-up banner by the row, and leaves it as it was raised when the row is renamed", async () => {
    const { result } = await renderOnRow(startedAgo(24.9, { priorityUid: 'u1' }));
    await settle(6000);
    expect(alert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tag: 'timer-due', body: TIMER_DUE.body('Ship the fix', '25m'), sound: true }));
    vi.mocked(dismissByTag).mockClear();
    act(() => void result.current.store.setPriorities(TODAY, [renamed], [row]));
    await settle();
    expect(result.current.timer.name).toBe('Ship the hotfix');
    // Neither raised again nor taken down: a banner closed stays closed, and a rename typed while
    // it is up isn't announced again at each pause in the typing.
    expect(alert).toHaveBeenCalledOnce();
    expect(dismissByTag).not.toHaveBeenCalled();
  });

  it('names the session by its row when it finishes on its own after the grace', async () => {
    await renderOnRow(startedAgo(34.9, { priorityUid: 'u1' }));
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(35, { priorityUid: 'u1' }), { durationSeconds: 1500 }) });
    await settle(6000);
    expect(alert).toHaveBeenLastCalledWith(expect.objectContaining({ title: TIMER_DONE.title, body: TIMER_DONE.body('Ship the fix', '25m') }));
  });

  it('names the session by its row when a pause left for an hour closes it', async () => {
    await renderOnRow(startedAgo(70, { pausedAt: T0 - 59 * MINUTE_MS, priorityUid: 'u1' }));
    vi.mocked(api.finishSession).mockResolvedValue({
      session: endSession(startedAgo(70, { priorityUid: 'u1' }), { endedAt: T0 - 59 * MINUTE_MS, durationSeconds: 660 }),
    });
    await settle(MINUTE_MS);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_PAUSED_OUT.title, body: TIMER_PAUSED_OUT.body('Ship the fix', '11m') }));
  });
});

describe('start', () => {
  it('starts on the server and logs the row', async () => {
    vi.mocked(api.startSession).mockResolvedValue({ session: makeSession({ priorityUid: 'u1' }) });
    const { result } = await renderRunning(null);
    await act(() => result.current.timer.start(TODAY, 1500, 'Write the report', 'u1'));
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 1500, 'Write the report', 'u1');
    expect(result.current.timer.running?.priorityUid).toBe('u1');
    expect(result.current.store.days[TODAY]?.sessions.map((s) => s.id)).toEqual([1]);
  });

  it('follows a timer another device already runs (409), says so, and refreshes its day only if held', async () => {
    const theirs = makeSession({ id: 7, date: YESTERDAY, label: 'Theirs' });
    vi.mocked(api.startSession).mockRejectedValue(apiError(409, { error: 'running', session: theirs }));
    const { result } = await renderRunning(null);
    vi.mocked(api.getDay).mockClear();
    await act(() => result.current.timer.start(TODAY, 1500, 'Mine'));
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 1500, 'Mine', null);
    expect(result.current.timer.running?.id).toBe(7);
    // Not a day the store holds: it loads with the row when it is opened.
    expect(api.getDay).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_ELSEWHERE.title, tag: 'timer-elsewhere', sound: false }));

    // A day the store holds is fetched again, so its log has the row.
    await act(() => result.current.store.load(YESTERDAY));
    vi.mocked(api.getDay).mockClear();
    await act(() => result.current.timer.start(TODAY, 1500, 'Mine'));
    expect(vi.mocked(api.getDay).mock.calls).toEqual([[YESTERDAY]]);
  });

  it('waits for a priorities save still out before starting on a row from it', async () => {
    const { result } = await renderRunning(null);
    const rows = deferred<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(rows.promise);
    vi.mocked(api.startSession).mockResolvedValue({ session: makeSession({ priorityUid: 'u1' }) });
    let started!: Promise<void>;
    act(() => {
      void result.current.store.setPriorities(TODAY, [justTyped], []);
      started = result.current.timer.start(TODAY, 1500, 'Write the report', 'u1');
    });
    await settle();
    // The server refuses a uid it hasn't stored.
    expect(api.startSession).not.toHaveBeenCalled();
    rows.resolve({ priorities: [justTyped] });
    await act(() => started);
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 1500, 'Write the report', 'u1');
    expect(result.current.timer.running?.priorityUid).toBe('u1');
  });

  it('counts a start as out from its call to its answer, waiting first for a promised uid and starting on it', async () => {
    const { result } = await renderRunning(null);
    const uid = deferred<string | null>();
    const answer = deferred<SessionResponse>();
    vi.mocked(api.startSession).mockReturnValueOnce(answer.promise);
    expect(result.current.timer.starting).toBe(false);
    const started = begin(() => result.current.timer.start(TODAY, 1500, 'Write the report', uid.promise));
    await settle();
    expect(result.current.timer.starting).toBe(true);
    // A row whose save is still out: the server would refuse a uid it hasn't stored.
    expect(api.startSession).not.toHaveBeenCalled();
    uid.resolve('u1');
    await settle();
    expect(api.startSession).toHaveBeenCalledExactlyOnceWith(TODAY, 1500, 'Write the report', 'u1');
    expect(result.current.timer.starting).toBe(true);
    answer.resolve({ session: makeSession({ priorityUid: 'u1' }) });
    await act(() => started);
    expect(result.current.timer.starting).toBe(false);
    expect(result.current.timer.running?.priorityUid).toBe('u1');
  });

  it("rethrows a promised uid's failure as the start's, sending no start", async () => {
    const { result } = await renderRunning(null);
    const uid = deferred<string | null>();
    const started = begin(() => result.current.timer.start(TODAY, 1500, 'Write the report', uid.promise));
    uid.reject(new Error('The list is full.'));
    await act(() => expect(started).rejects.toThrow('The list is full.'));
    expect(api.startSession).not.toHaveBeenCalled();
    expect(result.current.timer.starting).toBe(false);
    expect(result.current.timer.running).toBeNull();
  });

  it('rethrows any other failure for the card to show', async () => {
    const { result } = await renderRunning(null);
    vi.mocked(api.startSession).mockRejectedValueOnce(apiError(400, { error: 'bad' }));
    await expect(result.current.timer.start(TODAY, 1500, '')).rejects.toThrow('Request failed (400)');
    vi.mocked(api.startSession).mockRejectedValueOnce(new Error('offline'));
    await expect(result.current.timer.start(TODAY, 1500, '')).rejects.toThrow('offline');
    expect(result.current.timer.running).toBeNull();
  });
});

describe('adjust', () => {
  it('adopts the stored session a + answers with', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.patchSession).mockResolvedValue({ session: startedAgo(5, { plannedSeconds: 1800, label: 'Stored' }) });
    await act(() => result.current.timer.adjust(5 * 60));
    expect(api.patchSession).toHaveBeenCalledWith(1, { plannedSeconds: 1800 });
    expect(result.current.timer.running).toMatchObject({ plannedSeconds: 1800, label: 'Stored' });
  });

  it('compounds rapid presses, shows the newest at once, and sends them in order', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const first = deferred<SessionResponse>();
    vi.mocked(api.patchSession)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ session: startedAgo(5, { plannedSeconds: 2100 }) });
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = result.current.timer.adjust(5 * 60);
      b = result.current.timer.adjust(5 * 60);
    });
    expect(result.current.timer.running?.plannedSeconds).toBe(2100);
    await settle();
    // The second waits for the first, so the server takes them in the order they were made.
    expect(vi.mocked(api.patchSession).mock.calls).toEqual([[1, { plannedSeconds: 1800 }]]);
    first.resolve({ session: startedAgo(5, { plannedSeconds: 1800 }) });
    await act(() => a);
    // The first answer is in, and the second press is still on top of it.
    expect(result.current.timer.running?.plannedSeconds).toBe(2100);
    await act(() => b);
    expect(vi.mocked(api.patchSession).mock.calls).toEqual([
      [1, { plannedSeconds: 1800 }],
      [1, { plannedSeconds: 2100 }],
    ]);
    expect(result.current.timer.running?.plannedSeconds).toBe(2100);
  });

  it('keeps the second press when the first fails, and warns once', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const first = deferred<SessionResponse>();
    vi.mocked(api.patchSession)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ session: startedAgo(5, { plannedSeconds: 2100 }) });
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = result.current.timer.adjust(5 * 60);
      b = result.current.timer.adjust(5 * 60);
    });
    first.reject(new Error('offline'));
    await act(() => a);
    // Only the refused press is gone; the one still on its way shows.
    expect(result.current.timer.running?.plannedSeconds).toBe(2100);
    await act(() => b);
    expect(result.current.timer.running?.plannedSeconds).toBe(2100);
    expect(warnSaveFailed).toHaveBeenCalledTimes(1);
  });

  it('stops at the longest plan the server takes, and does nothing past it', async () => {
    const { result } = await renderRunning(startedAgo(60, { plannedSeconds: 8 * 3600 - 120 }));
    expect(result.current.timer.canAdd).toBe(true);
    vi.mocked(api.patchSession).mockResolvedValue({ session: startedAgo(60, { plannedSeconds: 8 * 3600 }) });
    await act(() => result.current.timer.adjust(5 * 60));
    expect(api.patchSession).toHaveBeenCalledWith(1, { plannedSeconds: 8 * 3600 });
    expect(result.current.timer.canAdd).toBe(false);
    await act(() => result.current.timer.adjust(5 * 60));
    expect(api.patchSession).toHaveBeenCalledTimes(1);
    // An 8 h plan that ran out: + neither asks for more nor finishes it, and the banner offers no more time.
    cleanup();
    const due = await renderRunning(startedAgo(8 * 60 + 2, { plannedSeconds: 8 * 3600 }));
    expect(due.result.current.timer).toMatchObject({ due: true, canAdd: false });
    expect(vi.mocked(alert).mock.lastCall![0]).toMatchObject({ tag: 'timer-due', action: undefined });
    await act(() => due.result.current.timer.adjust(5 * 60));
    expect(api.patchSession).toHaveBeenCalledTimes(1);
    expect(api.finishSession).not.toHaveBeenCalled();
    expect(warnSaveFailed).not.toHaveBeenCalled();
  });

  it('finishes when the new plan is already used up', async () => {
    const { result } = await renderRunning(startedAgo(1.5, { plannedSeconds: 120 }));
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(1.5), { durationSeconds: 90 }) });
    await act(() => result.current.timer.adjust(-5 * 60));
    expect(api.patchSession).not.toHaveBeenCalled();
    expect(api.finishSession).toHaveBeenCalledWith(1, false);
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions[0]?.durationSeconds).toBe(90);
    expect(result.current.timer.finished).toMatchObject({ id: 1, status: 'completed', durationSeconds: 90 });
  });

  it('reports no finish when shrinking finds it cancelled elsewhere', async () => {
    const { result } = await renderRunning(startedAgo(1.5, { plannedSeconds: 120 }));
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(1.5), { status: 'cancelled' }) });
    await act(() => result.current.timer.adjust(-5 * 60));
    expect(result.current.timer.running).toBeNull();
    expect(result.current.timer.finished).toBeNull();
  });

  it('re-syncs after a 404 with a sync sent after it, not the one already out', async () => {
    const session = startedAgo(5);
    const { result } = await renderRunning(session);
    // The minute's sync goes out before the phone ends the session, and answers late.
    const minute = deferred<RunningResponse>();
    vi.mocked(api.getRunning).mockReturnValueOnce(minute.promise).mockResolvedValue({ session: null });
    await settle(MINUTE_MS);
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    vi.mocked(api.patchSession).mockRejectedValue(apiError(404));
    await act(() => result.current.timer.adjust(5 * 60));
    // Nothing goes out beside the sync already out.
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    minute.resolve({ session });
    await settle();
    expect(api.getRunning).toHaveBeenCalledTimes(3);
    expect(result.current.timer.running).toBeNull();
  });

  it('only warns on a failure that is not about the session (offline)', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.patchSession).mockRejectedValue(new Error('offline'));
    await act(() => result.current.timer.adjust(5 * 60));
    expect(result.current.timer.running?.plannedSeconds).toBe(1500);
    expect(warnSaveFailed).toHaveBeenCalledTimes(1);
    expect(api.getRunning).toHaveBeenCalledTimes(1);
  });
});

it('every press does nothing without a running session', async () => {
  const { result } = await renderRunning(null);
  await act(() => result.current.timer.adjust(60));
  await act(() => result.current.timer.edit({ label: 'x' }));
  await act(() => result.current.timer.pause());
  await act(() => result.current.timer.resume());
  await act(() => result.current.timer.finish());
  await act(() => result.current.timer.cancel());
  act(() => result.current.timer.requestFinish());
  expect(api.patchSession).not.toHaveBeenCalled();
  expect(api.pauseSession).not.toHaveBeenCalled();
  expect(api.resumeSession).not.toHaveBeenCalled();
  expect(api.finishSession).not.toHaveBeenCalled();
  expect(api.cancelSession).not.toHaveBeenCalled();
});

describe('edit', () => {
  it('links to a row once its priorities save answers, and a pause pressed meanwhile goes out after', async () => {
    // Shown at once without the category it was given in the log: the server drops it on a link.
    const { result } = await renderRunning(startedAgo(5, { categoryUid: 'cat000000001' }));
    const rows = deferred<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(rows.promise);
    vi.mocked(api.patchSession).mockResolvedValue({ session: startedAgo(5, { priorityUid: 'u1' }) });
    vi.mocked(api.pauseSession).mockResolvedValue({ session: startedAgo(5, { priorityUid: 'u1', pausedAt: T0 }) });
    let linked!: Promise<void>;
    let paused!: Promise<void>;
    act(() => {
      void result.current.store.setPriorities(TODAY, [justTyped], []);
      linked = result.current.timer.edit({ priorityUid: 'u1' });
      paused = result.current.timer.pause();
    });
    expect(result.current.timer.running).toMatchObject({ priorityUid: 'u1', categoryUid: null, pausedAt: T0 });
    await settle();
    expect(api.patchSession).not.toHaveBeenCalled();
    expect(api.pauseSession).not.toHaveBeenCalled();
    rows.resolve({ priorities: [justTyped] });
    await act(() => Promise.all([linked, paused]));
    expect(api.patchSession).toHaveBeenCalledWith(1, { priorityUid: 'u1' });
    expect(vi.mocked(api.patchSession).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.pauseSession).mock.invocationCallOrder[0]!);
    expect(result.current.timer.running).toMatchObject({ priorityUid: 'u1', pausedAt: T0 });
  });

  it('leaves the session a sync showed alone when the rename answers after it', async () => {
    const { result } = await renderRunning(startedAgo(5));
    // Finished on the phone and the next one started there, and this tab's sync saw it before
    // the rename answered: the answer only says what became of the renamed row.
    const rename = deferred<SessionResponse>();
    vi.mocked(api.patchSession).mockReturnValueOnce(rename.promise);
    const a = begin(() => result.current.timer.edit({ label: 'Renamed' }));
    vi.mocked(api.getRunning).mockResolvedValue({ session: makeSession({ id: 3, label: 'Third' }) });
    await settle(MINUTE_MS);
    expect(result.current.timer.running).toMatchObject({ id: 3, label: 'Third' });
    rename.resolve({ session: endSession(startedAgo(5, { label: 'Renamed' }), { endedAt: T0, durationSeconds: 300 }) });
    await act(() => a);
    expect(result.current.timer.running).toMatchObject({ id: 3, label: 'Third' });
    expect(result.current.store.days[TODAY]?.sessions.find((s) => s.id === 1)).toMatchObject({ status: 'completed', label: 'Renamed' });

    // Ended on the phone with nothing after it: an answer from before that doesn't bring it back.
    const late = deferred<SessionResponse>();
    vi.mocked(api.patchSession).mockReturnValueOnce(late.promise);
    const b = begin(() => result.current.timer.edit({ label: 'Third, renamed' }));
    vi.mocked(api.getRunning).mockResolvedValue({ session: null });
    await settle(MINUTE_MS);
    late.resolve({ session: makeSession({ id: 3, label: 'Third, renamed' }) });
    await act(() => b);
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions.some((s) => s.status === 'running')).toBe(false);
  });
});

describe("the day's log", () => {
  it('takes the answer to every press on the running session', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const row = () => result.current.store.days[TODAY]?.sessions.find((s) => s.id === 1);
    vi.mocked(api.patchSession).mockImplementation(async (_id, patch) => ({ session: startedAgo(5, patch) }));
    await act(() => result.current.timer.edit({ label: 'Renamed in the bar' }));
    expect(row()).toMatchObject({ label: 'Renamed in the bar', status: 'running' });
    await act(() => result.current.timer.adjust(5 * 60));
    expect(row()?.plannedSeconds).toBe(1800);
    const e = begin(() => result.current.timer.edit({ label: 'Linked', priorityUid: 'u1' }));
    // The timer shows it at once; the log once the server has it.
    expect(result.current.timer.running).toMatchObject({ label: 'Linked', priorityUid: 'u1' });
    await act(() => e);
    expect(api.patchSession).toHaveBeenLastCalledWith(1, { label: 'Linked', priorityUid: 'u1' });
    expect(row()).toMatchObject({ label: 'Linked', priorityUid: 'u1' });
  });
});

describe('a press the server answers differently', () => {
  it('drops a session that answers a press as ended elsewhere, and logs its row', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.patchSession).mockResolvedValue({
      session: endSession(startedAgo(5, { label: 'Renamed' }), { endedAt: T0, durationSeconds: 300 }),
    });
    await act(() => result.current.timer.edit({ label: 'Renamed' }));
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions[0]).toMatchObject({ status: 'completed', label: 'Renamed' });
  });

  it('keeps the pause another device made when a sync lands under a pause of its own', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const pausing = deferred<SessionResponse>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(pausing.promise);
    const p = begin(() => result.current.timer.pause());
    const elsewhere = startedAgo(5, { pausedAt: T0 - 2 * MINUTE_MS });
    vi.mocked(api.getRunning).mockResolvedValue({ session: elsewhere });
    await settle(MINUTE_MS);
    expect(result.current.timer.running?.pausedAt).toBe(T0 - 2 * MINUTE_MS);
    pausing.resolve({ session: elsewhere });
    await act(() => p);
    expect(result.current.timer.running?.pausedAt).toBe(T0 - 2 * MINUTE_MS);
  });

  it('keeps a resume another device made when a sync lands under a resume of its own', async () => {
    const { result } = await renderRunning(startedAgo(15, { pausedAt: T0 - 10 * MINUTE_MS }));
    const resuming = deferred<SessionResponse>();
    vi.mocked(api.resumeSession).mockReturnValueOnce(resuming.promise);
    const r = begin(() => result.current.timer.resume());
    // The phone resumed it first, and banked a shorter pause.
    const elsewhere = startedAgo(15, { pausedSeconds: 300 });
    vi.mocked(api.getRunning).mockResolvedValue({ session: elsewhere });
    await settle(MINUTE_MS);
    expect(result.current.timer.running).toMatchObject({ pausedAt: null, pausedSeconds: 300 });
    resuming.resolve({ session: elsewhere });
    await act(() => r);
    expect(result.current.timer.running).toMatchObject({ pausedAt: null, pausedSeconds: 300 });
  });
});

describe('pause and resume', () => {
  it('pauses at once, holds the countdown and logs the pill on the day', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const pausing = deferred<SessionResponse>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(pausing.promise);
    const p = begin(() => result.current.timer.pause());
    expect(result.current.timer).toMatchObject({ paused: true, countdownSeconds: 1200 });
    pausing.resolve({ session: startedAgo(5, { pausedAt: T0 }) });
    await act(() => p);
    expect(result.current.store.days[TODAY]?.sessions[0]?.pausedAt).toBe(T0);
    vi.mocked(api.getRunning).mockResolvedValue({ session: startedAgo(5, { pausedAt: T0 }) });
    await settle(10 * MINUTE_MS);
    expect(result.current.timer.countdownSeconds).toBe(1200);
    expect(document.title).toBe('Paused 20:00 · Write the report — Clockspan');
    // A second pause is a no-op.
    await act(() => result.current.timer.pause());
    expect(api.pauseSession).toHaveBeenCalledTimes(1);
  });

  it('resumes with the pause counted, and a second resume is a no-op', async () => {
    const { result } = await renderRunning(startedAgo(15, { pausedAt: T0 - 10 * MINUTE_MS }));
    vi.mocked(api.resumeSession).mockResolvedValue({ session: startedAgo(15, { pausedSeconds: 600 }) });
    const done = begin(() => result.current.timer.resume());
    expect(result.current.timer.running).toMatchObject({ pausedAt: null, pausedSeconds: 600 });
    await act(() => done);
    expect(result.current.timer).toMatchObject({ paused: false, countdownSeconds: 1200 });
    await act(() => result.current.timer.resume());
    expect(api.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the newer state when a pause and a resume cross', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const paused = deferred<SessionResponse>();
    const resumed = deferred<SessionResponse>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(paused.promise);
    vi.mocked(api.resumeSession).mockReturnValueOnce(resumed.promise);
    const p = begin(() => result.current.timer.pause());
    const r = begin(() => result.current.timer.resume());
    paused.resolve({ session: startedAgo(5, { pausedAt: T0 }) });
    await act(() => p);
    expect(result.current.timer.paused).toBe(false);

    // And the other way round: the resume's answer lands after a new pause.
    const pausedAgain = deferred<SessionResponse>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(pausedAgain.promise);
    act(() => void result.current.timer.pause());
    resumed.resolve({ session: startedAgo(5) });
    await act(() => r);
    expect(result.current.timer.paused).toBe(true);
    pausedAgain.resolve({ session: startedAgo(5, { pausedAt: T0 }) });
    await settle();
  });

  it('closes a pause left for an hour, quietly, logging the time before it', async () => {
    const { result } = await renderRunning(startedAgo(70, { pausedAt: T0 - 59 * MINUTE_MS, label: '' }));
    expect(api.finishSession).not.toHaveBeenCalled();
    vi.mocked(api.finishSession).mockResolvedValue({
      session: endSession(startedAgo(70, { label: '' }), { endedAt: T0 - 59 * MINUTE_MS, durationSeconds: 660 }),
    });
    await settle(MINUTE_MS);
    expect(api.finishSession).toHaveBeenCalledWith(1, false, { plannedSeconds: 1500, pausedAt: T0 - 59 * MINUTE_MS });
    expect(result.current.timer.running).toBeNull();
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ title: TIMER_PAUSED_OUT.title, body: TIMER_PAUSED_OUT.body('', '11m'), sound: false, notifications: false }),
    );
  });
});

describe('finish and cancel', () => {
  it('finish logs the session and clears the timer', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(5), { durationSeconds: 300 }) });
    expect(result.current.timer.finished).toBeNull();
    await act(() => result.current.timer.finish(true));
    expect(api.finishSession).toHaveBeenCalledWith(1, true);
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions[0]?.status).toBe('completed');
    expect(result.current.timer.finished).toMatchObject({ id: 1, status: 'completed', durationSeconds: 300 });
    expect(document.title).toBe('Clockspan');
  });

  it('a finish that waited behind a press leaves a session another device started since', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const plus = deferred<SessionResponse>();
    vi.mocked(api.patchSession).mockReturnValueOnce(plus.promise);
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(5), { durationSeconds: 300 }) });
    let a!: Promise<void>;
    let f!: Promise<void>;
    act(() => {
      a = result.current.timer.adjust(5 * 60);
      f = result.current.timer.finish();
    });
    vi.mocked(api.getRunning).mockResolvedValue({ session: makeSession({ id: 3, label: 'Third' }) });
    await settle(MINUTE_MS);
    plus.reject(apiError(409));
    await act(() => a);
    await act(() => f);
    expect(api.finishSession).toHaveBeenCalledWith(1, false);
    expect(result.current.timer.running).toMatchObject({ id: 3, label: 'Third' });
    expect(result.current.store.days[TODAY]?.sessions.find((s) => s.id === 1)?.status).toBe('completed');
  });

  it('reports no finish for a session the server says was cancelled elsewhere', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(5), { status: 'cancelled' }) });
    await act(() => result.current.timer.finish());
    expect(result.current.timer.running).toBeNull();
    expect(result.current.timer.finished).toBeNull();
  });

  it('cancel drops the row and clears the timer; a 409 re-syncs', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.cancelSession)
      .mockRejectedValueOnce(apiError(409))
      .mockResolvedValueOnce({ session: endSession(startedAgo(5), { status: 'cancelled' }) });
    await act(() => result.current.timer.cancel());
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    await settle();
    await act(() => result.current.timer.cancel());
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions).toEqual([]);
    expect(result.current.timer.finished).toBeNull();
  });

  it('requestFinish finishes at once before the end', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(5), { durationSeconds: 300 }) });
    act(() => result.current.timer.requestFinish());
    await settle();
    expect(api.finishSession).toHaveBeenCalledTimes(1);
  });

  it('requestFinish asks which length to log a minute or more past the end, and a finish closes it at once', async () => {
    const { result } = await renderRunning(startedAgo(27));
    act(() => result.current.timer.requestFinish());
    expect(result.current.timer.finishChoice).toBe(result.current.timer.running);
    expect(api.finishSession).not.toHaveBeenCalled();
    act(() => result.current.timer.dismissFinishChoice());
    expect(result.current.timer.finishChoice).toBeNull();

    act(() => result.current.timer.requestFinish());
    const finishing = deferred<SessionResponse>();
    vi.mocked(api.finishSession).mockReturnValueOnce(finishing.promise);
    const f = begin(() => result.current.timer.finish(true));
    // The sheet closes on the press, while the session is still shown.
    expect(result.current.timer.running?.id).toBe(1);
    expect(result.current.timer.finishChoice).toBeNull();
    finishing.resolve({ session: endSession(startedAgo(27), { durationSeconds: 27 * 60 }) });
    await act(() => f);
    expect(api.finishSession).toHaveBeenCalledWith(1, true);
  });

  it('the choice closes when the session ends elsewhere, and stays shut for the next one with the same id', async () => {
    const { result } = await renderRunning(startedAgo(27));
    act(() => result.current.timer.requestFinish());
    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: null });
    await settle(MINUTE_MS);
    expect(result.current.timer.finishChoice).toBeNull();
    // SQLite gives a new row the id of a deleted newest one.
    vi.mocked(api.startSession).mockResolvedValue({ session: makeSession({ id: 1, startedAt: Date.now() }) });
    await act(() => result.current.timer.start(TODAY, 1500, 'Next'));
    expect(result.current.timer.finishChoice).toBeNull();
  });

  it('the choice closes for good when another device moves the end', async () => {
    const session = startedAgo(27);
    const { result } = await renderRunning(session);
    act(() => result.current.timer.requestFinish());
    expect(result.current.timer.finishChoice).not.toBeNull();
    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: { ...session, plannedSeconds: 33 * 60 } });
    await settle(MINUTE_MS);
    expect(result.current.timer.due).toBe(false);
    expect(result.current.timer.finishChoice).toBeNull();
    // Taken back to the old plan: the end the question was asked for, but nobody asked again.
    await settle(MINUTE_MS);
    expect(result.current.timer.due).toBe(true);
    expect(result.current.timer.finishChoice).toBeNull();
  });

  it('a finish by hand that is out when the grace runs out sends no second finish', async () => {
    const { result } = await renderRunning(startedAgo(34.9));
    const finishing = deferred<SessionResponse>();
    vi.mocked(api.finishSession).mockReturnValueOnce(finishing.promise);
    const f = begin(() => result.current.timer.finish());
    await settle(6000);
    expect(api.finishSession).toHaveBeenCalledTimes(1);
    finishing.resolve({ session: endSession(startedAgo(35), { durationSeconds: 1500 }) });
    await act(() => f);
    await settle(1000);
    expect(api.finishSession).toHaveBeenCalledTimes(1);
    expect(result.current.timer.running).toBeNull();
    expect(result.current.timer.finished).toMatchObject({ id: 1, status: 'completed' });
    expect(alert).not.toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_DONE.title }));
  });
});

describe("time's up", () => {
  it('announces once per planned end, with the chime and a button that adds time', async () => {
    const { result, unmount } = await renderRunning(startedAgo(24.9));
    expect(alert).not.toHaveBeenCalled();
    await settle(6000);
    expect(result.current.timer.due).toBe(true);
    const endAt = T0 - 24.9 * MINUTE_MS + 25 * MINUTE_MS;
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: TIMER_DUE.title,
        body: TIMER_DUE.body('Write the report', '25m'),
        tag: 'timer-due',
        sticky: true,
        sound: true,
        notifications: makeSettings().notifications,
        chime: makeSettings().sounds.timer,
      }),
    );
    expect(localStorage.getItem('focus:timer-due')).toBe(dueKey(1, endAt));
    await settle(30_000);
    expect(alert).toHaveBeenCalledTimes(1);

    // The button: five more minutes from now.
    vi.mocked(api.patchSession).mockImplementation(async (_id, patch) => ({ session: makeSession({ ...patch, startedAt: T0 - 24.9 * MINUTE_MS }) }));
    const action = vi.mocked(alert).mock.calls[0]![0].action!;
    expect(action.label).toBe(TIMER_DUE.more(makeSettings().adjustStepMinutes));
    vi.mocked(dismissByTag).mockClear();
    act(() => action.run());
    await settle();
    expect(result.current.timer.due).toBe(false);
    expect(dismissByTag).toHaveBeenCalledWith('timer-due');
    unmount();
  });

  it('takes the button off, quietly, once the time worked reaches the longest plan', async () => {
    // A minute past a 7 h 55 min plan: five more minutes are still there to add.
    await renderRunning(startedAgo(8 * 60 - 4, { plannedSeconds: 8 * 3600 - 5 * 60 }));
    expect(vi.mocked(alert).mock.lastCall![0]).toMatchObject({ tag: 'timer-due', sound: true, action: { label: TIMER_DUE.more(5) } });
    await settle(3 * MINUTE_MS);
    expect(alert).toHaveBeenCalledTimes(1);
    await settle(2 * MINUTE_MS);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(vi.mocked(alert).mock.lastCall![0]).toMatchObject({ tag: 'timer-due', sound: false, notifications: false, action: undefined });
  });

  it('shows the banner again after a reload without a second chime', async () => {
    const session = startedAgo(26);
    localStorage.setItem('focus:timer-due', dueKey(1, session.startedAt + 25 * MINUTE_MS));
    await renderRunning(session);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tag: 'timer-due', sound: false, notifications: false }));
  });

  it('brings the banner back, quietly, when the added time does not save', async () => {
    const { result } = await renderRunning(startedAgo(26));
    expect(alert).toHaveBeenCalledTimes(1);
    vi.mocked(api.patchSession).mockRejectedValue(new Error('offline'));
    vi.mocked(dismissByTag).mockClear();
    act(() => vi.mocked(alert).mock.calls[0]![0].action!.run());
    // Given time at once, so the banner goes while the + is on its way.
    expect(result.current.timer.due).toBe(false);
    expect(dismissByTag).toHaveBeenCalledWith('timer-due');
    await settle();
    expect(result.current.timer.due).toBe(true);
    expect(warnSaveFailed).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(vi.mocked(alert).mock.lastCall![0]).toMatchObject({
      tag: 'timer-due',
      sticky: true,
      sound: false,
      notifications: false,
      action: { label: TIMER_DUE.more(makeSettings().adjustStepMinutes) },
    });
  });

  it('waits for the settings before any alert, so the right sound plays', async () => {
    const settings = deferred<Settings>();
    vi.mocked(api.getSettings).mockReset().mockReturnValue(settings.promise);
    await renderRunning(startedAgo(26));
    await settle(1000);
    expect(alert).not.toHaveBeenCalled();
    settings.resolve(makeSettings({ sound: false }));
    await settle();
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tag: 'timer-due', sound: false }));
  });

  it('finishes at the planned length after the grace, with a chime only if none played for that end', async () => {
    const { result } = await renderRunning(startedAgo(34.9, { label: '' }));
    expect(alert).toHaveBeenCalledTimes(1); // the due banner, chimed
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(35, { label: '' }), { durationSeconds: 1500 }) });
    await settle(6000);
    expect(api.finishSession).toHaveBeenCalledWith(1, false, { plannedSeconds: 1500, pausedAt: null });
    expect(result.current.timer.running).toBeNull();
    // Nobody pressed Finish: nothing for a break suggestion to follow.
    expect(result.current.timer.finished).toBeNull();
    expect(alert).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: TIMER_DONE.title, body: TIMER_DONE.body('', '25m'), sound: false, notifications: false }),
    );
  });

  it('chimes once for a timer left alone when storage is blocked', async () => {
    const blocked = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
    await renderRunning(startedAgo(34.9));
    expect(vi.mocked(alert).mock.lastCall![0]).toMatchObject({ tag: 'timer-due', sound: true });
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(35), { durationSeconds: 1500 }) });
    await settle(6000);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenLastCalledWith(expect.objectContaining({ title: TIMER_DONE.title, sound: false, notifications: false }));
  });

  it('finishes quietly on a page opened past the grace when that end already chimed', async () => {
    const session = startedAgo(45);
    // The page that chimed was closed or reloaded before the grace ran out.
    localStorage.setItem('focus:timer-due', dueKey(1, session.startedAt + 25 * MINUTE_MS));
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(45), { durationSeconds: 1500 }) });
    const { result } = await renderRunning(session);
    await settle();
    expect(result.current.timer.running).toBeNull();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_DONE.title, sound: false, notifications: false }));
  });

  it('chimes the completion for a session that ran out while the page was closed', async () => {
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(45)) });
    const { result } = await renderRunning(startedAgo(45));
    await settle();
    expect(result.current.timer.running).toBeNull();
    // Found past the grace: no due banner, just the completion.
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_DONE.title, body: TIMER_DONE.body('Write the report', '25m'), sound: true }));
  });

  it('says nothing when the server reports it was cancelled elsewhere', async () => {
    vi.mocked(api.finishSession).mockResolvedValue({ session: endSession(startedAgo(45), { status: 'cancelled' }) });
    const { result } = await renderRunning(startedAgo(45));
    await settle();
    expect(result.current.timer.running).toBeNull();
    expect(alert).not.toHaveBeenCalled();
  });

  /**
   * The tab was hidden and its clock stood still for `minutes` (a phone's screen asleep), and the
   * sync it sends as it comes back is held until the test answers it.
   */
  async function comeBackAfter(minutes: number) {
    setVisibility('hidden');
    vi.setSystemTime(Date.now() + minutes * MINUTE_MS);
    const sync = deferred<RunningResponse>();
    vi.mocked(api.getRunning).mockReturnValueOnce(sync.promise);
    act(() => setVisibility('visible'));
    await settle(1000);
    return sync;
  }

  it("raises no time's-up banner on a copy from before the tab was hidden until its sync answers", async () => {
    const session = startedAgo(20);
    const { result } = await renderRunning(session);
    const sync = await comeBackAfter(6);
    expect(result.current.timer.due).toBe(true);
    expect(alert).not.toHaveBeenCalled();
    // Given ten more minutes on another device meanwhile.
    sync.resolve({ session: { ...session, plannedSeconds: 35 * 60 } });
    await settle(1000);
    expect(result.current.timer.due).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });

  it('sends no finish on a copy from before the tab was hidden until its sync answers', async () => {
    const session = startedAgo(30);
    const { result } = await renderRunning(session);
    const sync = await comeBackAfter(10);
    expect(result.current.timer.overrunSeconds).toBeGreaterThan(600);
    expect(api.finishSession).not.toHaveBeenCalled();
    sync.resolve({ session: { ...session, plannedSeconds: 50 * 60 } });
    await settle(1000);
    expect(api.finishSession).not.toHaveBeenCalled();
    expect(result.current.timer).toMatchObject({ running: { id: 1, plannedSeconds: 3000 }, due: false });
  });

  it('shows the timer as it is now when the server refuses a finish judged by an older copy', async () => {
    const session = startedAgo(34.9);
    const { result } = await renderRunning(session);
    // Another device gave it more time after this one's last sync.
    vi.mocked(api.finishSession).mockRejectedValueOnce(apiError(409));
    vi.mocked(api.getRunning).mockResolvedValue({ session: { ...session, plannedSeconds: 40 * 60 } });
    await settle(6000);
    expect(api.finishSession).toHaveBeenCalledWith(1, false, { plannedSeconds: 1500, pausedAt: null });
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    await settle(5000);
    expect(api.finishSession).toHaveBeenCalledTimes(1);
    expect(result.current.timer).toMatchObject({ running: { plannedSeconds: 2400 }, due: false });
  });

  it('drops the timer at once when its finish finds the session deleted on another device (404)', async () => {
    // Finished and deleted from the log on another device after this one's last sync.
    const { result } = await renderRunning(startedAgo(34.9));
    vi.mocked(api.finishSession).mockRejectedValueOnce(apiError(404));
    vi.mocked(api.getRunning).mockResolvedValue({ session: null });
    await settle(6000);
    expect(api.finishSession).toHaveBeenCalledWith(1, false, { plannedSeconds: 1500, pausedAt: null });
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    expect(result.current.timer.running).toBeNull();
    await settle(5000);
    expect(api.finishSession).toHaveBeenCalledTimes(1);
  });

  it('retries a failed auto-finish, 2 s doubling, one request at a time', async () => {
    const first = deferred<SessionResponse>();
    vi.mocked(api.finishSession).mockReturnValueOnce(first.promise);
    const { result } = await renderRunning(startedAgo(45));
    await settle(3000);
    expect(api.finishSession).toHaveBeenCalledTimes(1);
    first.reject(new Error('offline'));
    await settle();

    vi.mocked(api.finishSession).mockRejectedValueOnce(new Error('offline'));
    await settle(1000);
    expect(api.finishSession).toHaveBeenCalledTimes(1);
    await settle(1000);
    expect(api.finishSession).toHaveBeenCalledTimes(2);
    await settle(3000);
    expect(api.finishSession).toHaveBeenCalledTimes(2);
    vi.mocked(api.finishSession).mockResolvedValueOnce({ session: endSession(startedAgo(45), { durationSeconds: 1500 }) });
    await settle(1000);
    expect(api.finishSession).toHaveBeenCalledTimes(3);
    expect(result.current.timer.running).toBeNull();
  });
});

it('useTimer refuses to run outside the provider', () => {
  expect(() => renderHook(() => useTimer())).toThrow('useTimer outside TimerProvider');
});
