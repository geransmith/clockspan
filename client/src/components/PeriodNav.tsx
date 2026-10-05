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
}

/** ◀ label ▶ with a reset to the current period ("This week", "This month", …) once stepped back; shared by the review and the calendar. */
export function PeriodNav({ kind, label, from, today, onFrom, noReset }: Props) {
  const current = periodRange(kind, today, 0).from;
  return (
    <div className="period-nav">
      <button className="btn btn-icon" onClick={() => onFrom(periodRange(kind, from, 1).from)} aria-label={`Previous ${kind}`}>
        <ChevronLeft />
      </button>
      <span className="period-label">{label}</span>
      <button className="btn btn-icon" onClick={() => onFrom(periodRange(kind, from, -1).from)} aria-label={`Next ${kind}`} disabled={from >= current}>
        <ChevronRight />
      </button>
      {!noReset && <PeriodReset kind={kind} from={from} today={today} onFrom={onFrom} />}
    </div>
  );
}

/** "This week" / "This month" / "This quarter": back to today's period, shown once stepped back. */
export function PeriodReset({ kind, from, today, onFrom }: Pick<Props, 'kind' | 'from' | 'today' | 'onFrom'>) {
  const current = periodRange(kind, today, 0).from;
  if (from >= current) return null;
  return (
    <button className="btn btn-ghost" onClick={() => onFrom(current)}>
      This {kind}
    </button>
  );
}
