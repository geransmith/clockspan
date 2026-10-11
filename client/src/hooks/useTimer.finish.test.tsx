// @vitest-environment happy-dom
import { act, cleanup } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert, warnSaveFailed } from '../lib/alerts';
import { TIMER_DONE } from '../lib/copy';
import { MINUTE_MS } from '../../../shared/dates.js';
import {
  answered,
  apiError,
  begin,
  deferredAnswer,
  echoPriorities,
  endSession,
  makeDay,
  makePriority,
  makeSession,
  refused,
  settle,
  TODAY,
  YESTERDAY,
} from '../test/hooks';
import type { Session, SessionResponse } from '../types';
import { renderRunning, startedAgo } from './useTimer.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

describe('finish and cancel', () => {
  it('finish logs the session and clears the timer', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(5), { durationSeconds: 300 }) }));
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
    const plus = deferredAnswer<SessionResponse>();
    vi.mocked(api.patchSession).mockReturnValueOnce(plus.promise);
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(5), { durationSeconds: 300 }) }));
    let a!: Promise<void>;
    let f!: Promise<void>;
    act(() => {
      a = result.current.timer.adjust(5 * 60);
      f = result.current.timer.finish();
    });
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: makeSession({ id: 3, label: 'Third' }) }));
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
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(5), { status: 'cancelled' }) }));
    await act(() => result.current.timer.finish());
    expect(result.current.timer.running).toBeNull();
    expect(result.current.timer.finished).toBeNull();
  });

  it('cancel drops the row and clears the timer; a 409 re-syncs', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.cancelSession)
      .mockImplementationOnce(() => refused(409))
      .mockResolvedValueOnce(answered({ session: endSession(startedAgo(5), { status: 'cancelled' }) }));
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
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(5), { durationSeconds: 300 }) }));
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
    const finishing = deferredAnswer<SessionResponse>();
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
    vi.mocked(api.getRunning).mockResolvedValueOnce(answered({ session: null }));
    await settle(MINUTE_MS);
    expect(result.current.timer.finishChoice).toBeNull();
    // SQLite gives a new row the id of a deleted newest one.
    vi.mocked(api.startSession).mockResolvedValue(answered({ session: makeSession({ id: 1, startedAt: Date.now() }) }));
    await act(() => result.current.timer.start(TODAY, 1500, 'Next'));
    expect(result.current.timer.finishChoice).toBeNull();
  });

  it('the choice closes for good when another device moves the end', async () => {
    const session = startedAgo(27);
    const { result } = await renderRunning(session);
    act(() => result.current.timer.requestFinish());
    expect(result.current.timer.finishChoice).not.toBeNull();
    vi.mocked(api.getRunning).mockResolvedValueOnce(answered({ session: { ...session, plannedSeconds: 33 * 60 } }));
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
    const finishing = deferredAnswer<SessionResponse>();
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

describe('Done', () => {
  const row = makePriority(1, 'Ship the fix', { uid: 'u1' });
  const rect = { left: 10, top: 20, width: 30, height: 40 } as DOMRect;
  /** The row's tick as the last list sent carries it. */
  const sentTick = () => vi.mocked(api.putPriorities).mock.lastCall?.[1].find((p) => p.uid === 'u1')?.done;

  /** Renders with `session` running and today's list holding `row`, whose saves the server takes as sent. */
  async function renderOnRow(session: Session) {
    vi.mocked(api.getDay).mockResolvedValue(answered(makeDay(TODAY, { priorities: [row] })));
    vi.mocked(api.putPriorities).mockImplementation(echoPriorities);
    return renderRunning(session);
  }

  it("is offered while the session's task has an open row on its day", async () => {
    const { result } = await renderOnRow(startedAgo(5, { priorityUid: 'u1' }));
    expect(result.current.timer.taskOpen).toBe(true);
    // Ticked on the sheet, the board or another device: Finish is left.
    act(() => void result.current.store.setPriorities(TODAY, [{ ...row, done: true }], [row]));
    expect(result.current.timer.taskOpen).toBe(false);
    await settle();
    cleanup();
    expect((await renderOnRow(startedAgo(5))).result.current.timer.taskOpen).toBe(false);
    cleanup();
    // A session from before midnight, after a reload: the store doesn't hold its day.
    expect((await renderOnRow(startedAgo(5, { priorityUid: 'u1', date: YESTERDAY }))).result.current.timer.taskOpen).toBe(false);
  });

  it('finishes, then ticks the task and raises the moment from where it was pressed', async () => {
    const session = startedAgo(5, { priorityUid: 'u1' });
    const { result } = await renderOnRow(session);
    const finishing = deferredAnswer<SessionResponse>();
    vi.mocked(api.finishSession).mockReturnValueOnce(finishing.promise);
    act(() => result.current.timer.requestDone(rect));
    await settle();
    expect(api.finishSession).toHaveBeenCalledWith(1, false);
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(result.current.timer.ticked).toBeNull();
    finishing.resolve({ session: endSession(session, { durationSeconds: 300 }) });
    await settle();
    expect(sentTick()).toBe(true);
    expect(result.current.store.days[TODAY]?.priorities[0]?.done).toBe(true);
    expect(result.current.timer.ticked).toEqual({ at: rect });
    expect(result.current.timer.finished).toMatchObject({ id: 1, status: 'completed' });
    expect(result.current.timer.running).toBeNull();
  });

  it('asks how much to log a minute or more past the end, and only its answer ticks', async () => {
    const session = startedAgo(27, { priorityUid: 'u1' });
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(session, { durationSeconds: 27 * 60 }) }));
    let { result } = await renderOnRow(session);
    // Back, then Finish: the question Finish asks logs without the tick.
    act(() => result.current.timer.requestDone(rect));
    expect(result.current.timer.finishChoice).toBe(result.current.timer.running);
    expect(api.finishSession).not.toHaveBeenCalled();
    act(() => result.current.timer.dismissFinishChoice());
    act(() => result.current.timer.requestFinish());
    await act(() => result.current.timer.finish());
    expect(api.finishSession).toHaveBeenCalledWith(1, false);
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(result.current.timer.ticked).toBeNull();
    cleanup();

    ({ result } = await renderOnRow(session));
    act(() => result.current.timer.requestDone(rect));
    await act(() => result.current.timer.finish(true));
    expect(api.finishSession).toHaveBeenLastCalledWith(1, true);
    await settle();
    expect(sentTick()).toBe(true);
    expect(result.current.timer.ticked).toEqual({ at: rect });
  });

  it('ticks once when its question is answered twice before the finish is in', async () => {
    const session = startedAgo(27, { priorityUid: 'u1' });
    const finishing = deferredAnswer<SessionResponse>();
    vi.mocked(api.finishSession)
      .mockReturnValueOnce(finishing.promise)
      .mockResolvedValue(answered({ session: endSession(session, { durationSeconds: 25 * 60 }) }));
    const { result } = await renderOnRow(session);
    act(() => result.current.timer.requestDone(rect));
    // Planned, pressed twice: the second finish goes out behind the first.
    act(() => {
      void result.current.timer.finish();
      void result.current.timer.finish();
    });
    finishing.resolve({ session: endSession(session, { durationSeconds: 25 * 60 }) });
    await settle();
    expect(api.finishSession).toHaveBeenCalledTimes(2);
    expect(api.putPriorities).toHaveBeenCalledOnce();
    expect(result.current.timer.ticked).toEqual({ at: rect });
  });

  it('is not what Finish or − past the time worked does: both log without the tick', async () => {
    const session = startedAgo(5, { priorityUid: 'u1' });
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(session, { durationSeconds: 300 }) }));
    let { result } = await renderOnRow(session);
    act(() => result.current.timer.requestFinish());
    await settle();
    expect(result.current.timer.finished).toMatchObject({ id: 1 });
    cleanup();
    ({ result } = await renderOnRow(session));
    await act(() => result.current.timer.adjust(-25 * 60));
    expect(api.finishSession).toHaveBeenCalledTimes(2);
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(result.current.timer.ticked).toBeNull();
  });

  it('ticks nothing when the finish fails, and the session runs on with Done to press again', async () => {
    const session = startedAgo(5, { priorityUid: 'u1' });
    const { result } = await renderOnRow(session);
    vi.mocked(api.finishSession).mockRejectedValueOnce(new Error('offline'));
    act(() => result.current.timer.requestDone(rect));
    await settle();
    expect(warnSaveFailed).toHaveBeenCalledOnce();
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(result.current.timer.ticked).toBeNull();
    expect(result.current.timer.running?.id).toBe(1);
    expect(result.current.timer.taskOpen).toBe(true);

    vi.mocked(api.finishSession).mockResolvedValueOnce(answered({ session: endSession(session, { durationSeconds: 300 }) }));
    act(() => result.current.timer.requestDone(rect));
    await settle();
    expect(sentTick()).toBe(true);
  });

  it('ticks nothing when the finish answers the session cancelled elsewhere, or on no task', async () => {
    const session = startedAgo(5, { priorityUid: 'u1' });
    let { result } = await renderOnRow(session);
    vi.mocked(api.finishSession).mockResolvedValueOnce(answered({ session: endSession(session, { status: 'cancelled' }) }));
    act(() => result.current.timer.requestDone(rect));
    await settle();
    expect(result.current.timer.finished).toBeNull();
    cleanup();
    // Set to Unplanned on another device before the finish reached the server.
    ({ result } = await renderOnRow(session));
    vi.mocked(api.finishSession).mockResolvedValueOnce(answered({ session: endSession({ ...session, priorityUid: null }, { durationSeconds: 300 }) }));
    act(() => result.current.timer.requestDone(rect));
    await settle();
    expect(result.current.timer.finished).toMatchObject({ id: 1, status: 'completed' });
    expect(api.putPriorities).not.toHaveBeenCalled();
    expect(result.current.timer.ticked).toBeNull();
  });
});
