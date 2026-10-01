import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * A ref holding `value` as of the last commit, for a callback, timer, listener or effect that
 * must see the newest render without depending on it. Updated in a layout effect, so it is
 * current before any handler runs and render stays pure. It only has what has rendered: a change
 * made earlier in the same handler isn't in it yet, so a store's callbacks read their own state
 * through `useTracked().current()` instead.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
