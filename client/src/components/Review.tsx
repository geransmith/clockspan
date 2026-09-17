import { useEffect, useState } from 'react';
import * as api from '../api';
import { useSettings } from '../hooks/useSettings';
import { formatDateLong, formatDuration, formatWeekday } from '../lib/format';
import { periodRange, reviewRange, type PeriodKind } from '../lib/review';
import type { Day } from '../types';
import { Check, ChevronLeft, ChevronRight } from './Icons';

const KINDS: { id: PeriodKind; label: string }[] = [
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'quarter', label: 'Quarter' },
];

interface Props {
  today: string;
  now: number;
  onOpen: (date: string) => void;
}

/**
 * The daily retrospectives rolled up: how the period's time split between the plan and
 * everything else, which priorities never got done, and each day's note on why.
 */
export function Review({ today, now, onOpen }: Props) {
  const { settings } = useSettings();
  const [kind, setKind] = useState<PeriodKind>('week');
  const [offset, setOffset] = useState(0);
  const [days, setDays] = useState<Day[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const period = periodRange(kind, today, offset);

  useEffect(() => {
    let cancelled = false;
    setDays(null);
    setError(null);
    api
      .getRange(period.from, period.to)
      .then((r) => {
        if (!cancelled) setDays(r.days);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [period.from, period.to]);

  const pickKind = (k: PeriodKind) => {
    setKind(k);
    setOffset(0);
  };
  const dayName = (date: string) => `${formatWeekday(date)} ${formatDateLong(date).replace(/^\w+,?\s*/, '')}`;

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
      <div className="review-nav">
        <button className="btn btn-icon" onClick={() => setOffset((o) => o + 1)} aria-label={`Previous ${kind}`}>
          <ChevronLeft />
        </button>
        <span className="review-period">{period.label}</span>
        <button className="btn btn-icon" onClick={() => setOffset((o) => Math.max(0, o - 1))} aria-label={`Next ${kind}`} disabled={offset === 0}>
          <ChevronRight />
        </button>
        {offset > 0 && (
          <button className="btn btn-ghost" onClick={() => setOffset(0)}>
            This {kind}
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {!error && !days && <div className="sheet-loading" aria-busy="true" />}
      {days && <Body days={days} today={today} now={now} kind={kind} onOpen={onOpen} dayName={dayName} settings={settings} />}
    </section>
  );
}

function Body({
  days,
  today,
  now,
  kind,
  onOpen,
  dayName,
  settings,
}: {
  days: Day[];
  today: string;
  now: number;
  kind: PeriodKind;
  onOpen: (date: string) => void;
  dayName: (date: string) => string;
  settings: ReturnType<typeof useSettings>['settings'];
}) {
  const r = reviewRange(days, settings, today, now);
  if (r.days === 0) return <p className="muted center review-empty">Nothing recorded this {kind}.</p>;
  const onPlanPct = r.focusedSeconds > 0 ? Math.round((r.onPlanSeconds / r.focusedSeconds) * 100) : null;
  const when = (date: string) => (kind === 'week' ? formatWeekday(date) : dayName(date));

  return (
    <div className="review-body">
      <div className="tiles review-tiles">
        <Tile label="Days" value={String(r.days)} sub={`worked ${formatDuration(r.workedSeconds)}`} />
        <Tile label="Focused" value={formatDuration(r.focusedSeconds)} sub={onPlanPct == null ? 'no sessions' : `${onPlanPct}% on plan`} />
        <Tile label="Priorities" value={r.prioritiesTotal > 0 ? `${r.prioritiesDone}/${r.prioritiesTotal}` : '—'} sub={`${r.retrosDone} of ${r.days} reviewed`} />
      </div>

      <section className="review-section">
        <h3 className="retro-heading">
          Off the plan <span className="muted">{formatDuration(r.offPlanSeconds)}</span>
        </h3>
        {r.unplanned.length === 0 ? (
          <p className="muted small">Every logged session was for a priority.</p>
        ) : (
          <ul className="review-list">
            {r.unplanned.map(({ date, session }) => (
              <li key={session.id}>
                <button className="review-row" onClick={() => onOpen(date)}>
                  <span className="review-text">{session.label || <span className="muted">Untitled session</span>}</span>
                  <span className="review-meta">
                    <span className="muted small">{when(date)}</span>
                    <span className="review-time">{formatDuration(session.durationSeconds ?? 0)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="review-section">
        <h3 className="retro-heading">
          Not done <span className="muted">{r.notDone.length}</span>
        </h3>
        {r.notDone.length === 0 ? (
          <p className="muted small">{r.prioritiesTotal > 0 ? 'Every priority got ticked.' : 'No priorities were written.'}</p>
        ) : (
          <ul className="review-list">
            {r.notDone.map((g, i) => (
              <li key={`${g.date}-${i}`}>
                <button className="review-row" onClick={() => onOpen(g.date)}>
                  <span className="review-text">
                    {g.text}
                    {g.addedMidDay && <span className="pill pill--warn retro-late">mid-day</span>}
                  </span>
                  <span className="review-meta">
                    <span className="muted small">{when(g.date)}</span>
                    <span className="review-time">{g.focusedSeconds > 0 ? formatDuration(g.focusedSeconds) : <span className="muted">no time</span>}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="review-section">
        <h3 className="retro-heading">Why</h3>
        {r.notes.length === 0 ? (
          <p className="muted small">No retrospective notes yet. The card at the bottom of each day's sheet is where they go.</p>
        ) : (
          <ul className="review-list">
            {r.notes.map((n) => (
              <li key={n.date}>
                <button className="review-row review-row--note" onClick={() => onOpen(n.date)}>
                  <span className="review-meta review-note-head">
                    <strong>{dayName(n.date)}</strong>
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
          </ul>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
}
