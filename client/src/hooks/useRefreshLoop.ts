import { useEffect, useState } from 'react';
import { MINUTE_MS } from '../../../shared/dates.js';
import { useLatest } from './useLatest';

/** Runs closer together than this are one run: a tab shown twice in a row asks once. */
const THROTTLE_MS = 5000;

/**
 * Keeps something on screen in step with the server: `run` every minute and when the tab comes
 * back (with `immediately`, on mount too), at most once every 5 s. No `focus` listener: some
 * embedded browsers fire `focus` on ordinary clicks (see the gotcha in AGENTS.md). Returns true
 * while a come-back run is out, so the caller can wait for its answer before acting on a copy
 * that may be hours old; one that comes back inside the throttle waits on the run already out.
 */
export function useRefreshLoop(run: () => Promise<unknown>, immediately = false): boolean {
  const latestRun = useLatest(run);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let last = 0;
    let out: Promise<unknown> | null = null;
    const tick = (): Promise<unknown> | null => {
      const t = Date.now();
      if (t - last < THROTTLE_MS) return out;
      last = t;
      const p = latestRun.current().finally(() => {
        if (out === p) out = null;
      });
      out = p;
      return p;
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const p = tick();
      if (!p) return;
      setPending(true);
      void p.finally(() => setPending(false));
    };
    if (immediately) void tick();
    const id = setInterval(() => void tick(), MINUTE_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [latestRun, immediately]);
  return pending;
}
