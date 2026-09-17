import { useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import { useDay } from '../hooks/useDay';
import { useSettings } from '../hooks/useSettings';
import { calendarMonth } from '../lib/calendar';
import { dayName, formatDateLong, formatDuration, formatWeekday } from '../lib/format';
import { periodOffset, periodRange } from '../lib/review';
import { daySummaryOf } from '../lib/stickers';
import { timeclockForDate } from '../lib/timeclock';
import type { Day } from '../types';
import { Check } from './Icons';
import { PeriodNav } from './PeriodNav';

interface Props {
  today: string;
  now: number;
  /** The sheet's date: the month the calendar opens on, with that day picked. */
  date: string;
  onOpen: (date: string) => void;
  onReviewWeek: (date: string) => void;
}

/**
 * History → Days: one month at a time, each day a cell, the picked day laid out underneath
 * with the numbers the sheet would show and a way to it or to its week's review.
 */
export function Calendar({ today, now, date, onOpen, onReviewWeek }: Props) {
  const { settings } = useSettings();
  const [offset, setOffset] = useState(() => periodOffset('month', today, date));
  const [selected, setSelected] = useState<string | null>(date > today ? null : date);
  const period = periodRange('month', today, offset);
  // Tagged with its range, like the review, so a step reads as loading straight away.
  const rangeKey = `${period.from}:${period.to}`;
  const [fetched, setFetched] = useState<{ key: string; days?: Day[]; error?: string } | null>(null);
  const current = fetched?.key === rangeKey ? fetched : null;
  const error = current?.error ?? null;
  // Today comes from the live day so a punch or a tick shows without a refetch.
  const { day: liveToday } = useDay(today);

  useEffect(() => {
    let cancelled = false;
    api
      .getRange(period.from, period.to)
      .then((r) => {
        if (!cancelled) setFetched({ key: rangeKey, days: r.days });
      })
      .catch((err) => {
        if (!cancelled) setFetched({ key: rangeKey, error: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [period.from, period.to, rangeKey]);

  const days = useMemo(() => {
    if (!current?.days) return null;
    const byDate = new Map(current.days.map((d) => [d.date, d]));
    if (liveToday && today >= period.from && today <= period.to) byDate.set(today, liveToday);
    return byDate;
  }, [current, liveToday, today, period.from, period.to]);
  const weeks = useMemo(() => (days ? calendarMonth([...days.values()].map(daySummaryOf), today, period.from) : null), [days, today, period.from]);

  const step = (o: number) => {
    setOffset(o);
    // The panel only ever shows a day of the month on screen.
    setSelected(null);
  };

  return (
    <section className="card calendar">
      <header className="card-head">
        <h2 className="card-title">Days</h2>
      </header>
      <PeriodNav kind="month" label={period.label} offset={offset} onOffset={step} />
      {error && <p className="error">{error}</p>}
      {!error && !weeks && <div className="sheet-loading" aria-busy="true" />}
      {weeks && days && (
        <>
          <div className="calendar-grid" role="grid" aria-label={period.label}>
            <div className="calendar-row" role="row">
              {weeks[0]!.map((d) => (
                <div key={d.date} className="calendar-weekday" role="columnheader">
                  {formatWeekday(d.date)}
                </div>
              ))}
            </div>
            {weeks.map((week) => (
              <div key={week[0]!.date} className="calendar-row" role="row">
                {week.map((d) => {
                  if (d.outside) return <div key={d.date} className="calendar-day is-outside" role="gridcell" aria-hidden="true" />;
                  const cls = ['calendar-day'];
                  if (!d.hasData) cls.push('is-empty');
                  if (d.isFuture) cls.push('is-future');
                  if (d.date === today) cls.push('is-today');
                  if (d.date === selected) cls.push('is-selected');
                  const day = days.get(d.date);
                  const tc = day ? timeclockForDate(day.punches, settings, d.date, today, now) : null;
                  const worked = tc && tc.clockIn != null ? formatDuration(tc.workedSeconds) : null;
                  return (
                    <button
                      key={d.date}
                      type="button"
                      className={cls.join(' ')}
                      role="gridcell"
                      aria-selected={d.date === selected}
                      aria-label={`${formatDateLong(d.date)}${worked ? `, worked ${worked}` : d.hasData ? '' : ', nothing recorded'}`}
                      data-date={d.date}
                      disabled={d.isFuture}
                      onClick={() => setSelected(d.date)}
                    >
                      <span className="calendar-daynum">{Number(d.date.slice(8))}</span>
                      {worked ? <span className="calendar-worked">{worked}</span> : d.hasData ? <span className="calendar-dot" aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="calendar-detail">
            {selected == null ? (
              <p className="muted small">Tap a day to see it.</p>
            ) : (
              <DayDetail date={selected} day={days.get(selected)} today={today} now={now} onOpen={onOpen} onReviewWeek={onReviewWeek} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function DayDetail({
  date,
  day,
  today,
  now,
  onOpen,
  onReviewWeek,
}: {
  date: string;
  day: Day | undefined;
  today: string;
  now: number;
  onOpen: (date: string) => void;
  onReviewWeek: (date: string) => void;
}) {
  const { settings } = useSettings();
  const name = dayName(date, today);
  const s = day ? daySummaryOf(day) : null;
  const tc = day ? timeclockForDate(day.punches, settings, date, today, now) : null;
  const sessions = day ? day.sessions.filter((x) => x.status === 'completed').length : 0;
  const note = day?.retroNote.trim() ?? '';
  return (
    <>
      <header className="calendar-detail-head">
        <strong>
          {name}
          {day?.retroAt != null && (
            <span className="history-reviewed" title="Retrospective reviewed" aria-label="Retrospective reviewed">
              <Check />
            </span>
          )}
        </strong>
        {name !== formatDateLong(date) && <span className="muted small">{formatDateLong(date)}</span>}
      </header>
      {s && tc ? (
        <div className="tiles calendar-tiles">
          <Tile label="Worked" value={tc.clockIn != null ? formatDuration(tc.workedSeconds) : '—'} sub={tc.clockIn == null ? 'no clock-in' : tc.lunchStatus === 'taken' ? 'lunch taken' : ''} />
          <Tile label="Focused" value={s.focusSeconds > 0 ? formatDuration(s.focusSeconds) : '—'} sub={sessions > 0 ? `${sessions} session${sessions === 1 ? '' : 's'}` : ''} />
          <Tile label="Priorities" value={s.prioritiesTotal > 0 ? `${s.prioritiesDone}/${s.prioritiesTotal}` : '—'} sub={s.prioritiesTotal > 0 && s.prioritiesDone === s.prioritiesTotal ? 'all done' : ''} />
        </div>
      ) : (
        <p className="muted small">Nothing recorded.</p>
      )}
      {note && <p className="review-note calendar-note">{note}</p>}
      <div className="calendar-actions">
        <button className="btn" onClick={() => onOpen(date)}>
          Open day
        </button>
        <button className="btn btn-ghost" onClick={() => onReviewWeek(date)}>
          Review this week
        </button>
      </div>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}
