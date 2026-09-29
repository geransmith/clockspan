// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useTracked } from './useTracked';

afterEach(cleanup);

describe('useTracked', () => {
  it('lets a callback read every change at once, before the render that shows it', () => {
    const { result } = renderHook(() => useTracked(() => ({ planned: 25 })));
    act(() => {
      const { change, current } = result.current;
      // Two rapid presses: the second builds on the first.
      change((s) => ({ planned: s.planned + 5 }));
      change((s) => ({ planned: s.planned + 5 }));
      expect(current()).toEqual({ planned: 35 });
      expect(result.current.tracked).toEqual({ planned: 25 });
    });
    expect(result.current.tracked).toEqual({ planned: 35 });
  });

  it('keeps its functions and queue across renders, and hands out a new id each time', () => {
    const { result, rerender } = renderHook(() => useTracked(0));
    const first = result.current;
    rerender();
    for (const key of ['current', 'change', 'nextId', 'queue'] as const) expect(result.current[key]).toBe(first[key]);
    expect([first.nextId(), first.nextId()]).toEqual([1, 2]);
  });
});
