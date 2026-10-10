import { useRef, type RefObject } from 'react';
import { periodRange, type PeriodKind } from '../lib/review';
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
  /** Leave the reset to the current period out; the caller shows `PeriodReset` somewhere roomier. */
  noReset?: boolean;
  /** The ◀ button, for a caller that gives it the focus (its own `PeriodReset`, a Try again). */
  prevRef?: RefObject<HTMLButtonElement | null>;
}

/**
 * ◀ label ▶ with a reset to the current period ("This week", "This month", …) once stepped back;
 * shared by the review and the calendar. A press that reaches the current period disables ▶ or
 * takes the reset away, so the focus moves to ◀ rather than falling back to the top of the page.
 */
export function PeriodNav({ kind, label, from, today, onFrom, noReset, prevRef }: Props) {
  const own = useRef<HTMLButtonElement>(null);
  const prev = prevRef ?? own;
  const current = periodRange(kind, today, 0).from;
  const next = () => {
    const f = periodRange(kind, from, -1).from;
    onFrom(f);
    if (f >= current) prev.current?.focus();
  };
  return (
    <div className="period-nav">
      <button ref={prev} className="btn btn-icon" onClick={() => onFrom(periodRange(kind, from, 1).from)} aria-label={`Previous ${kind}`}>
        <ChevronLeft />
      </button>
      <span className="period-label">{label}</span>
      <button className="btn btn-icon" onClick={next} aria-label={`Next ${kind}`} disabled={from >= current}>
        <ChevronRight />
      </button>
      {!noReset && <PeriodReset kind={kind} from={from} today={today} onFrom={onFrom} prevRef={prev} />}
    </div>
  );
}

/** "This week" / "This month" / "This quarter": back to today's period, shown once stepped back. It hands the focus to `prevRef` as it goes. */
export function PeriodReset({
  kind,
  from,
  today,
  onFrom,
  prevRef,
}: Pick<Props, 'kind' | 'from' | 'today' | 'onFrom'> & { prevRef: RefObject<HTMLButtonElement | null> }) {
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
      This {kind}
    </button>
  );
}
