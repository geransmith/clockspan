import type { PeriodKind } from '../lib/review';
import { ChevronLeft, ChevronRight } from './Icons';

interface Props {
  /** Names the buttons and the reset. */
  kind: PeriodKind;
  label: string;
  /** Periods back from the current one; 0 disables "next" and hides the reset. */
  offset: number;
  onOffset: (offset: number) => void;
  /** Leave the "This week" button out; the caller shows `PeriodReset` somewhere roomier. */
  noReset?: boolean;
}

/** ◀ label ▶ with a "This week" reset once stepped back; shared by the review and the calendar. */
export function PeriodNav({ kind, label, offset, onOffset, noReset }: Props) {
  return (
    <div className="period-nav">
      <button className="btn btn-icon" onClick={() => onOffset(offset + 1)} aria-label={`Previous ${kind}`}>
        <ChevronLeft />
      </button>
      <span className="period-label">{label}</span>
      <button className="btn btn-icon" onClick={() => onOffset(offset - 1)} aria-label={`Next ${kind}`} disabled={offset === 0}>
        <ChevronRight />
      </button>
      {!noReset && <PeriodReset kind={kind} offset={offset} onOffset={onOffset} />}
    </div>
  );
}

export function PeriodReset({ kind, offset, onOffset }: Pick<Props, 'kind' | 'offset' | 'onOffset'>) {
  if (offset === 0) return null;
  return (
    <button className="btn btn-ghost" onClick={() => onOffset(0)}>
      This {kind}
    </button>
  );
}
