import { useEffect } from 'react';
import { CHANGED_ELSEWHERE } from '../api';
import { changedElsewhere } from '../lib/ownWrites';
import { nextBackoff } from '../../../shared/backoff.js';

/** How long the revisions heard gather before they are judged, so a burst of writes is one read. */
export const GATHER_MS = 300;

/**
 * Keeps the server's live stream (`GET /api/changes`) open while the tab is shown, one per tab,
 * since a browser holds six connections per host over HTTP/1.1. The stream names the user's
 * revision as it opens, which is where the page's first one starts judging, and after each of their
 * writes. Once the revisions heard have gathered, any this page didn't write itself
 * (`changedElsewhere`) raise CHANGED_ELSEWHERE with the newest one. Every later stream is judged
 * from where the last left off: one the browser reconnects by itself, one opened again here on
 * `nextBackoff` after the browser gave up (a 401, a 429, a proxy's error page), and one opened as
 * the tab is shown again. A tab back inside useRefreshLoop's 5 s throttle reads nothing.
 */
export function useLiveChanges(): void {
  useEffect(() => {
    let source: EventSource | null = null;
    // The revision judged up to: null until the first message.
    let handled: number | null = null;
    let heard = 0;
    let gather: number | undefined;
    let retry: number | undefined;
    let wait = 0;

    const judge = () => {
      gather = undefined;
      if (changedElsewhere(handled!, heard)) window.dispatchEvent(new CustomEvent(CHANGED_ELSEWHERE, { detail: heard }));
      handled = heard;
    };
    const open = () => {
      const es = new EventSource('/api/changes');
      es.onmessage = (e: MessageEvent<string>) => {
        wait = 0;
        const n = Number(e.data);
        if (handled === null) handled = heard = n;
        else if (n > heard) {
          heard = n;
          gather ??= window.setTimeout(judge, GATHER_MS);
        }
      };
      es.onerror = () => {
        if (es.readyState !== EventSource.CLOSED) return;
        wait = nextBackoff(wait);
        retry = window.setTimeout(open, wait);
      };
      source = es;
    };
    const close = () => {
      source?.close();
      source = null;
      clearTimeout(gather);
      gather = undefined;
      clearTimeout(retry);
      // The next stream is judged from here, so a judgement this drops is made then.
      if (handled !== null) heard = handled;
    };
    // No `focus` listener, for the same reason as in useRefreshLoop.
    const follow = () => {
      close();
      if (document.visibilityState === 'visible') open();
    };
    follow();
    document.addEventListener('visibilitychange', follow);
    return () => {
      document.removeEventListener('visibilitychange', follow);
      close();
    };
  }, []);
}
