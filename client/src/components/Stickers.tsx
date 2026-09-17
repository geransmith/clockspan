import { useEffect, useMemo, useState } from 'react';
import * as api from '../api';
import { useDay } from '../hooks/useDay';
import { useSettings } from '../hooks/useSettings';
import { STICKERS_EMPTY } from '../lib/copy';
import { formatWeekday } from '../lib/format';
import { countStickers, daySummaryOf, STICKER_REASONS, STICKER_WEEKS, stickerEmoji, stickerWeeks } from '../lib/stickers';
import type { DaySummary } from '../types';

interface Props {
  today: string;
  now: number;
}

/**
 * Four weeks of days, each wearing a sticker for every thing it did. Past days come from
 * the history summaries; today is rolled up from the live day so a tick shows at once.
 */
export function Stickers({ today, now }: Props) {
  const { settings } = useSettings();
  const { day } = useDay(today);
  const [past, setPast] = useState<DaySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listDays(STICKER_WEEKS * 7 + 7)
      .then((r) => !cancelled && setPast(r.days))
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [today]);

  const weeks = useMemo(() => {
    if (!past) return null;
    const days = past.filter((d) => d.date !== today);
    if (day) days.push(daySummaryOf(day));
    return stickerWeeks(days, settings, today, now);
  }, [past, day, settings, today, now]);

  if (error) return <p className="error">{error}</p>;
  if (!weeks) return <div className="sheet-loading" aria-busy="true" />;

  const { total, full } = countStickers(weeks);
  const first = weeks[0]![0]!;
  return (
    <div className="stickers">
      <p className="stickers-count">
        <strong>{total}</strong> sticker{total === 1 ? '' : 's'} · last {STICKER_WEEKS} weeks
        {full > 0 && (
          <>
            {' '}
            · {full} full day{full === 1 ? '' : 's'}
          </>
        )}
      </p>
      <div className="stickers-grid" role="grid" aria-label={`Stickers since ${first.date}`}>
        {weeks[0]!.map((d) => (
          <div key={d.date} className="stickers-weekday" role="columnheader">
            {formatWeekday(d.date)}
          </div>
        ))}
        {weeks.flat().map((d) => {
          const day = Number(d.date.slice(8));
          const cls = ['sticker-day'];
          if (!d.hasData) cls.push('is-empty');
          if (d.isFuture) cls.push('is-future');
          if (d.date === today) cls.push('is-today');
          if (d.stickers.length === STICKER_REASONS.length) cls.push('is-full');
          const reasons = d.stickers.map((id) => STICKER_REASONS.find((r) => r.id === id)!.label);
          return (
            <div key={d.date} className={cls.join(' ')} role="gridcell" aria-label={`${d.date}: ${reasons.length ? reasons.join(', ') : 'no stickers'}`}>
              <span className="sticker-daynum">{day}</span>
              <span className="sticker-row">
                {d.stickers.map((id) => (
                  <span key={id} className="sticker" title={STICKER_REASONS.find((r) => r.id === id)!.label} aria-hidden="true">
                    {stickerEmoji(d.date, id)}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </div>
      {total === 0 ? (
        <p className="muted small">{STICKERS_EMPTY}</p>
      ) : (
        <ul className="stickers-legend">
          {STICKER_REASONS.map((r) => (
            <li key={r.id}>{r.label}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
