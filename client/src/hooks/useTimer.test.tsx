// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert, dismissByTag, unlockAudio, warnQuietly } from '../lib/alerts';
import { TIMER_DONE, TIMER_DUE, TIMER_ELSEWHERE, TIMER_PAUSED_OUT } from '../lib/copy';
import { formatCountdown } from '../lib/format';
import { dueKey } from '../lib/timer';
import { AllProviders, apiError, deferred, makeDay, makeSession, makeSettings, MIN, settle, setVisibility, T0, TODAY } from '../test/hooks';
import type { Session } from '../types';
import { useDayStore } from './useDay';
import { useTimer } from './useTimer';

vi.mock('../api');
vi.mock('../lib/alerts');

type Answer = { session: Session };

function renderTimer() {
  return renderHook(() => ({ timer: useTimer(), store: useDayStore() }), { wrapper: AllProviders });
}

/** Renders with `session` running on the server (every poll says so), and waits for the first sync. */
async function renderRunning(session: Session | null = makeSession()) {
  vi.mocked(api.getRunning).mockResolvedValue({ session });
  const r = renderTimer();
  await settle();
  return r;
}

/** A session that started `minutes` ago with the default 25 min plan. */
const startedAgo = (minutes: number, patch: Partial<Session> = {}) => makeSession({ startedAt: Date.now() - minutes * MIN, ...patch });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings());
  vi.mocked(api.getRunning).mockResolvedValue({ session: null });
  vi.mocked(api.getDay).mockResolvedValue(makeDay());
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  document.title = '';
});

describe('sync with the server', () => {
  it('follows the running session on load and counts down from its start', async () => {
    const { result } = await renderRunning(startedAgo(5));
    expect(result.current.timer.running?.id).toBe(1);
    expect(result.current.timer).toMatchObject({ elapsedSeconds: 300, remainingSeconds: 1200, paused: false, due: false });
    expect(result.current.timer.progress).toBeCloseTo(0.2);
    await settle(1000);
    expect(result.current.timer.remainingSeconds).toBe(1199);
    expect(document.title).toBe('19:59 · Write the report — Clockspan');
  });

  it('asks again every minute and when the tab comes back, at most every 5 s', async () => {
    await renderRunning(null);
    expect(api.getRunning).toHaveBeenCalledTimes(1);
    await settle(MIN);
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    expect(api.getRunning).toHaveBeenCalledTimes(2); // 0 s since the last one
    await settle(5000);
    act(() => setVisibility('visible'));
    expect(api.getRunning).toHaveBeenCalledTimes(3);
    await settle();
  });

  it('reloads the days of a session another device started or ended', async () => {
    const { result } = await renderRunning(null);
    vi.mocked(api.getDay).mockClear();
    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: makeSession({ date: '2026-09-27' }) });
    await settle(MIN);
    expect(result.current.timer.running?.date).toBe('2026-09-27');
    expect(vi.mocked(api.getDay).mock.calls).toEqual([['2026-09-27']]);

    // The same session again: nothing to reload.
    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: makeSession({ date: '2026-09-27' }) });
    await settle(MIN);
    expect(api.getDay).toHaveBeenCalledTimes(1);

    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: null });
    await settle(MIN);
    expect(result.current.timer.running).toBeNull();
    expect(api.getDay).toHaveBeenCalledTimes(2);
  });

  it('drops an answer that a local change overtook, and a failed poll quietly', async () => {
    const poll = deferred<{ session: Session | null }>();
    vi.mocked(api.getRunning).mockReturnValueOnce(poll.promise);
    vi.mocked(api.startSession).mockResolvedValue({ session: makeSession() });
    const { result } = renderTimer();
    await act(() => result.current.timer.start(TODAY, 1500, 'Write the report'));
    poll.resolve({ session: null });
    await settle();
    expect(result.current.timer.running?.id).toBe(1);

    vi.mocked(api.getRunning).mockRejectedValueOnce(new Error('offline'));
    await settle(MIN);
    expect(result.current.timer.running?.id).toBe(1);
  });

  it('puts the plain title back on unmount (a sign-out)', async () => {
    const { unmount } = await renderRunning(startedAgo(5));
    expect(document.title).toBe('20:00 · Write the report — Clockspan');
    unmount();
    expect(document.title).toBe('Clockspan');
  });

  it('stops polling on unmount', async () => {
    const { unmount } = await renderRunning(null);
    unmount();
    await settle(5 * MIN);
    act(() => setVisibility('visible'));
    expect(api.getRunning).toHaveBeenCalledTimes(1);
  });
});

describe('start', () => {
  it('unlocks audio, starts on the server and logs the row', async () => {
    vi.mocked(api.startSession).mockResolvedValue({ session: makeSession({ priorityUid: 'u1' }) });
    const { result } = await renderRunning(null);
    // Today is held, as the app always holds it.
    await act(() => result.current.store.load(TODAY));
    await act(() => result.current.timer.start(TODAY, 1500, 'Write the report', 'u1'));
    expect(unlockAudio).toHaveBeenCalled();
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 1500, 'Write the report', 'u1');
    expect(result.current.timer.running?.priorityUid).toBe('u1');
    expect(result.current.store.days[TODAY]?.sessions.map((s) => s.id)).toEqual([1]);
  });

  it('follows a timer another device already runs (409) and says so', async () => {
    const theirs = makeSession({ id: 7, date: '2026-09-27', label: 'Theirs' });
    vi.mocked(api.startSession).mockRejectedValue(apiError(409, { error: 'running', session: theirs }));
    const { result } = await renderRunning(null);
    await act(() => result.current.timer.start(TODAY, 1500, 'Mine'));
    expect(api.startSession).toHaveBeenCalledWith(TODAY, 1500, 'Mine', null);
    expect(result.current.timer.running?.id).toBe(7);
    expect(api.getDay).toHaveBeenCalledWith('2026-09-27');
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_ELSEWHERE.title, tag: 'timer-elsewhere', sound: false }));
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
  it('changes the plan at once and adopts the stored session', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.patchSession).mockResolvedValue({ session: startedAgo(5, { plannedSeconds: 1800, label: 'Stored' }) });
    await act(() => result.current.timer.adjust(5 * 60));
    expect(api.patchSession).toHaveBeenCalledWith(1, { plannedSeconds: 1800 });
    expect(result.current.timer.running).toMatchObject({ plannedSeconds: 1800, label: 'Stored' });
  });

  it('compounds rapid presses, shows the newest at once, and sends them in order', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const first = deferred<Answer>();
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
    const first = deferred<Answer>();
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
    expect(warnQuietly).toHaveBeenCalledTimes(1);
  });

  it('never brings a finished timer back when a + before the finish fails late', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const plus = deferred<Answer>();
    vi.mocked(api.patchSession).mockReturnValueOnce(plus.promise);
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(5, { status: 'completed', durationSeconds: 300 }) });
    let a!: Promise<void>;
    let f!: Promise<void>;
    act(() => {
      a = result.current.timer.adjust(5 * 60);
      f = result.current.timer.finish();
    });
    plus.reject(new Error('offline'));
    await act(() => a);
    await act(() => f);
    expect(api.finishSession).toHaveBeenCalledWith(1, false);
    expect(result.current.timer.running).toBeNull();
    expect(result.current.timer.finished).toMatchObject({ id: 1, status: 'completed' });
    // The server has nothing running now, and the next sync agrees.
    vi.mocked(api.getRunning).mockResolvedValue({ session: null });
    await settle(MIN);
    expect(result.current.timer.running).toBeNull();
  });

  it('never plans under a minute', async () => {
    const { result } = await renderRunning(startedAgo(0.5, { plannedSeconds: 120 }));
    vi.mocked(api.patchSession).mockResolvedValue({ session: startedAgo(0.5, { plannedSeconds: 60 }) });
    await act(() => result.current.timer.adjust(-5 * 60));
    expect(api.patchSession).toHaveBeenCalledWith(1, { plannedSeconds: 60 });
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
    expect(warnQuietly).not.toHaveBeenCalled();
  });

  it('plans whole minutes, so a minute over the new end is a whole minute', async () => {
    // 25 min 37 s into a 25 min plan.
    const session = makeSession({ startedAt: T0 - 1537 * 1000 });
    const { result } = await renderRunning(session);
    const longer = { ...session, plannedSeconds: 31 * 60 };
    vi.mocked(api.patchSession).mockResolvedValue({ session: longer });
    await act(() => result.current.timer.adjust(5 * 60));
    // Five minutes from now, up to the next whole minute: 31:00, not 30:37.
    expect(api.patchSession).toHaveBeenCalledWith(1, { plannedSeconds: 31 * 60 });
    expect(result.current.timer.remainingSeconds).toBe(31 * 60 - 1537);

    // 23 s past the new end, Finish has nothing to ask.
    vi.mocked(api.getRunning).mockResolvedValue({ session: longer });
    vi.mocked(api.finishSession).mockResolvedValue({ session: { ...longer, status: 'completed', durationSeconds: 31 * 60 } });
    await settle((31 * 60 - 1537 + 23) * 1000);
    expect(result.current.timer.overrunSeconds).toBe(23);
    act(() => result.current.timer.requestFinish());
    expect(result.current.timer.finishChoice).toBe(false);
    await settle();
    expect(api.finishSession).toHaveBeenCalledWith(1, false);
  });

  it('finishes when the new plan is already used up', async () => {
    const { result } = await renderRunning(startedAgo(1.5, { plannedSeconds: 120 }));
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(1.5, { status: 'completed', durationSeconds: 90 }) });
    await act(() => result.current.timer.adjust(-5 * 60));
    expect(api.patchSession).not.toHaveBeenCalled();
    expect(api.finishSession).toHaveBeenCalledWith(1);
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions[0]?.durationSeconds).toBe(90);
    expect(result.current.timer.finished).toMatchObject({ id: 1, status: 'completed', durationSeconds: 90 });
  });

  it('reports no finish when shrinking finds it cancelled elsewhere', async () => {
    const { result } = await renderRunning(startedAgo(1.5, { plannedSeconds: 120 }));
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(1.5, { status: 'cancelled' }) });
    await act(() => result.current.timer.adjust(-5 * 60));
    expect(result.current.timer.running).toBeNull();
    expect(result.current.timer.finished).toBeNull();
  });

  it('once due, +N means N minutes from now', async () => {
    const { result } = await renderRunning(startedAgo(27));
    expect(result.current.timer).toMatchObject({ due: true, overrunSeconds: 120, remainingSeconds: 0 });
    expect(document.title).toBe(`${formatCountdown(-120)} · Write the report — Clockspan`);
    vi.mocked(api.patchSession).mockResolvedValue({ session: startedAgo(27, { plannedSeconds: 32 * 60 }) });
    await act(() => result.current.timer.adjust(5 * 60));
    expect(api.patchSession).toHaveBeenCalledWith(1, { plannedSeconds: 32 * 60 });
    expect(result.current.timer).toMatchObject({ due: false, remainingSeconds: 300 });
  });

  it('puts the old plan back and re-syncs when the session is gone (404)', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.patchSession).mockRejectedValue(apiError(404));
    vi.mocked(api.getRunning).mockResolvedValue({ session: null });
    let done!: Promise<void>;
    act(() => {
      done = result.current.timer.adjust(5 * 60);
    });
    expect(result.current.timer.running?.plannedSeconds).toBe(1800);
    await act(() => done);
    expect(warnQuietly).toHaveBeenCalledWith(expect.objectContaining({ tag: 'save-failed' }));
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    await settle();
    expect(result.current.timer.running).toBeNull();
  });

  it('re-syncs after a 404 with a sync sent after it, not the one already out', async () => {
    const session = startedAgo(5);
    const { result } = await renderRunning(session);
    // The minute's sync goes out before the phone ends the session, and answers late.
    const minute = deferred<{ session: Session | null }>();
    vi.mocked(api.getRunning).mockReturnValueOnce(minute.promise).mockResolvedValue({ session: null });
    await settle(MIN);
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
    expect(warnQuietly).toHaveBeenCalledTimes(1);
    expect(api.getRunning).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a running session', async () => {
    const { result } = await renderRunning(null);
    await act(() => result.current.timer.adjust(60));
    await act(() => result.current.timer.setLabel('x'));
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
});

describe('setLabel', () => {
  it('renames at once and keeps the stored label', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.patchSession).mockResolvedValue({ session: startedAgo(5, { label: 'Stored name' }) });
    await act(() => result.current.timer.setLabel('Typed name'));
    expect(api.patchSession).toHaveBeenCalledWith(1, { label: 'Typed name' });
    expect(result.current.timer.running?.label).toBe('Stored name');
  });

  it('puts the old label back when the save fails', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.patchSession).mockRejectedValue(new Error('offline'));
    await act(() => result.current.timer.setLabel('Typed name'));
    expect(result.current.timer.running?.label).toBe('Write the report');
  });

  it('leaves the session a sync showed alone when the rename answers after it', async () => {
    const { result } = await renderRunning(startedAgo(5));
    // Finished on the phone and the next one started there, and this tab's sync saw it before
    // the rename answered: the answer only says what became of the renamed row.
    const rename = deferred<Answer>();
    vi.mocked(api.patchSession).mockReturnValueOnce(rename.promise);
    let a!: Promise<void>;
    act(() => {
      a = result.current.timer.setLabel('Renamed');
    });
    vi.mocked(api.getRunning).mockResolvedValue({ session: makeSession({ id: 3, label: 'Third' }) });
    await settle(MIN);
    expect(result.current.timer.running).toMatchObject({ id: 3, label: 'Third' });
    rename.resolve({ session: startedAgo(5, { label: 'Renamed', status: 'completed', endedAt: T0, durationSeconds: 300 }) });
    await act(() => a);
    expect(result.current.timer.running).toMatchObject({ id: 3, label: 'Third' });
    expect(result.current.store.days[TODAY]?.sessions.find((s) => s.id === 1)).toMatchObject({ status: 'completed', label: 'Renamed' });

    // Ended on the phone with nothing after it: an answer from before that doesn't bring it back.
    const late = deferred<Answer>();
    vi.mocked(api.patchSession).mockReturnValueOnce(late.promise);
    let b!: Promise<void>;
    act(() => {
      b = result.current.timer.setLabel('Third, renamed');
    });
    vi.mocked(api.getRunning).mockResolvedValue({ session: null });
    await settle(MIN);
    late.resolve({ session: makeSession({ id: 3, label: 'Third, renamed' }) });
    await act(() => b);
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions.some((s) => s.status === 'running')).toBe(false);

    // Replaced by another device's session before the rename fails: nothing to put back.
    vi.mocked(api.startSession).mockResolvedValue({ session: makeSession({ id: 2, label: 'Next' }) });
    await act(() => result.current.timer.start(TODAY, 1500, 'Next'));
    const failing = deferred<Answer>();
    vi.mocked(api.patchSession).mockReturnValueOnce(failing.promise);
    let c!: Promise<void>;
    act(() => {
      c = result.current.timer.setLabel('Next, renamed');
    });
    vi.mocked(api.getRunning).mockResolvedValue({ session: makeSession({ id: 4, label: 'Fourth' }) });
    await settle(MIN);
    failing.reject(new Error('offline'));
    await act(() => c);
    expect(result.current.timer.running).toMatchObject({ id: 4, label: 'Fourth' });
  });
});

describe("the day's log", () => {
  it('takes the answer to every press on the running session', async () => {
    const { result } = await renderRunning(startedAgo(5));
    await act(() => result.current.store.load(TODAY));
    const row = () => result.current.store.days[TODAY]?.sessions.find((s) => s.id === 1);
    vi.mocked(api.patchSession).mockImplementation(async (_id, patch) => ({ session: startedAgo(5, patch) }));
    await act(() => result.current.timer.setLabel('Renamed in the bar'));
    expect(row()).toMatchObject({ label: 'Renamed in the bar', status: 'running' });
    await act(() => result.current.timer.adjust(5 * 60));
    expect(row()?.plannedSeconds).toBe(1800);
    let e!: Promise<void>;
    act(() => {
      e = result.current.timer.edit({ label: 'Linked', priorityUid: 'u1' });
    });
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
      session: startedAgo(5, { label: 'Renamed', status: 'completed', endedAt: T0, durationSeconds: 300 }),
    });
    await act(() => result.current.timer.setLabel('Renamed'));
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions[0]).toMatchObject({ status: 'completed', label: 'Renamed' });
  });

  it('keeps the pause another device made when a sync lands under a pause of its own', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const pausing = deferred<Answer>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(pausing.promise);
    let p!: Promise<void>;
    act(() => {
      p = result.current.timer.pause();
    });
    const elsewhere = startedAgo(5, { pausedAt: T0 - 2 * MIN });
    vi.mocked(api.getRunning).mockResolvedValue({ session: elsewhere });
    await settle(MIN);
    expect(result.current.timer.running?.pausedAt).toBe(T0 - 2 * MIN);
    pausing.resolve({ session: elsewhere });
    await act(() => p);
    expect(result.current.timer.running?.pausedAt).toBe(T0 - 2 * MIN);
  });

  it('keeps a resume another device made when a sync lands under a resume of its own', async () => {
    const { result } = await renderRunning(startedAgo(15, { pausedAt: T0 - 10 * MIN }));
    const resuming = deferred<Answer>();
    vi.mocked(api.resumeSession).mockReturnValueOnce(resuming.promise);
    let r!: Promise<void>;
    act(() => {
      r = result.current.timer.resume();
    });
    // The phone resumed it first, and banked a shorter pause.
    const elsewhere = startedAgo(15, { pausedSeconds: 300 });
    vi.mocked(api.getRunning).mockResolvedValue({ session: elsewhere });
    await settle(MIN);
    expect(result.current.timer.running).toMatchObject({ pausedAt: null, pausedSeconds: 300 });
    resuming.resolve({ session: elsewhere });
    await act(() => r);
    expect(result.current.timer.running).toMatchObject({ pausedAt: null, pausedSeconds: 300 });
  });
});

describe('pause and resume', () => {
  it('pauses at once, holds the countdown and logs the pill on the day', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.pauseSession).mockResolvedValue({ session: startedAgo(5, { pausedAt: T0 }) });
    await act(() => result.current.timer.pause());
    expect(result.current.timer).toMatchObject({ paused: true, remainingSeconds: 1200 });
    expect(result.current.store.days[TODAY]?.sessions[0]?.pausedAt).toBe(T0);
    vi.mocked(api.getRunning).mockResolvedValue({ session: startedAgo(5, { pausedAt: T0 }) });
    await settle(10 * MIN);
    expect(result.current.timer.remainingSeconds).toBe(1200);
    expect(document.title).toBe('Paused 20:00 · Write the report — Clockspan');
    // A second pause is a no-op.
    await act(() => result.current.timer.pause());
    expect(api.pauseSession).toHaveBeenCalledTimes(1);
  });

  it('resumes with the pause counted, and a second resume is a no-op', async () => {
    const { result } = await renderRunning(startedAgo(15, { pausedAt: T0 - 10 * MIN }));
    vi.mocked(api.resumeSession).mockResolvedValue({ session: startedAgo(15, { pausedSeconds: 600 }) });
    let done!: Promise<void>;
    act(() => {
      done = result.current.timer.resume();
    });
    expect(result.current.timer.running).toMatchObject({ pausedAt: null, pausedSeconds: 600 });
    await act(() => done);
    expect(result.current.timer).toMatchObject({ paused: false, remainingSeconds: 1200 });
    await act(() => result.current.timer.resume());
    expect(api.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('puts the pause fields back when either fails', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.pauseSession).mockRejectedValue(new Error('offline'));
    await act(() => result.current.timer.pause());
    expect(result.current.timer.running).toMatchObject({ pausedAt: null, pausedSeconds: 0 });

    vi.mocked(api.pauseSession).mockResolvedValue({ session: startedAgo(5, { pausedAt: T0 }) });
    await act(() => result.current.timer.pause());
    vi.mocked(api.resumeSession).mockRejectedValue(new Error('offline'));
    await act(() => result.current.timer.resume());
    expect(result.current.timer.running).toMatchObject({ pausedAt: T0, pausedSeconds: 0 });
    expect(warnQuietly).toHaveBeenCalledTimes(2);
  });

  it('keeps the newer state when a pause and a resume cross', async () => {
    const { result } = await renderRunning(startedAgo(5));
    const paused = deferred<Answer>();
    const resumed = deferred<Answer>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(paused.promise);
    vi.mocked(api.resumeSession).mockReturnValueOnce(resumed.promise);
    let p!: Promise<void>;
    let r!: Promise<void>;
    act(() => {
      p = result.current.timer.pause();
    });
    act(() => {
      r = result.current.timer.resume();
    });
    paused.resolve({ session: startedAgo(5, { pausedAt: T0 }) });
    await act(() => p);
    expect(result.current.timer.paused).toBe(false);

    // And the other way round: the resume's answer lands after a new pause.
    const pausedAgain = deferred<Answer>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(pausedAgain.promise);
    act(() => void result.current.timer.pause());
    resumed.resolve({ session: startedAgo(5) });
    await act(() => r);
    expect(result.current.timer.paused).toBe(true);
    pausedAgain.resolve({ session: startedAgo(5, { pausedAt: T0 }) });
    await settle();
  });

  it('an answer that comes after a sync showed the session end leaves what the sync showed', async () => {
    const { result } = await renderRunning(startedAgo(5));
    // The server paused it, then the phone finished it and started another, and this tab's sync
    // saw that before the pause's answer arrived.
    const pausing = deferred<Answer>();
    vi.mocked(api.pauseSession).mockReturnValueOnce(pausing.promise);
    let p!: Promise<void>;
    act(() => {
      p = result.current.timer.pause();
    });
    const third = makeSession({ id: 3, label: 'Third', startedAt: Date.now() - MIN, pausedAt: Date.now() });
    vi.mocked(api.getRunning).mockResolvedValue({ session: third });
    await settle(MIN);
    pausing.resolve({ session: startedAgo(6, { pausedAt: T0 }) });
    await act(() => p);
    expect(result.current.timer.running).toMatchObject({ id: 3, label: 'Third' });
    expect(result.current.store.days[TODAY]?.sessions.map((s) => s.id)).not.toContain(1);

    // Resumed here, ended on the phone, and synced before the resume answered.
    const resuming = deferred<Answer>();
    vi.mocked(api.resumeSession).mockReturnValueOnce(resuming.promise);
    let r!: Promise<void>;
    act(() => {
      r = result.current.timer.resume();
    });
    vi.mocked(api.getRunning).mockResolvedValue({ session: null });
    await settle(MIN);
    resuming.resolve({ session: { ...third, pausedAt: null, pausedSeconds: 60 } });
    await act(() => r);
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions.some((s) => s.status === 'running')).toBe(false);
  });

  it('closes a pause left for an hour, quietly, logging the time before it', async () => {
    const { result } = await renderRunning(startedAgo(70, { pausedAt: T0 - 59 * MIN, label: '' }));
    expect(api.finishSession).not.toHaveBeenCalled();
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(71, { status: 'completed', durationSeconds: null }) });
    await settle(MIN);
    expect(api.finishSession).toHaveBeenCalledWith(1);
    expect(result.current.timer.running).toBeNull();
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ title: TIMER_PAUSED_OUT.title, body: TIMER_PAUSED_OUT.body('', '0m'), sound: false, notifications: false }),
    );
  });
});

describe('finish and cancel', () => {
  it('finish logs the session and clears the timer', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(5, { status: 'completed', durationSeconds: 300 }) });
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
    const plus = deferred<Answer>();
    vi.mocked(api.patchSession).mockReturnValueOnce(plus.promise);
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(5, { status: 'completed', durationSeconds: 300 }) });
    let a!: Promise<void>;
    let f!: Promise<void>;
    act(() => {
      a = result.current.timer.adjust(5 * 60);
      f = result.current.timer.finish();
    });
    vi.mocked(api.getRunning).mockResolvedValue({ session: makeSession({ id: 3, label: 'Third' }) });
    await settle(MIN);
    plus.reject(apiError(409));
    await act(() => a);
    await act(() => f);
    expect(api.finishSession).toHaveBeenCalledWith(1, false);
    expect(result.current.timer.running).toMatchObject({ id: 3, label: 'Third' });
    expect(result.current.store.days[TODAY]?.sessions.find((s) => s.id === 1)?.status).toBe('completed');
  });

  it('reports no finish for a session the server says was cancelled elsewhere', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(5, { status: 'cancelled' }) });
    await act(() => result.current.timer.finish());
    expect(result.current.timer.running).toBeNull();
    expect(result.current.timer.finished).toBeNull();
  });

  it('cancel drops the row and clears the timer; a 409 re-syncs', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.cancelSession)
      .mockRejectedValueOnce(apiError(409))
      .mockResolvedValueOnce({ session: startedAgo(5, { status: 'cancelled' }) });
    await act(() => result.current.timer.cancel());
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    await settle();
    await act(() => result.current.timer.cancel());
    expect(result.current.timer.running).toBeNull();
    expect(result.current.store.days[TODAY]?.sessions).toEqual([]);
    expect(result.current.timer.finished).toBeNull();
  });

  it('requestFinish finishes at once before the end and under a minute past it', async () => {
    const { result } = await renderRunning(startedAgo(5));
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(5, { status: 'completed', durationSeconds: 300 }) });
    act(() => result.current.timer.requestFinish());
    await settle();
    expect(api.finishSession).toHaveBeenCalledTimes(1);

    // 25 min 30 s in when the next poll brings it: both lengths are 25 whole minutes.
    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: startedAgo(24.5) });
    await settle(MIN);
    act(() => result.current.timer.requestFinish());
    await settle();
    expect(api.finishSession).toHaveBeenCalledTimes(2);
    expect(result.current.timer.finishChoice).toBe(false);
  });

  it('requestFinish asks which length to log a minute or more past the end', async () => {
    const { result } = await renderRunning(startedAgo(27));
    act(() => result.current.timer.requestFinish());
    expect(result.current.timer.finishChoice).toBe(true);
    expect(api.finishSession).not.toHaveBeenCalled();
    act(() => result.current.timer.dismissFinishChoice());
    expect(result.current.timer.finishChoice).toBe(false);

    act(() => result.current.timer.requestFinish());
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(27, { status: 'completed', durationSeconds: 27 * 60 }) });
    await act(() => result.current.timer.finish(true));
    expect(result.current.timer.finishChoice).toBe(false);
  });

  it('the choice closes when the session ends elsewhere, and stays shut for the next one', async () => {
    const { result } = await renderRunning(startedAgo(27));
    act(() => result.current.timer.requestFinish());
    vi.mocked(api.getRunning).mockResolvedValueOnce({ session: null });
    await settle(MIN);
    expect(result.current.timer.finishChoice).toBe(false);
    vi.mocked(api.startSession).mockResolvedValue({ session: makeSession({ id: 2, startedAt: Date.now() }) });
    await act(() => result.current.timer.start(TODAY, 1500, 'Next'));
    expect(result.current.timer.finishChoice).toBe(false);
  });

  it('the choice goes with a session that finished on its own', async () => {
    const { result } = await renderRunning(startedAgo(34.9));
    act(() => result.current.timer.requestFinish());
    expect(result.current.timer.finishChoice).toBe(true);
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(35, { status: 'completed', durationSeconds: 1500 }) });
    vi.mocked(api.getRunning).mockResolvedValue({ session: null });
    await settle(6000);
    expect(result.current.timer.running).toBeNull();
    vi.mocked(api.startSession).mockResolvedValue({ session: makeSession({ id: 2, startedAt: Date.now() }) });
    await act(() => result.current.timer.start(TODAY, 1500, 'Next'));
    expect(result.current.timer.running?.id).toBe(2);
    expect(result.current.timer.finishChoice).toBe(false);
  });
});

describe("time's up", () => {
  it('announces once per planned end, with the chime and a button that adds time', async () => {
    const { result, unmount } = await renderRunning(startedAgo(24.9));
    expect(alert).not.toHaveBeenCalled();
    await settle(6000);
    expect(result.current.timer.due).toBe(true);
    const endAt = T0 - 24.9 * MIN + 25 * MIN;
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
    vi.mocked(api.patchSession).mockImplementation(async (_id, patch) => ({ session: startedAgo(0, { ...patch, startedAt: T0 - 24.9 * MIN }) }));
    const action = vi.mocked(alert).mock.calls[0]![0].action!;
    expect(action.label).toBe(TIMER_DUE.more(makeSettings().adjustStepMinutes));
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
    await settle(3 * MIN);
    expect(alert).toHaveBeenCalledTimes(1);
    await settle(2 * MIN);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(vi.mocked(alert).mock.lastCall![0]).toMatchObject({ tag: 'timer-due', sound: false, notifications: false, action: undefined });
  });

  it('shows the banner again after a reload without a second chime', async () => {
    const session = startedAgo(26);
    localStorage.setItem('focus:timer-due', dueKey(1, session.startedAt + 25 * MIN));
    await renderRunning(session);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ tag: 'timer-due', sound: false, notifications: false }));
  });

  it('waits for the settings before any alert, so the right sound plays', async () => {
    const settings = deferred<ReturnType<typeof makeSettings>>();
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
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(35, { status: 'completed', durationSeconds: 1500, label: '' }) });
    await settle(6000);
    expect(api.finishSession).toHaveBeenCalledWith(1);
    expect(result.current.timer.running).toBeNull();
    // Nobody pressed Finish: nothing for a break suggestion to follow.
    expect(result.current.timer.finished).toBeNull();
    expect(alert).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: TIMER_DONE.title, body: TIMER_DONE.body('', '25m'), sound: false, notifications: false }),
    );
  });

  it('chimes the completion for a session that ran out while the page was closed', async () => {
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(45, { status: 'completed', durationSeconds: null }) });
    const { result } = await renderRunning(startedAgo(45));
    await settle();
    expect(result.current.timer.running).toBeNull();
    // Found past the grace: no due banner, just the completion.
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_DONE.title, body: TIMER_DONE.body('Write the report', '0m'), sound: true }));
  });

  it('says nothing when the server reports it was cancelled elsewhere', async () => {
    vi.mocked(api.finishSession).mockResolvedValue({ session: startedAgo(45, { status: 'cancelled' }) });
    const { result } = await renderRunning(startedAgo(45));
    await settle();
    expect(result.current.timer.running).toBeNull();
    expect(alert).not.toHaveBeenCalled();
  });

  it('retries a failed auto-finish, 2 s doubling, one request at a time', async () => {
    const first = deferred<Answer>();
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
    vi.mocked(api.finishSession).mockResolvedValueOnce({ session: startedAgo(45, { status: 'completed', durationSeconds: 1500 }) });
    await settle(1000);
    expect(api.finishSession).toHaveBeenCalledTimes(3);
    expect(result.current.timer.running).toBeNull();
  });
});

it('useTimer refuses to run outside the provider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderHook(() => useTimer())).toThrow('useTimer outside TimerProvider');
});
