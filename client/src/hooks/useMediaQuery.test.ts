// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { stubMatchMedia } from '../test/fixtures';
import { useMediaQuery } from './useMediaQuery';

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
