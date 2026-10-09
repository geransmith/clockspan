import { useCallback, useRef, useState } from 'react';
import { serial } from '../lib/optimistic';

/**
 * What each store (`useDay`, `useSettings`, `useTimer`, `useBoard`) is built on: its state (a
 * `Tracked` value from `lib/optimistic.ts`, or, in the day store, one per date plus the dates
 * whose first load failed), ids for its pending changes, and the `serial()` queue its writes go
 * out on. `tracked` is for rendering. `current()` is the same state as of the last `change`, for
 * callbacks, which can't wait for a render: rapid presses
 * (−5m, −5m) build on each other, `addPriority` reads the list a blur-flush just set, and a read
 * deciding whether its answer lands must see every change made so far.
 */
export function useTracked<S>(initial: S | (() => S)) {
  const [tracked, setTracked] = useState(initial);
  const held = useRef(tracked);
  const current = useCallback(() => held.current, []);
  const change = useCallback((fn: (state: S) => S) => {
    held.current = fn(held.current);
    setTracked(held.current);
  }, []);
  const lastId = useRef(0);
  const nextId = useCallback(() => ++lastId.current, []);
  const [queue] = useState(serial);
  return { tracked, current, change, nextId, queue };
}
