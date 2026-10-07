// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMediaQuery } from './useMediaQuery';

/** A stand-in for `matchMedia`: each query answers from `matching`, and `change()` tells the listeners it moved. */
function stubMatchMedia(matching: Set<string>) {
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return matching.has(query);
    },
    media: query,
    addEventListener: (_type: string, l: () => void) => listeners.set(query, (listeners.get(query) ?? new Set()).add(l)),
    removeEventListener: (_type: string, l: () => void) => listeners.get(query)?.delete(l),
  }));
  return {
    change(query: string, matches: boolean) {
      if (matches) matching.add(query);
      else matching.delete(query);
      for (const l of listeners.get(query) ?? []) l();
    },
    listening: (query: string) => listeners.get(query)?.size ?? 0,
  };
}

afterEach(cleanup);

describe('useMediaQuery', () => {
  it('answers the query and follows it as it changes', () => {
    const media = stubMatchMedia(new Set(['(pointer: fine)']));
    const { result } = renderHook(() => useMediaQuery('(pointer: fine)'));
    expect(result.current).toBe(true);
    act(() => media.change('(pointer: fine)', false));
    expect(result.current).toBe(false);
  });

  it('listens to the query asked now, and to nothing once unmounted', () => {
    const media = stubMatchMedia(new Set(['(min-width: 900px)']));
    const { result, rerender, unmount } = renderHook(({ query }) => useMediaQuery(query), { initialProps: { query: '(pointer: fine)' } });
    expect(result.current).toBe(false);
    rerender({ query: '(min-width: 900px)' });
    expect(result.current).toBe(true);
    expect([media.listening('(pointer: fine)'), media.listening('(min-width: 900px)')]).toEqual([0, 1]);
    unmount();
    expect(media.listening('(min-width: 900px)')).toBe(0);
  });
});
