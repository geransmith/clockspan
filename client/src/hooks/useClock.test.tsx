// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { settle, setVisibility, T0 } from '../test/hooks';
import { ClockProvider, useClock } from './useClock';

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Reader() {
  return <output>{useClock()}</output>;
}

it('hands a reader mounted mid-second the same tick as the rest, once a second', async () => {
  const tree = (late: boolean) => (
    <ClockProvider>
      <Reader />
      {late && <Reader />}
    </ClockProvider>
  );
  const { container, rerender } = render(tree(false));
  const shown = () => [...container.querySelectorAll('output')].map((o) => Number(o.textContent));
  await settle(500);
  rerender(tree(true));
  // A reader with a clock of its own would start at T0 + 500 and tick half a second behind.
  expect(shown()).toEqual([T0, T0]);
  await settle(500);
  expect(shown()).toEqual([T0 + 1000, T0 + 1000]);
});

it('ticks at once when the tab comes back', async () => {
  const { container } = render(
    <ClockProvider>
      <Reader />
    </ClockProvider>,
  );
  const shown = () => Number(container.querySelector('output')?.textContent);
  await settle(1000);
  expect(shown()).toBe(T0 + 1000);
  vi.setSystemTime(T0 + 60_000);
  act(() => setVisibility('hidden'));
  expect(shown()).toBe(T0 + 1000);
  act(() => setVisibility('visible'));
  expect(shown()).toBe(T0 + 60_000);
});

it('refuses to run outside the provider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => renderHook(() => useClock())).toThrow('useClock outside ClockProvider');
});
