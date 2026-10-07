import { useEffect, useState } from 'react';
import { RETENTION_LIMITS } from '../../../../shared/settings.js';
import * as api from '../../api';
import { useBoardStore } from '../../hooks/useBoard';
import { useDays, useDayStore } from '../../hooks/useDay';
import { useSubmit } from '../../hooks/useSubmit';
import { CONFIRM, DAYS_DELETED } from '../../lib/copy';
import { addDays, todayKey } from '../../../../shared/dates.js';
import { counted, formatDateFull } from '../../lib/format';
import type { PruneInfo } from '../../types';
import { Toggle } from '../Toggle';
import { NumberField, Section, type TabProps } from './controls';
import { ErrorLine } from '../ErrorLine';

export function DataTab({ settings, set, onReset }: TabProps & { onReset: () => void }) {
  return (
    <>
      <Section
        title="Automatic cleanup"
        hint="Deletes days older than this, with their punches, priorities, sessions, breaks and notes. Settings are kept. Runs on the server every few hours."
      >
        <Toggle label="Delete old days automatically" checked={settings.retention.enabled} onChange={(v) => set({ retention: { enabled: v } })} />
        <NumberField
          label="Keep the last"
          unit="days"
          value={settings.retention.days}
          {...RETENTION_LIMITS}
          disabled={!settings.retention.enabled}
          onCommit={(m) => set({ retention: { days: m } })}
        />
      </Section>
      <DeleteOldDays />
      <Section title="Reset" hint="Every setting goes back to its default. Days, punches and sessions are kept.">
        <div>
          <button className="btn btn-ghost btn-danger-text" onClick={onReset}>
            Reset all settings
          </button>
        </div>
      </Section>
      <p className="muted small">
        Clockspan v{__APP_VERSION__} · data stays on your server ·{' '}
        <a className="about-link" href="https://github.com/geransmith/clockspan/releases" target="_blank" rel="noreferrer">
          Release notes
        </a>
      </p>
    </>
  );
}

/**
 * Settings → Data → "Delete old days now". The count line is the server's answer for the
 * chosen cutoff, so the confirm names exactly what will go. The delete goes through the day
 * store (`pruneBefore`), so the days on screen follow it, and the board is read again while it is
 * on, since the prune takes the cards done before the cutoff. Not a settings save: nothing here
 * goes through the header's Saving/Saved pill.
 */
function DeleteOldDays() {
  const today = todayKey();
  const { pruneBefore } = useDayStore();
  const { generation } = useDays();
  const board = useBoardStore();
  const [before, setBefore] = useState(() => addDays(today, -365));
  const [loaded, setLoaded] = useState<PruneInfo | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, setError, run } = useSubmit();
  // The server says which cutoff each count is for: one for another date, or cleared by a
  // delete, is not shown, so Delete waits for the count that matches.
  const info = loaded?.before === before ? loaded : null;

  // A delete moves `generation`, which counts again for whatever date is picked by then.
  useEffect(() => {
    let cancelled = false;
    api
      .getPruneInfo(before)
      .then((r) => !cancelled && setLoaded(r))
      .catch((err: unknown) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [before, generation, setError]);

  const remove = () => {
    if (!info || !window.confirm(CONFIRM.deleteDays(info.matching, formatDateFull(before)))) return;
    setDone(null);
    run(async () => {
      const { deleted } = await pruneBefore(before);
      // Fresh: a read already out may have left before the prune. Nothing while the board is off.
      void board.load({ fresh: true });
      setDone(DAYS_DELETED(deleted));
      setLoaded(null);
    });
  };

  const stored = !info
    ? null
    : info.oldest === null
      ? 'No days stored.'
      : `${counted(info.total, 'day')} stored, oldest ${formatDateFull(info.oldest)}. ${info.matching} before this date.`;

  return (
    <Section
      title="Delete old days now"
      hint="Removes every day before the date, with its punches, priorities, sessions, breaks and notes. Today and a day with a running timer are always kept."
    >
      <div className="setting-row">
        <span>Delete days before</span>
        <span className="inline-controls">
          <input
            className="input"
            type="date"
            value={before}
            max={today}
            // `max` doesn't stop a typed date, and a cutoff after today would delete today too.
            onChange={(e) => {
              if (!e.target.value) return;
              setBefore(e.target.value < today ? e.target.value : today);
              setDone(null);
              setError(null);
            }}
            aria-label="Delete days before"
          />
          <button className="btn btn-ghost btn-danger-text" onClick={remove} disabled={busy || !info || info.matching === 0}>
            Delete…
          </button>
        </span>
      </div>
      {stored && <p className="muted small">{stored}</p>}
      {info?.serverMaxDays != null && <p className="muted small">This server keeps at most {info.serverMaxDays} days for every user.</p>}
      {/* Always there, so a screen reader hears the line arrive. */}
      <p className="success" role="status">
        {done}
      </p>
      <ErrorLine error={error} />
    </Section>
  );
}
