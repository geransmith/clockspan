import { useCallback, useEffect, useRef, useState } from 'react';
import { CHANGED_ELSEWHERE } from '../api';
import { MINUTE_MS } from '../../../shared/dates.js';
import { useLatest } from './useLatest';

/** Runs closer together than this are one run: a tab shown twice in a row asks once. */
const THROTTLE_MS = 5000;

/**
 * Keeps something on screen in step with the server: `run` every minute and when the tab comes
 * back (with `immediately`, on mount too), at most once every 5 s, and at once when another tab or
 * device saves a change (CHANGED_ELSEWHERE, from useLiveChanges): after the run out, never beside
 * it, and one run for a burst of them. No `focus` listener: some embedded browsers fire `focus` on
 * ordinary clicks (see the gotcha in AGENTS.md). `pending` is true while a come-back's run is out,
 * so the caller can wait for its answer before acting on a copy that may be hours old; one that
 * comes back inside the throttle waits on the run already out. `runNow` is for a caller that has
 * just learned its copy is wrong: a run sent before that may answer with the old state, so it
 * starts a fresh run, after the one out (never beside it, or the older answer could land last). It
 * counts for the throttle, so the tab coming back just after waits on it and sends nothing more.
 */
export function useRefreshLoop(run: () => Promise<unknown>, immediately = false): { pending: boolean; runNow: () => Promise<unknown> } {
  const latestRun = useLatest(run);
  const [pending, setPending] = useState(false);
  const loop = useRef<{ last: number; out: Promise<unknown> | null }>({ last: 0, out: null });

  const start = useCallback(
    (after: Promise<unknown> | null = null) => {
      const l = loop.current;
      l.last = Date.now();
      const go = () => latestRun.current();
      const p = (after ? after.then(go, go) : go()).finally(() => {
        if (l.out === p) l.out = null;
      });
      l.out = p;
      return p;
    },
    [latestRun],
  );
  const runNow = useCallback(() => start(loop.current.out), [start]);

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
    // The run queued behind the one out for a change heard meanwhile, which later ones share.
    let queued: Promise<unknown> | null = null;
    const onChanged = () => {
      const out = loop.current.out;
      if (!out) void start();
      else queued ??= start(out.finally(() => (queued = null)));
    };
    if (immediately) void tick();
    const id = setInterval(() => void tick(), MINUTE_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(CHANGED_ELSEWHERE, onChanged);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(CHANGED_ELSEWHERE, onChanged);
    };
  }, [start, immediately]);
  return { pending, runNow };
}
