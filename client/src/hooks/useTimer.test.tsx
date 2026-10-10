// @vitest-environment happy-dom
import { act, cleanup } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert, dismissByTag, warnSaveFailed } from '../lib/alerts';
import { TIMER_DONE, TIMER_DUE, TIMER_ELSEWHERE, TIMER_PAUSED_OUT } from '../lib/copy';
import { formatCountdown } from '../lib/format';
import { MINUTE_MS } from '../../../shared/dates.js';
import {
  answered,
  apiError,
  begin,
  deferred,
  deferredAnswer,
  echoPriorities,
  endSession,
  makeDay,
  makePriority,
  makeSession,
  refused,
  setVisibility,
  settle,
  T0,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type { Priority, RunningResponse, Session, SessionResponse } from '../types';
import { renderRunning, renderTimer, startedAgo } from './useTimer.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

/** A row just given text on today's list, whose save the tests hold back. */
const justTyped: Priority = makePriority(1, 'Just typed', { uid: 'u1' });

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
    vi.mocked(api.getRunning).mockResolvedValueOnce(answered({ session: makeSession({ date: YESTERDAY }) }));
    await settle(MINUTE_MS);
    expect(result.current.timer.running?.date).toBe(YESTERDAY);
    expect(vi.mocked(api.getDay).mock.calls).toEqual([[YESTERDAY]]);

    // The same session again: nothing to refresh.
    const before = result.current.timer.running;
    vi.mocked(api.getRunning).mockResolvedValueOnce(answered({ session: makeSession({ date: YESTERDAY }) }));
    await settle(MINUTE_MS);
    expect(result.current.timer.running).toBe(before);
    // Given time on another device: the timer follows, and its day has nothing new to read.
    vi.mocked(api.getRunning).mockResolvedValueOnce(answered({ session: makeSession({ date: YESTERDAY, plannedSeconds: 30 * 60 }) }));
    await settle(MINUTE_MS);
    expect(result.current.timer.running?.plannedSeconds).toBe(30 * 60);
    expect(api.getDay).toHaveBeenCalledTimes(1);

    vi.mocked(api.getRunning).mockResolvedValueOnce(answered({ session: null }));
    await settle(MINUTE_MS);
    expect(result.current.timer.running).toBeNull();
    expect(api.getDay).toHaveBeenCalledTimes(2);

    // A day the store doesn't hold loads with the row when it is opened: nothing to fetch now.
    vi.mocked(api.getRunning).mockResolvedValueOnce(answered({ session: makeSession({ id: 2, date: '2026-09-26' }) }));
    await settle(MINUTE_MS);
    expect(result.current.timer.running?.date).toBe('2026-09-26');
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });

  it('drops an answer that a local change overtook, and a failed poll quietly', async () => {
    const poll = deferredAnswer<RunningResponse>();
    vi.mocked(api.getRunning).mockReturnValueOnce(poll.promise);
    vi.mocked(api.startSession).mockResolvedValue(answered({ session: makeSession() }, 1));
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

  it('keeps the newer of two syncs out at once, whichever answers last', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const minute = deferredAnswer<RunningResponse>();
    vi.mocked(api.getRunning).mockReturnValueOnce(minute.promise);
    await settle(MINUTE_MS);
    // Finished on the phone; the tab coming back asks beside the minute's sync, still out.
    vi.mocked(api.getRunning).mockResolvedValueOnce(answered({ session: null }, 2));
    await settle(10_000);
    act(() => setVisibility('visible'));
    await settle();
    expect(api.getRunning).toHaveBeenCalledTimes(3);
    expect(result.current.timer.running).toBeNull();
    minute.resolve({ session: startedAgo(5) }, 1);
    await settle();
    expect(result.current.timer.running).toBeNull();
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
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [row] })));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
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
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(35, { priorityUid: 'u1' }), { durationSeconds: 1500 }) }));
    await settle(6000);
    expect(alert).toHaveBeenLastCalledWith(expect.objectContaining({ title: TIMER_DONE.title, body: TIMER_DONE.body('Ship the fix', '25m') }));
  });

  it('names the session by its row when a pause left for an hour closes it', async () => {
    await renderOnRow(startedAgo(70, { pausedAt: T0 - 59 * MINUTE_MS, priorityUid: 'u1' }));
    vi.mocked(api.finishSession).mockResolvedValue(
      answered({
        session: endSession(startedAgo(70, { priorityUid: 'u1' }), { endedAt: T0 - 59 * MINUTE_MS, durationSeconds: 660 }),
      }),
    );
    await settle(MINUTE_MS);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_PAUSED_OUT.title, body: TIMER_PAUSED_OUT.body('Ship the fix', '11m') }));
  });
});

describe('start', () => {
  it('starts on the server and logs the row', async () => {
    vi.mocked(api.startSession).mockResolvedValue(answered({ session: makeSession({ priorityUid: 'u1' }) }));
    const { result } = await renderRunning(null);
    await act(() => result.current.timer.start(TODAY, 1500, 'Write the report', 'u1'));
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 1500, 'Write the report', 'u1');
    expect(result.current.timer.running?.priorityUid).toBe('u1');
    expect(result.current.store.days[TODAY]?.sessions.map((s) => s.id)).toEqual([1]);
  });

  it('shows the timer another device already runs once the sync its 409 brings answers, and says so', async () => {
    const theirs = makeSession({ id: 7, label: 'Theirs' });
    const { result } = await renderRunning(null);
    vi.mocked(api.startSession).mockImplementation(() => refused(409));
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: theirs }));
    await act(() => result.current.timer.start(TODAY, 1500, 'Mine'));
    await settle();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 1500, 'Mine', null);
    expect(result.current.timer.running?.id).toBe(7);
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_ELSEWHERE.title, tag: 'timer-elsewhere', sound: false }));
  });

  it('waits for a priorities save still out before starting on a row from it', async () => {
    const { result } = await renderRunning(null);
    const rows = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(rows.promise);
    vi.mocked(api.startSession).mockResolvedValue(answered({ session: makeSession({ priorityUid: 'u1' }) }));
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
    const answer = deferredAnswer<SessionResponse>();
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
    vi.mocked(api.startSession).mockRejectedValueOnce(apiError(400));
    await expect(result.current.timer.start(TODAY, 1500, '')).rejects.toThrow('Request failed (400)');
    vi.mocked(api.startSession).mockRejectedValueOnce(new Error('offline'));
    await expect(result.current.timer.start(TODAY, 1500, '')).rejects.toThrow('offline');
    expect(result.current.timer.running).toBeNull();
  });
});

describe('adjust', () => {
  it('adopts the stored session a + answers with', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.patchSession).mockResolvedValue(answered({ session: startedAgo(5, { plannedSeconds: 1800, label: 'Stored' }) }));
    await act(() => result.current.timer.adjust(5 * 60));
    expect(api.patchSession).toHaveBeenCalledWith(1, { plannedSeconds: 1800 });
    expect(result.current.timer.running).toMatchObject({ plannedSeconds: 1800, label: 'Stored' });
  });

  it('compounds rapid presses, shows the newest at once, and sends them in order', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const first = deferredAnswer<SessionResponse>();
    vi.mocked(api.patchSession)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(answered({ session: startedAgo(5, { plannedSeconds: 2100 }) }));
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
    const first = deferredAnswer<SessionResponse>();
    vi.mocked(api.patchSession)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(answered({ session: startedAgo(5, { plannedSeconds: 2100 }) }));
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
    vi.mocked(api.patchSession).mockResolvedValue(answered({ session: startedAgo(60, { plannedSeconds: 8 * 3600 }) }));
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
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(1.5), { durationSeconds: 90 }) }));
    await act(() => result.current.timer.adjust(-5 * 60));
    expect(api.patchSession).not.toHaveBeenCalled();
    expect(api.finishSession).toHaveBeenCalledWith(1, false);
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions[0]?.durationSeconds).toBe(90);
    expect(result.current.timer.finished).toMatchObject({ id: 1, status: 'completed', durationSeconds: 90 });
  });

  it('reports no finish when shrinking finds it cancelled elsewhere', async () => {
    const { result } = await renderRunning(startedAgo(1.5, { plannedSeconds: 120 }));
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(1.5), { status: 'cancelled' }) }));
    await act(() => result.current.timer.adjust(-5 * 60));
    expect(result.current.timer.running).toBeNull();
    expect(result.current.timer.finished).toBeNull();
  });

  it('re-syncs after a 404 with a sync sent after it, not the one already out', async () => {
    const session = startedAgo(5);
    const { result } = await renderRunning(session);
    // The minute's sync goes out before the phone ends the session, and answers late.
    const minute = deferredAnswer<RunningResponse>();
    vi.mocked(api.getRunning)
      .mockReturnValueOnce(minute.promise)
      .mockResolvedValue(answered({ session: null }));
    await settle(MINUTE_MS);
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    vi.mocked(api.patchSession).mockImplementation(() => refused(404));
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
    const rows = deferredAnswer<{ priorities: Priority[] }>();
    vi.mocked(api.putPriorities).mockReturnValueOnce(rows.promise);
    vi.mocked(api.patchSession).mockResolvedValue(answered({ session: startedAgo(5, { priorityUid: 'u1' }) }));
    vi.mocked(api.pauseSession).mockResolvedValue(answered({ session: startedAgo(5, { priorityUid: 'u1', pausedAt: T0 }) }));
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
    const rename = deferredAnswer<SessionResponse>();
    vi.mocked(api.patchSession).mockReturnValueOnce(rename.promise);
    const a = begin(() => result.current.timer.edit({ label: 'Renamed' }));
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: makeSession({ id: 3, label: 'Third' }) }));
    await settle(MINUTE_MS);
    expect(result.current.timer.running).toMatchObject({ id: 3, label: 'Third' });
    rename.resolve({ session: endSession(startedAgo(5, { label: 'Renamed' }), { endedAt: T0, durationSeconds: 300 }) });
    await act(() => a);
    expect(result.current.timer.running).toMatchObject({ id: 3, label: 'Third' });
    expect(result.current.store.days[TODAY]?.sessions.find((s) => s.id === 1)).toMatchObject({ status: 'completed', label: 'Renamed' });

    // Ended on the phone with nothing after it: an answer from before that doesn't bring it back.
    const late = deferredAnswer<SessionResponse>();
    vi.mocked(api.patchSession).mockReturnValueOnce(late.promise);
    const b = begin(() => result.current.timer.edit({ label: 'Third, renamed' }));
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: null }));
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
    vi.mocked(api.patchSession).mockImplementation(async (_id, patch) => answered({ session: startedAgo(5, patch) }));
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
    vi.mocked(api.patchSession).mockResolvedValue(
      answered({
        session: endSession(startedAgo(5, { label: 'Renamed' }), { endedAt: T0, durationSeconds: 300 }),
      }),
    );
    await act(() => result.current.timer.edit({ label: 'Renamed' }));
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions[0]).toMatchObject({ status: 'completed', label: 'Renamed' });
  });

  it('keeps the pause another device made when a sync lands under a pause of its own', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const pausing = deferredAnswer<SessionResponse>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(pausing.promise);
    const p = begin(() => result.current.timer.pause());
    const elsewhere = startedAgo(5, { pausedAt: T0 - 2 * MINUTE_MS });
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: elsewhere }));
    await settle(MINUTE_MS);
    expect(result.current.timer.running?.pausedAt).toBe(T0 - 2 * MINUTE_MS);
    pausing.resolve({ session: elsewhere });
    await act(() => p);
    expect(result.current.timer.running?.pausedAt).toBe(T0 - 2 * MINUTE_MS);
  });

  it('keeps a resume another device made when a sync lands under a resume of its own', async () => {
    const { result } = await renderRunning(startedAgo(15, { pausedAt: T0 - 10 * MINUTE_MS }));
    const resuming = deferredAnswer<SessionResponse>();
    vi.mocked(api.resumeSession).mockReturnValueOnce(resuming.promise);
    const r = begin(() => result.current.timer.resume());
    // The phone resumed it first, and banked a shorter pause.
    const elsewhere = startedAgo(15, { pausedSeconds: 300 });
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: elsewhere }));
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
    const pausing = deferredAnswer<SessionResponse>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(pausing.promise);
    const p = begin(() => result.current.timer.pause());
    expect(result.current.timer).toMatchObject({ paused: true, countdownSeconds: 1200 });
    pausing.resolve({ session: startedAgo(5, { pausedAt: T0 }) });
    await act(() => p);
    expect(result.current.store.days[TODAY]?.sessions[0]?.pausedAt).toBe(T0);
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: startedAgo(5, { pausedAt: T0 }) }));
    await settle(10 * MINUTE_MS);
    expect(result.current.timer.countdownSeconds).toBe(1200);
    expect(document.title).toBe('Paused 20:00 · Write the report — Clockspan');
    // A second pause is a no-op.
    await act(() => result.current.timer.pause());
    expect(api.pauseSession).toHaveBeenCalledTimes(1);
  });

  it('resumes with the pause counted, and a second resume is a no-op', async () => {
    const { result } = await renderRunning(startedAgo(15, { pausedAt: T0 - 10 * MINUTE_MS }));
    vi.mocked(api.resumeSession).mockResolvedValue(answered({ session: startedAgo(15, { pausedSeconds: 600 }) }));
    const done = begin(() => result.current.timer.resume());
    expect(result.current.timer.running).toMatchObject({ pausedAt: null, pausedSeconds: 600 });
    await act(() => done);
    expect(result.current.timer).toMatchObject({ paused: false, countdownSeconds: 1200 });
    await act(() => result.current.timer.resume());
    expect(api.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the newer state when a pause and a resume cross', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const paused = deferredAnswer<SessionResponse>();
    const resumed = deferredAnswer<SessionResponse>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(paused.promise);
    vi.mocked(api.resumeSession).mockReturnValueOnce(resumed.promise);
    const p = begin(() => result.current.timer.pause());
    const r = begin(() => result.current.timer.resume());
    paused.resolve({ session: startedAgo(5, { pausedAt: T0 }) });
    await act(() => p);
    expect(result.current.timer.paused).toBe(false);

    // And the other way round: the resume's answer lands after a new pause.
    const pausedAgain = deferredAnswer<SessionResponse>();
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
    vi.mocked(api.finishSession).mockResolvedValue(
      answered({
        session: endSession(startedAgo(70, { label: '' }), { endedAt: T0 - 59 * MINUTE_MS, durationSeconds: 660 }),
      }),
    );
    await settle(MINUTE_MS);
    expect(api.finishSession).toHaveBeenCalledWith(1, false, { plannedSeconds: 1500, pausedAt: T0 - 59 * MINUTE_MS });
    expect(result.current.timer.running).toBeNull();
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ title: TIMER_PAUSED_OUT.title, body: TIMER_PAUSED_OUT.body('', '11m'), sound: false, notifications: false }),
    );
  });
});
