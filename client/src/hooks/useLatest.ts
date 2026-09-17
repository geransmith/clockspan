import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * A ref that always holds the latest `value`, for callbacks that must read the current
 * state rather than the render they closed over (rapid −5m clicks compounding, a click right
 * after a debounced flush). Updated in a layout effect, so it is current before any event
 * handler can run and render itself stays pure.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
