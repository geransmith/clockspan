// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { settle, setVisibility, T0 } from '../test/hooks';
import { useNow } from './useNow';

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('ticks on its interval, and at once when the tab comes back or gets focus', async () => {
  const { result, unmount } = renderHook(() => useNow(1000));
  expect(result.current).toBe(T0);
  await settle(1000);
  expect(result.current).toBe(T0 + 1000);

  // A hidden tab's timers are throttled: the clock can be far behind when it comes back.
  vi.setSystemTime(T0 + 60_000);
  act(() => setVisibility('hidden'));
  expect(result.current).toBe(T0 + 1000);
  act(() => setVisibility('visible'));
  expect(result.current).toBe(T0 + 60_000);
  vi.setSystemTime(T0 + 90_000);
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(result.current).toBe(T0 + 90_000);
  unmount();
});
