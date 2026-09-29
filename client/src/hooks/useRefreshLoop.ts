import { useCallback, useEffect, useRef, useState } from 'react';
import { MINUTE_MS } from '../../../shared/dates.js';
import { useLatest } from './useLatest';

/** Runs closer together than this are one run: a tab shown twice in a row asks once. */
const THROTTLE_MS = 5000;

/**
 * Keeps something on screen in step with the server: `run` every minute and when the tab comes
 * back (with `immediately`, on mount too), at most once every 5 s. No `focus` listener: some
 * embedded browsers fire `focus` on ordinary clicks (see the gotcha in AGENTS.md). `pending` is
 * true while a come-back's run is out, so the caller can wait for its answer before acting on a
 * copy that may be hours old; one that comes back inside the throttle waits on the run already
 * out. `runNow` is for a caller that knows its copy is wrong: it runs at once, or shares a run
 * already out, and counts for the throttle, so the tab coming back just after asks nothing more.
 */
export function useRefreshLoop(run: () => Promise<unknown>, immediately = false): { pending: boolean; runNow: () => Promise<unknown> } {
  const latestRun = useLatest(run);
  const [pending, setPending] = useState(false);
  const loop = useRef<{ last: number; out: Promise<unknown> | null }>({ last: 0, out: null });

  const start = useCallback(() => {
    const l = loop.current;
    l.last = Date.now();
    const p = latestRun.current().finally(() => {
      if (l.out === p) l.out = null;
    });
    l.out = p;
    return p;
  }, [latestRun]);
  const runNow = useCallback(() => loop.current.out ?? start(), [start]);

  useEffect(() => {
    const tick = (): Promise<unknown> | null => (Date.now() - loop.current.last < THROTTLE_MS ? loop.current.out : start());
    // The run the latest come-back waits on: an older one answering late doesn't end the wait.
    let waitingOn: Promise<unknown> | null = null;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const p = tick();
      if (!p) return;
      waitingOn = p;
      setPending(true);
      void p.finally(() => {
        if (waitingOn === p) setPending(false);
      });
    };
    if (immediately) void tick();
    const id = setInterval(() => void tick(), MINUTE_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [start, immediately]);
  return { pending, runNow };
}
