import { memo, useRef, useState } from 'react';
import { startOfWeek } from '../../../shared/dates.js';
import type { ReviewPeriod } from '../lib/review';
import { Calendar } from './Calendar';
import { Review } from './Review';

interface Props {
  today: string;
  now: number;
  /** The sheet's date, which the calendar opens on. */
  date: string;
  /** The period a day was opened from in Review, which Back reopens Review on; null opens on Days. */
  review: ReviewPeriod | null;
  /** `review` is the period on screen for a day opened from Review, null for one opened from Days. */
  onOpen: (date: string, review: ReviewPeriod | null) => void;
}

type Tab = 'days' | 'review';

/** Memoized: App re-renders every second, and nothing here needs more than the minute it is handed. */
export const History = memo(function History({ today, now, date, review, onOpen }: Props) {
  const [tab, setTab] = useState<Tab>(review ? 'review' : 'days');
  const [period, setPeriod] = useState<ReviewPeriod>(() => review ?? { kind: 'week', from: startOfWeek(today) });
  const reviewButton = useRef<HTMLButtonElement>(null);
  // The calendar, and the button pressed in it, are hidden once Review shows: the focus goes to
  // the Review switch rather than falling back to the top of the page.
  const reviewWeek = (d: string) => {
    setPeriod({ kind: 'week', from: startOfWeek(d) });
    setTab('review');
    reviewButton.current?.focus();
  };
  return (
    <div className="history-view stack">
      {/* A switch between two views, not ARIA tabs: there are no tab panels or arrow keys to go with them. */}
      <div className="segmented" role="group" aria-label="History view">
        <button className="segment" aria-pressed={tab === 'days'} onClick={() => setTab('days')}>
          Days
        </button>
        <button ref={reviewButton} className="segment" aria-pressed={tab === 'review'} onClick={() => setTab('review')}>
          Review
        </button>
      </div>
      {/* Stays mounted while Review shows, so a switch back finds the month and the day it was left on. */}
      <div hidden={tab !== 'days'}>
        <Calendar today={today} now={now} date={date} onOpen={(d) => onOpen(d, null)} onReviewWeek={reviewWeek} />
      </div>
      {tab === 'review' && <Review today={today} now={now} period={period} onPeriod={setPeriod} onOpen={(d) => onOpen(d, period)} />}
    </div>
  );
});
