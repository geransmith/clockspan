import { useMemo, useState, type ReactNode } from 'react';
import { startOfMonth } from '../../../shared/dates.js';
import { useRange } from '../hooks/useRange';
import { useSettings } from '../hooks/useSettings';
import { calendarMonth, type CalendarDay } from '../lib/calendar';
import { LOAD_FAILED } from '../lib/copy';
import { dayName, formatDateLong, formatDuration, formatHours, formatWeekday, plural } from '../lib/format';
import { hasContent } from '../lib/retro';
import { periodOffset, periodRange } from '../lib/review';
import {
  allPrioritiesDone,
  countStickers,
  dayTimeclock,
  daySummaryOf,
  isFullDay,
  STICKER_LABELS,
  stickerEmoji,
  stickerReasons,
  type DaySummary,
  type StickerId,
} from '../lib/stickers';
import { targetFraction, type TimeclockResult } from '../lib/timeclock';
import { Check } from './Icons';
import { LoadFailed } from './LoadFailed';
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
  // Held by its first day, so the grid and the picked day stay put when the clock passes
  // midnight into the next month; the offset from today only drives ◀ ▶ and "This month".
  const [month, setMonth] = useState(() => startOfMonth(date));
  const [selected, setSelected] = useState<string | null>(date);
  const [filter, setFilter] = useState<StickerId | null>(null);
  const period = periodRange('month', month, 0);
  const offset = periodOffset('month', today, month);
  const { days: list, failed, retry } = useRange(period.from, period.to);
  // The range lays the store's days over the answer, and one can be empty (today before a
  // punch): only a day with something on it counts, as in the review.
  const kept = useMemo(() => list?.filter(hasContent), [list]);
  const weeks = useMemo(
    () => (kept ? calendarMonth(kept.map(daySummaryOf), settings, today, now, period.from, settings.showWeekends) : null),
    [kept, settings, today, now, period.from],
  );
  const stickers = settings.stickers;
  // Hours not tracked: no Clocked out sticker, so the legend and a full day go without it.
  const { trackHours } = settings;
  const reasons = useMemo(() => stickerReasons(trackHours), [trackHours]);
  const count = useMemo(() => (weeks && stickers ? countStickers(weeks, reasons) : null), [weeks, stickers, reasons]);
  // Worked out from the day rather than read off its cell: with weekends off, a Saturday opened
  // from its sheet is picked but has no cell.
  const picked = kept?.find((d) => d.date === selected);
  const summary = picked && daySummaryOf(picked);
  const stats = summary && { summary, tc: dayTimeclock(summary, settings, today, now) };

  const step = (o: number) => {
    setMonth(periodRange('month', today, o).from);
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
      {failed ? <LoadFailed title={LOAD_FAILED.range} onRetry={retry} /> : !weeks && <div className="sheet-loading" aria-busy="true" />}
      {weeks && (
        <>
          {count && (
            <p className="calendar-count">
              <strong>{count.total}</strong> {plural(count.total, 'sticker')}
              {count.full > 0 && (
                <>
                  {' '}
                  · {count.full} full {plural(count.full, 'day')}
                </>
              )}
            </p>
          )}
          {/* Plain buttons in rows, not an ARIA grid: there are no arrow keys to go with one. */}
          <div className={`calendar-grid${settings.showWeekends ? '' : ' calendar-grid--work'}`} role="group" aria-label={period.label}>
            {/* Each day's name carries its weekday, so this row is for the eye only. */}
            <div className="calendar-row" aria-hidden="true">
              {weeks[0]!.map((d) => (
                <div key={d.date} className="calendar-weekday">
                  {formatWeekday(d.date)}
                </div>
              ))}
            </div>
            {weeks.map((week) => (
              <div key={week[0]!.date} className="calendar-row">
                {week.map((d) =>
                  d.outside ? (
                    <div key={d.date} className="calendar-day is-outside" aria-hidden="true" />
                  ) : (
                    <DayCell
                      key={d.date}
                      day={d}
                      today={today}
                      selected={d.date === selected}
                      full={stickers && isFullDay(d.stickers, reasons)}
                      shown={stickers ? (filter ? d.stickers.filter((id) => id === filter) : d.stickers) : null}
                      trackHours={trackHours}
                      onSelect={setSelected}
                    />
                  ),
                )}
              </div>
            ))}
          </div>
          {count &&
            (count.total === 0 ? (
              <p className="muted small calendar-legend">Nothing here yet. Stickers appear as days get logged.</p>
            ) : (
              <div className="chips calendar-legend" role="group" aria-label="Show only">
                {reasons.map((r) => (
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
              <DayDetail
                date={selected}
                today={today}
                stats={stats}
                note={picked?.retroNote.trim() ?? ''}
                trackHours={trackHours}
                onOpen={onOpen}
                onReviewWeek={onReviewWeek}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function DayCell({
  day: d,
  today,
  selected,
  full,
  shown,
  trackHours,
  onSelect,
}: {
  day: CalendarDay;
  today: string;
  selected: boolean;
  /** It earned every sticker there is to earn. */
  full: boolean;
  /** The stickers to show, already narrowed by the legend; null with the sticker chart off. */
  shown: StickerId[] | null;
  trackHours: boolean;
  onSelect: (date: string) => void;
}) {
  const cls = ['calendar-day'];
  if (!d.hasData) cls.push('is-empty');
  if (d.isFuture) cls.push('is-future');
  if (d.date === today) cls.push('is-today');
  if (selected) cls.push('is-selected');
  if (full) cls.push('is-full');
  // With hours not tracked a cell shows only that the day has something on it.
  const clocked = trackHours && d.timeclock?.clockIn != null ? d.timeclock : null;
  let label: string;
  let face: ReactNode = null;
  if (shown) {
    label = shown.length ? shown.map((id) => STICKER_LABELS[id]).join(', ') : 'no stickers';
    face = (
      <span className="sticker-row">
        {shown.map((id) => (
          <span key={id} className="sticker" title={STICKER_LABELS[id]} aria-hidden="true">
            {stickerEmoji(d.date, id)}
          </span>
        ))}
      </span>
    );
  } else if (clocked) {
    label = `worked ${formatDuration(clocked.workedSeconds)}`;
    const done = targetFraction(clocked);
    face = (
      <>
        <span className="calendar-worked">{formatHours(clocked.workedSeconds)}</span>
        <span className={`calendar-bar${done === 1 ? ' is-met' : ''}`} aria-hidden="true">
          <span style={{ transform: `scaleX(${done})` }} />
        </span>
      </>
    );
  } else if (d.hasData) {
    label = 'something recorded';
    face = <span className="calendar-dot" aria-hidden="true" />;
  } else {
    label = 'nothing recorded';
  }
  return (
    <button
      type="button"
      className={cls.join(' ')}
      aria-pressed={selected}
      aria-current={d.date === today ? 'date' : undefined}
      aria-label={`${formatDateLong(d.date)}, ${label}`}
      data-date={d.date}
      disabled={d.isFuture}
      onClick={() => onSelect(d.date)}
    >
      <span className="calendar-daynum">{Number(d.date.slice(8))}</span>
      {face}
    </button>
  );
}

function DayDetail({
  date,
  today,
  stats,
  note,
  trackHours,
  onOpen,
  onReviewWeek,
}: {
  date: string;
  today: string;
  /** The picked day's numbers; undefined for a day with nothing on it. */
  stats: { summary: DaySummary; tc: TimeclockResult } | undefined;
  /** The day's retrospective note, trimmed. */
  note: string;
  trackHours: boolean;
  onOpen: (date: string) => void;
  onReviewWeek: (date: string) => void;
}) {
  const name = dayName(date, today);
  let tiles: ReactNode = <p className="muted small">Nothing recorded.</p>;
  if (stats) {
    const { summary: s, tc } = stats;
    tiles = (
      <div className="tiles calendar-tiles">
        {trackHours && (
          <Tile
            label="Worked"
            value={tc.clockIn != null ? formatDuration(tc.workedSeconds) : '—'}
            sub={tc.clockIn == null ? 'no clock-in' : tc.lunchStatus === 'taken' ? 'lunch taken' : ''}
          />
        )}
        <Tile
          label="Focused"
          value={s.focusSeconds > 0 ? formatDuration(s.focusSeconds) : '—'}
          sub={s.focusSessions > 0 ? `${s.focusSessions} ${plural(s.focusSessions, 'session')}` : ''}
        />
        <Tile
          label="Priorities"
          value={s.prioritiesTotal > 0 ? `${s.prioritiesDone}/${s.prioritiesTotal}` : '—'}
          sub={allPrioritiesDone(s) ? 'all done' : ''}
        />
      </div>
    );
  }
  return (
    <>
      <header className="calendar-detail-head">
        <strong>
          {name}
          {stats?.summary.retroAt != null && (
            <span className="history-reviewed" title="Retrospective reviewed" role="img" aria-label="Retrospective reviewed">
              <Check />
            </span>
          )}
        </strong>
        {name !== formatDateLong(date) && <span className="muted small">{formatDateLong(date)}</span>}
      </header>
      {tiles}
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
