import { memo, useState } from 'react';
import { periodOffset } from '../lib/review';
import { Calendar } from './Calendar';
import { Review, type ReviewPeriod } from './Review';

interface Props {
  today: string;
  now: number;
  /** The sheet's date, which the calendar opens on. */
  date: string;
  onOpen: (date: string) => void;
}

type Tab = 'days' | 'review';

/** Memoized: App re-renders every second, and nothing here needs more than the minute it is handed. */
export const History = memo(function History({ today, now, date, onOpen }: Props) {
  const [tab, setTab] = useState<Tab>('days');
  const [period, setPeriod] = useState<ReviewPeriod>({ kind: 'week', offset: 0 });
  const reviewWeek = (d: string) => {
    setPeriod({ kind: 'week', offset: periodOffset('week', today, d) });
    setTab('review');
  };
  return (
    <div className="history-view">
      <div className="segmented" role="tablist" aria-label="History view">
        <button className={`segment${tab === 'days' ? ' is-on' : ''}`} role="tab" aria-selected={tab === 'days'} onClick={() => setTab('days')}>
          Days
        </button>
        <button className={`segment${tab === 'review' ? ' is-on' : ''}`} role="tab" aria-selected={tab === 'review'} onClick={() => setTab('review')}>
          Review
        </button>
      </div>
      {tab === 'days' ? (
        <Calendar today={today} now={now} date={date} onOpen={onOpen} onReviewWeek={reviewWeek} />
      ) : (
        <Review today={today} now={now} period={period} onPeriod={setPeriod} onOpen={onOpen} />
      )}
    </div>
  );
});
