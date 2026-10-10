// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGED_ELSEWHERE } from '../api';
import { MINUTE_MS } from '../../../shared/dates.js';
import { deferred, settle, setVisibility, T0 } from '../test/hooks';
import { useRefreshLoop } from './useRefreshLoop';

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  setVisibility('visible');
});

/** What useLiveChanges raises when another tab or device saved a change, and api.ts when a write is refused 404 or 409. */
const changedElsewhere = () => void window.dispatchEvent(new CustomEvent(CHANGED_ELSEWHERE, { detail: 5 }));

describe('useRefreshLoop', () => {
  it('runs every minute, and on mount only when asked to', async () => {
    const run = vi.fn(() => Promise.resolve());
    renderHook(() => useRefreshLoop(run));
    expect(run).not.toHaveBeenCalled();
    await settle(MINUTE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    await settle(MINUTE_MS);
    expect(run).toHaveBeenCalledTimes(2);

    cleanup();
    const eager = vi.fn(() => Promise.resolve());
    renderHook(() => useRefreshLoop(eager, true));
    expect(eager).toHaveBeenCalledTimes(1);
  });

  it('runs when the tab comes back, pending until the answer, at most every 5 s', async () => {
    const answer = deferred<void>();
    const run = vi.fn(() => answer.promise);
    const { result } = renderHook(() => useRefreshLoop(run).pending);
    setVisibility('hidden');
    expect(run).not.toHaveBeenCalled();
    act(() => setVisibility('visible'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);
    answer.resolve();
    await settle();
    expect(result.current).toBe(false);
    // Back again within 5 s, with nothing out: no second request and nothing to wait for.
    act(() => setVisibility('visible'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
    await settle(5_000);
    act(() => setVisibility('visible'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('waits on the minute run still out when the tab comes back inside the throttle', async () => {
    const answer = deferred<void>();
    const run = vi.fn(() => answer.promise);
    const { result } = renderHook(() => useRefreshLoop(run).pending);
    // The minute's run goes out just as a frozen page resumes, then the tab reports visible.
    await settle(MINUTE_MS);
    act(() => setVisibility('visible'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);
    answer.resolve();
    await settle();
    expect(result.current).toBe(false);
  });

  it('keeps waiting on the newer run when an older, slow one answers late', async () => {
    const slow = deferred<void>();
    const newer = deferred<void>();
    const run = vi.fn().mockReturnValueOnce(slow.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useRefreshLoop(run).pending);
    act(() => setVisibility('visible'));
    await settle(6_000);
    // The first run is still out after 5 s; the tab comes back and a second one goes.
    act(() => setVisibility('visible'));
    expect(run).toHaveBeenCalledTimes(2);
    slow.resolve();
    await settle();
    // The late answer is not the one being waited on.
    expect(result.current).toBe(true);
    newer.resolve();
    await settle();
    expect(result.current).toBe(false);
  });

  it('runs at once when another tab or device saves a change, inside the throttle too, the tab coming back just after asks nothing more, and stops listening on unmount', async () => {
    const run = vi.fn(() => Promise.resolve());
    const { result, unmount } = renderHook(() => useRefreshLoop(run, true));
    await settle();
    act(changedElsewhere);
    expect(run).toHaveBeenCalledTimes(2);
    await settle(4_000);
    act(() => setVisibility('visible'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toBe(false);
    await settle(1_000);
    act(() => setVisibility('visible'));
    expect(run).toHaveBeenCalledTimes(3);
    await settle();
    unmount();
    changedElsewhere();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('queues one run behind the one out for a burst of changes, not one each', async () => {
    const out = deferred<void>();
    const run = vi.fn().mockReturnValueOnce(out.promise).mockResolvedValue(undefined);
    const { result } = renderHook(() => useRefreshLoop(run, true));
    act(() => {
      changedElsewhere();
      changedElsewhere();
      changedElsewhere();
    });
    expect(run).toHaveBeenCalledTimes(1);
    // The tab coming back now waits on the queued run and sends nothing.
    act(() => setVisibility('visible'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);
    out.resolve();
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.current.pending).toBe(false);
  });

  it('queues again for a change heard while the queued run is out', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(undefined);
    renderHook(() => useRefreshLoop(run, true));
    act(() => changedElsewhere());
    first.resolve();
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    act(() => changedElsewhere());
    second.resolve();
    await settle();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('uses the newest run and stops on unmount', async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const { rerender, unmount } = renderHook(({ run }) => useRefreshLoop(run), { initialProps: { run: first } });
    rerender({ run: second });
    await settle(MINUTE_MS);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
    unmount();
    await settle(5 * MINUTE_MS);
    act(() => setVisibility('visible'));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
