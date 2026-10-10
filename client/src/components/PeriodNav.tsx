import type { RefObject } from 'react';
import { PERIOD_LABELS, periodRange, type PeriodKind } from '../lib/review';
import { ChevronLeft, ChevronRight } from './Icons';

interface Props {
  /** Names the buttons and the reset. */
  kind: PeriodKind;
  label: string;
  /** The first day of the period on screen; ◀ ▶ step from it. */
  from: string;
  /** Today's period is the latest one: it disables "next" and hides the reset. */
  today: string;
  onFrom: (from: string) => void;
  /** The ◀ button, which the reset and the caller's Try Again give the focus to. */
  prevRef: RefObject<HTMLButtonElement | null>;
}

/**
 * ◀ label ▶ with a reset to the current period ("This Week", "This Month", …) once stepped back;
 * shared by the review and the calendar. A press that reaches the current period disables ▶ or
 * takes the reset away, so the focus moves to ◀ rather than falling back to the top of the page.
 */
export function PeriodNav({ kind, label, from, today, onFrom, prevRef }: Props) {
  const current = periodRange(kind, today, 0).from;
  const next = () => {
    const f = periodRange(kind, from, -1).from;
    onFrom(f);
    if (f >= current) prevRef.current?.focus();
  };
  return (
    <div className="period-nav">
      <button ref={prevRef} className="btn btn-icon" onClick={() => onFrom(periodRange(kind, from, 1).from)} aria-label={`Previous ${kind}`}>
        <ChevronLeft />
      </button>
      <span className="period-label">{label}</span>
      <button className="btn btn-icon" onClick={next} aria-label={`Next ${kind}`} disabled={from >= current}>
        <ChevronRight />
      </button>
      <PeriodReset kind={kind} from={from} today={today} onFrom={onFrom} prevRef={prevRef} />
    </div>
  );
}

/** "This Week" / "This Month" / "This Quarter": back to today's period, shown once stepped back. It hands the focus to `prevRef` as it goes. */
function PeriodReset({ kind, from, today, onFrom, prevRef }: Pick<Props, 'kind' | 'from' | 'today' | 'onFrom' | 'prevRef'>) {
  const current = periodRange(kind, today, 0).from;
  if (from >= current) return null;
  return (
    <button
      className="btn btn-ghost"
      onClick={() => {
        onFrom(current);
        prevRef.current?.focus();
      }}
    >
      This {PERIOD_LABELS[kind]}
    </button>
  );
}
