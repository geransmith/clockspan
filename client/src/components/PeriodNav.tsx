import { ChevronLeft, ChevronRight } from './Icons';

interface Props {
  /** "week" / "month" / "quarter": names the buttons and the reset. */
  kind: string;
  label: string;
  /** Periods back from the current one; 0 disables "next" and hides the reset. */
  offset: number;
  onOffset: (offset: number) => void;
}

/** ◀ label ▶ with a "This week" reset once stepped back; shared by the review and the calendar. */
export function PeriodNav({ kind, label, offset, onOffset }: Props) {
  return (
    <div className="period-nav">
      <button className="btn btn-icon" onClick={() => onOffset(offset + 1)} aria-label={`Previous ${kind}`}>
        <ChevronLeft />
      </button>
      <span className="period-label">{label}</span>
      <button className="btn btn-icon" onClick={() => onOffset(Math.max(0, offset - 1))} aria-label={`Next ${kind}`} disabled={offset === 0}>
        <ChevronRight />
      </button>
      {offset > 0 && (
        <button className="btn btn-ghost" onClick={() => onOffset(0)}>
          This {kind}
        </button>
      )}
    </div>
  );
}
