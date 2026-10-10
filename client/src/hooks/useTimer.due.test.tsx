// @vitest-environment happy-dom
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { alert, dismissByTag, warnSaveFailed } from '../lib/alerts';
import { TIMER_DONE, TIMER_DUE } from '../lib/copy';
import { dueKey } from '../lib/timer';
import { MINUTE_MS } from '../../../shared/dates.js';
import { answered, deferredAnswer, endSession, makeSession, makeSettings, refused, setVisibility, settle, T0 } from '../test/hooks';
import type { RunningResponse, SessionResponse, Settings } from '../types';
import { renderRunning, startedAgo } from './useTimer.testkit';

vi.mock('../api');
vi.mock('../lib/alerts');

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
    vi.mocked(api.patchSession).mockImplementation(async (_id, patch) => answered({ session: makeSession({ ...patch, startedAt: T0 - 24.9 * MINUTE_MS }) }));
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
    const settings = deferredAnswer<Settings>();
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
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(35, { label: '' }), { durationSeconds: 1500 }) }));
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
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(35), { durationSeconds: 1500 }) }));
    await settle(6000);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenLastCalledWith(expect.objectContaining({ title: TIMER_DONE.title, sound: false, notifications: false }));
  });

  it('finishes quietly on a page opened past the grace when that end already chimed', async () => {
    const session = startedAgo(45);
    // The page that chimed was closed or reloaded before the grace ran out.
    localStorage.setItem('focus:timer-due', dueKey(1, session.startedAt + 25 * MINUTE_MS));
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(45), { durationSeconds: 1500 }) }));
    const { result } = await renderRunning(session);
    await settle();
    expect(result.current.timer.running).toBeNull();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_DONE.title, sound: false, notifications: false }));
  });

  it('chimes the completion for a session that ran out while the page was closed', async () => {
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(45)) }));
    const { result } = await renderRunning(startedAgo(45));
    await settle();
    expect(result.current.timer.running).toBeNull();
    // Found past the grace: no due banner, just the completion.
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: TIMER_DONE.title, body: TIMER_DONE.body('Write the report', '25m'), sound: true }));
  });

  it('says nothing when the server reports it was cancelled elsewhere', async () => {
    vi.mocked(api.finishSession).mockResolvedValue(answered({ session: endSession(startedAgo(45), { status: 'cancelled' }) }));
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
    const sync = deferredAnswer<RunningResponse>();
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
    vi.mocked(api.finishSession).mockImplementationOnce(() => refused(409));
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: { ...session, plannedSeconds: 40 * 60 } }));
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
    vi.mocked(api.finishSession).mockImplementationOnce(() => refused(404));
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: null }));
    await settle(6000);
    expect(api.finishSession).toHaveBeenCalledWith(1, false, { plannedSeconds: 1500, pausedAt: null });
    expect(api.getRunning).toHaveBeenCalledTimes(2);
    expect(result.current.timer.running).toBeNull();
    await settle(5000);
    expect(api.finishSession).toHaveBeenCalledTimes(1);
  });

  it('retries a failed auto-finish, 2 s doubling, one request at a time', async () => {
    const first = deferredAnswer<SessionResponse>();
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
    vi.mocked(api.finishSession).mockResolvedValueOnce(answered({ session: endSession(startedAgo(45), { durationSeconds: 1500 }) }));
    await settle(1000);
    expect(api.finishSession).toHaveBeenCalledTimes(3);
    expect(result.current.timer.running).toBeNull();

    // A later session's first failed auto-finish waits 2 s again, not the wait the last one grew to.
    vi.mocked(api.getRunning).mockResolvedValue(answered({ session: startedAgo(45, { id: 2 }) }));
    vi.mocked(api.finishSession).mockRejectedValueOnce(new Error('offline'));
    act(() => void window.dispatchEvent(new CustomEvent(api.CHANGED_ELSEWHERE, { detail: 0 })));
    await settle();
    expect(api.finishSession).toHaveBeenCalledTimes(4);
    vi.mocked(api.finishSession).mockResolvedValueOnce(answered({ session: endSession(startedAgo(45, { id: 2 }), { durationSeconds: 1500 }) }));
    await settle(1000);
    expect(api.finishSession).toHaveBeenCalledTimes(4);
    await settle(1000);
    expect(api.finishSession).toHaveBeenCalledTimes(5);
  });
});
