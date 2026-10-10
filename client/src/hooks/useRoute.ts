import { useCallback, useEffect, useState } from 'react';
import { isValidDateKey, todayKey } from '../../../shared/dates.js';
import { PERIOD_KINDS, periodRange, type ReviewPeriod } from '../lib/review';

/**
 * The pages the app can show. The sheet is the default, and the one view the URL leaves out;
 * a name the list doesn't hold reads as the sheet.
 */
export const VIEWS = ['sheet', 'history', 'board'] as const;

export interface Route {
  view: (typeof VIEWS)[number];
  /**
   * The date on screen, or null for today. Today is kept as null rather than as its key so a
   * sheet left open past midnight moves to the new day, the way a reload of the same URL does.
   * A future date is today too: a day that hasn't started has nothing to punch or log, and the
   * date picker's `max` doesn't stop a typed one.
   */
  date: string | null;
  /**
   * The period a day was opened from in History → Review, recorded on the History entry so Back
   * reopens the review there. Null on every other view and for a day opened from Days.
   */
  review: ReviewPeriod | null;
}

function read(): Route {
  const params = new URLSearchParams(window.location.search);
  const view = VIEWS.find((v) => v === params.get('view')) ?? 'sheet';
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
  if (route.view !== 'sheet') params.set('view', route.view);
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
  useEffect(() => {
    const onPop = () => setRoute(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  // The route is always what the URL says, and each call writes the URL before it returns, so
  // merging onto the URL lets a second call in the same handler build on the first. Not inside
  // a setRoute updater: React runs those twice under StrictMode, which would push two entries.
  const navigate = useCallback((next: Partial<Route>, opts?: { replace?: boolean }) => {
    const here = read();
    const merged = { ...here, ...next };
    if (merged.date != null && merged.date >= todayKey()) merged.date = null;
    if (merged.view !== 'history') merged.review = null;
    const url = toUrl(merged);
    // Already there (the brand button on today's sheet): a push would add an entry Back
    // has to step through without anything changing.
    if (url === toUrl(here)) return;
    if (opts?.replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    setRoute(merged);
  }, []);
  return [route, navigate];
}
