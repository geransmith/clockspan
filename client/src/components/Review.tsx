import { useState, type ReactNode } from 'react';
import { useRange } from '../hooks/useRange';
import { useSettings } from '../hooks/useSettings';
import { UNTITLED_SESSION } from '../lib/copy';
import { formatDateShort, formatDuration, formatWeekday } from '../lib/format';
import { periodRange, reviewRange, type PeriodKind } from '../lib/review';
import type { Day } from '../types';
import { Check } from './Icons';
import { PeriodNav } from './PeriodNav';
import { Tile } from './Tile';

const KINDS: { id: PeriodKind; label: string }[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' },
];

export interface ReviewPeriod {
  kind: PeriodKind;
  offset: number;
}

interface Props {
  today: string;
  now: number;
  /** Owned by History so the calendar's "Review this week" can point it at a week. */
  period: ReviewPeriod;
  onPeriod: (next: ReviewPeriod) => void;
  onOpen: (date: string) => void;
}

/**
 * The daily retrospectives rolled up: how the period's time split between the plan and
 * everything else, which priorities never got done, and each day's note on why.
 */
export function Review({ today, now, period: { kind, offset }, onPeriod, onOpen }: Props) {
  const { settings } = useSettings();
  const period = periodRange(kind, today, offset);
  const { days, error } = useRange(period.from, period.to);

  const pickKind = (k: PeriodKind) => onPeriod({ kind: k, offset: 0 });
  const dayLabel = (date: string) => `${formatWeekday(date)} ${formatDateShort(date)}`;

  return (
    <section className="card review">
      <header className="card-head">
        <h2 className="card-title">Review</h2>
        <span className="chips" role="tablist" aria-label="Period">
          {KINDS.map((k) => (
            <button key={k.id} className={`chip${kind === k.id ? ' is-on' : ''}`} onClick={() => pickKind(k.id)} role="tab" aria-selected={kind === k.id}>
              {k.label}
            </button>
          ))}
        </span>
      </header>
      <PeriodNav kind={kind} label={period.label} offset={offset} onOffset={(o) => onPeriod({ kind, offset: o })} />

      {error && <p className="error">{error}</p>}
      {!error && !days && <div className="sheet-loading" aria-busy="true" />}
      {days && <Body key={`${kind}:${period.from}`} days={days} today={today} now={now} kind={kind} onOpen={onOpen} dayLabel={dayLabel} settings={settings} />}
    </section>
  );
}

function Body({
  days,
  today,
  now,
  kind,
  onOpen,
  dayLabel,
  settings,
}: {
  days: Day[];
  today: string;
  now: number;
  kind: PeriodKind;
  onOpen: (date: string) => void;
  dayLabel: (date: string) => string;
  settings: ReturnType<typeof useSettings>['settings'];
}) {
  const r = reviewRange(days, settings, today, now);
  if (r.days === 0) return <p className="muted center review-empty">Nothing recorded this {kind}.</p>;
  const onPlanPct = r.focusedSeconds > 0 ? Math.round((r.onPlanSeconds / r.focusedSeconds) * 100) : null;
  // A row merged across days names them in a week and counts them in a longer period; it
  // opens the latest of them.
  const when = (dates: string[]) => {
    if (kind === 'week') return dates.map(formatWeekday).join(', ');
    return dates.length === 1 ? dayLabel(dates[0]!) : `${dates.length} days`;
  };
  const latest = (dates: string[]) => dates[dates.length - 1]!;

  return (
    <div className="review-body">
      <div className="tiles review-tiles">
        <Tile label="Days" value={String(r.days)} sub={settings.trackHours ? `worked ${formatDuration(r.workedSeconds)}` : ''} />
        <Tile label="Focused" value={formatDuration(r.focusedSeconds)} sub={onPlanPct == null ? 'no sessions' : `${onPlanPct}% on plan`} />
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
          <p className="muted small">Every logged session was for a priority.</p>
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
          Not done <span className="muted">{r.prioritiesTotal - r.prioritiesDone}</span>
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
                    <strong>{dayLabel(n.date)}</strong>
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

/** Past this many rows a list shows its first ones and a button for the rest. */
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
