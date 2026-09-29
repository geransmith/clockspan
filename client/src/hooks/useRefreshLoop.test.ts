// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, MIN, settle, setVisibility, T0 } from '../test/hooks';
import { useRefreshLoop } from './useRefreshLoop';

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  setVisibility('visible');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useRefreshLoop', () => {
  it('runs every minute, and on mount only when asked to', async () => {
    const run = vi.fn(() => Promise.resolve());
    renderHook(() => useRefreshLoop(run));
    expect(run).not.toHaveBeenCalled();
    await settle(MIN);
    expect(run).toHaveBeenCalledTimes(1);
    await settle(MIN);
    expect(run).toHaveBeenCalledTimes(2);

    cleanup();
    const eager = vi.fn(() => Promise.resolve());
    renderHook(() => useRefreshLoop(eager, true));
    expect(eager).toHaveBeenCalledTimes(1);
  });

  it('runs when the tab comes back, pending until the answer, at most every 5 s', async () => {
    const answer = deferred<void>();
    const run = vi.fn(() => answer.promise);
    const { result } = renderHook(() => useRefreshLoop(run));
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
    const { result } = renderHook(() => useRefreshLoop(run));
    // The minute's run goes out just as a frozen page resumes, then the tab reports visible.
    await settle(MIN);
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
    const { result } = renderHook(() => useRefreshLoop(run));
    act(() => setVisibility('visible'));
    await settle(6_000);
    // The first run is still out after 5 s; the tab comes back and a second one goes.
    act(() => setVisibility('visible'));
    expect(run).toHaveBeenCalledTimes(2);
    slow.resolve();
    await settle();
    // The late answer is not the one being waited on: back again inside the throttle, still pending.
    act(() => setVisibility('visible'));
    expect(result.current).toBe(true);
    newer.resolve();
    await settle();
    expect(result.current).toBe(false);
  });

  it('uses the newest run and stops on unmount', async () => {
    const first = vi.fn(() => Promise.resolve());
    const second = vi.fn(() => Promise.resolve());
    const { rerender, unmount } = renderHook(({ run }) => useRefreshLoop(run), { initialProps: { run: first } });
    rerender({ run: second });
    await settle(MIN);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1]);
    unmount();
    await settle(5 * MIN);
    act(() => setVisibility('visible'));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
