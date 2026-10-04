import { useState, type ReactNode } from 'react';
import { useRange } from '../hooks/useRange';
import { useSettings } from '../hooks/useSettings';
import { UNTITLED_SESSION } from '../lib/copy';
import { formatDateLong, formatDuration, formatWeekday } from '../lib/format';
import { PERIOD_KINDS, periodOffset, periodRange, reviewRange, type PeriodKind, type ReviewPeriod } from '../lib/review';
import type { Day } from '../types';
import { Check } from './Icons';
import { PeriodNav } from './PeriodNav';
import { Tile } from './Tile';

const PERIOD_LABELS: Record<PeriodKind, string> = { week: 'Week', month: 'Month', quarter: 'Quarter' };

interface Props {
  today: string;
  now: number;
  /**
   * Owned by History so the calendar's "Review this week" can point it at a week. A day opened
   * from here takes the period along, so Back reopens the review on it.
   */
  period: ReviewPeriod;
  onPeriod: (next: ReviewPeriod) => void;
  onOpen: (date: string) => void;
}

/**
 * The daily retrospectives rolled up: how the period's time split between the plan and
 * everything else, which priorities never got done, and each day's note on why.
 */
export function Review({ today, now, period: { kind, from }, onPeriod, onOpen }: Props) {
  const period = periodRange(kind, from, 0);
  const offset = periodOffset(kind, today, from);
  const { days, error } = useRange(period.from, period.to);

  // Another kind is taken around the period on screen, by its last day or today if that comes
  // first, so a past week becomes its month and the current period stays the current one.
  const pickKind = (k: PeriodKind) => onPeriod({ kind: k, from: periodRange(k, period.to < today ? period.to : today, 0).from });

  return (
    <section className="card review">
      <header className="card-head">
        <h2 className="card-title">Review</h2>
        <span className="chips" role="group" aria-label="Period">
          {PERIOD_KINDS.map((k) => (
            <button key={k} className={`chip${kind === k ? ' is-on' : ''}`} onClick={() => pickKind(k)} aria-pressed={kind === k}>
              {PERIOD_LABELS[k]}
            </button>
          ))}
        </span>
      </header>
      <PeriodNav kind={kind} label={period.label} offset={offset} onOffset={(o) => onPeriod({ kind, from: periodRange(kind, today, o).from })} />

      {error && <p className="error">{error}</p>}
      {!error && !days && <div className="sheet-loading" aria-busy="true" />}
      {days && <Body key={`${kind}:${period.from}`} days={days} today={today} now={now} kind={kind} onOpen={onOpen} />}
    </section>
  );
}

function Body({ days, today, now, kind, onOpen }: { days: Day[]; today: string; now: number; kind: PeriodKind; onOpen: (date: string) => void }) {
  const { settings } = useSettings();
  const r = reviewRange(days, settings, today, now);
  if (r.days === 0) return <p className="muted center review-empty">Nothing recorded.</p>;
  // A row merged across days names them in a week and counts them in a longer period; it
  // opens the latest of them.
  const when = (dates: string[]) => {
    if (kind === 'week') return dates.map(formatWeekday).join(', ');
    return dates.length === 1 ? formatDateLong(dates[0]!) : `${dates.length} days`;
  };
  const latest = (dates: string[]) => dates[dates.length - 1]!;

  return (
    <div className="review-body">
      <div className="tiles">
        <Tile label="Days" value={String(r.days)} sub={settings.trackHours ? `worked ${formatDuration(r.workedSeconds)}` : ''} />
        <Tile label="Focused" value={formatDuration(r.focusedSeconds)} sub={r.onPlanPercent == null ? 'no sessions' : `${r.onPlanPercent}% on plan`} />
        <Tile
          label="Priorities"
          value={r.prioritiesTotal > 0 ? `${r.prioritiesDone}/${r.prioritiesTotal}` : '—'}
          sub={`${r.retrosDone} of ${r.days} reviewed`}
        />
      </div>

      <section className="review-section">
        <h3 className="retro-heading">
          Off the plan <span className="muted">{formatDuration(r.offPlanSeconds)}</span>
        </h3>
        {r.unplanned.length === 0 ? (
          <p className="muted small">{r.onPlanPercent == null ? 'No sessions logged.' : 'Every logged session was for a priority.'}</p>
        ) : (
          <Folded
            items={r.unplanned.map((g) => (
              <li key={g.key}>
                <button className="review-row" onClick={() => onOpen(latest(g.dates))}>
                  <span className="review-text">{g.label || <span className="muted">{UNTITLED_SESSION}</span>}</span>
                  <span className="review-meta">
                    <span className="muted small">{when(g.dates)}</span>
                    <span className="review-time">{formatDuration(g.seconds)}</span>
                  </span>
                </button>
              </li>
            ))}
          />
        )}
      </section>

      <section className="review-section">
        <h3 className="retro-heading">
          Not done <span className="muted">{r.notDone.length}</span>
        </h3>
        {r.notDone.length === 0 ? (
          <p className="muted small">{r.prioritiesTotal > 0 ? 'Every priority got ticked.' : 'No priorities were written.'}</p>
        ) : (
          <Folded
            items={r.notDone.map((g) => (
              <li key={g.key}>
                <button className="review-row" onClick={() => onOpen(latest(g.dates))}>
                  <span className="review-text">
                    {g.text}
                    {g.addedMidDay && <span className="pill pill--warn retro-late">mid-day</span>}
                  </span>
                  <span className="review-meta">
                    <span className="muted small">{when(g.dates)}</span>
                    <span className="review-time">{g.focusedSeconds > 0 ? formatDuration(g.focusedSeconds) : <span className="muted">no time</span>}</span>
                  </span>
                </button>
              </li>
            ))}
          />
        )}
      </section>

      <section className="review-section">
        <h3 className="retro-heading">Why</h3>
        {r.notes.length === 0 ? (
          <p className="muted small">No retrospective notes yet. Each day's retrospective card is where they go.</p>
        ) : (
          <Folded
            items={r.notes.map((n) => (
              <li key={n.date}>
                <button className="review-row review-row--note" onClick={() => onOpen(n.date)}>
                  <span className="review-meta review-note-head">
                    <strong>{formatDateLong(n.date)}</strong>
                    {n.reviewedAt != null && (
                      <span className="pill pill--ok">
                        <Check /> reviewed
                      </span>
                    )}
                  </span>
                  <span className="review-note">{n.note}</span>
                </button>
              </li>
            ))}
          />
        )}
      </section>
    </div>
  );
}

/**
 * A list longer than FOLD_AT + 1 rows shows its first FOLD_AT and a Show all button. One row
 * over shows in full, since the button would take the space of the one row it hides.
 */
const FOLD_AT = 8;

function Folded({ items }: { items: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  const folded = !open && items.length > FOLD_AT + 1;
  return (
    <>
      <ul className="review-list">{folded ? items.slice(0, FOLD_AT) : items}</ul>
      {folded && (
        <button className="btn btn-ghost review-more" onClick={() => setOpen(true)}>
          Show all {items.length}
        </button>
      )}
    </>
  );
}
