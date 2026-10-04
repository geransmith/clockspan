import { useCallback, useEffect, useState } from 'react';
import { isValidDateKey, todayKey } from '../../../shared/dates.js';
import { PERIOD_KINDS, periodRange, type ReviewPeriod } from '../lib/review';
import { useLatest } from './useLatest';

export interface Route {
  view: 'sheet' | 'history';
  /**
   * The date on screen, or null for today. Today is kept as null rather than as its key so a
   * sheet left open past midnight moves to the new day, the way a reload of the same URL does.
   * A future date is today too: a day that hasn't started has nothing to punch or log, and the
   * date picker's `max` doesn't stop a typed one.
   */
  date: string | null;
  /**
   * The period a day was opened from in History → Review, recorded on the History entry so Back
   * reopens the review there. Null on the sheet and for a day opened from Days.
   */
  review: ReviewPeriod | null;
}

function read(): Route {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') === 'history' ? 'history' : 'sheet';
  const date = params.get('date');
  return {
    view,
    date: date && isValidDateKey(date) && date < todayKey() ? date : null,
    review: view === 'history' ? readReview(params) : null,
  };
}

function readReview(params: URLSearchParams): ReviewPeriod | null {
  const kind = PERIOD_KINDS.find((k) => k === params.get('review'));
  const from = params.get('from');
  if (!kind || !from || !isValidDateKey(from) || from > todayKey()) return null;
  return { kind, from: periodRange(kind, from, 0).from };
}

function toUrl(route: Route): string {
  const params = new URLSearchParams();
  if (route.view === 'history') params.set('view', 'history');
  if (route.date != null) params.set('date', route.date);
  if (route.review) {
    params.set('review', route.review.kind);
    params.set('from', route.review.from);
  }
  const qs = params.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ''}`;
}

/**
 * The sheet's date and view, and the review period a day was opened from, live in the URL so
 * reloads and back/forward behave. `replace` rewrites the current entry instead of adding one,
 * to record where the user is before moving on.
 */
export function useRoute(): [Route, (next: Partial<Route>, opts?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(read);
  // Read through a ref rather than inside the updater: React runs updaters twice under
  // StrictMode, and a pushState in there would push two history entries per navigation.
  const current = useLatest(route);
  useEffect(() => {
    const onPop = () => setRoute(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback(
    (next: Partial<Route>, opts?: { replace?: boolean }) => {
      const merged = { ...current.current, ...next };
      if (merged.date != null && merged.date >= todayKey()) merged.date = null;
      if (merged.view === 'sheet') merged.review = null;
      const url = toUrl(merged);
      // Already there (the brand button on today's sheet): a push would add an entry Back
      // has to step through without anything changing.
      if (url === toUrl(current.current)) return;
      if (opts?.replace) history.replaceState(null, '', url);
      else history.pushState(null, '', url);
      setRoute(merged);
    },
    [current],
  );
  return [route, navigate];
}
