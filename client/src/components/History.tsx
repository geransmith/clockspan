import { useEffect, useState } from 'react';
import * as api from '../api';
import { useSettings } from '../hooks/useSettings';
import { addDays, endOfDay, formatDateLong, formatDuration } from '../lib/format';
import { computeTimeclock } from '../lib/timeclock';
import type { DaySummary } from '../types';
import { Check } from './Icons';
import { Review } from './Review';

interface Props {
  today: string;
  now: number;
  onOpen: (date: string) => void;
}

type Tab = 'days' | 'review';

export function History({ today, now, onOpen }: Props) {
  const [tab, setTab] = useState<Tab>('days');
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
      {tab === 'days' ? <Days today={today} now={now} onOpen={onOpen} /> : <Review today={today} now={now} onOpen={onOpen} />}
    </div>
  );
}

function Days({ today, now, onOpen }: Props) {
  const { settings } = useSettings();
  const [days, setDays] = useState<DaySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listDays(90)
      .then((r) => setDays(r.days))
      .catch((err) => setError((err as Error).message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!days) return <div className="sheet-loading" aria-busy="true" />;
  if (days.length === 0) return <p className="muted center">No days recorded yet.</p>;

  return (
    <section className="card">
      <header className="card-head">
        <h2 className="card-title">History</h2>
        <span className="muted">{days.length} day{days.length === 1 ? "" : "s"}</span>
      </header>
      <ul className="history">
        {days.map((d) => {
          const frozenNow = d.date === today ? now : Math.min(now, endOfDay(d.date));
          const tc = computeTimeclock(d.punches, settings, frozenNow, { frozen: d.date !== today });
          const name = d.date === today ? 'Today' : d.date === addDays(today, -1) ? 'Yesterday' : formatDateLong(d.date);
          return (
            <li key={d.date}>
              <button className="history-row" onClick={() => onOpen(d.date)}>
                <span className="history-date">
                  <strong>
                    {name}
                    {d.retroAt != null && (
                      <span className="history-reviewed" title="Retrospective reviewed" aria-label="Retrospective reviewed">
                        <Check />
                      </span>
                    )}
                  </strong>
                  {(d.date === today || d.date === addDays(today, -1)) && <span className="muted small">{formatDateLong(d.date)}</span>}
                </span>
                <span className="history-stat">
                  <span className="muted small">Worked</span>
                  {tc.clockIn != null ? formatDuration(tc.workedSeconds) : '—'}
                </span>
                <span className="history-stat">
                  <span className="muted small">Focused</span>
                  {d.focusSeconds > 0 ? formatDuration(d.focusSeconds) : '—'}
                </span>
                <span className="history-stat">
                  <span className="muted small">Priorities</span>
                  {d.prioritiesTotal > 0 ? `${d.prioritiesDone}/${d.prioritiesTotal}` : '—'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
