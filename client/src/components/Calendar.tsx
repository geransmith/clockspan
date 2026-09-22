import { useMemo, useState } from 'react';
import { useDay } from '../hooks/useDay';
import { useRange } from '../hooks/useRange';
import { useSettings } from '../hooks/useSettings';
import { calendarMonth } from '../lib/calendar';
import { STICKERS_EMPTY } from '../lib/copy';
import { dayName, formatDateLong, formatDuration, formatWeekday } from '../lib/format';
import { periodOffset, periodRange } from '../lib/review';
import { countStickers, daySummaryOf, STICKER_REASONS, stickerEmoji, type StickerId } from '../lib/stickers';
import { timeclockForDate } from '../lib/timeclock';
import type { Day } from '../types';
import { Check } from './Icons';
import { PeriodNav, PeriodReset } from './PeriodNav';
import { Tile } from './Tile';

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
 * with the numbers the sheet would show and a way to it or to its week's review. With the
 * sticker chart on, a cell wears a sticker for each thing the day did instead of its hours,
 * and the legend counts them and narrows the grid to one reason.
 */
export function Calendar({ today, now, date, onOpen, onReviewWeek }: Props) {
  const { settings } = useSettings();
  const [offset, setOffset] = useState(() => periodOffset('month', today, date));
  const [selected, setSelected] = useState<string | null>(date > today ? null : date);
  const [filter, setFilter] = useState<StickerId | null>(null);
  const period = periodRange('month', today, offset);
  const { days: fetched, error } = useRange(period.from, period.to);
  // Today comes from the live day so a punch or a tick shows without a refetch.
  const { day: liveToday } = useDay(today);

  const days = useMemo(() => {
    if (!fetched) return null;
    const byDate = new Map(fetched.map((d) => [d.date, d]));
    if (liveToday && today >= period.from && today <= period.to) byDate.set(today, liveToday);
    return byDate;
  }, [fetched, liveToday, today, period.from, period.to]);
  const weeks = useMemo(
    () => (days ? calendarMonth([...days.values()].map(daySummaryOf), settings, today, now, period.from, settings.showWeekends) : null),
    [days, settings, today, now, period.from],
  );
  const stickers = settings.stickers;
  const count = useMemo(() => (weeks && stickers ? countStickers(weeks) : null), [weeks, stickers]);

  const step = (o: number) => {
    setOffset(o);
    // The panel only ever shows a day of the month on screen.
    setSelected(null);
  };

  return (
    <section className="card calendar">
      <header className="card-head">
        <h2 className="card-title">Days</h2>
        <PeriodReset kind="month" offset={offset} onOffset={step} />
      </header>
      <PeriodNav kind="month" label={period.label} offset={offset} onOffset={step} noReset />
      {error && <p className="error">{error}</p>}
      {!error && !weeks && <div className="sheet-loading" aria-busy="true" />}
      {weeks && days && (
        <>
          {count && (
            <p className="calendar-count">
              <strong>{count.total}</strong> sticker{count.total === 1 ? '' : 's'}
              {count.full > 0 && (
                <>
                  {' '}
                  · {count.full} full day{count.full === 1 ? '' : 's'}
                </>
              )}
            </p>
          )}
          <div className={`calendar-grid${settings.showWeekends ? '' : ' calendar-grid--work'}`} role="grid" aria-label={period.label}>
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
                  if (stickers && d.stickers.length === STICKER_REASONS.length) cls.push('is-full');
                  const day = days.get(d.date);
                  const tc = day ? timeclockForDate(day.punches, settings, d.date, today, now) : null;
                  const worked = tc && tc.clockIn != null ? formatDuration(tc.workedSeconds) : null;
                  const shown = filter ? d.stickers.filter((id) => id === filter) : d.stickers;
                  const label = stickers
                    ? shown.length
                      ? shown.map((id) => STICKER_REASONS.find((r) => r.id === id)!.label).join(', ')
                      : 'no stickers'
                    : worked
                      ? `worked ${worked}`
                      : d.hasData
                        ? ''
                        : 'nothing recorded';
                  return (
                    <button
                      key={d.date}
                      type="button"
                      className={cls.join(' ')}
                      role="gridcell"
                      aria-selected={d.date === selected}
                      aria-label={`${formatDateLong(d.date)}${label ? `, ${label}` : ''}`}
                      data-date={d.date}
                      disabled={d.isFuture}
                      onClick={() => setSelected(d.date)}
                    >
                      <span className="calendar-daynum">{Number(d.date.slice(8))}</span>
                      {stickers ? (
                        <span className="sticker-row">
                          {shown.map((id) => (
                            <span key={id} className="sticker" title={STICKER_REASONS.find((r) => r.id === id)!.label} aria-hidden="true">
                              {stickerEmoji(d.date, id)}
                            </span>
                          ))}
                        </span>
                      ) : worked ? (
                        <span className="calendar-worked">{worked}</span>
                      ) : d.hasData ? (
                        <span className="calendar-dot" aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {count &&
            (count.total === 0 ? (
              <p className="muted small calendar-legend">{STICKERS_EMPTY}</p>
            ) : (
              <div className="chips calendar-legend" role="group" aria-label="Show only">
                {STICKER_REASONS.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`chip${filter === r.id ? ' is-on' : ''}`}
                    aria-pressed={filter === r.id}
                    onClick={() => setFilter((f) => (f === r.id ? null : r.id))}
                  >
                    {r.label} <span className="chip-num">{count.byReason[r.id]}</span>
                  </button>
                ))}
              </div>
            ))}
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
          <Tile
            label="Worked"
            value={tc.clockIn != null ? formatDuration(tc.workedSeconds) : '—'}
            sub={tc.clockIn == null ? 'no clock-in' : tc.lunchStatus === 'taken' ? 'lunch taken' : ''}
          />
          <Tile
            label="Focused"
            value={s.focusSeconds > 0 ? formatDuration(s.focusSeconds) : '—'}
            sub={sessions > 0 ? `${sessions} session${sessions === 1 ? '' : 's'}` : ''}
          />
          <Tile
            label="Priorities"
            value={s.prioritiesTotal > 0 ? `${s.prioritiesDone}/${s.prioritiesTotal}` : '—'}
            sub={s.prioritiesTotal > 0 && s.prioritiesDone === s.prioritiesTotal ? 'all done' : ''}
          />
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
